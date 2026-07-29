import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

/**
 * Catalogue search.
 *
 * This finally uses the generated `tsvector` columns and GIN indexes added in
 * the constraints_and_search migration. Until now the book list fell back to
 * `ILIKE`, which works but cannot rank.
 *
 * Three things are going on:
 *
 *   1. `websearch_to_tsquery` parses what people actually type — quoted
 *      phrases, `or`, and leading `-` for exclusion — and never throws on
 *      malformed input. Compare v2, which passed the raw query string to
 *      `new RegExp()`: unindexable, and `.*(a+)+$` was a denial of service.
 *   2. Title is weighted `A` and description `B` in the stored vector, so
 *      `ts_rank` puts a title match above a passing mention in a blurb.
 *   3. Author names live in a different table, so they cannot be part of the
 *      book's generated column. They are searched separately and unioned in.
 *
 * Raw SQL is unavoidable here — Prisma has no way to express `@@` or
 * `ts_rank` — so every value is passed as a bound parameter via Prisma.sql
 * rather than interpolated. `searchVector` is declared `Unsupported` in the
 * schema precisely because it is only ever touched from here.
 */

export interface SearchHit {
  id: string;
  title: string;
  subtitle: string | null;
  publishedOn: Date | null;
  rank: number;
  matchedOn: "text" | "fuzzy";
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  /** True when full-text found nothing and the trigram fallback was used. */
  usedFuzzyFallback: boolean;
}

/** Rows the raw queries return, before shaping. */
interface RawHit {
  id: string;
  title: string;
  subtitle: string | null;
  publishedOn: Date | null;
  rank: number;
}

interface CountRow {
  count: bigint;
}

/**
 * Minimum trigram similarity for the fuzzy fallback. Below roughly this,
 * matches stop feeling like typos and start feeling like coincidences.
 */
const FUZZY_THRESHOLD = 0.3;

/**
 * Whether the trigram fallback is appropriate for this query.
 *
 * It is not, when the user has used an explicit operator. A quoted phrase or a
 * `-exclusion` is a request for precision, and answering it with "here are some
 * titles with similar characters" ignores what was asked. Without this guard,
 * searching `"engine analytical"` — which correctly matches nothing, because
 * phrase order matters — fell through to trigram and returned
 * "Notes on the Analytical Engine" anyway, quietly defeating the phrase search.
 */
function fuzzyFallbackAppropriate(query: string): boolean {
  const hasPhrase = query.includes('"');

  // Negation is a hyphen that *begins a term*, not any hyphen anywhere. An
  // earlier version tested `query.includes("-")`, which misread hyphenated
  // words — "Spider-Man", "e-book", "Wells-Barnett" — as exclusions and
  // disabled typo tolerance for all of them.
  const hasNegation = /(^|\s)-\S/.test(query);

  // A bare `or` is left alone deliberately: unlike a phrase or an exclusion, it
  // only widens the query, so falling back does not contradict what was asked.
  return !hasPhrase && !hasNegation;
}

export async function searchBooks({
  query,
  limit = 12,
  offset = 0,
}: {
  query: string;
  limit?: number;
  offset?: number;
}): Promise<SearchResult> {
  const trimmed = query.trim();
  if (trimmed === "") {
    return { hits: [], total: 0, usedFuzzyFallback: false };
  }

  const [rows, countRows] = await Promise.all([
    db.$queryRaw<RawHit[]>(Prisma.sql`
      SELECT b.id,
             b.title,
             b.subtitle,
             b."publishedOn",
             GREATEST(
               ts_rank(b."searchVector", q.tsq),
               COALESCE(a.author_rank, 0)
             ) AS rank
      FROM "Book" b
      CROSS JOIN websearch_to_tsquery('english', ${trimmed}) AS q(tsq)
      LEFT JOIN (
        SELECT ba."bookId", MAX(ts_rank(au."searchVector", q2.tsq)) AS author_rank
        FROM "BookAuthor" ba
        JOIN "Author" au ON au.id = ba."authorId"
        CROSS JOIN websearch_to_tsquery('english', ${trimmed}) AS q2(tsq)
        WHERE au."searchVector" @@ q2.tsq
        GROUP BY ba."bookId"
      ) a ON a."bookId" = b.id
      WHERE b."searchVector" @@ q.tsq OR a."bookId" IS NOT NULL
      ORDER BY rank DESC, b.title ASC
      LIMIT ${limit} OFFSET ${offset}
    `),
    db.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "Book" b
      CROSS JOIN websearch_to_tsquery('english', ${trimmed}) AS q(tsq)
      LEFT JOIN (
        SELECT DISTINCT ba."bookId"
        FROM "BookAuthor" ba
        JOIN "Author" au ON au.id = ba."authorId"
        CROSS JOIN websearch_to_tsquery('english', ${trimmed}) AS q2(tsq)
        WHERE au."searchVector" @@ q2.tsq
      ) a ON a."bookId" = b.id
      WHERE b."searchVector" @@ q.tsq OR a."bookId" IS NOT NULL
    `),
  ]);

  if (rows.length > 0) {
    return {
      hits: rows.map((row) => ({ ...row, matchedOn: "text" as const })),
      total: Number(countRows[0]?.count ?? 0),
      usedFuzzyFallback: false,
    };
  }

  if (!fuzzyFallbackAppropriate(trimmed)) {
    return { hits: [], total: 0, usedFuzzyFallback: false };
  }

  // Nothing matched. Before giving up, try trigram similarity — "Frankenstien"
  // should still find Frankenstein. This is what the Book_title_trgm_idx GIN
  // index is for.
  const fuzzy = await db.$queryRaw<RawHit[]>(Prisma.sql`
    SELECT b.id,
           b.title,
           b.subtitle,
           b."publishedOn",
           similarity(b.title, ${trimmed}) AS rank
    FROM "Book" b
    WHERE similarity(b.title, ${trimmed}) > ${FUZZY_THRESHOLD}
    ORDER BY rank DESC, b.title ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    hits: fuzzy.map((row) => ({ ...row, matchedOn: "fuzzy" as const })),
    total: fuzzy.length,
    usedFuzzyFallback: fuzzy.length > 0,
  };
}

/**
 * Hydrates search hits with the fields the list view needs.
 *
 * Two queries rather than one enormous join: the raw search decides *which*
 * books and in what order, then Prisma loads the rest with proper types. The
 * ordering from the first query is preserved.
 */
export async function hydrateBookHits(hits: SearchHit[]) {
  if (hits.length === 0) return [];

  const books = await db.book.findMany({
    where: { id: { in: hits.map((hit) => hit.id) } },
    select: {
      id: true,
      title: true,
      subtitle: true,
      publishedOn: true,
      authors: {
        orderBy: { position: "asc" },
        select: { author: { select: { name: true } } },
      },
      copies: { select: { status: true } },
      cover: { select: { storageKey: true, width: true, height: true } },
    },
  });

  const byId = new Map(books.map((book) => [book.id, book]));

  return hits.flatMap((hit) => {
    const book = byId.get(hit.id);
    if (!book) return [];
    return [
      {
        id: book.id,
        title: book.title,
        subtitle: book.subtitle,
        publishedOn: book.publishedOn,
        authors: book.authors.map((link) => link.author.name),
        copyCount: book.copies.length,
        availableCount: book.copies.filter((c) => c.status === "AVAILABLE")
          .length,
        cover: book.cover,
        matchedOn: hit.matchedOn,
      },
    ];
  });
}
