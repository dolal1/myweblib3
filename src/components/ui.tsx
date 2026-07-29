import Link from "next/link";

/** Small shared primitives, kept deliberately plain until the design settles. */

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {subtitle}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function Alert({
  kind = "error",
  children,
}: {
  kind?: "error" | "info";
  children: React.ReactNode;
}) {
  const tone =
    kind === "error"
      ? "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
      : "border-slate-300 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200";

  return (
    <p
      role="alert"
      className={`mb-4 rounded-md border px-3 py-2 text-sm ${tone}`}
    >
      {children}
    </p>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
      {children}
    </p>
  );
}

export function ButtonLink({
  href,
  children,
  variant = "primary",
}: {
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "secondary";
}) {
  const tone =
    variant === "primary"
      ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
      : "border border-slate-300 dark:border-slate-700";

  return (
    <Link
      href={href}
      className={`inline-block rounded-md px-3 py-2 text-sm font-medium ${tone}`}
    >
      {children}
    </Link>
  );
}

/**
 * Offset pagination.
 *
 * v2 rendered every row in the table with no limit at all, so this is not a
 * refinement so much as a missing feature. Offset rather than cursor because
 * the catalogue is browsed by page number and sorted by a stable key; cursors
 * would be the right call for an infinite feed.
 */
export function Pagination({
  page,
  pageCount,
  basePath,
  query,
}: {
  page: number;
  pageCount: number;
  basePath: string;
  query?: string;
}) {
  if (pageCount <= 1) return null;

  const href = (target: number) => {
    const params = new URLSearchParams();
    if (target > 1) params.set("page", String(target));
    if (query) params.set("q", query);
    const search = params.toString();
    return search ? `${basePath}?${search}` : basePath;
  };

  return (
    <nav
      aria-label="Pagination"
      className="mt-8 flex items-center justify-between text-sm"
    >
      {page > 1 ? (
        <Link href={href(page - 1)} className="underline" rel="prev">
          ← Previous
        </Link>
      ) : (
        <span className="text-slate-400">← Previous</span>
      )}

      <span className="text-slate-600 dark:text-slate-400">
        Page {page} of {pageCount}
      </span>

      {page < pageCount ? (
        <Link href={href(page + 1)} className="underline" rel="next">
          Next →
        </Link>
      ) : (
        <span className="text-slate-400">Next →</span>
      )}
    </nav>
  );
}

/** Search box that submits with GET, so results are linkable and bookmarkable. */
export function SearchForm({
  action,
  defaultValue,
  placeholder,
}: {
  action: string;
  defaultValue?: string;
  placeholder: string;
}) {
  return (
    <form action={action} method="GET" className="mb-6 flex gap-2">
      <input
        type="search"
        name="q"
        defaultValue={defaultValue ?? ""}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
      />
      <button
        type="submit"
        className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium dark:border-slate-700"
      >
        Search
      </button>
    </form>
  );
}

export function formatYearRange(
  birthYear: number | null,
  deathYear: number | null,
): string | null {
  if (birthYear === null && deathYear === null) return null;
  return `${birthYear ?? "?"}–${deathYear ?? ""}`;
}
