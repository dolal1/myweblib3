import Link from "next/link";

import { logout } from "@/app/actions/auth";
import { getCurrentUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";

/**
 * A Server Component that only awaits a database call — with no cookies(),
 * headers(), or searchParams — is still statically prerendered at build time,
 * which would bake these counts into the bundle. Live figures need an explicit
 * opt-out.
 */
export const dynamic = "force-dynamic";

/**
 * Placeholder home page. Its only real job right now is to prove the whole
 * stack is wired together: a Server Component reading through Prisma from
 * Postgres, rendered on the server.
 *
 * Phase 4 replaces this with the public catalogue.
 */
export default async function Home() {
  const [user, books, copies, openLoans, holds] = await Promise.all([
    getCurrentUser(),
    db.book.count(),
    db.bookCopy.count(),
    db.loan.count({ where: { returnedAt: null } }),
    db.hold.count({ where: { status: "WAITING" } }),
  ]);

  const stats = [
    { label: "Titles", value: books },
    { label: "Copies", value: copies },
    { label: "On loan", value: openLoans },
    { label: "Holds waiting", value: holds },
  ];

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">myweblib3</h1>
        {user ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-600 dark:text-slate-400">
              {user.name}{" "}
              <span className="text-xs text-slate-400">({user.role})</span>
            </span>
            <form action={logout}>
              <button type="submit" className="font-medium underline">
                Log out
              </button>
            </form>
          </div>
        ) : (
          <div className="flex gap-3 text-sm font-medium">
            <Link href="/login" className="underline">
              Log in
            </Link>
            <Link href="/register" className="underline">
              Register
            </Link>
          </div>
        )}
      </div>
      <p className="mt-2 text-slate-600 dark:text-slate-400">
        A library catalogue and circulation system. Successor to{" "}
        <span className="font-mono">myweblib2</span> (2020).
      </p>

      <dl className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"
          >
            <dt className="text-sm text-slate-500 dark:text-slate-400">
              {stat.label}
            </dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-10 text-sm text-slate-500 dark:text-slate-400">
        Read from Postgres at request time. If these numbers render, the schema,
        migrations, seed, Prisma client, and database connection are all
        working.
      </p>
    </main>
  );
}
