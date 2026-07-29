import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { POLICY, addDays } from "@/lib/circulation/policy";
import {
  cancelHold,
  checkIn,
  checkOut,
  expireStaleHolds,
  getMemberAccount,
  placeHold,
  renew,
} from "@/lib/circulation/service";
import { db } from "@/lib/db";

/**
 * Circulation against a real database.
 *
 * Every operation here spans several tables, so these tests are the only place
 * the transactional behaviour is actually proven. The concurrency test in
 * particular is the one the plan called for by name.
 */

const PREFIX = "circ-";

async function cleanup() {
  await db.fine.deleteMany({
    where: { loan: { copy: { barcode: { startsWith: PREFIX } } } },
  });
  await db.loan.deleteMany({
    where: { copy: { barcode: { startsWith: PREFIX } } },
  });
  await db.hold.deleteMany({
    where: { book: { title: { startsWith: PREFIX } } },
  });
  await db.bookCopy.deleteMany({ where: { barcode: { startsWith: PREFIX } } });
  await db.bookAuthor.deleteMany({
    where: { book: { title: { startsWith: PREFIX } } },
  });
  await db.book.deleteMany({ where: { title: { startsWith: PREFIX } } });
  await db.author.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

interface Fixture {
  bookId: string;
  copies: string[];
  members: string[];
  staffId: string;
}

async function fixture({
  copies = 1,
  members = 2,
}: { copies?: number; members?: number } = {}): Promise<Fixture> {
  const author = await db.author.create({
    data: { name: `${PREFIX}author`, sortName: `${PREFIX}author` },
  });
  const book = await db.book.create({
    data: {
      title: `${PREFIX}title`,
      authors: { create: [{ authorId: author.id, role: "AUTHOR" }] },
    },
  });

  const copyRows = [];
  for (let i = 0; i < copies; i += 1) {
    copyRows.push(
      await db.bookCopy.create({
        data: { barcode: `${PREFIX}${i}`, bookId: book.id },
      }),
    );
  }

  const memberRows = [];
  for (let i = 0; i < members; i += 1) {
    memberRows.push(
      await db.user.create({
        data: {
          email: `${PREFIX}m${i}@test`,
          name: `Member ${i}`,
          passwordHash: "x",
        },
      }),
    );
  }

  const staff = await db.user.create({
    data: {
      email: `${PREFIX}staff@test`,
      name: "Staff",
      passwordHash: "x",
      role: "LIBRARIAN",
    },
  });

  return {
    bookId: book.id,
    copies: copyRows.map((c) => c.barcode),
    members: memberRows.map((m) => m.id),
    staffId: staff.id,
  };
}

/**
 * Backdates an open loan so it is `daysLate` days overdue.
 *
 * Both `checkedOutAt` and `dueAt` have to move, because the
 * `Loan_due_after_checkout` check constraint refuses a loan due before it was
 * issued. An earlier version of these tests moved only `dueAt` and the database
 * rejected it — the constraint working exactly as intended, on a state that
 * could never occur in the real application.
 */
async function makeOverdue(barcode: string, daysLate: number) {
  const now = new Date();
  await db.loan.updateMany({
    where: { copy: { barcode }, returnedAt: null },
    data: {
      checkedOutAt: addDays(now, -(POLICY.loanPeriodDays + daysLate)),
      dueAt: addDays(now, -daysLate),
    },
  });
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe("checkOut", () => {
  it("issues a loan and marks the copy on loan", async () => {
    const f = await fixture();
    const result = await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });

    expect(result.ok).toBe(true);
    const copy = await db.bookCopy.findUnique({
      where: { barcode: f.copies[0]! },
    });
    expect(copy?.status).toBe("ON_LOAN");
  });

  it("refuses an unknown barcode", async () => {
    const f = await fixture();
    const result = await checkOut({
      barcode: "no-such-barcode",
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No copy found/);
  });

  it("refuses a copy already on loan", async () => {
    const f = await fixture();
    await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });

    const second = await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[1]!,
      issuedById: f.staffId,
    });
    expect(second.ok).toBe(false);
  });

  /**
   * The test the plan asked for by name.
   *
   * Two checkouts of the same copy fired simultaneously. Both will read
   * "AVAILABLE" and both will pass the policy check — no amount of
   * application-level validation closes that window. Exactly one must win,
   * and it is the Loan_one_open_per_copy partial unique index that guarantees
   * it.
   */
  it("permits exactly one of two simultaneous checkouts of the same copy", async () => {
    const f = await fixture({ members: 2 });

    const [a, b] = await Promise.all([
      checkOut({
        barcode: f.copies[0]!,
        memberId: f.members[0]!,
        issuedById: f.staffId,
      }),
      checkOut({
        barcode: f.copies[0]!,
        memberId: f.members[1]!,
        issuedById: f.staffId,
      }),
    ]);

    const succeeded = [a, b].filter((r) => r.ok);
    const failed = [a, b].filter((r) => !r.ok);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    // The loser gets a real message, not a stack trace.
    const error = failed[0];
    if (error && !error.ok) expect(error.error.length).toBeGreaterThan(10);

    // And the database holds exactly one open loan.
    const openLoans = await db.loan.count({
      where: { copy: { barcode: f.copies[0]! }, returnedAt: null },
    });
    expect(openLoans).toBe(1);
  });

  it("holds the line under a burst of ten concurrent attempts", async () => {
    const f = await fixture({ members: 1 });

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        checkOut({
          barcode: f.copies[0]!,
          memberId: f.members[0]!,
          issuedById: f.staffId,
        }),
      ),
    );

    expect(attempts.filter((r) => r.ok)).toHaveLength(1);
    await expect(
      db.loan.count({
        where: { copy: { barcode: f.copies[0]! }, returnedAt: null },
      }),
    ).resolves.toBe(1);
  });

  it("refuses a suspended member", async () => {
    const f = await fixture();
    await db.user.update({
      where: { id: f.members[0]! },
      data: { suspended: true },
    });

    const result = await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/suspended/i);
  });

  it("refuses past the concurrent loan limit", async () => {
    const f = await fixture({ copies: POLICY.maxConcurrentLoans + 1 });

    for (let i = 0; i < POLICY.maxConcurrentLoans; i += 1) {
      const r = await checkOut({
        barcode: f.copies[i]!,
        memberId: f.members[0]!,
        issuedById: f.staffId,
      });
      expect(r.ok).toBe(true);
    }

    const overLimit = await checkOut({
      barcode: f.copies[POLICY.maxConcurrentLoans]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) expect(overLimit.error).toMatch(/limit/i);
  });

  it("refuses a member with fines above the threshold", async () => {
    const f = await fixture({ copies: 2 });

    // Create a returned loan carrying a large unpaid fine. checkedOutAt has to
    // precede dueAt — see Loan_due_after_checkout.
    const copy = await db.bookCopy.findUniqueOrThrow({
      where: { barcode: f.copies[0]! },
    });
    const loan = await db.loan.create({
      data: {
        copyId: copy.id,
        memberId: f.members[0]!,
        checkedOutAt: addDays(new Date(), -44),
        dueAt: addDays(new Date(), -30),
        returnedAt: new Date(),
      },
    });
    await db.fine.create({
      data: {
        loanId: loan.id,
        amountCents: POLICY.borrowingBlockedAboveCents + 100,
      },
    });

    const result = await checkOut({
      barcode: f.copies[1]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/fines/i);
  });
});

