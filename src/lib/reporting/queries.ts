import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { addDays } from "@/lib/circulation/policy";
import { db } from "@/lib/db";

/**
 * Reporting queries.
 *
 * Aggregation happens in Postgres, not in JavaScript. The temptation with an
 * ORM is to pull rows and reduce them in the application, which works on seed
 * data and falls over on real volume. `groupBy`, `aggregate`, and a couple of
 * raw queries keep the work where the data is.
 */

export interface Overview {
  titles: number;
  copies: number;
  members: number;
  openLoans: number;
  overdueLoans: number;
  waitingHolds: number;
  readyHolds: number;
  unpaidFineCents: number;
  loansLast30Days: number;
  newMembersLast30Days: number;
  pendingNotifications: number;
}

export async function getOverview(now = new Date()): Promise<Overview> {
  const thirtyDaysAgo = addDays(now, -30);

  const [
    titles,
    copies,
    members,
    openLoans,
    overdueLoans,
    waitingHolds,
    readyHolds,
    fines,
    loansLast30Days,
    newMembersLast30Days,
    pendingNotifications,
  ] = await Promise.all([
    db.book.count(),
    db.bookCopy.count(),
    db.user.count({ where: { role: "MEMBER" } }),
    db.loan.count({ where: { returnedAt: null } }),
    db.loan.count({ where: { returnedAt: null, dueAt: { lt: now } } }),
    db.hold.count({ where: { status: "WAITING" } }),
    db.hold.count({ where: { status: "READY" } }),
    db.fine.aggregate({
      where: { paidAt: null, waivedAt: null },
      _sum: { amountCents: true },
    }),
    db.loan.count({ where: { checkedOutAt: { gte: thirtyDaysAgo } } }),
    db.user.count({
      where: { role: "MEMBER", createdAt: { gte: thirtyDaysAgo } },
    }),
    db.notification.count({ where: { sentAt: null } }),
  ]);

  return {
    titles,
    copies,
    members,
    openLoans,
    overdueLoans,
    waitingHolds,
    readyHolds,
    unpaidFineCents: fines._sum.amountCents ?? 0,
    loansLast30Days,
    newMembersLast30Days,
    pendingNotifications,
  };
}

/**
 * Most-borrowed titles over a window.
 *
 * `groupBy` on the join then a second query for the titles, rather than
 * fetching every loan and counting in memory.
 */
export async function getMostBorrowed({
  since,
  limit = 10,
}: {
  since: Date;
  limit?: number;
}): Promise<{ id: string; title: string; loanCount: number }[]> {
  const grouped = await db.loan.groupBy({
    by: ["copyId"],
    where: { checkedOutAt: { gte: since } },
    _count: { copyId: true },
  });

  if (grouped.length === 0) return [];

  // Loans are per copy; borrowing is per title, so roll copies up to books.
  const copies = await db.bookCopy.findMany({
    where: { id: { in: grouped.map((g) => g.copyId) } },
    select: { id: true, bookId: true },
  });
  const bookIdByCopy = new Map(copies.map((c) => [c.id, c.bookId]));

  const countByBook = new Map<string, number>();
  for (const group of grouped) {
    const bookId = bookIdByCopy.get(group.copyId);
    if (!bookId) continue;
    countByBook.set(
      bookId,
      (countByBook.get(bookId) ?? 0) + group._count.copyId,
    );
  }

  const books = await db.book.findMany({
    where: { id: { in: [...countByBook.keys()] } },
    select: { id: true, title: true },
  });

  return books
    .map((book) => ({
      id: book.id,
      title: book.title,
      loanCount: countByBook.get(book.id) ?? 0,
    }))
    .sort((a, b) => b.loanCount - a.loanCount || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/** Copy status breakdown, for a sense of where the stock actually is. */
export async function getCopyStatusBreakdown() {
  const grouped = await db.bookCopy.groupBy({
    by: ["status"],
    _count: { status: true },
  });

  return grouped
    .map((g) => ({ status: g.status, count: g._count.status }))
    .sort((a, b) => b.count - a.count);
}

interface DayRow {
  day: Date;
  count: bigint;
}

/**
 * Loans per day over the last `days` days, with zero-filled gaps.
 *
 * `generate_series` does the zero-filling in SQL. Doing it in JavaScript means
 * building a date loop and reconciling timezones, which is exactly the sort of
 * thing that produces off-by-one-day bugs.
 */
export async function getLoansPerDay(
  days = 30,
): Promise<{ day: string; count: number }[]> {
  const rows = await db.$queryRaw<DayRow[]>(Prisma.sql`
    SELECT d.day::date AS day,
           COUNT(l.id)::bigint AS count
    FROM generate_series(
           (CURRENT_DATE - (${days - 1}::int) * INTERVAL '1 day'),
           CURRENT_DATE,
           INTERVAL '1 day'
         ) AS d(day)
    LEFT JOIN "Loan" l
      ON date_trunc('day', l."checkedOutAt") = d.day
    GROUP BY d.day
    ORDER BY d.day ASC
  `);

  return rows.map((row) => ({
    day: row.day.toISOString().slice(0, 10),
    count: Number(row.count),
  }));
}

/** Members with the most outstanding owed, for chasing up. */
export async function getMembersOwing(limit = 10) {
  const grouped = await db.fine.groupBy({
    by: ["loanId"],
    where: { paidAt: null, waivedAt: null },
    _sum: { amountCents: true },
  });

  if (grouped.length === 0) return [];

  const loans = await db.loan.findMany({
    where: { id: { in: grouped.map((g) => g.loanId) } },
    select: { id: true, member: { select: { id: true, name: true } } },
  });
  const memberByLoan = new Map(loans.map((l) => [l.id, l.member]));

  const owed = new Map<string, { name: string; cents: number }>();
  for (const group of grouped) {
    const member = memberByLoan.get(group.loanId);
    if (!member) continue;
    const existing = owed.get(member.id);
    owed.set(member.id, {
      name: member.name,
      cents: (existing?.cents ?? 0) + (group._sum.amountCents ?? 0),
    });
  }

  return [...owed.entries()]
    .map(([id, value]) => ({ id, name: value.name, owedCents: value.cents }))
    .sort((a, b) => b.owedCents - a.owedCents)
    .slice(0, limit);
}
