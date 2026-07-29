import type { Metadata } from "next";
import Link from "next/link";

import {
  ButtonLink,
  EmptyState,
  PageHeader,
  Pagination,
  SearchForm,
} from "@/components/ui";
import { getCurrentUser, hasRole } from "@/lib/auth/dal";
import { PAGE_SIZE, listBooks } from "@/lib/catalogue/queries";
import { hydrateBookHits, searchBooks } from "@/lib/catalogue/search";

export const metadata: Metadata = { title: "Books" };

/**
 * Browsing and searching are two different queries.
 *
 * With no `q`, this is an alphabetical listing and Prisma handles it. With a
 * `q`, it becomes ranked full-text search over the generated tsvector columns,
 * which needs raw SQL — so the two paths are kept separate rather than bent
 * into one query that does neither well.
 */
async function loadBooks(page: number, query: string) {
  if (!query) {
    const listed = await listBooks({ page });
    return {
      items: listed.items.map((item) => ({ ...item, matchedOn: null })),
      page: listed.page,
      pageCount: listed.pageCount,
      total: listed.total,
      fuzzy: false,
    };
  }

  const result = await searchBooks({
    query,
    limit: PAGE_SIZE,
    offset: (Math.max(1, page) - 1) * PAGE_SIZE,
  });

  return {
    items: await hydrateBookHits(result.hits),
    page,
    pageCount: Math.max(1, Math.ceil(result.total / PAGE_SIZE)),
    total: result.total,
    fuzzy: result.usedFuzzyFallback,
  };
}

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const params = await searchParams;
  const page = Number(params.page ?? "1") || 1;
  const query = params.q?.trim() ?? "";

  const [user, books] = await Promise.all([
    getCurrentUser(),
    loadBooks(page, query),
  ]);

  const canManage = hasRole(user, "LIBRARIAN");

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <PageHeader
        title="Books"
        subtitle={`${books.total} ${books.total === 1 ? "title" : "titles"} in the catalogue`}
        action={
          canManage ? <ButtonLink href="/books/new">Add book</ButtonLink> : null
        }
      />

      <SearchForm
        action="/books"
        defaultValue={query}
        placeholder="Search by title, author, or description"
      />

      {query ? (
        <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
          {books.fuzzy
            ? `Nothing matched “${query}” exactly — showing titles that look similar.`
            : `${books.total} ${books.total === 1 ? "result" : "results"} for “${query}”, best first.`}{" "}
          <span className="text-xs">
            Quoted phrases and <code>-exclusions</code> work.
          </span>
        </p>
      ) : null}

      {books.items.length === 0 ? (
        <EmptyState>
          {query ? `No books match “${query}”.` : "No books yet."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {books.items.map((book) => (
            <li key={book.id} className="flex justify-between gap-4 py-4">
              <div className="min-w-0">
                <Link
                  href={`/books/${book.id}`}
                  className="font-medium underline"
                >
                  {book.title}
                </Link>
                {book.subtitle ? (
                  <span className="text-slate-500 dark:text-slate-400">
                    : {book.subtitle}
                  </span>
                ) : null}
                <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
                  {/* Plural by construction: a book can have several authors,
                      which v2's single-ObjectId field made impossible. */}
                  {book.authors.length > 0
                    ? book.authors.join(", ")
                    : "Unattributed"}
                  {book.publishedOn
                    ? ` · ${book.publishedOn.getUTCFullYear()}`
                    : ""}
                </p>
              </div>

              <div className="shrink-0 text-right text-sm">
                <Availability
                  available={book.availableCount}
                  total={book.copyCount}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <Pagination
        page={books.page}
        pageCount={books.pageCount}
        basePath="/books"
        {...(query ? { query } : {})}
      />
    </main>
  );
}

function Availability({
  available,
  total,
}: {
  available: number;
  total: number;
}) {
  if (total === 0) {
    return <span className="text-slate-400">No copies</span>;
  }

  const tone =
    available > 0
      ? "text-emerald-700 dark:text-emerald-400"
      : "text-amber-700 dark:text-amber-400";

  return (
    <span className={`tabular-nums ${tone}`}>
      {available} of {total} available
    </span>
  );
}
