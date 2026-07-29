import type { Metadata } from "next";

import { createAuthor } from "@/app/actions/authors";
import { AuthorForm } from "@/components/author-form";
import { PageHeader } from "@/components/ui";
import { requireRole } from "@/lib/auth/dal";

export const metadata: Metadata = { title: "Add author" };

export default async function NewAuthorPage() {
  // Guards the *rendering* of the form. The action guards the mutation — both
  // are needed, and only the second is a security boundary.
  await requireRole("LIBRARIAN");

  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <PageHeader title="Add author" />
      <AuthorForm
        action={createAuthor}
        submitLabel="Create author"
        cancelHref="/authors"
      />
    </main>
  );
}
