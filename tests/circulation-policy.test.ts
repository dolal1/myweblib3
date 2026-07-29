import { describe, expect, it } from "vitest";

import {
  POLICY,
  addDays,
  checkoutRefusal,
  daysBetween,
  dueDateFor,
  explainCheckoutRefusal,
  fineCentsFor,
  formatCents,
  holdExpiryFrom,
  isOverdue,
  renewalRefusal,
  renewedDueDate,
  type MemberStanding,
} from "@/lib/circulation/policy";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-06-01T09:00:00Z");

const standing = (overrides: Partial<MemberStanding> = {}): MemberStanding => ({
  suspended: false,
  openLoanCount: 0,
  unpaidFineCents: 0,
  ...overrides,
});

describe("dates", () => {
  it("sets the due date one loan period out", () => {
    expect(dueDateFor(T0).getTime()).toBe(
      T0.getTime() + POLICY.loanPeriodDays * DAY,
    );
  });

  it("counts whole elapsed days, floored", () => {
    expect(daysBetween(T0, addDays(T0, 3))).toBe(3);
    // 23 hours late is not yet a day late.
    expect(daysBetween(T0, new Date(T0.getTime() + 23 * 3600_000))).toBe(0);
    expect(daysBetween(addDays(T0, 3), T0)).toBe(-3);
  });

  it("reports overdue strictly after the due moment", () => {
    const due = dueDateFor(T0);
    expect(isOverdue(due, new Date(due.getTime() - 1))).toBe(false);
    expect(isOverdue(due, due)).toBe(false);
    expect(isOverdue(due, new Date(due.getTime() + 1))).toBe(true);
  });
});

describe("fineCentsFor", () => {
  const due = dueDateFor(T0);

  it("charges nothing before the due date", () => {
    expect(fineCentsFor(due, new Date(due.getTime() - DAY))).toBe(0);
  });

  it("charges nothing within the grace period", () => {
    // A book returned the morning after it was due should not generate a bill.
    expect(fineCentsFor(due, addDays(due, POLICY.fineGraceDays))).toBe(0);
  });

  it("charges the daily rate once past grace", () => {
    const asOf = addDays(due, POLICY.fineGraceDays + 3);
    expect(fineCentsFor(due, asOf)).toBe(3 * POLICY.fineCentsPerDay);
  });

  it("caps the fine per loan", () => {
    // Two years late should not produce a five-figure invoice.
    expect(fineCentsFor(due, addDays(due, 730))).toBe(
      POLICY.maxFineCentsPerLoan,
    );
  });

  it("only ever returns whole non-negative cents", () => {
    for (const days of [-5, 0, 1, 2, 7, 30, 400]) {
      const value = fineCentsFor(due, addDays(due, days));
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      // Must satisfy the Fine_amount_non_negative check constraint.
    }
  });
});

describe("renewedDueDate", () => {
  it("extends from the current due date when not yet overdue", () => {
    const due = addDays(T0, 5);
    expect(renewedDueDate(due, T0).getTime()).toBe(
      due.getTime() + POLICY.renewalPeriodDays * DAY,
    );
  });

  it("extends from today when already overdue", () => {
    // Otherwise renewing a month late would put the member in credit.
    const due = addDays(T0, -30);
    expect(renewedDueDate(due, T0).getTime()).toBe(
      T0.getTime() + POLICY.renewalPeriodDays * DAY,
    );
  });
});