describe("checkIn", () => {
  it("closes the loan and returns the copy to the shelf", async () => {
    const f = await fixture();
    await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });

    const result = await checkIn({ barcode: f.copies[0]! });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.fineCents).toBe(0);

    const copy = await db.bookCopy.findUnique({
      where: { barcode: f.copies[0]! },
    });
    expect(copy?.status).toBe("AVAILABLE");
  });

  it("refuses a copy that is not on loan", async () => {
    const f = await fixture();
    const result = await checkIn({ barcode: f.copies[0]! });
    expect(result.ok).toBe(false);
  });

  it("assesses a fine for an overdue return", async () => {
    const f = await fixture();
    await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });

    // Backdate the loan so the return is late.
    const daysLate = 5;
    await makeOverdue(f.copies[0]!, daysLate);

    const result = await checkIn({ barcode: f.copies[0]! });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected =
        (daysLate - POLICY.fineGraceDays) * POLICY.fineCentsPerDay;
      expect(result.data.fineCents).toBe(expected);
    }

    const fines = await db.fine.findMany({
      where: { loan: { copy: { barcode: f.copies[0]! } } },
    });
    expect(fines).toHaveLength(1);
    expect(fines[0]?.reason).toBe("OVERDUE");
  });

  it("charges nothing inside the grace period", async () => {
    const f = await fixture();
    await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });
    await makeOverdue(f.copies[0]!, POLICY.fineGraceDays);

    const result = await checkIn({ barcode: f.copies[0]! });
    if (result.ok) expect(result.data.fineCents).toBe(0);
    await expect(
      db.fine.count({ where: { loan: { copy: { barcode: f.copies[0]! } } } }),
    ).resolves.toBe(0);
  });

  it("frees the copy for re-lending", async () => {
    const f = await fixture();
    await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });
    await checkIn({ barcode: f.copies[0]! });

    // The partial unique index only covers open loans, so this must succeed.
    const again = await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[1]!,
      issuedById: f.staffId,
    });
    expect(again.ok).toBe(true);
  });
});

