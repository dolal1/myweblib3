import type { Metadata } from "next";
import Link from "next/link";

import { createBook } from "@/app/actions/books";
import { BookForm } from "@/components/book-form";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireRole } from "@/lib/auth/dal";
import { getBookFormOptions } from "@/lib/catalogue/queries";

export const metadata: Metadata = { title: "Add book" };

export default async function NewBookPage() {
  await requireRole("LIBRARIAN");

  const { authors, genres } = await getBookFormOptions();

  // A book requires at least one author, so there is nothing useful to show
  // until one exists. Saying so beats rendering an unsubmittable form.
  if (authors.length === 0) {
    return (
      <main className="mx-auto max-w-xl px-6 py-12">
        <PageHeader title="Add book" />
        <EmptyState>
          Add an author first — every book needs at least one credit.{" "}
          <Link href="/authors/new" className="underline">
            Add an author
          </Link>
          .
        </EmptyState>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <PageHeader title="Add book" />
      <BookForm
        action={createBook}
        authors={authors}
        genres={genres}
        submitLabel="Create book"
        cancelHref="/books"
      />
    </main>
  );
}
