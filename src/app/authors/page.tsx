import type { Metadata } from "next";
import Link from "next/link";

import {
  ButtonLink,
  EmptyState,
  PageHeader,
  Pagination,
  SearchForm,
  formatYearRange,
} from "@/components/ui";
import { getCurrentUser, hasRole } from "@/lib/auth/dal";
import { listAuthors } from "@/lib/catalogue/queries";

export const metadata: Metadata = { title: "Authors" };

export default async function AuthorsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  // searchParams is a promise in Next 15+; awaiting it also opts this route
  // into dynamic rendering, which is what we want for a searchable list.
  const params = await searchParams;
  const page = Number(params.page ?? "1") || 1;
  const query = params.q?.trim() ?? "";

  const [user, authors] = await Promise.all([
    getCurrentUser(),
    listAuthors({ page, ...(query ? { query } : {}) }),
  ]);

  const canManage = hasRole(user, "LIBRARIAN");

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <PageHeader
        title="Authors"
        subtitle={`${authors.total} ${authors.total === 1 ? "author" : "authors"} in the catalogue`}
        action={
          canManage ? (
            <ButtonLink href="/authors/new">Add author</ButtonLink>
          ) : null
        }
      />

      <SearchForm
        action="/authors"
        defaultValue={query}
        placeholder="Search authors by name"
      />

      {authors.items.length === 0 ? (
        <EmptyState>
          {query ? `No authors match “${query}”.` : "No authors yet."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {authors.items.map((author) => {
            const years = formatYearRange(author.birthYear, author.deathYear);
            return (
              <li
                key={author.id}
                className="flex items-baseline justify-between gap-4 py-3"
              >
                <div>
                  <Link
                    href={`/authors/${author.id}`}
                    className="font-medium underline"
                  >
                    {author.name}
                  </Link>
                  {years ? (
                    <span className="ml-2 text-sm text-slate-500 dark:text-slate-400">
                      {years}
                    </span>
                  ) : null}
                </div>
                <span className="shrink-0 text-sm text-slate-500 tabular-nums dark:text-slate-400">
                  {author.bookCount} {author.bookCount === 1 ? "book" : "books"}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <Pagination
        page={authors.page}
        pageCount={authors.pageCount}
        basePath="/authors"
        {...(query ? { query } : {})}
      />
    </main>
  );
}
