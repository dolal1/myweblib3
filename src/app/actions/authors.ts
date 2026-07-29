"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireRole } from "@/lib/auth/dal";
import {
  authorFormSchema,
  deriveSortName,
  toFieldErrors,
  type ActionState,
} from "@/lib/catalogue/validation";
import { db } from "@/lib/db";
import { isForeignKeyViolation, isUniqueViolation } from "@/lib/db-errors";

/**
 * Author mutations.
 *
 * Note the first line of every function: `await requireRole("LIBRARIAN")`.
 * Server Actions are reachable by direct POST, so this — not the page that
 * renders the form — is the only thing standing between a stranger and the
 * catalogue. v2's equivalent middleware existed and was wired to one route out
 * of fifteen.
 */

function parseAuthorForm(formData: FormData) {
  return authorFormSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    sortName: String(formData.get("sortName") ?? ""),
    bio: String(formData.get("bio") ?? ""),
    birthYear: String(formData.get("birthYear") ?? ""),
    deathYear: String(formData.get("deathYear") ?? ""),
  });
}

export async function createAuthor(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireRole("LIBRARIAN");

  const parsed = parseAuthorForm(formData);
  if (!parsed.success) {
    return { errors: toFieldErrors(parsed.error) };
  }

  const { name, sortName, bio, birthYear, deathYear } = parsed.data;

  let id: string;
  try {
    const author = await db.author.create({
      data: {
        name,
        sortName: sortName ?? deriveSortName(name),
        ...(bio !== undefined ? { bio } : {}),
        ...(birthYear !== undefined ? { birthYear } : {}),
        ...(deathYear !== undefined ? { deathYear } : {}),
      },
      select: { id: true },
    });
    id = author.id;
  } catch (error) {
    // Let the unique index decide, rather than a check-then-insert that races.
    if (isUniqueViolation(error)) {
      return { errors: { name: ["An author with that name already exists"] } };
    }
    throw error;
  }

  revalidatePath("/authors");
  redirect(`/authors/${id}`);
}

export async function updateAuthor(
  id: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireRole("LIBRARIAN");

  const parsed = parseAuthorForm(formData);
  if (!parsed.success) {
    return { errors: toFieldErrors(parsed.error) };
  }

  const { name, sortName, bio, birthYear, deathYear } = parsed.data;

  try {
    await db.author.update({
      where: { id },
      data: {
        name,
        sortName: sortName ?? deriveSortName(name),
        bio: bio ?? null,
        birthYear: birthYear ?? null,
        deathYear: deathYear ?? null,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { errors: { name: ["An author with that name already exists"] } };
    }
    throw error;
  }

  revalidatePath("/authors");
  revalidatePath(`/authors/${id}`);
  redirect(`/authors/${id}`);
}

/**
 * Deletes an author, or explains why it cannot.
 *
 * This is the headline fix from docs/from-v2.md. v2 guarded this with a
 * Mongoose `pre('remove')` hook that raised "This author has books still" — and
 * then its delete route caught the error with a bare `catch` and redirected, so
 * the user clicked Delete, watched the page reload, and had no idea why the
 * author was still there.
 *
 * Here Postgres refuses via `onDelete: Restrict` on BookAuthor.author, and the
 * refusal becomes a sentence the librarian can act on.
 */
export async function deleteAuthor(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireRole("LIBRARIAN");

  const id = String(formData.get("id") ?? "");
  if (!id) return { message: "No author specified" };

  try {
    await db.author.delete({ where: { id } });
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      const bookCount = await db.bookAuthor.count({ where: { authorId: id } });
      return {
        message:
          `This author is still credited on ${bookCount} ` +
          `${bookCount === 1 ? "book" : "books"}. Remove those credits first.`,
      };
    }
    throw error;
  }

  revalidatePath("/authors");
  redirect("/authors");
}
