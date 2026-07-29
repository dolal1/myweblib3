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
import { listBooks } from "@/lib/catalogue/queries";

export const metadata: Metadata = { title: "Books" };

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
    listBooks({ page, ...(query ? { query } : {}) }),
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
        placeholder="Search by title or author"
      />

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
