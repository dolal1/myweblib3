import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { deleteAuthor } from "@/app/actions/authors";
import { DeleteButton } from "@/components/delete-button";
import {
  ButtonLink,
  EmptyState,
  PageHeader,
  formatYearRange,
} from "@/components/ui";
import { getCurrentUser, hasRole } from "@/lib/auth/dal";
import { getAuthor } from "@/lib/catalogue/queries";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const author = await getAuthor((await params).id);
  return { title: author?.name ?? "Author not found" };
}

export default async function AuthorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [user, author] = await Promise.all([getCurrentUser(), getAuthor(id)]);

  // A missing record is a 404, not a redirect to "/". v2 swallowed the
  // difference between "no such author" and "the database is down".
  if (!author) notFound();

  const canManage = hasRole(user, "LIBRARIAN");
  const years = formatYearRange(author.birthYear, author.deathYear);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <PageHeader
        title={author.name}
        {...(years ? { subtitle: years } : {})}
        action={
          canManage ? (
            <div className="flex gap-2">
              <ButtonLink
                href={`/authors/${author.id}/edit`}
                variant="secondary"
              >
                Edit
              </ButtonLink>
            </div>
          ) : null
        }
      />

      <p className="text-sm text-slate-500 dark:text-slate-400">
        <Link href="/authors" className="underline">
          ← All authors
        </Link>
      </p>

      {author.bio ? (
        <p className="mt-6 whitespace-pre-line text-slate-700 dark:text-slate-300">
          {author.bio}
        </p>
      ) : null}

      <h2 className="mt-10 text-lg font-semibold">
        Credited on {author.books.length}{" "}
        {author.books.length === 1 ? "book" : "books"}
      </h2>

      {author.books.length === 0 ? (
        <div className="mt-3">
          <EmptyState>No books credited to this author yet.</EmptyState>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-slate-200 dark:divide-slate-800">
          {author.books.map(({ book, role }) => (
            <li key={book.id} className="flex justify-between gap-4 py-3">
              <div>
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
                {role !== "AUTHOR" ? (
                  <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 uppercase dark:bg-slate-800 dark:text-slate-300">
                    {role.toLowerCase()}
                  </span>
                ) : null}
              </div>
              <span className="shrink-0 text-sm text-slate-500 tabular-nums dark:text-slate-400">
                {book._count.copies}{" "}
                {book._count.copies === 1 ? "copy" : "copies"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <section className="mt-12 border-t border-slate-200 pt-6 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
            Danger zone
          </h2>
          <p className="mt-1 mb-3 text-sm text-slate-500 dark:text-slate-400">
            {author.books.length > 0
              ? "This author is credited on books, so the database will refuse to delete them. Try it — the reason appears below the button."
              : "This author has no book credits and can be deleted."}
          </p>
          <DeleteButton
            action={deleteAuthor}
            id={author.id}
            label="Delete author"
            confirm={`Delete ${author.name}?`}
          />
        </section>
      ) : null}
    </main>
  );
}
