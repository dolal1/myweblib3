"use server";

import { revalidatePath } from "next/cache";

import { requireActiveMember, requireRole, requireUser } from "@/lib/auth/dal";
import { formatCents } from "@/lib/circulation/policy";
import {
  cancelHold as cancelHoldService,
  checkIn,
  checkOut,
  placeHold as placeHoldService,
  renew as renewService,
} from "@/lib/circulation/service";
import { db } from "@/lib/db";

/**
 * Circulation actions.
 *
 * Same rule as everywhere else: the authorization check is the first statement,
 * because a Server Action is a public POST endpoint. Note the distinction
 * between `requireRole("LIBRARIAN")` for desk operations and
 * `requireActiveMember()` for things a member does to their own account.
 */

export interface DeskState {
  ok?: boolean;
  message?: string;
  detail?: string;
}

export async function checkOutAction(
  _prev: DeskState,
  formData: FormData,
): Promise<DeskState> {
  const staff = await requireRole("LIBRARIAN");

  const barcode = String(formData.get("barcode") ?? "").trim();
  const memberId = String(formData.get("memberId") ?? "").trim();

  if (!barcode) return { message: "Scan or type a barcode." };
  if (!memberId) return { message: "Choose a member." };

  const result = await checkOut({ barcode, memberId, issuedById: staff.id });

  if (!result.ok) return { message: result.error };

  revalidatePath("/desk");
  revalidatePath("/books");
  return {
    ok: true,
    message: `Checked out ${barcode}.`,
    detail: `Due ${result.data.dueAt.toISOString().slice(0, 10)}.`,
  };
}

export async function checkInAction(
  _prev: DeskState,
  formData: FormData,
): Promise<DeskState> {
  await requireRole("LIBRARIAN");

  const barcode = String(formData.get("barcode") ?? "").trim();
  if (!barcode) return { message: "Scan or type a barcode." };

  const result = await checkIn({ barcode });
  if (!result.ok) return { message: result.error };

  const parts: string[] = [];
  if (result.data.fineCents > 0) {
    parts.push(
      `Overdue fine of ${formatCents(result.data.fineCents)} applied.`,
    );
  }
  if (result.data.promotedHold) {
    parts.push(
      `Hold ready for ${result.data.promotedHold.memberName} until ` +
        `${result.data.promotedHold.expiresAt.toISOString().slice(0, 10)}.`,
    );
  }

  revalidatePath("/desk");
  revalidatePath("/books");
  return {
    ok: true,
    message: `Returned ${barcode}.`,
    ...(parts.length > 0 ? { detail: parts.join(" ") } : {}),
  };
}

/** A member renewing their own loan. */
export async function renewAction(
  _prev: DeskState,
  formData: FormData,
): Promise<DeskState> {
  const user = await requireUser();

  const loanId = String(formData.get("loanId") ?? "").trim();
  if (!loanId) return { message: "No loan specified." };

  // Staff may renew anyone's loan; a member only their own. Passing memberId
  // is what makes the service enforce ownership.
  const isStaff = user.role === "LIBRARIAN" || user.role === "ADMIN";
  const result = await renewService({
    loanId,
    ...(isStaff ? {} : { memberId: user.id }),
  });

  if (!result.ok) return { message: result.error };

  revalidatePath("/account");
  revalidatePath("/desk");
  return {
    ok: true,
    message: `Renewed until ${result.data.dueAt.toISOString().slice(0, 10)}.`,
  };
}

export async function placeHoldAction(
  _prev: DeskState,
  formData: FormData,
): Promise<DeskState> {
  // Suspended members can browse but not borrow or reserve.
  const member = await requireActiveMember();

  const bookId = String(formData.get("bookId") ?? "").trim();
  if (!bookId) return { message: "No title specified." };

  const result = await placeHoldService({ bookId, memberId: member.id });
  if (!result.ok) return { message: result.error };

  revalidatePath("/account");
  revalidatePath(`/books/${bookId}`);
  return {
    ok: true,
    message: `Hold placed — you are number ${result.data.position} in the queue.`,
  };
}

export async function cancelHoldAction(
  _prev: DeskState,
  formData: FormData,
): Promise<DeskState> {
  const user = await requireUser();

  const holdId = String(formData.get("holdId") ?? "").trim();
  if (!holdId) return { message: "No hold specified." };

  const isStaff = user.role === "LIBRARIAN" || user.role === "ADMIN";
  const result = await cancelHoldService({
    holdId,
    ...(isStaff ? {} : { memberId: user.id }),
  });

  if (!result.ok) return { message: result.error };

  revalidatePath("/account");
  return { ok: true, message: "Hold cancelled." };
}

/** Staff-only: mark a fine as paid. */
export async function payFineAction(
  _prev: DeskState,
  formData: FormData,
): Promise<DeskState> {
  await requireRole("LIBRARIAN");

  const fineId = String(formData.get("fineId") ?? "").trim();
  if (!fineId) return { message: "No fine specified." };

  const fine = await db.fine.findUnique({
    where: { id: fineId },
    select: { paidAt: true, waivedAt: true, amountCents: true },
  });
  if (!fine) return { message: "That fine does not exist." };
  if (fine.paidAt || fine.waivedAt) {
    return { message: "That fine is already settled." };
  }

  await db.fine.update({
    where: { id: fineId },
    data: { paidAt: new Date() },
  });

  revalidatePath("/account");
  revalidatePath("/desk");
  return {
    ok: true,
    message: `Recorded ${formatCents(fine.amountCents)} paid.`,
  };
}
