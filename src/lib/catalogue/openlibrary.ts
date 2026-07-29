import { z } from "zod";

import { toIsbn13 } from "@/lib/catalogue/isbn";

/**
 * Open Library metadata lookup.
 *
 * Chosen over Google Books because it needs no API key and no quota, which
 * keeps `git clone && npm run dev` working for anyone.
 *
 * Three rules for talking to somebody else's server, all of them things v2
 * never had to think about because it never called out at all:
 *
 *   1. **Always time out.** A `fetch` with no signal waits as long as the other
 *      end feels like taking, and a librarian staring at a spinner is worse than
 *      one told to type the title manually.
 *   2. **Never trust the shape.** The response is parsed with zod. A field going
 *      missing upstream should degrade the form, not throw inside a render.
 *   3. **Fail soft.** Every failure — timeout, 500, HTML error page, malformed
 *      JSON — returns a typed miss. Metadata lookup is a convenience; the
 *      librarian can always type it in.
 */

const TIMEOUT_MS = 5_000;

const API_BASE = "https://openlibrary.org/api/books";

/** Only the fields we actually use, all optional because upstream is upstream. */
const OpenLibraryBook = z.object({
  title: z.string().optional(),
  subtitle: z.string().optional(),
  number_of_pages: z.number().int().positive().optional(),
  publish_date: z.string().optional(),
  authors: z.array(z.object({ name: z.string() })).optional(),
  publishers: z.array(z.object({ name: z.string() })).optional(),
  cover: z
    .object({
      small: z.string().optional(),
      medium: z.string().optional(),
      large: z.string().optional(),
    })
    .optional(),
});

const OpenLibraryResponse = z.record(z.string(), OpenLibraryBook);

export interface BookMetadata {
  isbn13: string;
  title: string;
  subtitle: string | undefined;
  authorNames: string[];
  publisher: string | undefined;
  publishedOn: string | undefined;
  pageCount: number | undefined;
  coverUrl: string | undefined;
}

export type LookupResult =
  | { ok: true; data: BookMetadata }
  | { ok: false; reason: "invalid-isbn" | "not-found" | "unavailable" };

/**
 * Open Library's `publish_date` is free text: "1818", "Jan 01, 1818",
 * "1st January 1818". Anything unparseable is dropped rather than guessed at —
 * a wrong date silently entering the catalogue is worse than a blank one.
 */
const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Explicit patterns rather than `Date.parse`, which was wrong twice over:
 *
 *   - **Timezone.** `Date.parse("Jan 01, 1818")` is interpreted in *local* time,
 *     so on a UTC+3 machine it became 1817-12-31T21:00Z and `toISOString()`
 *     then reported the wrong day. Every date built here is built in UTC.
 *   - **Leniency.** It accepted `"circa 1818"` and quietly produced a date. A
 *     parser for third-party free text has to be stricter than the input, not
 *     more forgiving.
 */
function parseParts(raw: string): { y: number; m: number; d: number } | null {
  const text = raw.trim();

  // 1818
  const year = /^(\d{4})$/.exec(text);
  if (year) return { y: Number(year[1]), m: 1, d: 1 };

  // 1818-03-11
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) {
    return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  }

  // Jan 01, 1818  /  January 1 1818
  const monthFirst = /^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(text);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1]!.slice(0, 3).toLowerCase()];
    if (month) {
      return { y: Number(monthFirst[3]), m: month, d: Number(monthFirst[2]) };
    }
  }

  // 1 January 1818
  const dayFirst = /^(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{4})$/i.exec(text);
  if (dayFirst) {
    const month = MONTHS[dayFirst[2]!.slice(0, 3).toLowerCase()];
    if (month) {
      return { y: Number(dayFirst[3]), m: month, d: Number(dayFirst[1]) };
    }
  }

  // March 1818 (no day)
  const monthYear = /^([a-z]{3,9})\.?\s+(\d{4})$/i.exec(text);
  if (monthYear) {
    const month = MONTHS[monthYear[1]!.slice(0, 3).toLowerCase()];
    if (month) return { y: Number(monthYear[2]), m: month, d: 1 };
  }

  return null;
}

export function parsePublishDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;

  const parts = parseParts(raw);
  if (!parts) return undefined;

  const { y, m, d } = parts;

  // Plausibility applies to every path, including the bare-year fast path — an
  // earlier version returned before this check and let "0001" and "9999"
  // through.
  if (y < 1000 || y > new Date().getUTCFullYear() + 1) return undefined;
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;

  const date = new Date(Date.UTC(y, m - 1, d));

  // Rejects 31 February and friends: the constructor rolls them over, so if the
  // components changed, the input was not a real date.
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return undefined;
  }

  return date.toISOString().slice(0, 10);
}

export async function lookupByIsbn(
  input: string,
  // Injectable for tests; defaults to global fetch.
  fetchImpl: typeof fetch = fetch,
): Promise<LookupResult> {
  const normalised = toIsbn13(input);
  if (!normalised.ok) return { ok: false, reason: "invalid-isbn" };

  const isbn13 = normalised.isbn13;
  const bibkey = `ISBN:${isbn13}`;
  const url = `${API_BASE}?bibkeys=${encodeURIComponent(bibkey)}&format=json&jscmd=data`;

  let payload: unknown;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });

    if (!response.ok) return { ok: false, reason: "unavailable" };

    payload = await response.json();
  } catch {
    // Covers the timeout, DNS failure, connection reset, and an HTML error page
    // that fails to parse as JSON. All the same to the caller.
    return { ok: false, reason: "unavailable" };
  }

  const parsed = OpenLibraryResponse.safeParse(payload);
  if (!parsed.success) return { ok: false, reason: "unavailable" };

  // Open Library answers with an empty object for an unknown ISBN rather than
  // a 404, so "no such key" is the not-found signal.
  const book = parsed.data[bibkey];
  if (!book || !book.title) return { ok: false, reason: "not-found" };

  return {
    ok: true,
    data: {
      isbn13,
      title: book.title,
      subtitle: book.subtitle,
      authorNames: book.authors?.map((a) => a.name) ?? [],
      publisher: book.publishers?.[0]?.name,
      publishedOn: parsePublishDate(book.publish_date),
      pageCount: book.number_of_pages,
      coverUrl: book.cover?.large ?? book.cover?.medium ?? book.cover?.small,
    },
  };
}

/** Human-readable explanation for the form. */
export function explainLookupFailure(
  reason: Exclude<LookupResult, { ok: true }>["reason"],
): string {
  switch (reason) {
    case "invalid-isbn":
      return "That does not look like a valid ISBN — check the digits.";
    case "not-found":
      return "Open Library has no record of that ISBN. Enter the details manually.";
    case "unavailable":
      return "Could not reach Open Library just now. Enter the details manually.";
  }
}
