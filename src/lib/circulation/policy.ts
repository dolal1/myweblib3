/**
 * Circulation policy — every business rule in one place.
 *
 * The plan for this project called for these to live in a single module rather
 * than scattered through handlers, and the reason is mundane but real: a
 * library changes its loan period or fine rate far more often than it changes
 * its code. Anything a librarian might reasonably want changed should be here,
 * as a named constant, not buried in a `dueAt` calculation three files deep.
 *
 * Pure functions only. No database, no clock of their own — the current time is
 * always passed in, which is what makes the fine arithmetic testable without
 * mocking global state.
 */

export const POLICY = {
  /** Days a loan runs for, from checkout. */
  loanPeriodDays: 14,

  /** Additional days granted per renewal. */
  renewalPeriodDays: 14,

  /** How many times one loan may be renewed. */
  maxRenewals: 2,

  /** Concurrent open loans a member may hold. */
  maxConcurrentLoans: 5,

  /** Open holds a member may have queued. */
  maxConcurrentHolds: 5,

  /** Charged per day, per overdue item, in cents. */
  fineCentsPerDay: 25,

  /** A single overdue item never accrues more than this. */
  maxFineCentsPerLoan: 2000,

  /**
   * Grace period before fines begin. A book returned the morning after it was
   * due does not generate a bill.
   */
  fineGraceDays: 1,

  /** Once a hold is ready, how long the member has to collect it. */
  holdPickupDays: 7,

  /** Unpaid fines above this block further borrowing. */
  borrowingBlockedAboveCents: 500,

  /** How many days before the due date a reminder is sent. */
  dueSoonReminderDays: 2,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/**
 * Whole days from `a` to `b`, floored. Negative when b precedes a.
 *
 * Deliberately calendar-naive: it counts elapsed 24-hour periods rather than
 * date boundaries. For fines that is the fairer reading — a book due at 09:00
 * and returned at 23:00 the same day is not a day late.
 */
export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / DAY_MS);
}

export function dueDateFor(checkedOutAt: Date): Date {
  return addDays(checkedOutAt, POLICY.loanPeriodDays);
}

export function renewedDueDate(currentDueAt: Date, now: Date): Date {
  // Renewing an already-overdue loan extends from today, not from the date it
  // should have come back — otherwise a member could renew a month late and
  // immediately be in credit.
  const base = currentDueAt.getTime() > now.getTime() ? currentDueAt : now;
  return addDays(base, POLICY.renewalPeriodDays);
}

export function isOverdue(dueAt: Date, now: Date): boolean {
  return dueAt.getTime() < now.getTime();
}

/**
 * Fine owed for an item returned (or still out) at `asOf`.
 *
 * Applies the grace period first, then the daily rate, then the per-loan cap.
 */
export function fineCentsFor(dueAt: Date, asOf: Date): number {
  const daysLate = daysBetween(dueAt, asOf);
  const chargeableDays = daysLate - POLICY.fineGraceDays;

  if (chargeableDays <= 0) return 0;

  return Math.min(
    chargeableDays * POLICY.fineCentsPerDay,
    POLICY.maxFineCentsPerLoan,
  );
}

export function holdExpiryFrom(readyAt: Date): Date {
  return addDays(readyAt, POLICY.holdPickupDays);
}

/** Formats integer cents for display. Money is never a float here. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Reasons a checkout can be refused.
 *
 * A discriminated set rather than booleans, so the caller can say *why* — v2's
 * habit of collapsing every failure into a redirect is the thing being avoided.
 */
export type CheckoutRefusal =
  | { kind: "COPY_UNAVAILABLE"; status: string }
  | { kind: "MEMBER_SUSPENDED" }
  | { kind: "LOAN_LIMIT_REACHED"; limit: number }
  | { kind: "FINES_OUTSTANDING"; owedCents: number }
  | { kind: "RESERVED_FOR_ANOTHER_MEMBER" };

export type RenewalRefusal =
  | { kind: "ALREADY_RETURNED" }
  | { kind: "RENEWAL_LIMIT_REACHED"; limit: number }
  | { kind: "HOLDS_QUEUED"; waiting: number };

export interface MemberStanding {
  suspended: boolean;
  openLoanCount: number;
  unpaidFineCents: number;
}

export function checkoutRefusal(
  standing: MemberStanding,
  copyStatus: string,
  options: { reservedForOther: boolean } = { reservedForOther: false },
): CheckoutRefusal | null {
  if (standing.suspended) return { kind: "MEMBER_SUSPENDED" };

  if (copyStatus !== "AVAILABLE" && copyStatus !== "HOLD_SHELF") {
    return { kind: "COPY_UNAVAILABLE", status: copyStatus };
  }

  if (options.reservedForOther) {
    return { kind: "RESERVED_FOR_ANOTHER_MEMBER" };
  }

  if (standing.openLoanCount >= POLICY.maxConcurrentLoans) {
    return { kind: "LOAN_LIMIT_REACHED", limit: POLICY.maxConcurrentLoans };
  }

  if (standing.unpaidFineCents > POLICY.borrowingBlockedAboveCents) {
    return { kind: "FINES_OUTSTANDING", owedCents: standing.unpaidFineCents };
  }

  return null;
}

export function renewalRefusal(
  loan: { returnedAt: Date | null; renewalCount: number },
  waitingHolds: number,
): RenewalRefusal | null {
  if (loan.returnedAt !== null) return { kind: "ALREADY_RETURNED" };

  if (loan.renewalCount >= POLICY.maxRenewals) {
    return { kind: "RENEWAL_LIMIT_REACHED", limit: POLICY.maxRenewals };
  }

  // Someone waiting outranks someone wanting to keep it longer.
  if (waitingHolds > 0) {
    return { kind: "HOLDS_QUEUED", waiting: waitingHolds };
  }

  return null;
}

/** Turns a refusal into a sentence for the desk. */
export function explainCheckoutRefusal(refusal: CheckoutRefusal): string {
  switch (refusal.kind) {
    case "COPY_UNAVAILABLE":
      return `That copy is not available for loan (status: ${refusal.status.toLowerCase().replace(/_/g, " ")}).`;
    case "MEMBER_SUSPENDED":
      return "This member's borrowing privileges are suspended.";
    case "LOAN_LIMIT_REACHED":
      return `This member already has ${refusal.limit} items on loan, which is the limit.`;
    case "FINES_OUTSTANDING":
      return `This member owes ${formatCents(refusal.owedCents)} in unpaid fines and cannot borrow until that is settled.`;
    case "RESERVED_FOR_ANOTHER_MEMBER":
      return "That copy is on the hold shelf for a different member.";
  }
}

export function explainRenewalRefusal(refusal: RenewalRefusal): string {
  switch (refusal.kind) {
    case "ALREADY_RETURNED":
      return "That loan has already been closed.";
    case "RENEWAL_LIMIT_REACHED":
      return `This loan has already been renewed ${refusal.limit} times.`;
    case "HOLDS_QUEUED":
      return `${refusal.waiting} ${refusal.waiting === 1 ? "member is" : "members are"} waiting for this title, so it cannot be renewed.`;
  }
}
