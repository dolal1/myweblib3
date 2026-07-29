import "server-only";

import type { AuthorWhereInput } from "@/generated/prisma/models/Author";
import type { BookWhereInput } from "@/generated/prisma/models/Book";
import { db } from "@/lib/db";

/**
 * Catalogue reads.
 *
 * Two habits worth naming, both absent from v2:
 *
 *   1. Every list query is bounded. v2's `/books` route ran `Book.find()` with
 *      no limit and rendered the entire table.
 *   2. Every query selects the columns it needs. Returning whole rows to a
 *      Server Component risks serialising something private into the client
 *      payload the moment a field is added to the model.
 */

export const PAGE_SIZE = 12;

export interface PageParams {
  /** 1-based. */
  page?: number;
}

function offsetFor(page: number): number {
  return (Math.max(1, page) - 1) * PAGE_SIZE;
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
}

export async function listAuthors({
  page = 1,
  query,
}: PageParams & { query?: string } = {}): Promise<
  Paged<{
    id: string;
    name: string;
    sortName: string;
    birthYear: number | null;
    deathYear: number | null;
    bookCount: number;
  }>
> {
  // `contains` with `mode: insensitive` compiles to ILIKE — parameterised, so
  // unlike v2's `new RegExp(req.query.name)` there is nothing to inject and
  // nothing to make catastrophically backtrack.
  const where: AuthorWhereInput = query?.trim()
    ? { name: { contains: query.trim(), mode: "insensitive" } }
    : {};

  const [rows, total] = await Promise.all([
    db.author.findMany({
      where,
      orderBy: { sortName: "asc" },
      skip: offsetFor(page),
      take: PAGE_SIZE,
      select: {
        id: true,
        name: true,
        sortName: true,
        birthYear: true,
        deathYear: true,
        _count: { select: { books: true } },
      },
    }),
    db.author.count({ where }),
  ]);

  return {
    items: rows.map(({ _count, ...author }) => ({
      ...author,
      bookCount: _count.books,
    })),
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    total,
  };
}

export async function getAuthor(id: string) {
  return db.author.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      sortName: true,
      bio: true,
      birthYear: true,
      deathYear: true,
      books: {
        orderBy: { book: { title: "asc" } },
        select: {
          role: true,
          book: {
            select: {
              id: true,
              title: true,
              subtitle: true,
              publishedOn: true,
              _count: { select: { copies: true } },
            },
          },
        },
      },
    },
  });
}

export async function listBooks({
  page = 1,
  query,
}: PageParams & { query?: string } = {}): Promise<
  Paged<{
    id: string;
    title: string;
    subtitle: string | null;
    publishedOn: Date | null;
    authors: string[];
    copyCount: number;
    availableCount: number;
  }>
> {
  const trimmed = query?.trim();
  const where: BookWhereInput = trimmed
    ? {
        OR: [
          { title: { contains: trimmed, mode: "insensitive" } },
          {
            authors: {
              some: {
                author: { name: { contains: trimmed, mode: "insensitive" } },
              },
            },
          },
        ],
      }
    : {};

  const [rows, total] = await Promise.all([
    db.book.findMany({
      where,
      orderBy: { title: "asc" },
      skip: offsetFor(page),
      take: PAGE_SIZE,
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
      },
    }),
    db.book.count({ where }),
  ]);

  return {
    items: rows.map((book) => ({
      id: book.id,
      title: book.title,
      subtitle: book.subtitle,
      publishedOn: book.publishedOn,
      authors: book.authors.map((link) => link.author.name),
      copyCount: book.copies.length,
      availableCount: book.copies.filter((c) => c.status === "AVAILABLE")
        .length,
    })),
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    total,
  };
}

export async function getBook(id: string) {
  const book = await db.book.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      subtitle: true,
      isbn13: true,
      description: true,
      publisher: true,
      publishedOn: true,
      pageCount: true,
      language: true,
      authors: {
        orderBy: { position: "asc" },
        select: { role: true, author: { select: { id: true, name: true } } },
      },
      genres: { select: { id: true, name: true, slug: true } },
      copies: {
        orderBy: { barcode: "asc" },
        select: {
          id: true,
          barcode: true,
          status: true,
          condition: true,
          shelfLocation: true,
          loans: {
            where: { returnedAt: null },
            select: { dueAt: true, member: { select: { name: true } } },
          },
        },
      },
      _count: { select: { holds: true } },
    },
  });

  if (!book) return null;

  // "Is this overdue?" is derived from the current time, so it is computed here
  // rather than in a component. Reading the clock during render is impure —
  // eslint's react-hooks/purity rule flags it, and rightly: it invites
  // server/client hydration mismatches. The data layer is the honest place for
  // it, and the answer travels with the row.
  const now = Date.now();

  return {
    ...book,
    copies: book.copies.map((copy) => {
      const openLoan = copy.loans[0] ?? null;
      return {
        ...copy,
        openLoan: openLoan
          ? {
              dueAt: openLoan.dueAt,
              memberName: openLoan.member.name,
              overdue: openLoan.dueAt.getTime() < now,
            }
          : null,
      };
    }),
  };
}

/** Authors and genres for the book form's selects. */
export async function getBookFormOptions() {
  const [authors, genres] = await Promise.all([
    db.author.findMany({
      orderBy: { sortName: "asc" },
      select: { id: true, name: true },
    }),
    db.genre.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  return { authors, genres };
}
