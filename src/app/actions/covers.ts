"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/dal";
import {
  MAX_UPLOAD_BYTES,
  attachCover,
  deleteCover,
  explainCoverFailure,
  importCoverFromUrl,
} from "@/lib/covers/service";
import { db } from "@/lib/db";

export interface CoverState {
  ok?: boolean;
  message?: string;
}

/**
 * Uploads a cover.
 *
 * This is a real multipart file input, not v2's arrangement of reading the file
 * in the browser, JSON-encoding it into a hidden form field, and posting it
 * through a urlencoded body with a 10 MB limit.
 *
 * Note that Server Actions cap request bodies at 1 MB by default. The limit is
 * raised in next.config.ts to match MAX_UPLOAD_BYTES, otherwise a perfectly
 * ordinary photo would be rejected by the framework before this code ran.
 */
export async function uploadCoverAction(
  bookId: string,
  _prev: CoverState,
  formData: FormData,
): Promise<CoverState> {
  await requireRole("LIBRARIAN");

  const file = formData.get("cover");
  if (!(file instanceof File) || file.size === 0) {
    return { message: "Choose an image to upload." };
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      message: `That image is ${Math.round(file.size / 1024 / 1024)} MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    };
  }

  const book = await db.book.findUnique({
    where: { id: bookId },
    select: { id: true },
  });
  if (!book) return { message: "That book no longer exists." };

  const bytes = Buffer.from(await file.arrayBuffer());
  const result = await attachCover(bookId, bytes);

  if (!result.ok) return { message: explainCoverFailure(result.failure) };

  revalidatePath(`/books/${bookId}`);
  revalidatePath("/books");
  return { ok: true, message: "Cover updated." };
}

/** Imports the cover Open Library returned alongside the ISBN metadata. */
export async function importCoverAction(
  _prev: CoverState,
  formData: FormData,
): Promise<CoverState> {
  await requireRole("LIBRARIAN");

  const bookId = String(formData.get("bookId") ?? "");
  const url = String(formData.get("url") ?? "");
  if (!bookId || !url) return { message: "Nothing to import." };

  const result = await importCoverFromUrl(bookId, url);
  if (!result.ok) {
    return {
      message: `Could not import that image. ${explainCoverFailure(result.failure)}`,
    };
  }

  revalidatePath(`/books/${bookId}`);
  revalidatePath("/books");
  return { ok: true, message: "Cover imported." };
}

export async function removeCoverAction(
  _prev: CoverState,
  formData: FormData,
): Promise<CoverState> {
  await requireRole("LIBRARIAN");

  const bookId = String(formData.get("bookId") ?? "");
  if (!bookId) return { message: "No book specified." };

  const cover = await db.cover.findUnique({
    where: { bookId },
    select: { id: true, storageKey: true },
  });
  if (!cover) return { message: "That book has no cover." };

  await db.cover.delete({ where: { id: cover.id } });

  // Content-addressed storage means another book may share these bytes.
  const stillUsed = await db.cover.count({
    where: { storageKey: cover.storageKey },
  });
  if (stillUsed === 0) await deleteCover(cover.storageKey);

  revalidatePath(`/books/${bookId}`);
  revalidatePath("/books");
  return { ok: true, message: "Cover removed." };
}
