import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

import type { SearchHit } from "../search";
import type { CatalogueFilter } from "./filter";

/**
 * Runs a validated CatalogueFilter.
 *
 * The model never writes SQL and never sees the database. It produces a filter
 * object; this file turns each field into a fixed SQL fragment with the value
 * bound as a parameter. The worst a hostile query can do is fill in fields of
 * a filter.
 *
 * Matching rules per field:
 *   - keywords: the same websearch_to_tsquery + ts_rank as keyword search.
 *   - author: full-text on the author name, or trigram word similarity so
 *     "Achbe" still finds Achebe. Fuzzy here, unlike titles, because people
 *     misspell names far more often than they misspell what a book is about.
 *   - genre: exact slug, which the schema already restricted to real genres.
 *   - years: inclusive, on publishedOn. Books with no date are excluded once
 *     a year bound is set, since nothing is known about them.
 *   - availableOnly: at least one copy on the shelf now.
 */

const AUTHOR_SIMILARITY = 0.5;

function conditions(filter: CatalogueFilter): Prisma.Sql[] {
  const where: Prisma.Sql[] = [];

  if (filter.keywords) {
    where.push(
      Prisma.sql`b."searchVector" @@ websearch_to_tsquery('english', ${filter.keywords})`,
    );
  }

  if (filter.author) {
    where.push(Prisma.sql`EXISTS (
      SELECT 1
      FROM "BookAuthor" ba
      JOIN "Author" au ON au.id = ba."authorId"
      WHERE ba."bookId" = b.id
        AND (au."searchVector" @@ websearch_to_tsquery('english', ${filter.author})
             OR word_similarity(${filter.author}, au.name) > ${AUTHOR_SIMILARITY})
    )`);
  }

  if (filter.genre) {
    where.push(Prisma.sql`EXISTS (
      SELECT 1
      FROM "_BookToGenre" bg
      JOIN "Genre" g ON g.id = bg."B"
      WHERE bg."A" = b.id AND g.slug = ${filter.genre}
    )`);
  }

  if (filter.yearFrom !== null) {
    where.push(
      Prisma.sql`b."publishedOn" >= make_date(${filter.yearFrom}::int, 1, 1)`,
    );
  }
  if (filter.yearTo !== null) {
    where.push(
      Prisma.sql`b."publishedOn" < make_date(${filter.yearTo + 1}::int, 1, 1)`,
    );
  }

  if (filter.availableOnly) {
    where.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "BookCopy" c
      WHERE c."bookId" = b.id AND c.status = 'AVAILABLE'
    )`);
  }

  return where;
}

export async function searchByFilter(
  filter: CatalogueFilter,
  { limit = 12, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<{ hits: SearchHit[]; total: number }> {
  const where = conditions(filter);
  // checkFilter never passes an empty filter, but an empty WHERE here would
  // return the whole catalogue, so this does not rely on it.
  if (where.length === 0) return { hits: [], total: 0 };

  const whereSql = Prisma.join(where, " AND ");
  const rank = filter.keywords
    ? Prisma.sql`ts_rank(b."searchVector", websearch_to_tsquery('english', ${filter.keywords}))`
    : Prisma.sql`0::real`;

  const [rows, countRows] = await Promise.all([
    db.$queryRaw<Omit<SearchHit, "matchedOn">[]>(Prisma.sql`
      SELECT b.id, b.title, b.subtitle, b."publishedOn", ${rank} AS rank
      FROM "Book" b
      WHERE ${whereSql}
      ORDER BY rank DESC, b.title ASC
      LIMIT ${limit} OFFSET ${offset}
    `),
    db.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count FROM "Book" b WHERE ${whereSql}
    `),
  ]);

  return {
    hits: rows.map((row) => ({ ...row, matchedOn: "text" as const })),
    total: Number(countRows[0]?.count ?? 0),
  };
}
