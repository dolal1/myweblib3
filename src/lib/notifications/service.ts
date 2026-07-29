import "server-only";

import { POLICY, addDays, formatCents } from "@/lib/circulation/policy";
import { expireStaleHolds } from "@/lib/circulation/service";
import { pruneExpiredSessions } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { isUniqueViolation } from "@/lib/db-errors";
import { env } from "@/lib/env";

/**
 * Scheduled notifications.
 *
 * Idempotency is the whole design problem here. A cron job gets retried, run
 * twice by two instances, or fired manually by someone testing — and none of
 * those may email a member twice about the same overdue book.
 *
 * The mechanism is the `dedupeKey` unique index on Notification. Every message
 * derives a key from what it is about *and the day it covers*, so a re-run
 * collides on the index instead of sending again. That is a database guarantee
 * rather than a "check then insert", which would race between two instances
 * exactly as v2's registration check did.
 */

export interface JobSummary {
  dueSoon: number;
  overdue: number;
  holdsExpired: number;
  sessionsPruned: number;
  skippedAsDuplicate: number;
}

/** yyyy-mm-dd in UTC, so the key is stable regardless of server timezone. */
function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Records a notification, or does nothing if this exact message was already
 * recorded. Returns whether it was newly created.
 */
async function record(notification: {
  userId: string;
  kind: "DUE_SOON" | "OVERDUE" | "HOLD_READY";
  dedupeKey: string;
  subject: string;
  body: string;
}): Promise<boolean> {
  try {
    await db.notification.create({ data: notification });
    return true;
  } catch (error) {
    // Already sent. This is the expected outcome of a re-run, not an error.
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export async function runDailyJob(now = new Date()): Promise<JobSummary> {
  const summary: JobSummary = {
    dueSoon: 0,
    overdue: 0,
    holdsExpired: 0,
    sessionsPruned: 0,
    skippedAsDuplicate: 0,
  };

  // --- Due soon -----------------------------------------------------------
  // A window, not a single day: if the job misses a run, the next one still
  // catches everything inside the reminder period.
  const dueSoonCutoff = addDays(now, POLICY.dueSoonReminderDays);

  const dueSoon = await db.loan.findMany({
    where: {
      returnedAt: null,
      dueAt: { gte: now, lte: dueSoonCutoff },
    },
    select: {
      id: true,
      dueAt: true,
      member: { select: { id: true, name: true } },
      copy: { select: { book: { select: { title: true } } } },
    },
  });

  for (const loan of dueSoon) {
    const created = await record({
      userId: loan.member.id,
      kind: "DUE_SOON",
      // Keyed on the due date rather than today: one reminder per loan per due
      // date, however many times the job runs.
      dedupeKey: `due-soon:${loan.id}:${dayStamp(loan.dueAt)}`,
      subject: `Due soon: ${loan.copy.book.title}`,
      body:
        `Hello ${loan.member.name},\n\n` +
        `“${loan.copy.book.title}” is due back on ` +
        `${dayStamp(loan.dueAt)}.\n\n` +
        `You can renew it at ${env.APP_URL}/account if nobody is waiting.\n`,
    });
    if (created) summary.dueSoon += 1;
    else summary.skippedAsDuplicate += 1;
  }

  // --- Overdue ------------------------------------------------------------
  const overdue = await db.loan.findMany({
    where: { returnedAt: null, dueAt: { lt: now } },
    select: {
      id: true,
      dueAt: true,
      member: { select: { id: true, name: true } },
      copy: { select: { book: { select: { title: true } } } },
    },
  });

  for (const loan of overdue) {
    const daysLate = Math.floor(
      (now.getTime() - loan.dueAt.getTime()) / 86_400_000,
    );
    const accrued = Math.min(
      Math.max(0, daysLate - POLICY.fineGraceDays) * POLICY.fineCentsPerDay,
      POLICY.maxFineCentsPerLoan,
    );

    const created = await record({
      userId: loan.member.id,
      kind: "OVERDUE",
      // Keyed on today, so an item that stays out generates one notice per day
      // rather than one ever — but still only one per day per run.
      dedupeKey: `overdue:${loan.id}:${dayStamp(now)}`,
      subject: `Overdue: ${loan.copy.book.title}`,
      body:
        `Hello ${loan.member.name},\n\n` +
        `“${loan.copy.book.title}” was due on ${dayStamp(loan.dueAt)} and is ` +
        `${daysLate} ${daysLate === 1 ? "day" : "days"} overdue.\n\n` +
        (accrued > 0
          ? `A fine of ${formatCents(accrued)} will be charged on return.\n\n`
          : `It is still within the grace period, so no fine yet.\n\n`) +
        `Please return it to the library.\n`,
    });
    if (created) summary.overdue += 1;
    else summary.skippedAsDuplicate += 1;
  }

  // --- Housekeeping -------------------------------------------------------
  summary.holdsExpired = await expireStaleHolds(now);
  summary.sessionsPruned = await pruneExpiredSessions();

  return summary;
}

/**
 * Notifies a member that a hold is ready. Called from the return path rather
 * than the daily job, because a hold becoming available is worth knowing about
 * immediately.
 */
export async function notifyHoldReady({
  holdId,
}: {
  holdId: string;
}): Promise<boolean> {
  const hold = await db.hold.findUnique({
    where: { id: holdId },
    select: {
      id: true,
      expiresAt: true,
      member: { select: { id: true, name: true } },
      book: { select: { title: true } },
    },
  });
  if (!hold) return false;

  return record({
    userId: hold.member.id,
    kind: "HOLD_READY",
    dedupeKey: `hold-ready:${hold.id}`,
    subject: `Ready to collect: ${hold.book.title}`,
    body:
      `Hello ${hold.member.name},\n\n` +
      `“${hold.book.title}” is waiting for you at the library` +
      (hold.expiresAt ? ` until ${dayStamp(hold.expiresAt)}` : "") +
      `.\n`,
  });
}

/**
 * Pending notifications, oldest first.
 *
 * Delivery is deliberately not implemented: wiring a real email provider would
 * mean an API key in the environment and an account to manage, which is a poor
 * trade for a project someone should be able to clone and run. Messages are
 * recorded, visible in the admin dashboard, and marked sent by
 * markNotificationsSent — so the seam an SMTP or Resend call would slot into is
 * there and tested, without the dependency.
 */
export async function pendingNotifications(limit = 50) {
  return db.notification.findMany({
    where: { sentAt: null },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      kind: true,
      subject: true,
      body: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
    },
  });
}

export async function markNotificationsSent(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { count } = await db.notification.updateMany({
    where: { id: { in: ids }, sentAt: null },
    data: { sentAt: new Date() },
  });
  return count;
}
