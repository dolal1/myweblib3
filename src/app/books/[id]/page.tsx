import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { placeHoldAction } from "@/app/actions/circulation";
import { Cover } from "@/components/cover";
import { CoverUpload } from "@/components/cover-upload";
import { ActionButton } from "@/components/desk-form";
import { PageHeader } from "@/components/ui";
import { getCurrentUser, hasRole } from "@/lib/auth/dal";
import { formatIsbn13 } from "@/lib/catalogue/isbn";
import { getBook } from "@/lib/catalogue/queries";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const book = await getBook((await params).id);
  return { title: book?.title ?? "Book not found" };
}

const STATUS_LABEL = {
  AVAILABLE: "On shelf",
  ON_LOAN: "On loan",
  HOLD_SHELF: "Awaiting collection",
  LOST: "Lost",
  WITHDRAWN: "Withdrawn",
} as const;

export default async function BookPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [user, book] = await Promise.all([getCurrentUser(), getBook(id)]);

  if (!book) notFound();

  const canManage = hasRole(user, "LIBRARIAN");
  const available = book.copies.filter((c) => c.status === "AVAILABLE").length;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <PageHeader
        title={book.title}
        {...(book.subtitle ? { subtitle: book.subtitle } : {})}
        action={
          <div className="flex items-start gap-2">
            {/* A hold is only useful when nothing is on the shelf, and only
                offered to a member in good standing. */}
            {user && !user.suspended && available === 0 ? (
              <ActionButton
                action={placeHoldAction}
                name="bookId"
                value={book.id}
                label="Place hold"
                variant="primary"
              />
            ) : null}
            {canManage ? (
              <Link
                href={`/books/${book.id}/edit`}
                className="inline-block rounded-md border border-slate-300 px-3 py-2 text-sm font-medium dark:border-slate-700"
              >
                Edit
              </Link>
            ) : null}
          </div>
        }
      />

      <p className="text-sm text-slate-500 dark:text-slate-400">
        <Link href="/books" className="underline">
          ← All books
        </Link>
      </p>

      <div className="mt-6 flex gap-6">
        <Cover cover={book.cover} title={book.title} size="large" />

        <div className="min-w-0 flex-1">
          <p className="text-slate-700 dark:text-slate-300">
            {book.authors.map((link, index) => (
              <span key={`${link.author.id}-${link.role}`}>
                {index > 0 ? ", " : ""}
                <Link href={`/authors/${link.author.id}`} className="underline">
                  {link.author.name}
                </Link>
                {link.role !== "AUTHOR" ? (
                  <span className="text-slate-500">
                    {" "}
                    ({link.role.toLowerCase()})
                  </span>
                ) : null}
              </span>
            ))}
          </p>

          {book.description ? (
            <p className="mt-4 whitespace-pre-line text-slate-700 dark:text-slate-300">
              {book.description}
            </p>
          ) : null}
        </div>
      </div>

      <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <Detail label="Published">
          {book.publishedOn?.toISOString().slice(0, 10) ?? "—"}
        </Detail>
        <Detail label="Publisher">{book.publisher ?? "—"}</Detail>
        {/* v2 wrote pageCount and read it in its views but never added it to
            the schema, so this was blank for the project's whole life. */}
        <Detail label="Pages">{book.pageCount ?? "—"}</Detail>
        <Detail label="ISBN">
          {book.isbn13 ? (
            <span className="font-mono text-xs">
              {formatIsbn13(book.isbn13)}
            </span>
          ) : (
            "—"
          )}
        </Detail>
        <Detail label="Language">{book.language}</Detail>
        <Detail label="Holds waiting">{book._count.holds}</Detail>
      </dl>

      {book.genres.length > 0 ? (
        <ul className="mt-6 flex flex-wrap gap-2">
          {book.genres.map((genre) => (
            <li
              key={genre.id}
              className="rounded-full border border-slate-300 px-2.5 py-0.5 text-xs dark:border-slate-700"
            >
              {genre.name}
            </li>
          ))}
        </ul>
      ) : null}

      <h2 className="mt-10 text-lg font-semibold">
        Copies{" "}
        <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
          ({available} of {book.copies.length} on shelf)
        </span>
      </h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        A copy is a physical object with its own barcode. v2 had no such
        concept, which is why it could never lend anything.
      </p>

      {book.copies.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">
          No copies have been acquired yet.
        </p>
      ) : (
        <table className="mt-3 w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs text-slate-500 uppercase dark:border-slate-800">
            <tr>
              <th className="py-2 font-medium">Barcode</th>
              <th className="py-2 font-medium">Status</th>
              <th className="py-2 font-medium">Shelf</th>
              <th className="py-2 font-medium">Due</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {book.copies.map((copy) => (
              <tr key={copy.id}>
                <td className="py-2 font-mono text-xs">{copy.barcode}</td>
                <td className="py-2">{STATUS_LABEL[copy.status]}</td>
                <td className="py-2 text-slate-500 dark:text-slate-400">
                  {copy.shelfLocation ?? "—"}
                </td>
                <td className="py-2 text-slate-500 tabular-nums dark:text-slate-400">
                  {copy.openLoan ? (
                    <DueDate
                      dueAt={copy.openLoan.dueAt}
                      overdue={copy.openLoan.overdue}
                    />
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canManage ? (
        <section className="mt-12 border-t border-slate-200 pt-6 dark:border-slate-800">
          <h2 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-300">
            Cover image
          </h2>
          <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
            Stored outside the database and served from its own immutable URL.
            v2 kept the bytes in the document and base64-inlined them into every
            page render.
          </p>
          <CoverUpload bookId={book.id} hasCover={book.cover !== null} />
        </section>
      ) : null}
    </main>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs text-slate-500 uppercase dark:text-slate-400">
        {label}
      </dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

/**
 * `overdue` arrives as a prop rather than being derived from `Date.now()` here.
 * Reading the clock during render is impure — it is what eslint's
 * react-hooks/purity rule objects to, and it is a hydration mismatch waiting to
 * happen. The comparison is done once in lib/catalogue/queries.ts.
 */
function DueDate({ dueAt, overdue }: { dueAt: Date; overdue: boolean }) {
  return (
    <span className={overdue ? "text-red-700 dark:text-red-400" : undefined}>
      {dueAt.toISOString().slice(0, 10)}
      {overdue ? " (overdue)" : ""}
    </span>
  );
}
