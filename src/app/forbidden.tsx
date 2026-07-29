import Link from "next/link";

/**
 * Rendered when a Server Function or page calls `forbidden()`. Sends HTTP 403:
 * we know who you are, and you still may not do this.
 */
export default function Forbidden() {
  return (
    <main className="mx-auto max-w-md px-6 py-24 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Not allowed</h1>
      <p className="mt-2 text-slate-600 dark:text-slate-400">
        Your account does not have permission to do that.
      </p>
      <Link
        href="/"
        className="mt-6 inline-block rounded-md border border-slate-300 px-4 py-2 text-sm font-medium dark:border-slate-700"
      >
        Back to the catalogue
      </Link>
    </main>
  );
}
