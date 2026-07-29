import type { Metadata } from "next";
import Link from "next/link";

import { cancelHoldAction, renewAction } from "@/app/actions/circulation";
import { ActionButton } from "@/components/desk-form";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { POLICY, formatCents } from "@/lib/circulation/policy";
import { getMemberAccount } from "@/lib/circulation/service";

export const metadata: Metadata = { title: "My account" };

export default async function AccountPage() {
  const user = await requireUser();
  const account = await getMemberAccount(user.id);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <PageHeader
        title="My account"
        subtitle={
          user.suspended
            ? "Your borrowing privileges are currently suspended."
            : `${account.loans.length} on loan · ${account.holds.length} on hold · ${formatCents(account.totalOwedCents)} owed`
        }
      />

      {user.suspended ? (
        <p
          role="alert"
          className="mb-8 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
        >
          You can browse the catalogue, but cannot borrow or place holds until
          the suspension is lifted. Speak to a librarian.
        </p>
      ) : null}

      <section>
        <h2 className="text-lg font-semibold">On loan</h2>
        {account.loans.length === 0 ? (
          <div className="mt-3">
            <EmptyState>
              Nothing on loan.{" "}
              <Link href="/books" className="underline">
                Browse the catalogue
              </Link>
              .
            </EmptyState>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 dark:divide-slate-800">
            {account.loans.map((loan) => (
              <li
                key={loan.id}
                className="flex flex-wrap justify-between gap-3 py-3"
              >
                <div>
                  <Link
                    href={`/books/${loan.copy.book.id}`}
                    className="font-medium underline"
                  >
                    {loan.copy.book.title}
                  </Link>
                  <p className="mt-0.5 text-sm">
                    <span
                      className={
                        loan.overdue
                          ? "text-red-700 dark:text-red-400"
                          : "text-slate-500 dark:text-slate-400"
                      }
                    >
                      Due {loan.dueAt.toISOString().slice(0, 10)}
                      {loan.overdue ? " — overdue" : ""}
                    </span>
                    <span className="text-slate-400">
                      {" "}
                      · renewed {loan.renewalCount}/{POLICY.maxRenewals}
                    </span>
                  </p>
                </div>

                {loan.renewable ? (
                  <ActionButton
                    action={renewAction}
                    name="loanId"
                    value={loan.id}
                    label="Renew"
                  />
                ) : (
                  <span className="text-xs text-slate-400">
                    Renewal limit reached
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Holds</h2>
        {account.holds.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            No holds.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 dark:divide-slate-800">
            {account.holds.map((hold) => (
              <li
                key={hold.id}
                className="flex flex-wrap justify-between gap-3 py-3"
              >
                <div>
                  <Link
                    href={`/books/${hold.book.id}`}
                    className="font-medium underline"
                  >
                    {hold.book.title}
                  </Link>
                  <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                    {hold.status === "READY"
                      ? `Ready for collection until ${hold.expiresAt?.toISOString().slice(0, 10) ?? "—"}`
                      : `Waiting since ${hold.placedAt.toISOString().slice(0, 10)}`}
                  </p>
                </div>
                <ActionButton
                  action={cancelHoldAction}
                  name="holdId"
                  value={hold.id}
                  label="Cancel"
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">
          Fines{" "}
          {account.totalOwedCents > 0 ? (
            <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
              ({formatCents(account.totalOwedCents)} outstanding)
            </span>
          ) : null}
        </h2>
        {account.fines.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Nothing owed.
          </p>
        ) : (
          <>
            <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
              {account.fines.map((fine) => (
                <li key={fine.id} className="flex justify-between gap-4 py-2">
                  <span>
                    {fine.loan.copy.book.title}
                    <span className="text-slate-500 dark:text-slate-400">
                      {" "}
                      · {fine.reason.toLowerCase()} ·{" "}
                      {fine.assessedAt.toISOString().slice(0, 10)}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatCents(fine.amountCents)}
                  </span>
                </li>
              ))}
            </ul>
            {account.totalOwedCents > POLICY.borrowingBlockedAboveCents ? (
              <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
                Borrowing is blocked above{" "}
                {formatCents(POLICY.borrowingBlockedAboveCents)}. Settle these
                at the desk to borrow again.
              </p>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
