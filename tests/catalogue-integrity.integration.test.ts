import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  isForeignKeyViolation,
  isUniqueViolation,
  violatedCheckConstraint,
} from "@/lib/db-errors";

/**
 * The database's integrity rules, and the code that translates them.
 *
 * These are the claims docs/from-v2.md makes about what v3 fixes, asserted
 * against a live Postgres rather than trusted. The pairing matters: each test
 * both provokes a real database refusal *and* checks that the corresponding
 * helper in lib/db-errors.ts recognises it — because an unrecognised error is
 * how v2 turned a refusal into a silent no-op.
 */

const PREFIX = "integrity-test-";

async function cleanup() {
  await db.loan.deleteMany({
    where: { copy: { barcode: { startsWith: PREFIX } } },
  });
  await db.bookCopy.deleteMany({ where: { barcode: { startsWith: PREFIX } } });
  await db.bookAuthor.deleteMany({
    where: { book: { title: { startsWith: PREFIX } } },
  });
  await db.book.deleteMany({ where: { title: { startsWith: PREFIX } } });
  await db.author.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

async function makeAuthorWithBook() {
  const author = await db.author.create({
    data: { name: `${PREFIX}author`, sortName: `${PREFIX}author` },
  });
  const book = await db.book.create({
    data: {
      title: `${PREFIX}book`,
      authors: { create: [{ authorId: author.id, role: "AUTHOR" }] },
    },
  });
  return { author, book };
}

describe("author deletion is restricted by the database", () => {
  it("refuses to delete an author still credited on a book", async () => {
    const { author } = await makeAuthorWithBook();

    // v2 guarded this with a Mongoose pre('remove') hook that stopped firing
    // in Mongoose 7 — and whose error the delete route swallowed anyway.
    let caught: unknown;
    try {
      await db.author.delete({ where: { id: author.id } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    // The translation layer must recognise it, or the UI shows nothing useful.
    expect(isForeignKeyViolation(caught)).toBe(true);

    // And the author is still there.
    await expect(
      db.author.findUnique({ where: { id: author.id } }),
    ).resolves.not.toBeNull();
  });

  it("reports how many books block the deletion", async () => {
    const { author } = await makeAuthorWithBook();
    // This is the number deleteAuthor puts in its message.
    await expect(
      db.bookAuthor.count({ where: { authorId: author.id } }),
    ).resolves.toBe(1);
  });

  it("allows deletion once the credits are removed", async () => {
    const { author, book } = await makeAuthorWithBook();

    await db.bookAuthor.deleteMany({ where: { bookId: book.id } });
    await expect(
      db.author.delete({ where: { id: author.id } }),
    ).resolves.toBeTruthy();
  });
});

describe("book deletion is restricted by its copies", () => {
  it("refuses to delete a title that still has copies", async () => {
    const { book } = await makeAuthorWithBook();
    await db.bookCopy.create({
      data: { barcode: `${PREFIX}0001`, bookId: book.id },
    });

    let caught: unknown;
    try {
      await db.book.delete({ where: { id: book.id } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(isForeignKeyViolation(caught)).toBe(true);
  });
});

describe("one open loan per copy", () => {
  it("refuses a second concurrent checkout of the same copy", async () => {
    const { book } = await makeAuthorWithBook();
    const copy = await db.bookCopy.create({
      data: { barcode: `${PREFIX}0002`, bookId: book.id },
    });
    const [a, b] = await Promise.all([
      db.user.create({
        data: {
          email: `${PREFIX}a@test`,
          name: "A",
          passwordHash: "x",
        },
      }),
      db.user.create({
        data: {
          email: `${PREFIX}b@test`,
          name: "B",
          passwordHash: "x",
        },
      }),
    ]);

    const dueAt = new Date(Date.now() + 14 * 86_400_000);
    await db.loan.create({ data: { copyId: copy.id, memberId: a.id, dueAt } });

    let caught: unknown;
    try {
      await db.loan.create({
        data: { copyId: copy.id, memberId: b.id, dueAt },
      });
    } catch (error) {
      caught = error;
    }

    // Loan_one_open_per_copy — the partial unique index. No application check
    // can close this race; the database can.
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught)).toBe(true);
  });

  it("permits re-lending after the copy comes back", async () => {
    const { book } = await makeAuthorWithBook();
    const copy = await db.bookCopy.create({
      data: { barcode: `${PREFIX}0003`, bookId: book.id },
    });
    const member = await db.user.create({
      data: { email: `${PREFIX}c@test`, name: "C", passwordHash: "x" },
    });

    const dueAt = new Date(Date.now() + 14 * 86_400_000);
    const first = await db.loan.create({
      data: { copyId: copy.id, memberId: member.id, dueAt },
    });
    await db.loan.update({
      where: { id: first.id },
      data: { returnedAt: new Date() },
    });

    // The index only covers rows WHERE returnedAt IS NULL, so this must work.
    await expect(
      db.loan.create({ data: { copyId: copy.id, memberId: member.id, dueAt } }),
    ).resolves.toBeTruthy();
  });
});

describe("check constraints", () => {
  it("rejects a malformed ISBN and names the constraint", async () => {
    let caught: unknown;
    try {
      await db.book.create({
        data: { title: `${PREFIX}bad-isbn`, isbn13: "12345" },
      });
    } catch (error) {
      caught = error;
    }
    expect(violatedCheckConstraint(caught)).toBe("Book_isbn13_format");
  });

  it("rejects a non-positive page count", async () => {
    let caught: unknown;
    try {
      await db.book.create({
        data: { title: `${PREFIX}bad-pages`, pageCount: 0 },
      });
    } catch (error) {
      caught = error;
    }
    expect(violatedCheckConstraint(caught)).toBe("Book_page_count_positive");
  });

  it("rejects a negative fine", async () => {
    const { book } = await makeAuthorWithBook();
    const copy = await db.bookCopy.create({
      data: { barcode: `${PREFIX}0004`, bookId: book.id },
    });
    const member = await db.user.create({
      data: { email: `${PREFIX}d@test`, name: "D", passwordHash: "x" },
    });
    const loan = await db.loan.create({
      data: {
        copyId: copy.id,
        memberId: member.id,
        dueAt: new Date(Date.now() + 86_400_000),
      },
    });

    let caught: unknown;
    try {
      await db.fine.create({ data: { loanId: loan.id, amountCents: -100 } });
    } catch (error) {
      caught = error;
    }
    expect(violatedCheckConstraint(caught)).toBe("Fine_amount_non_negative");
  });

  it("rejects a duplicate author name", async () => {
    await db.author.create({
      data: { name: `${PREFIX}dupe`, sortName: `${PREFIX}dupe` },
    });

    let caught: unknown;
    try {
      await db.author.create({
        data: { name: `${PREFIX}dupe`, sortName: `${PREFIX}dupe` },
      });
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught)).toBe(true);
  });
});

describe("many-to-many authorship", () => {
  it("records a book with two authors, which v2 could not represent", async () => {
    const [one, two] = await Promise.all([
      db.author.create({
        data: { name: `${PREFIX}one`, sortName: `${PREFIX}one` },
      }),
      db.author.create({
        data: { name: `${PREFIX}two`, sortName: `${PREFIX}two` },
      }),
    ]);

    const book = await db.book.create({
      data: {
        title: `${PREFIX}co-authored`,
        authors: {
          create: [
            { authorId: one.id, role: "AUTHOR", position: 0 },
            { authorId: two.id, role: "AUTHOR", position: 1 },
          ],
        },
      },
      include: { authors: { orderBy: { position: "asc" } } },
    });

    expect(book.authors).toHaveLength(2);
    expect(book.authors[0]?.authorId).toBe(one.id);
    expect(book.authors[1]?.authorId).toBe(two.id);
  });

  it("distinguishes contribution roles on the same book", async () => {
    const author = await db.author.create({
      data: { name: `${PREFIX}multi`, sortName: `${PREFIX}multi` },
    });

    // The composite primary key is (bookId, authorId, role), so one person can
    // be both author and translator of the same title.
    const book = await db.book.create({
      data: {
        title: `${PREFIX}two-roles`,
        authors: {
          create: [
            { authorId: author.id, role: "AUTHOR" },
            { authorId: author.id, role: "TRANSLATOR" },
          ],
        },
      },
      include: { authors: true },
    });

    expect(book.authors).toHaveLength(2);
    expect(book.authors.map((a) => a.role).sort()).toEqual([
      "AUTHOR",
      "TRANSLATOR",
    ]);
  });
});
