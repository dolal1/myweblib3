import { z } from "zod";

/**
 * The structured filter a natural-language query is turned into.
 *
 * Two layers of checking, because they catch different things:
 *
 *   1. **Shape.** `buildFilterSchema` is sent to the API as a structured-output
 *      format and parsed again with zod on the way back. The genre is an enum
 *      of the genres this library actually has, so the model cannot invent
 *      one. This guarantees types, not sense.
 *   2. **Sense.** `checkFilter` rejects output that is well-typed but wrong:
 *      a year range running backwards, a year of 0003 or 2900, a "search" with
 *      nothing in it. A rejected filter is treated exactly like a failed call
 *      and the page falls back to keyword search. A confidently wrong filter
 *      hides books that exist, which is worse than a plainer search.
 *
 * Nothing here imports the database or `server-only`, so the eval runs it
 * outside Next.js.
 */

const MAX_TEXT = 200;

export function buildFilterSchema(genreSlugs: readonly string[]) {
  const genre =
    genreSlugs.length > 0
      ? z.enum(genreSlugs as [string, ...string[]]).nullable()
      : z.null();

  return z.object({
    kind: z
      .enum(["search", "not_a_search"])
      .describe(
        "not_a_search when the text is not a request to find books " +
          "(a greeting, a question about something else, an instruction).",
      ),
    keywords: z
      .string()
      .nullable()
      .describe(
        "Topic or title words to match against titles and descriptions. " +
          "Null when the query names no topic or title.",
      ),
    author: z
      .string()
      .nullable()
      .describe("Author name as the user wrote it. Null when none is named."),
    genre: genre.describe("One of the library's genres, or null."),
    yearFrom: z
      .number()
      .int()
      .nullable()
      .describe("Earliest publication year, inclusive. Null when unbounded."),
    yearTo: z
      .number()
      .int()
      .nullable()
      .describe("Latest publication year, inclusive. Null when unbounded."),
    availableOnly: z
      .boolean()
      .describe("True only when the user asks for books they can borrow now."),
  });
}

export type InterpretedQuery = z.infer<ReturnType<typeof buildFilterSchema>>;

/** A filter that passed both layers. Only this is ever run against the database. */
export interface CatalogueFilter {
  keywords: string | null;
  author: string | null;
  genre: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  availableOnly: boolean;
}

export type FilterCheck =
  | { ok: true; filter: CatalogueFilter }
  | { ok: false; reason: "not_a_search" | "implausible"; detail: string };

function cleanText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed === "" ? null : trimmed;
}

export function checkFilter(
  output: InterpretedQuery,
  now: Date = new Date(),
): FilterCheck {
  if (output.kind === "not_a_search") {
    return { ok: false, reason: "not_a_search", detail: "model: not a search" };
  }

  const keywords = cleanText(output.keywords);
  const author = cleanText(output.author);

  for (const [field, value] of [
    ["keywords", keywords],
    ["author", author],
  ] as const) {
    if (value !== null && value.length > MAX_TEXT) {
      return {
        ok: false,
        reason: "implausible",
        detail: `${field} is ${value.length} characters`,
      };
    }
  }

  // The same plausibility window as Open Library dates in openlibrary.ts.
  const latest = now.getUTCFullYear() + 1;
  for (const [field, year] of [
    ["yearFrom", output.yearFrom],
    ["yearTo", output.yearTo],
  ] as const) {
    if (year !== null && (year < 1000 || year > latest)) {
      return {
        ok: false,
        reason: "implausible",
        detail: `${field} ${year} is outside 1000–${latest}`,
      };
    }
  }

  // Rejected, not swapped. "Between 1990 and 1980" might be a slip, or the
  // model might have mixed up the fields; guessing which is how a wrong filter
  // gets run with confidence.
  if (
    output.yearFrom !== null &&
    output.yearTo !== null &&
    output.yearFrom > output.yearTo
  ) {
    return {
      ok: false,
      reason: "implausible",
      detail: `yearFrom ${output.yearFrom} is after yearTo ${output.yearTo}`,
    };
  }

  const filter: CatalogueFilter = {
    keywords,
    author,
    genre: output.genre,
    yearFrom: output.yearFrom,
    yearTo: output.yearTo,
    availableOnly: output.availableOnly,
  };

  // Every field empty would list the whole catalogue, which is not an answer
  // to anything the user typed. availableOnly alone does count as a search
  // ("what can I borrow right now?"), so it is not part of this test.
  const constrained =
    filter.keywords !== null ||
    filter.author !== null ||
    filter.genre !== null ||
    filter.yearFrom !== null ||
    filter.yearTo !== null ||
    filter.availableOnly;

  if (!constrained) {
    return { ok: false, reason: "not_a_search", detail: "empty filter" };
  }

  return { ok: true, filter };
}

/**
 * What the model understood, as short labels shown above the results. If the
 * interpretation is wrong, this is where the user sees it.
 */
export function describeFilter(
  filter: CatalogueFilter,
  genreNames: ReadonlyMap<string, string> = new Map(),
): string[] {
  const parts: string[] = [];
  if (filter.keywords) parts.push(`About “${filter.keywords}”`);
  if (filter.author) parts.push(`By ${filter.author}`);
  if (filter.genre) parts.push(genreNames.get(filter.genre) ?? filter.genre);

  const { yearFrom, yearTo } = filter;
  if (yearFrom !== null && yearTo !== null) {
    parts.push(
      yearFrom === yearTo ? `Published ${yearFrom}` : `${yearFrom}–${yearTo}`,
    );
  } else if (yearFrom !== null) {
    parts.push(`From ${yearFrom}`);
  } else if (yearTo !== null) {
    parts.push(`Up to ${yearTo}`);
  }

  if (filter.availableOnly) parts.push("Available now");
  return parts;
}

/** The cache key: case, spacing and trailing punctuation do not change meaning. */
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?.!]+$/, "");
}
