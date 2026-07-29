import type { Metadata } from "next";
import Link from "next/link";

import { checkInAction, checkOutAction } from "@/app/actions/circulation";
import { DeskForm } from "@/components/desk-form";
import { PageHeader } from "@/components/ui";
import { requireRole } from "@/lib/auth/dal";
import { formatCents } from "@/lib/circulation/policy";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Circulation desk" };

export default async function DeskPage() {
  await requireRole("LIBRARIAN");

  const now = new Date();

  const [members, overdue, readyHolds, todayLoans] = await Promise.all([
    db.user.findMany({
      where: { role: "MEMBER" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true },
    }),
    db.loan.findMany({
      where: { returnedAt: null, dueAt: { lt: now } },
      orderBy: { dueAt: "asc" },
      take: 20,
      select: {
        id: true,
        dueAt: true,
        member: { select: { name: true } },
        copy: {
          select: {
            barcode: true,
            book: { select: { id: true, title: true } },
          },
        },
      },
    }),
    db.hold.findMany({
      where: { status: "READY" },
      orderBy: { readyAt: "asc" },
      take: 20,
      select: {
        id: true,
        expiresAt: true,
        member: { select: { name: true } },
        book: { select: { id: true, title: true } },
      },
    }),
    db.loan.count({
      where: { checkedOutAt: { gte: new Date(now.getTime() - 86_400_000) } },
    }),
  ]);

  const unpaidFines = await db.fine.aggregate({
    where: { paidAt: null, waivedAt: null },
    _sum: { amountCents: true },
  });

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <PageHeader
        title="Circulation desk"
        subtitle={`${todayLoans} items issued in the last 24 hours · ${formatCents(unpaidFines._sum.amountCents ?? 0)} in unpaid fines`}
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <DeskForm
          action={checkOutAction}
          title="Check out"
          description="Choose a member, then scan the item."
          members={members}
          submitLabel="Check out"
        />
        <DeskForm
          action={checkInAction}
          title="Return"
          description="Scan the item. Fines and holds are handled automatically."
          submitLabel="Return"
        />
      </div>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">
          Overdue{" "}
          <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
            ({overdue.length})
          </span>
        </h2>
        {overdue.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Nothing overdue.
          </p>
        ) : (
          <table className="mt-3 w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs text-slate-500 uppercase dark:border-slate-800">
              <tr>
                <th className="py-2 font-medium">Title</th>
                <th className="py-2 font-medium">Member</th>
                <th className="py-2 font-medium">Barcode</th>
                <th className="py-2 font-medium">Due</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {overdue.map((loan) => (
                <tr key={loan.id}>
                  <td className="py-2">
                    <Link
                      href={`/books/${loan.copy.book.id}`}
                      className="underline"
                    >
                      {loan.copy.book.title}
                    </Link>
                  </td>
                  <td className="py-2">{loan.member.name}</td>
                  <td className="py-2 font-mono text-xs">
                    {loan.copy.barcode}
                  </td>
                  <td className="py-2 text-red-700 tabular-nums dark:text-red-400">
                    {loan.dueAt.toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">
          On the hold shelf{" "}
          <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
            ({readyHolds.length})
          </span>
        </h2>
        {readyHolds.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Nothing waiting for collection.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
            {readyHolds.map((hold) => (
              <li key={hold.id} className="flex justify-between gap-4 py-2">
                <span>
                  <Link href={`/books/${hold.book.id}`} className="underline">
                    {hold.book.title}
                  </Link>
                  <span className="text-slate-500 dark:text-slate-400">
                    {" "}
                    for {hold.member.name}
                  </span>
                </span>
                <span className="shrink-0 text-slate-500 tabular-nums dark:text-slate-400">
                  until {hold.expiresAt?.toISOString().slice(0, 10) ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