describe("checkoutRefusal", () => {
  it("permits a clean checkout of an available copy", () => {
    expect(checkoutRefusal(standing(), "AVAILABLE")).toBeNull();
  });

  it("refuses a suspended member", () => {
    const refusal = checkoutRefusal(standing({ suspended: true }), "AVAILABLE");
    expect(refusal?.kind).toBe("MEMBER_SUSPENDED");
  });

  it("refuses a copy that is not on the shelf", () => {
    for (const status of ["ON_LOAN", "LOST", "WITHDRAWN"]) {
      const refusal = checkoutRefusal(standing(), status);
      expect(refusal?.kind).toBe("COPY_UNAVAILABLE");
    }
  });

  it("allows collecting from the hold shelf", () => {
    expect(checkoutRefusal(standing(), "HOLD_SHELF")).toBeNull();
  });

  it("refuses a hold-shelf copy reserved for someone else", () => {
    const refusal = checkoutRefusal(standing(), "HOLD_SHELF", {
      reservedForOther: true,
    });
    expect(refusal?.kind).toBe("RESERVED_FOR_ANOTHER_MEMBER");
  });

  it("refuses at the concurrent loan limit", () => {
    expect(
      checkoutRefusal(
        standing({ openLoanCount: POLICY.maxConcurrentLoans - 1 }),
        "AVAILABLE",
      ),
    ).toBeNull();
    const refusal = checkoutRefusal(
      standing({ openLoanCount: POLICY.maxConcurrentLoans }),
      "AVAILABLE",
    );
    expect(refusal?.kind).toBe("LOAN_LIMIT_REACHED");
  });

  it("refuses above the outstanding-fine threshold, but not at it", () => {
    expect(
      checkoutRefusal(
        standing({ unpaidFineCents: POLICY.borrowingBlockedAboveCents }),
        "AVAILABLE",
      ),
    ).toBeNull();
    const refusal = checkoutRefusal(
      standing({ unpaidFineCents: POLICY.borrowingBlockedAboveCents + 1 }),
      "AVAILABLE",
    );
    expect(refusal?.kind).toBe("FINES_OUTSTANDING");
  });

  it("checks suspension before anything else", () => {
    // A suspended member should hear about the suspension, not the copy.
    const refusal = checkoutRefusal(
      standing({ suspended: true, openLoanCount: 99 }),
      "LOST",
    );
    expect(refusal?.kind).toBe("MEMBER_SUSPENDED");
  });

  it("explains every refusal kind in prose", () => {
    const refusals = [
      { kind: "COPY_UNAVAILABLE", status: "ON_LOAN" },
      { kind: "MEMBER_SUSPENDED" },
      { kind: "LOAN_LIMIT_REACHED", limit: 5 },
      { kind: "FINES_OUTSTANDING", owedCents: 750 },
      { kind: "RESERVED_FOR_ANOTHER_MEMBER" },
    ] as const;

    for (const refusal of refusals) {
      const message = explainCheckoutRefusal(refusal);
      expect(message.length).toBeGreaterThan(10);
      // The point of the refusal type is that the desk gets a real sentence,
      // rather than v2's silent redirect to "/".
      expect(message).toMatch(/[.!]$/);
    }
  });
});

describe("renewalRefusal", () => {
  const open = { returnedAt: null, renewalCount: 0 };

  it("permits renewal of an open loan with nobody waiting", () => {
    expect(renewalRefusal(open, 0)).toBeNull();
  });

  it("refuses a closed loan", () => {
    expect(renewalRefusal({ ...open, returnedAt: new Date() }, 0)?.kind).toBe(
      "ALREADY_RETURNED",
    );
  });

  it("refuses at the renewal cap", () => {
    expect(
      renewalRefusal({ ...open, renewalCount: POLICY.maxRenewals - 1 }, 0),
    ).toBeNull();
    expect(
      renewalRefusal({ ...open, renewalCount: POLICY.maxRenewals }, 0)?.kind,
    ).toBe("RENEWAL_LIMIT_REACHED");
  });

  it("refuses when anyone is waiting", () => {
    // Someone in the queue outranks someone wanting to keep it longer.
    expect(renewalRefusal(open, 1)?.kind).toBe("HOLDS_QUEUED");
  });
});

describe("holdExpiryFrom", () => {
  it("gives the member the pickup window", () => {
    expect(holdExpiryFrom(T0).getTime()).toBe(
      T0.getTime() + POLICY.holdPickupDays * DAY,
    );
  });
});

describe("formatCents", () => {
  it("formats whole and part dollars", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(225)).toBe("$2.25");
    expect(formatCents(2000)).toBe("$20.00");
  });

  it("handles negatives without mangling the cents", () => {
    expect(formatCents(-225)).toBe("-$2.25");
  });

  it("never produces floating point artefacts", () => {
    // The reason amountCents is an integer: 0.1 + 0.2 has no business near a
    // member's balance.
    for (let cents = 0; cents < 1000; cents += 7) {
      expect(formatCents(cents)).toMatch(/^\$\d+\.\d{2}$/);
    }
  });
});

describe("policy sanity", () => {
  it("keeps the numbers internally coherent", () => {
    // Guards against a well-meaning edit that makes the policy nonsensical.
    expect(POLICY.loanPeriodDays).toBeGreaterThan(0);
    expect(POLICY.maxRenewals).toBeGreaterThanOrEqual(0);
    expect(POLICY.fineCentsPerDay).toBeGreaterThan(0);
    expect(POLICY.maxFineCentsPerLoan).toBeGreaterThan(POLICY.fineCentsPerDay);
    expect(POLICY.holdPickupDays).toBeGreaterThan(0);
    expect(POLICY.dueSoonReminderDays).toBeLessThan(POLICY.loanPeriodDays);
    expect(Number.isInteger(POLICY.fineCentsPerDay)).toBe(true);
    expect(Number.isInteger(POLICY.maxFineCentsPerLoan)).toBe(true);
  });
});
