"use server";

import { requireRole } from "@/lib/auth/dal";
import {
  explainLookupFailure,
  lookupByIsbn,
  type BookMetadata,
} from "@/lib/catalogue/openlibrary";
import { db } from "@/lib/db";

export interface LookupState {
  message?: string;
  /** Prefill values for the book form. */
  prefill?: BookMetadata & {
    /** Authors already in the catalogue, matched by name. */
    matchedAuthorIds: string[];
    /** Author names from Open Library with no local record yet. */
    unknownAuthorNames: string[];
  };
  /** Set when the ISBN is already catalogued, with the existing book's id. */
  duplicateOfId?: string;
}

/**
 * Looks up an ISBN and returns values to prefill the new-book form.
 *
 * Staff-only, like every other catalogue mutation path — this one reads rather
 * than writes, but it spends someone else's API quota on our behalf and tells
 * the caller what is in our catalogue, so it is not for anonymous visitors.
 */
export async function lookupIsbnAction(
  _prev: LookupState,
  formData: FormData,
): Promise<LookupState> {
  await requireRole("LIBRARIAN");

  const raw = String(formData.get("isbn") ?? "").trim();
  if (!raw) return { message: "Enter an ISBN to look up." };

  const result = await lookupByIsbn(raw);
  if (!result.ok) return { message: explainLookupFailure(result.reason) };

  // Catch the duplicate here rather than letting the unique index reject the
  // form after the librarian has retyped everything.
  const existing = await db.book.findUnique({
    where: { isbn13: result.data.isbn13 },
    select: { id: true, title: true },
  });
  if (existing) {
    return {
      message: `“${existing.title}” is already in the catalogue with that ISBN.`,
      duplicateOfId: existing.id,
    };
  }

  // Match Open Library's author names against local records so the form can
  // preselect them. Anything unmatched is reported so the librarian knows an
  // author still needs creating.
  const names = result.data.authorNames;
  const known =
    names.length > 0
      ? await db.author.findMany({
          where: { name: { in: names, mode: "insensitive" } },
          select: { id: true, name: true },
        })
      : [];

  const knownLower = new Set(known.map((a) => a.name.toLowerCase()));

  return {
    prefill: {
      ...result.data,
      matchedAuthorIds: known.map((a) => a.id),
      unknownAuthorNames: names.filter((n) => !knownLower.has(n.toLowerCase())),
    },
  };
}
