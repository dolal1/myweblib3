"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireRole } from "@/lib/auth/dal";
import {
  bookSchema,
  toFieldErrors,
  type ActionState,
} from "@/lib/catalogue/validation";
import { db } from "@/lib/db";
import {
  isForeignKeyViolation,
  isUniqueViolation,
  violatedCheckConstraint,
} from "@/lib/db-errors";

/**
 * Book mutations. Every one re-checks the role — see the note in
 * actions/authors.ts.
 */

function parseBookForm(formData: FormData) {
  return bookSchema.safeParse({
    title: String(formData.get("title") ?? ""),
    subtitle: String(formData.get("subtitle") ?? ""),
    isbn13: String(formData.get("isbn13") ?? ""),
    description: String(formData.get("description") ?? ""),
    publisher: String(formData.get("publisher") ?? ""),
    language: String(formData.get("language") ?? "") || "en",
    pageCount: String(formData.get("pageCount") ?? ""),
    publishedOn: String(formData.get("publishedOn") ?? ""),
    // Repeated form fields: `getAll` is what makes several authors possible.
    authorIds: formData.getAll("authorIds").map(String).filter(Boolean),
    genreIds: formData.getAll("genreIds").map(String).filter(Boolean),
  });
}

/** Translates a database refusal into something a librarian can act on. */
function describeDbError(error: unknown): ActionState | undefined {
  if (isUniqueViolation(error)) {
    return {
      errors: { isbn13: ["A book with that ISBN is already in the catalogue"] },
    };
  }
  if (isForeignKeyViolation(error)) {
    return {
      message: "One of the selected authors or genres no longer exists.",
    };
  }

  const constraint = violatedCheckConstraint(error);
  if (constraint === "Book_isbn13_format") {
    return { errors: { isbn13: ["ISBN must be 13 digits"] } };
  }
  if (constraint === "Book_page_count_positive") {
    return { errors: { pageCount: ["Page count must be greater than zero"] } };
  }
  return undefined;
}

export async function createBook(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireRole("LIBRARIAN");

  const parsed = parseBookForm(formData);
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  const data = parsed.data;

  let id: string;
  try {
    const book = await db.book.create({
      data: {
        title: data.title,
        language: data.language,
        ...(data.subtitle !== undefined ? { subtitle: data.subtitle } : {}),
        ...(data.isbn13 !== undefined ? { isbn13: data.isbn13 } : {}),
        ...(data.description !== undefined
          ? { description: data.description }
          : {}),
        ...(data.publisher !== undefined ? { publisher: data.publisher } : {}),
        ...(data.pageCount !== undefined ? { pageCount: data.pageCount } : {}),
        ...(data.publishedOn !== undefined
          ? { publishedOn: new Date(data.publishedOn) }
          : {}),
        authors: {
          create: data.authorIds.map((authorId, position) => ({
            authorId,
            role: "AUTHOR" as const,
            position,
          })),
        },
        ...(data.genreIds.length > 0
          ? { genres: { connect: data.genreIds.map((gid) => ({ id: gid })) } }
          : {}),
      },
      select: { id: true },
    });
    id = book.id;
  } catch (error) {
    const described = describeDbError(error);
    if (described) return described;
    throw error;
  }

  revalidatePath("/books");
  redirect(`/books/${id}`);
}

export async function updateBook(
  id: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireRole("LIBRARIAN");

  const parsed = parseBookForm(formData);
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  const data = parsed.data;

  try {
    // Credits are replaced wholesale rather than diffed, inside a transaction so
    // a failure cannot leave a book with no authors at all.
    await db.$transaction(async (tx) => {
      await tx.book.update({
        where: { id },
        data: {
          title: data.title,
          language: data.language,
          subtitle: data.subtitle ?? null,
          isbn13: data.isbn13 ?? null,
          description: data.description ?? null,
          publisher: data.publisher ?? null,
          pageCount: data.pageCount ?? null,
          publishedOn: data.publishedOn ? new Date(data.publishedOn) : null,
          genres: { set: data.genreIds.map((gid) => ({ id: gid })) },
        },
      });

      await tx.bookAuthor.deleteMany({ where: { bookId: id } });
      await tx.bookAuthor.createMany({
        data: data.authorIds.map((authorId, position) => ({
          bookId: id,
          authorId,
          role: "AUTHOR" as const,
          position,
        })),
      });
    });
  } catch (error) {
    const described = describeDbError(error);
    if (described) return described;
    throw error;
  }

  revalidatePath("/books");
  revalidatePath(`/books/${id}`);
  redirect(`/books/${id}`);
}

/**
 * Deletes a book, or explains why not.
 *
 * `BookCopy.book` is `onDelete: Restrict`, so a title with copies on the shelf
 * cannot be deleted out from under them — the same protection as authors, one
 * level down.
 */
export async function deleteBook(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireRole("LIBRARIAN");

  const id = String(formData.get("id") ?? "");
  if (!id) return { message: "No book specified" };

  try {
    await db.book.delete({ where: { id } });
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      const copyCount = await db.bookCopy.count({ where: { bookId: id } });
      return {
        message:
          `This title still has ${copyCount} ` +
          `${copyCount === 1 ? "copy" : "copies"} on record. ` +
          `Withdraw them before deleting the title.`,
      };
    }
    throw error;
  }

  revalidatePath("/books");
  redirect("/books");
}