describe("renew", () => {
  it("extends the due date and counts the renewal", async () => {
    const f = await fixture();
    const out = await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });
    if (!out.ok) throw new Error("setup failed");

    const before = out.data.dueAt;
    const result = await renew({
      loanId: out.data.loanId,
      memberId: f.members[0]!,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.dueAt.getTime()).toBeGreaterThan(before.getTime());
    }
    const loan = await db.loan.findUniqueOrThrow({
      where: { id: out.data.loanId },
    });
    expect(loan.renewalCount).toBe(1);
  });

  it("refuses to renew someone else's loan", async () => {
    const f = await fixture();
    const out = await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });
    if (!out.ok) throw new Error("setup failed");

    // Changing an id in a form must not renew another member's loan.
    const result = await renew({
      loanId: out.data.loanId,
      memberId: f.members[1]!,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/does not belong to you/);
  });

  it("stops at the renewal cap", async () => {
    const f = await fixture();
    const out = await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });
    if (!out.ok) throw new Error("setup failed");

    for (let i = 0; i < POLICY.maxRenewals; i += 1) {
      const r = await renew({ loanId: out.data.loanId });
      expect(r.ok).toBe(true);
    }
    const overCap = await renew({ loanId: out.data.loanId });
    expect(overCap.ok).toBe(false);
  });

  it("refuses when another member is waiting", async () => {
    const f = await fixture({ members: 2 });
    const out = await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });
    if (!out.ok) throw new Error("setup failed");

    await placeHold({ bookId: f.bookId, memberId: f.members[1]! });

    const result = await renew({ loanId: out.data.loanId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/waiting/i);
  });
});

