import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { deleteBook, updateBook } from "@/app/actions/books";
import { BookForm } from "@/components/book-form";
import { DeleteButton } from "@/components/delete-button";
import { PageHeader } from "@/components/ui";
import { requireRole } from "@/lib/auth/dal";
import { getBook, getBookFormOptions } from "@/lib/catalogue/queries";

export const metadata: Metadata = { title: "Edit book" };

export default async function EditBookPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole("LIBRARIAN");

  const { id } = await params;
  const [book, options] = await Promise.all([
    getBook(id),
    getBookFormOptions(),
  ]);
  if (!book) notFound();

  const action = updateBook.bind(null, book.id);

  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <PageHeader title={`Edit ${book.title}`} />

      <BookForm
        action={action}
        authors={options.authors}
        genres={options.genres}
        values={{
          title: book.title,
          subtitle: book.subtitle,
          isbn13: book.isbn13,
          description: book.description,
          publisher: book.publisher,
          language: book.language,
          pageCount: book.pageCount,
          publishedOn: book.publishedOn,
          authorIds: book.authors.map((link) => link.author.id),
          genreIds: book.genres.map((genre) => genre.id),
        }}
        submitLabel="Save changes"
        cancelHref={`/books/${book.id}`}
      />

      <section className="mt-12 border-t border-slate-200 pt-6 dark:border-slate-800">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          Danger zone
        </h2>
        <p className="mt-1 mb-3 text-sm text-slate-500 dark:text-slate-400">
          {book.copies.length > 0
            ? `This title has ${book.copies.length} ${book.copies.length === 1 ? "copy" : "copies"} on record, so the database will refuse to delete it.`
            : "This title has no copies and can be deleted."}
        </p>
        <DeleteButton
          action={deleteBook}
          id={book.id}
          label="Delete book"
          confirm={`Delete ${book.title}?`}
        />
      </section>
    </main>
  );
}
