import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { updateAuthor } from "@/app/actions/authors";
import { AuthorForm } from "@/components/author-form";
import { PageHeader } from "@/components/ui";
import { requireRole } from "@/lib/auth/dal";
import { getAuthor } from "@/lib/catalogue/queries";

export const metadata: Metadata = { title: "Edit author" };

export default async function EditAuthorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole("LIBRARIAN");

  const { id } = await params;
  const author = await getAuthor(id);
  if (!author) notFound();

  // `updateAuthor` takes the id as its first argument, so it is bound here.
  // Next encrypts bound arguments before they reach the client, but the action
  // still re-checks the role — a bound id is not an authorization claim.
  const action = updateAuthor.bind(null, author.id);

  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <PageHeader title={`Edit ${author.name}`} />
      <AuthorForm
        action={action}
        values={{
          name: author.name,
          sortName: author.sortName,
          bio: author.bio,
          birthYear: author.birthYear,
          deathYear: author.deathYear,
        }}
        submitLabel="Save changes"
        cancelHref={`/authors/${author.id}`}
      />
    </main>
  );
}
