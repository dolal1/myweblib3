import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/ui";
import { requireRole } from "@/lib/auth/dal";
import { addDays, formatCents } from "@/lib/circulation/policy";
import {
  getCopyStatusBreakdown,
  getLoansPerDay,
  getMembersOwing,
  getMostBorrowed,
  getOverview,
} from "@/lib/reporting/queries";

export const metadata: Metadata = { title: "Reports" };

const STATUS_LABEL: Record<string, string> = {
  AVAILABLE: "On shelf",
  ON_LOAN: "On loan",
  HOLD_SHELF: "Hold shelf",
  LOST: "Lost",
  WITHDRAWN: "Withdrawn",
};

export default async function AdminPage() {
  // ADMIN only, unlike the desk which librarians reach.
  await requireRole("ADMIN");

  const now = new Date();
  const [overview, mostBorrowed, statuses, perDay, owing] = await Promise.all([
    getOverview(now),
    getMostBorrowed({ since: addDays(now, -30) }),
    getCopyStatusBreakdown(),
    getLoansPerDay(30),
    getMembersOwing(),
  ]);

  const peak = Math.max(1, ...perDay.map((d) => d.count));

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <PageHeader
        title="Reports"
        subtitle="Aggregated in Postgres, read at request time."
      />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Titles" value={overview.titles} />
        <Stat label="Copies" value={overview.copies} />
        <Stat label="Members" value={overview.members} />
        <Stat label="On loan" value={overview.openLoans} />
        <Stat
          label="Overdue"
          value={overview.overdueLoans}
          tone={overview.overdueLoans > 0 ? "warn" : "normal"}
        />
        <Stat label="Holds waiting" value={overview.waitingHolds} />
        <Stat label="Awaiting collection" value={overview.readyHolds} />
        <Stat
          label="Unpaid fines"
          value={formatCents(overview.unpaidFineCents)}
          tone={overview.unpaidFineCents > 0 ? "warn" : "normal"}
        />
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Loans per day</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Last 30 days · {overview.loansLast30Days} total ·{" "}
          {overview.newMembersLast30Days} new members
        </p>

        {/* A CSS bar chart. No charting library, no client JavaScript, and it
            works with images and scripts disabled. */}
        <ol
          className="mt-4 flex h-32 items-end gap-px"
          aria-label="Loans per day for the last 30 days"
        >
          {perDay.map((day) => (
            <li
              key={day.day}
              className="flex-1"
              style={{ height: `${Math.max(2, (day.count / peak) * 100)}%` }}
              title={`${day.day}: ${day.count} ${day.count === 1 ? "loan" : "loans"}`}
            >
              <div
                className={`h-full w-full rounded-t ${
                  day.count > 0
                    ? "bg-slate-800 dark:bg-slate-300"
                    : "bg-slate-200 dark:bg-slate-800"
                }`}
              />
            </li>
          ))}
        </ol>
        <div className="mt-1 flex justify-between text-xs text-slate-400">
          <span>{perDay[0]?.day}</span>
          <span>peak {peak}</span>
          <span>{perDay.at(-1)?.day}</span>
        </div>
      </section>

      <div className="mt-10 grid gap-8 sm:grid-cols-2">
        <section>
          <h2 className="text-lg font-semibold">Most borrowed</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Last 30 days, counted per title rather than per copy.
          </p>
          {mostBorrowed.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No loans yet.</p>
          ) : (
            <ol className="mt-3 space-y-1 text-sm">
              {mostBorrowed.map((book, index) => (
                <li key={book.id} className="flex justify-between gap-3">
                  <span className="truncate">
                    <span className="text-slate-400">{index + 1}. </span>
                    <Link href={`/books/${book.id}`} className="underline">
                      {book.title}
                    </Link>
                  </span>
                  <span className="shrink-0 text-slate-500 tabular-nums">
                    {book.loanCount}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section>
          <h2 className="text-lg font-semibold">Where the stock is</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Every copy, by status.
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {statuses.map((row) => (
              <li key={row.status} className="flex justify-between gap-3">
                <span>{STATUS_LABEL[row.status] ?? row.status}</span>
                <span className="text-slate-500 tabular-nums">{row.count}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {owing.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Members owing</h2>
          <ul className="mt-3 space-y-1 text-sm">
            {owing.map((member) => (
              <li key={member.id} className="flex justify-between gap-3">
                <span>{member.name}</span>
                <span className="tabular-nums">
                  {formatCents(member.owedCents)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-10 rounded-lg border border-slate-200 p-4 text-sm dark:border-slate-800">
        <h2 className="font-semibold">Notification queue</h2>
        <p className="mt-1 text-slate-600 dark:text-slate-400">
          {overview.pendingNotifications} pending.
        </p>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Messages are recorded by the daily job at{" "}
          <code>POST /api/jobs/daily</code>, which is idempotent — a re-run
          collides on a unique key rather than notifying twice. Email delivery
          is a deliberate no-op; see the note in{" "}
          <code>lib/notifications/service.ts</code>.
        </p>
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  tone = "normal",
}: {
  label: string;
  value: number | string;
  tone?: "normal" | "warn";
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd
        className={`mt-1 text-xl font-semibold tabular-nums ${
          tone === "warn" ? "text-amber-700 dark:text-amber-400" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
