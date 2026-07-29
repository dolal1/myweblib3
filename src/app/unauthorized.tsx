import Link from "next/link";

/**
 * Rendered by Next when a Server Function or page calls `unauthorized()`.
 * Sends HTTP 401 — the correct status for "we do not know who you are", as
 * distinct from 403 in forbidden.tsx.
 */
export default function Unauthorized() {
  return (
    <main className="mx-auto max-w-md px-6 py-24 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Log in required</h1>
      <p className="mt-2 text-slate-600 dark:text-slate-400">
        You need to be logged in to see this page.
      </p>
      <Link
        href="/login"
        className="mt-6 inline-block rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
      >
        Log in
      </Link>
    </main>
  );
}
