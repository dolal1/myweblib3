import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hydrateBookHits, searchBooks } from "@/lib/catalogue/search";
import { db } from "@/lib/db";

/**
 * Full-text search against a real Postgres.
 *
 * These have to be integration tests — the whole mechanism is generated
 * `tsvector` columns, GIN indexes, `websearch_to_tsquery`, and `ts_rank`. None
 * of that exists outside the database, so there is nothing meaningful to unit
 * test.
 */

const PREFIX = "srch-";

async function cleanup() {
  await db.bookAuthor.deleteMany({
    where: { book: { title: { startsWith: PREFIX } } },
  });
  await db.book.deleteMany({ where: { title: { startsWith: PREFIX } } });
  await db.author.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

beforeAll(async () => {
  await cleanup();

  const shelley = await db.author.create({
    data: { name: `${PREFIX}Mary Shelley`, sortName: `${PREFIX}Shelley` },
  });
  const lovelace = await db.author.create({
    data: { name: `${PREFIX}Ada Lovelace`, sortName: `${PREFIX}Lovelace` },
  });

  await db.book.create({
    data: {
      title: `${PREFIX}Frankenstein`,
      subtitle: "or, The Modern Prometheus",
      description:
        "A scientist assembles a living creature from dead tissue and then " +
        "abandons it to the world.",
      publisher: "Lackington",
      authors: { create: [{ authorId: shelley.id, role: "AUTHOR" }] },
    },
  });

  await db.book.create({
    data: {
      title: `${PREFIX}Notes on the Analytical Engine`,
      description:
        "Contains the first published algorithm intended to be carried out " +
        "by a machine.",
      authors: { create: [{ authorId: lovelace.id, role: "AUTHOR" }] },
    },
  });

  // A book whose *description* mentions Frankenstein, so ranking has something
  // to get right: the title match must outrank this one.
  await db.book.create({
    data: {
      title: `${PREFIX}A History of Gothic Fiction`,
      description:
        "Surveys the genre, giving particular attention to Frankenstein and " +
        "its many imitators.",
      authors: { create: [{ authorId: shelley.id, role: "EDITOR" }] },
    },
  });
});

afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

/**
 * Restrict assertions to this suite's fixtures, ignoring seeded data. Generic
 * so it preserves the element type rather than widening to { title }.
 */
const mine = <T extends { title: string }>(hits: T[]): T[] =>
  hits.filter((hit) => hit.title.startsWith(PREFIX));

describe("searchBooks", () => {
  it("finds a book by a word in its title", async () => {
    const result = await searchBooks({ query: "Frankenstein" });
    const titles = mine(result.hits).map((h) => h.title);
    expect(titles).toContain(`${PREFIX}Frankenstein`);
  });

  it("ranks a title match above a description match", async () => {
    // This is the reason for setweight() in the generated column, and the
    // reason ILIKE was not good enough.
    const result = await searchBooks({ query: "Frankenstein" });
    const ours = mine(result.hits);

    const titleIndex = ours.findIndex(
      (h) => h.title === `${PREFIX}Frankenstein`,
    );
    const descIndex = ours.findIndex(
      (h) => h.title === `${PREFIX}A History of Gothic Fiction`,
    );

    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(descIndex).toBeGreaterThanOrEqual(0);
    expect(titleIndex).toBeLessThan(descIndex);
  });

  it("finds a book by a word only in its description", async () => {
    const result = await searchBooks({ query: "algorithm" });
    expect(mine(result.hits).map((h) => h.title)).toContain(
      `${PREFIX}Notes on the Analytical Engine`,
    );
  });

  it("finds books by author name, across the table boundary", async () => {
    // Author names cannot live in the book's generated column, so this is the
    // unioned subquery doing its job.
    const result = await searchBooks({ query: "Lovelace" });
    expect(mine(result.hits).map((h) => h.title)).toContain(
      `${PREFIX}Notes on the Analytical Engine`,
    );
  });

  it("stems, so 'assembling' matches 'assembles'", async () => {
    const result = await searchBooks({ query: "assembling creature" });
    expect(mine(result.hits).map((h) => h.title)).toContain(
      `${PREFIX}Frankenstein`,
    );
  });

  it("supports quoted phrases", async () => {
    const hit = await searchBooks({ query: '"analytical engine"' });
    expect(mine(hit.hits).map((h) => h.title)).toContain(
      `${PREFIX}Notes on the Analytical Engine`,
    );

    // The same two words in the wrong order must not match: websearch parses
    // a quoted phrase into an order-sensitive `'analyt' <-> 'engin'`.
    const miss = await searchBooks({ query: '"engine analytical"' });
    expect(mine(miss.hits).map((h) => h.title)).not.toContain(
      `${PREFIX}Notes on the Analytical Engine`,
    );
    // And crucially the trigram fallback must not rescue it. An explicit
    // phrase search is a request for precision; answering it with
    // similar-looking characters would silently defeat the phrase.
    expect(miss.usedFuzzyFallback).toBe(false);
  });

  it("skips the fuzzy fallback for queries using explicit operators", async () => {
    for (const query of [
      `"${PREFIX}Frankenstien"`,
      `${PREFIX}Frankenstien -gothic`,
    ]) {
      const result = await searchBooks({ query });
      expect(result.usedFuzzyFallback).toBe(false);
    }
  });

  it("does not mistake a hyphenated word for an exclusion", async () => {
    // `srch-Frankenstien` contains a hyphen but no negation. Treating any
    // hyphen as an operator disabled typo tolerance for every hyphenated
    // title — "Spider-Man", "e-book", "Wells-Barnett".
    const result = await searchBooks({ query: `${PREFIX}Frankenstien` });
    expect(result.usedFuzzyFallback).toBe(true);
  });

  it("supports negation with a leading dash", async () => {
    const result = await searchBooks({ query: "Frankenstein -gothic" });
    const titles = mine(result.hits).map((h) => h.title);
    expect(titles).toContain(`${PREFIX}Frankenstein`);
    expect(titles).not.toContain(`${PREFIX}A History of Gothic Fiction`);
  });

  it("returns nothing for an empty query rather than everything", async () => {
    for (const query of ["", "   "]) {
      const result = await searchBooks({ query });
      expect(result.hits).toHaveLength(0);
      expect(result.total).toBe(0);
    }
  });

  it("treats a ReDoS payload as inert input", async () => {
    // `.*(a+)+$` in v2's search box compiled straight into new RegExp() and
    // pinned a CPU. Here it is just a string of punctuation with no lexemes.
    const result = await searchBooks({ query: ".*(a+)+$" });
    expect(Array.isArray(result.hits)).toBe(true);
  });

  it("survives characters that would break naive SQL or tsquery", async () => {
    // Every value is a bound parameter, and websearch_to_tsquery does not throw
    // on malformed input the way to_tsquery does.
    for (const query of [
      '\'; DROP TABLE "Book"; --',
      "&&&",
      "!!!",
      "( unbalanced",
      "\\",
      "café ☕",
    ]) {
      const result = await searchBooks({ query });
      expect(Array.isArray(result.hits)).toBe(true);
    }

    // And the table is still there.
    await expect(db.book.count()).resolves.toBeGreaterThan(0);
  });

  it("falls back to trigram similarity for a typo", async () => {
    const result = await searchBooks({ query: `${PREFIX}Frankenstien` });
    expect(result.usedFuzzyFallback).toBe(true);
    expect(result.hits.map((h) => h.title)).toContain(`${PREFIX}Frankenstein`);
    expect(result.hits.every((h) => h.matchedOn === "fuzzy")).toBe(true);
  });

  it("does not use the fallback when full-text already matched", async () => {
    const result = await searchBooks({ query: "Frankenstein" });
    expect(result.usedFuzzyFallback).toBe(false);
    expect(mine(result.hits).every((h) => h.matchedOn === "text")).toBe(true);
  });

  it("gives up rather than returning nonsense", async () => {
    const result = await searchBooks({
      query: "zzzzqqqxxx-no-such-title-anywhere",
    });
    expect(result.hits).toHaveLength(0);
    expect(result.usedFuzzyFallback).toBe(false);
  });

  it("paginates without repeating or dropping rows", async () => {
    const all = await searchBooks({
      query: PREFIX.replace("-", ""),
      limit: 50,
    });
    if (all.hits.length < 2) return; // fixtures changed; nothing to assert

    const first = await searchBooks({
      query: PREFIX.replace("-", ""),
      limit: 1,
      offset: 0,
    });
    const second = await searchBooks({
      query: PREFIX.replace("-", ""),
      limit: 1,
      offset: 1,
    });

    expect(first.hits).toHaveLength(1);
    expect(second.hits).toHaveLength(1);
    expect(first.hits[0]?.id).not.toBe(second.hits[0]?.id);
    // total is the full match count, independent of the page window.
    expect(first.total).toBe(second.total);
    expect(first.total).toBeGreaterThanOrEqual(2);
  });

  it("returns descending ranks", async () => {
    const result = await searchBooks({ query: "Frankenstein" });
    const ranks = result.hits.map((h) => h.rank);
    const sorted = [...ranks].sort((a, b) => b - a);
    expect(ranks).toEqual(sorted);
  });
});

describe("hydrateBookHits", () => {
  it("preserves the search ordering", async () => {
    const result = await searchBooks({ query: "Frankenstein" });
    const hydrated = await hydrateBookHits(result.hits);

    expect(hydrated.map((h) => h.id)).toEqual(result.hits.map((h) => h.id));
  });

  it("attaches authors and availability", async () => {
    const result = await searchBooks({ query: "Frankenstein" });
    const hydrated = await hydrateBookHits(result.hits);
    const frankenstein = hydrated.find(
      (h) => h.title === `${PREFIX}Frankenstein`,
    );

    expect(frankenstein).toBeDefined();
    expect(frankenstein?.authors).toContain(`${PREFIX}Mary Shelley`);
    expect(typeof frankenstein?.availableCount).toBe("number");
  });

  it("handles an empty hit list without querying", async () => {
    await expect(hydrateBookHits([])).resolves.toEqual([]);
  });
});
