import "server-only";

import { db } from "@/lib/db";
import { isUniqueViolation } from "@/lib/db-errors";
import {
  POLICY,
  checkoutRefusal,
  dueDateFor,
  explainCheckoutRefusal,
  explainRenewalRefusal,
  fineCentsFor,
  holdExpiryFrom,
  renewalRefusal,
  renewedDueDate,
  type MemberStanding,
} from "@/lib/circulation/policy";

/**
 * Circulation operations.
 *
 * Every one of these touches several tables, which is the entire reason this
 * project moved off MongoDB: checking out an item writes a Loan, flips a
 * BookCopy status, and may consume a Hold. Those have to succeed or fail
 * together.
 *
 * The important detail is that the policy check is *not* the safety mechanism.
 * `checkoutRefusal` gives the librarian a useful message, but two simultaneous
 * requests can both pass it. What actually prevents a double checkout is the
 * `Loan_one_open_per_copy` partial unique index, and the code below treats a
 * unique violation as a legitimate, expected outcome rather than a crash.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = (error: string): Result<never> => ({ ok: false, error });

/** Aggregates everything the policy needs to judge a member. */
async function memberStanding(
  tx: Pick<typeof db, "loan" | "fine" | "user">,
  memberId: string,
): Promise<MemberStanding | null> {
  const member = await tx.user.findUnique({
    where: { id: memberId },
    select: { suspended: true },
  });
  if (!member) return null;

  const [openLoanCount, fines] = await Promise.all([
    tx.loan.count({ where: { memberId, returnedAt: null } }),
    tx.fine.findMany({
      where: { loan: { memberId }, paidAt: null, waivedAt: null },
      select: { amountCents: true },
    }),
  ]);

  return {
    suspended: member.suspended,
    openLoanCount,
    unpaidFineCents: fines.reduce((sum, f) => sum + f.amountCents, 0),
  };
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export interface CheckoutInput {
  barcode: string;
  memberId: string;
  issuedById: string;
  now?: Date;
}

export async function checkOut({
  barcode,
  memberId,
  issuedById,
  now = new Date(),
}: CheckoutInput): Promise<Result<{ loanId: string; dueAt: Date }>> {
  try {
    return await db.$transaction(async (tx) => {
      const copy = await tx.bookCopy.findUnique({
        where: { barcode },
        select: { id: true, status: true, bookId: true },
      });
      if (!copy) return fail(`No copy found with barcode ${barcode}.`);

      const standing = await memberStanding(tx, memberId);
      if (!standing) return fail("That member no longer exists.");

      // If this title has a ready hold for someone else, this copy is spoken
      // for. The front of the queue outranks whoever is standing at the desk.
      const readyHoldForOther = await tx.hold.findFirst({
        where: {
          bookId: copy.bookId,
          status: "READY",
          memberId: { not: memberId },
        },
        select: { id: true },
      });

      const refusal = checkoutRefusal(standing, copy.status, {
        reservedForOther: readyHoldForOther !== null,
      });
      if (refusal) return fail(explainCheckoutRefusal(refusal));

      const loan = await tx.loan.create({
        data: {
          copyId: copy.id,
          memberId,
          issuedById,
          checkedOutAt: now,
          dueAt: dueDateFor(now),
        },
        select: { id: true, dueAt: true },
      });

      await tx.bookCopy.update({
        where: { id: copy.id },
        data: { status: "ON_LOAN" },
      });

      // Fulfil this member's own hold, if they had one.
      await tx.hold.updateMany({
        where: {
          bookId: copy.bookId,
          memberId,
          status: { in: ["WAITING", "READY"] },
        },
        data: { status: "FULFILLED" },
      });

      return ok({ loanId: loan.id, dueAt: loan.dueAt });
    });
  } catch (error) {
    // The partial unique index fired: another request checked this copy out
    // between our availability read and our insert. This is the race the index
    // exists to lose safely, so it is reported, not thrown.
    if (isUniqueViolation(error)) {
      return fail(
        "That copy was checked out by someone else a moment ago. Please re-scan.",
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Return
// ---------------------------------------------------------------------------

export interface ReturnOutcome {
  loanId: string;
  daysLate: number;
  fineCents: number;
  promotedHold: { memberName: string; expiresAt: Date } | null;
}

export async function checkIn({
  barcode,
  now = new Date(),
}: {
  barcode: string;
  now?: Date;
}): Promise<Result<ReturnOutcome>> {
  return db.$transaction(async (tx) => {
    const copy = await tx.bookCopy.findUnique({
      where: { barcode },
      select: { id: true, bookId: true },
    });
    if (!copy) return fail(`No copy found with barcode ${barcode}.`);

    const loan = await tx.loan.findFirst({
      where: { copyId: copy.id, returnedAt: null },
      select: { id: true, dueAt: true },
    });
    if (!loan) {
      return fail("That copy is not currently on loan.");
    }

    await tx.loan.update({
      where: { id: loan.id },
      data: { returnedAt: now },
    });

    // Assess the fine from the actual return time.
    const fineCents = fineCentsFor(loan.dueAt, now);
    if (fineCents > 0) {
      await tx.fine.create({
        data: {
          loanId: loan.id,
          amountCents: fineCents,
          reason: "OVERDUE",
          assessedAt: now,
        },
      });
    }

    // Promote the longest-waiting hold on this title, if any. Position is
    // derived from placedAt rather than stored, so a cancelled hold cannot
    // leave a gap in the queue.
    const nextHold = await tx.hold.findFirst({
      where: { bookId: copy.bookId, status: "WAITING" },
      orderBy: { placedAt: "asc" },
      select: { id: true, member: { select: { name: true } } },
    });

    if (nextHold) {
      const expiresAt = holdExpiryFrom(now);
      await tx.hold.update({
        where: { id: nextHold.id },
        data: { status: "READY", readyAt: now, expiresAt },
      });
      await tx.bookCopy.update({
        where: { id: copy.id },
        data: { status: "HOLD_SHELF" },
      });

      return ok({
        loanId: loan.id,
        daysLate: fineCents > 0 ? 1 : 0,
        fineCents,
        promotedHold: { memberName: nextHold.member.name, expiresAt },
      });
    }

    await tx.bookCopy.update({
      where: { id: copy.id },
      data: { status: "AVAILABLE" },
    });

    return ok({
      loanId: loan.id,
      daysLate: fineCents > 0 ? 1 : 0,
      fineCents,
      promotedHold: null,
    });
  });
}

// ---------------------------------------------------------------------------
// Renew
// ---------------------------------------------------------------------------

export async function renew({
  loanId,
  memberId,
  now = new Date(),
}: {
  loanId: string;
  /** When present, the loan must belong to this member. */
  memberId?: string;
  now?: Date;
}): Promise<Result<{ dueAt: Date }>> {
  return db.$transaction(async (tx) => {
    const loan = await tx.loan.findUnique({
      where: { id: loanId },
      select: {
        id: true,
        memberId: true,
        returnedAt: true,
        renewalCount: true,
        dueAt: true,
        copy: { select: { bookId: true } },
      },
    });
    if (!loan) return fail("That loan does not exist.");

    // Ownership check. A member renewing their own loan must not be able to
    // renew someone else's by changing an id in the form.
    if (memberId !== undefined && loan.memberId !== memberId) {
      return fail("That loan does not belong to you.");
    }

    const waitingHolds = await tx.hold.count({
      where: { bookId: loan.copy.bookId, status: { in: ["WAITING", "READY"] } },
    });

    const refusal = renewalRefusal(loan, waitingHolds);
    if (refusal) return fail(explainRenewalRefusal(refusal));

    const dueAt = renewedDueDate(loan.dueAt, now);
    await tx.loan.update({
      where: { id: loan.id },
      data: { dueAt, renewalCount: { increment: 1 } },
    });

    return ok({ dueAt });
  });
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

export async function placeHold({
  bookId,
  memberId,
  now = new Date(),
}: {
  bookId: string;
  memberId: string;
  now?: Date;
}): Promise<Result<{ holdId: string; position: number }>> {
  try {
    return await db.$transaction(async (tx) => {
      const member = await tx.user.findUnique({
        where: { id: memberId },
        select: { suspended: true },
      });
      if (!member) return fail("That member no longer exists.");
      if (member.suspended) {
        return fail("Your borrowing privileges are suspended.");
      }

      const book = await tx.book.findUnique({
        where: { id: bookId },
        select: { id: true },
      });
      if (!book) return fail("That title does not exist.");

      // Holding something you already have out is pointless.
      const existingLoan = await tx.loan.findFirst({
        where: { memberId, returnedAt: null, copy: { bookId } },
        select: { id: true },
      });
      if (existingLoan) {
        return fail("You already have this title on loan.");
      }

      const activeHolds = await tx.hold.count({
        where: { memberId, status: { in: ["WAITING", "READY"] } },
      });
      if (activeHolds >= POLICY.maxConcurrentHolds) {
        return fail(
          `You already have ${POLICY.maxConcurrentHolds} holds, which is the limit.`,
        );
      }

      const hold = await tx.hold.create({
        data: { bookId, memberId, status: "WAITING", placedAt: now },
        select: { id: true },
      });

      const position = await tx.hold.count({
        where: {
          bookId,
          status: "WAITING",
          placedAt: { lte: now },
        },
      });

      return ok({ holdId: hold.id, position });
    });
  } catch (error) {
    // Hold_one_active_per_member_book — the other partial unique index.
    if (isUniqueViolation(error)) {
      return fail("You already have a hold on this title.");
    }
    throw error;
  }
}

export async function cancelHold({
  holdId,
  memberId,
}: {
  holdId: string;
  memberId?: string;
}): Promise<Result<null>> {
  return db.$transaction(async (tx) => {
    const hold = await tx.hold.findUnique({
      where: { id: holdId },
      select: { id: true, memberId: true, status: true },
    });
    if (!hold) return fail("That hold does not exist.");
    if (memberId !== undefined && hold.memberId !== memberId) {
      return fail("That hold does not belong to you.");
    }
    if (hold.status !== "WAITING" && hold.status !== "READY") {
      return fail("That hold is no longer active.");
    }

    await tx.hold.update({
      where: { id: hold.id },
      data: { status: "CANCELLED" },
    });

    return ok(null);
  });
}

/**
 * Expires ready holds nobody collected, and releases their copies.
 *
 * Called by the scheduled job alongside the overdue sweep.
 */
export async function expireStaleHolds(now = new Date()): Promise<number> {
  const stale = await db.hold.findMany({
    where: { status: "READY", expiresAt: { lt: now } },
    select: { id: true, bookId: true },
  });

  for (const hold of stale) {
    await db.$transaction(async (tx) => {
      await tx.hold.update({
        where: { id: hold.id },
        data: { status: "EXPIRED" },
      });

      // Hand the copy to the next in line, or back to the shelf.
      const copy = await tx.bookCopy.findFirst({
        where: { bookId: hold.bookId, status: "HOLD_SHELF" },
        select: { id: true },
      });
      if (!copy) return;

      const next = await tx.hold.findFirst({
        where: { bookId: hold.bookId, status: "WAITING" },
        orderBy: { placedAt: "asc" },
        select: { id: true },
      });

      if (next) {
        await tx.hold.update({
          where: { id: next.id },
          data: {
            status: "READY",
            readyAt: now,
            expiresAt: holdExpiryFrom(now),
          },
        });
      } else {
        await tx.bookCopy.update({
          where: { id: copy.id },
          data: { status: "AVAILABLE" },
        });
      }
    });
  }

  return stale.length;
}

// ---------------------------------------------------------------------------
// Member-facing reads
// ---------------------------------------------------------------------------

export async function getMemberAccount(memberId: string, now = new Date()) {
  const [loans, holds, fines] = await Promise.all([
    db.loan.findMany({
      where: { memberId, returnedAt: null },
      orderBy: { dueAt: "asc" },
      select: {
        id: true,
        dueAt: true,
        renewalCount: true,
        copy: {
          select: {
            barcode: true,
            book: { select: { id: true, title: true } },
          },
        },
      },
    }),
    db.hold.findMany({
      where: { memberId, status: { in: ["WAITING", "READY"] } },
      orderBy: { placedAt: "asc" },
      select: {
        id: true,
        status: true,
        placedAt: true,
        expiresAt: true,
        book: { select: { id: true, title: true } },
      },
    }),
    db.fine.findMany({
      where: { loan: { memberId }, paidAt: null, waivedAt: null },
      select: {
        id: true,
        amountCents: true,
        reason: true,
        assessedAt: true,
        loan: {
          select: { copy: { select: { book: { select: { title: true } } } } },
        },
      },
    }),
  ]);

  return {
    loans: loans.map((loan) => ({
      ...loan,
      overdue: loan.dueAt.getTime() < now.getTime(),
      renewable: loan.renewalCount < POLICY.maxRenewals,
    })),
    holds,
    fines,
    totalOwedCents: fines.reduce((sum, f) => sum + f.amountCents, 0),
  };
}