describe("holds", () => {
  it("queues holds in the order they were placed", async () => {
    const f = await fixture({ members: 3 });
    await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });

    const first = await placeHold({
      bookId: f.bookId,
      memberId: f.members[1]!,
      now: new Date(Date.now() - 60_000),
    });
    const second = await placeHold({
      bookId: f.bookId,
      memberId: f.members[2]!,
    });

    expect(first.ok && first.data.position).toBe(1);
    expect(second.ok && second.data.position).toBe(2);
  });

  it("refuses a duplicate hold on the same title", async () => {
    const f = await fixture({ members: 2 });
    await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });

    await placeHold({ bookId: f.bookId, memberId: f.members[1]! });
    const again = await placeHold({
      bookId: f.bookId,
      memberId: f.members[1]!,
    });

    // Hold_one_active_per_member_book, the second partial unique index.
    expect(again.ok).toBe(false);
  });

  it("refuses a hold on something the member already has out", async () => {
    const f = await fixture();
    await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });

    const result = await placeHold({
      bookId: f.bookId,
      memberId: f.members[0]!,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already have this title/i);
  });

  it("promotes the front of the queue when a copy comes back", async () => {
    const f = await fixture({ members: 3 });
    await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });

    await placeHold({
      bookId: f.bookId,
      memberId: f.members[1]!,
      now: new Date(Date.now() - 60_000),
    });
    await placeHold({ bookId: f.bookId, memberId: f.members[2]! });

    const result = await checkIn({ barcode: f.copies[0]! });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.promotedHold?.memberName).toBe("Member 1");
    }

    // The copy waits on the hold shelf rather than going back into stock.
    const copy = await db.bookCopy.findUnique({
      where: { barcode: f.copies[0]! },
    });
    expect(copy?.status).toBe("HOLD_SHELF");

    const holds = await db.hold.findMany({
      where: { bookId: f.bookId },
      orderBy: { placedAt: "asc" },
    });
    expect(holds[0]?.status).toBe("READY");
    expect(holds[1]?.status).toBe("WAITING");
  });

  it("stops another member taking a copy reserved on the hold shelf", async () => {
    const f = await fixture({ members: 3 });
    await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });
    await placeHold({ bookId: f.bookId, memberId: f.members[1]! });
    await checkIn({ barcode: f.copies[0]! });

    // member 2 walks up to the desk with a copy reserved for member 1.
    const grab = await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[2]!,
      issuedById: f.staffId,
    });
    expect(grab.ok).toBe(false);

    // The member it is waiting for can collect it.
    const collect = await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[1]!,
      issuedById: f.staffId,
    });
    expect(collect.ok).toBe(true);

    const hold = await db.hold.findFirst({
      where: { bookId: f.bookId, memberId: f.members[1]! },
    });
    expect(hold?.status).toBe("FULFILLED");
  });

  it("cancels a hold, and refuses to cancel someone else's", async () => {
    const f = await fixture({ members: 2 });
    await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });
    const placed = await placeHold({
      bookId: f.bookId,
      memberId: f.members[1]!,
    });
    if (!placed.ok) throw new Error("setup failed");

    const wrongMember = await cancelHold({
      holdId: placed.data.holdId,
      memberId: f.members[0]!,
    });
    expect(wrongMember.ok).toBe(false);

    const owner = await cancelHold({
      holdId: placed.data.holdId,
      memberId: f.members[1]!,
    });
    expect(owner.ok).toBe(true);
  });

  it("expires an uncollected hold and releases the copy", async () => {
    const f = await fixture({ members: 2 });
    await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });
    await placeHold({ bookId: f.bookId, memberId: f.members[1]! });
    await checkIn({ barcode: f.copies[0]! });

    // Push the pickup window into the past.
    await db.hold.updateMany({
      where: { bookId: f.bookId, status: "READY" },
      data: { expiresAt: addDays(new Date(), -1) },
    });

    const expired = await expireStaleHolds();
    expect(expired).toBeGreaterThanOrEqual(1);

    const hold = await db.hold.findFirst({ where: { bookId: f.bookId } });
    expect(hold?.status).toBe("EXPIRED");

    const copy = await db.bookCopy.findUnique({
      where: { barcode: f.copies[0]! },
    });
    expect(copy?.status).toBe("AVAILABLE");
  });
});

describe("getMemberAccount", () => {
  it("reports loans, holds, and what is owed", async () => {
    const f = await fixture({ copies: 2, members: 2 });
    await checkOut({
      barcode: f.copies[0]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });

    // An overdue loan carrying a fine.
    await checkOut({
      barcode: f.copies[1]!,
      memberId: f.members[0]!,
      issuedById: f.staffId,
    });
    await makeOverdue(f.copies[1]!, 10);

    const account = await getMemberAccount(f.members[0]!);
    expect(account.loans).toHaveLength(2);
    expect(account.loans.some((l) => l.overdue)).toBe(true);
    expect(account.loans.every((l) => l.renewable)).toBe(true);
    expect(account.totalOwedCents).toBe(0); // not yet returned, so not assessed

    await checkIn({ barcode: f.copies[1]! });
    const after = await getMemberAccount(f.members[0]!);
    expect(after.loans).toHaveLength(1);
    expect(after.totalOwedCents).toBeGreaterThan(0);
  });
});
