import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { POLICY, addDays } from "@/lib/circulation/policy";
import { db } from "@/lib/db";
import {
  markNotificationsSent,
  notifyHoldReady,
  pendingNotifications,
  runDailyJob,
} from "@/lib/notifications/service";

/**
 * The daily job, against a real database.
 *
 * Idempotency is the claim worth testing hardest. A cron endpoint gets retried,
 * run by two instances at once, and poked by hand — and none of that may email
 * someone twice about the same overdue book. The guarantee is the dedupeKey
 * unique index, so it can only be verified here.
 */

const PREFIX = "notif-";

async function cleanup() {
  await db.notification.deleteMany({
    where: { user: { email: { startsWith: PREFIX } } },
  });
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

/** Creates a member holding one loan, due `dueInDays` from now. */
async function loanDue(dueInDays: number, suffix = "0") {
  const author = await db.author.create({
    data: { name: `${PREFIX}a${suffix}`, sortName: `${PREFIX}a${suffix}` },
  });
  const book = await db.book.create({
    data: {
      title: `${PREFIX}book${suffix}`,
      authors: { create: [{ authorId: author.id, role: "AUTHOR" }] },
    },
  });
  const copy = await db.bookCopy.create({
    data: { barcode: `${PREFIX}${suffix}`, bookId: book.id, status: "ON_LOAN" },
  });
  const member = await db.user.create({
    data: {
      email: `${PREFIX}m${suffix}@test`,
      name: `Member ${suffix}`,
      passwordHash: "x",
    },
  });

  const now = new Date();
  const loan = await db.loan.create({
    data: {
      copyId: copy.id,
      memberId: member.id,
      // checkedOutAt must precede dueAt (Loan_due_after_checkout).
      checkedOutAt: addDays(now, dueInDays - POLICY.loanPeriodDays),
      dueAt: addDays(now, dueInDays),
    },
  });

  return { loan, member, book, copy };
}

const notificationsFor = (userId: string) =>
  db.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe("runDailyJob — overdue", () => {
  it("records one overdue notice for an overdue loan", async () => {
    const { member } = await loanDue(-5);

    const summary = await runDailyJob();
    expect(summary.overdue).toBeGreaterThanOrEqual(1);

    const notes = await notificationsFor(member.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe("OVERDUE");
    expect(notes[0]?.subject).toContain(`${PREFIX}book0`);
  });

  it("does not notify twice when run twice on the same day", async () => {
    // The test the plan asked for: a re-run must not double-notify.
    const { member } = await loanDue(-5);

    await runDailyJob();
    const second = await runDailyJob();

    expect(await notificationsFor(member.id)).toHaveLength(1);
    expect(second.skippedAsDuplicate).toBeGreaterThanOrEqual(1);
    expect(second.overdue).toBe(0);
  });

  it("does not double-notify when two runs race", async () => {
    // Two instances firing at once. The unique index decides, not a
    // check-then-insert.
    const { member } = await loanDue(-5);

    await Promise.all([runDailyJob(), runDailyJob(), runDailyJob()]);

    expect(await notificationsFor(member.id)).toHaveLength(1);
  });

  it("notifies again on a later day", async () => {
    const { member } = await loanDue(-5);

    await runDailyJob();
    // Same loan, next day: the key includes the day, so this is a new notice.
    await runDailyJob(addDays(new Date(), 1));

    expect(await notificationsFor(member.id)).toHaveLength(2);
  });

  it("states the accrued fine once past the grace period", async () => {
    const daysLate = POLICY.fineGraceDays + 4;
    const { member } = await loanDue(-daysLate);

    await runDailyJob();
    const notes = await notificationsFor(member.id);
    const expected = 4 * POLICY.fineCentsPerDay;
    expect(notes[0]?.body).toContain(
      `$${Math.floor(expected / 100)}.${String(expected % 100).padStart(2, "0")}`,
    );
  });

  it("says no fine yet while inside the grace period", async () => {
    const { member } = await loanDue(-POLICY.fineGraceDays);
    await runDailyJob();
    const notes = await notificationsFor(member.id);
    expect(notes[0]?.body).toMatch(/grace period/i);
  });

  it("ignores loans that have been returned", async () => {
    const { loan, member } = await loanDue(-5);
    await db.loan.update({
      where: { id: loan.id },
      data: { returnedAt: new Date() },
    });

    await runDailyJob();
    expect(await notificationsFor(member.id)).toHaveLength(0);
  });
});

describe("runDailyJob — due soon", () => {
  it("reminds about a loan inside the reminder window", async () => {
    const { member } = await loanDue(POLICY.dueSoonReminderDays - 1);

    await runDailyJob();
    const notes = await notificationsFor(member.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe("DUE_SOON");
  });

  it("says nothing about a loan due beyond the window", async () => {
    const { member } = await loanDue(POLICY.dueSoonReminderDays + 5);
    await runDailyJob();
    expect(await notificationsFor(member.id)).toHaveLength(0);
  });

  it("sends one reminder per loan however often it runs", async () => {
    // Due far enough out that it stays inside the reminder window for both
    // runs. Using `dueSoonReminderDays - 1` here made the loan tip into overdue
    // between them — the second run's clock is a few milliseconds past the due
    // moment — and produced a legitimate second notice of a different kind,
    // which is correct behaviour but not what this test is about.
    const { member } = await loanDue(POLICY.dueSoonReminderDays);

    await runDailyJob();
    await runDailyJob(addDays(new Date(), 1));

    // Keyed on the due date, not the run date: one reminder, not one a day.
    const notes = await notificationsFor(member.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe("DUE_SOON");
  });

  it("switches from reminder to overdue notice once the due date passes", async () => {
    const { member } = await loanDue(1);

    await runDailyJob();
    // Two days later the same loan is overdue, and gets a notice saying so.
    await runDailyJob(addDays(new Date(), 2));

    const kinds = (await notificationsFor(member.id)).map((n) => n.kind);
    expect(kinds).toEqual(["DUE_SOON", "OVERDUE"]);
  });

  it("does not send both a reminder and an overdue notice for one loan", async () => {
    const { member } = await loanDue(-3);
    await runDailyJob();
    const notes = await notificationsFor(member.id);
    expect(notes.map((n) => n.kind)).toEqual(["OVERDUE"]);
  });
});

describe("runDailyJob — housekeeping", () => {
  it("reports counts for every task it performs", async () => {
    const summary = await runDailyJob();
    for (const key of [
      "dueSoon",
      "overdue",
      "holdsExpired",
      "sessionsPruned",
      "skippedAsDuplicate",
    ] as const) {
      expect(typeof summary[key]).toBe("number");
      expect(summary[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it("prunes an expired session", async () => {
    const member = await db.user.create({
      data: {
        email: `${PREFIX}sess@test`,
        name: "Sess",
        passwordHash: "x",
      },
    });
    await db.session.create({
      data: {
        id: "f".repeat(64),
        userId: member.id,
        expiresAt: addDays(new Date(), -1),
      },
    });

    const summary = await runDailyJob();
    expect(summary.sessionsPruned).toBeGreaterThanOrEqual(1);
    await expect(
      db.session.count({ where: { userId: member.id } }),
    ).resolves.toBe(0);
  });
});

describe("notifyHoldReady", () => {
  it("records a collection notice once", async () => {
    const { book, member } = await loanDue(5, "h");
    const hold = await db.hold.create({
      data: {
        bookId: book.id,
        memberId: member.id,
        status: "READY",
        readyAt: new Date(),
        expiresAt: addDays(new Date(), POLICY.holdPickupDays),
      },
    });

    await expect(notifyHoldReady({ holdId: hold.id })).resolves.toBe(true);
    // Keyed on the hold id alone — a hold becomes ready once.
    await expect(notifyHoldReady({ holdId: hold.id })).resolves.toBe(false);

    const notes = (await notificationsFor(member.id)).filter(
      (n) => n.kind === "HOLD_READY",
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toContain(book.title);
  });

  it("returns false for a hold that does not exist", async () => {
    await expect(
      notifyHoldReady({ holdId: "019f0000-0000-7000-8000-000000000000" }),
    ).resolves.toBe(false);
  });
});

describe("delivery seam", () => {
  it("lists pending notifications and marks them sent", async () => {
    await loanDue(-5);
    await runDailyJob();

    const pending = await pendingNotifications();
    const mine = pending.filter((n) => n.user.email.startsWith(PREFIX));
    expect(mine.length).toBeGreaterThanOrEqual(1);

    const marked = await markNotificationsSent(mine.map((n) => n.id));
    expect(marked).toBe(mine.length);

    const stillPending = (await pendingNotifications()).filter((n) =>
      n.user.email.startsWith(PREFIX),
    );
    expect(stillPending).toHaveLength(0);

    // Marking again is a no-op rather than an error.
    await expect(markNotificationsSent(mine.map((n) => n.id))).resolves.toBe(0);
    await expect(markNotificationsSent([])).resolves.toBe(0);
  });

  it("keeps notifying about a still-overdue item after delivery", async () => {
    const { member } = await loanDue(-5);
    await runDailyJob();

    const pending = (await pendingNotifications()).filter(
      (n) => n.user.email === `${PREFIX}m0@test`,
    );
    await markNotificationsSent(pending.map((n) => n.id));

    // Tomorrow's run should still produce a fresh notice.
    await runDailyJob(addDays(new Date(), 1));
    expect(await notificationsFor(member.id)).toHaveLength(2);
  });
});
