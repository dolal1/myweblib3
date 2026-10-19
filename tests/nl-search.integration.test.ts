import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CatalogueFilter } from "@/lib/catalogue/nl-search/filter";
import type { InterpretResult } from "@/lib/catalogue/nl-search/interpret";
import { searchByFilter } from "@/lib/catalogue/nl-search/query";
import {
  FEATURE,
  smartSearch,
  spentTodayMicroUsd,
  type Interpreter,
} from "@/lib/catalogue/nl-search/service";
import { db } from "@/lib/db";

/**
 * Smart search against a real Postgres: the filter query, and every branch of
 * the service (cache, budget, member allowance, model failure) with the model
 * replaced by a scripted interpreter. The model itself is covered by the eval.
 */

const PREFIX = "nls-";
const NOW = new Date("2026-10-19T12:00:00Z");

const EMPTY: CatalogueFilter = {
  keywords: null,
  author: null,
  genre: null,
  yearFrom: null,
  yearTo: null,
  availableOnly: false,
};

const METRICS = {
  model: "claude-haiku-5-5",
  latencyMs: 640,
  inputTokens: 900,
  outputTokens: 120,
  costMicroUsd: 150,
};

let userId: string;

async function cleanup() {
  await db.aiCall.deleteMany({
    where: { normalizedQuery: { startsWith: PREFIX } },
  });
  await db.bookCopy.deleteMany({ where: { barcode: { startsWith: PREFIX } } });
  await db.bookAuthor.deleteMany({
    where: { book: { title: { startsWith: PREFIX } } },
  });
  await db.book.deleteMany({ where: { title: { startsWith: PREFIX } } });
  await db.author.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.genre.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await db.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

beforeAll(async () => {
  await cleanup();

  userId = (
    await db.user.create({
      data: {
        email: `${PREFIX}member@test`,
        name: "Member",
        passwordHash: "x",
      },
    })
  ).id;

  const novels = await db.genre.create({
    data: { name: `${PREFIX}Novels`, slug: `${PREFIX}novels` },
  });
  const achebe = await db.author.create({
    data: { name: `${PREFIX}Chinua Achebe`, sortName: `${PREFIX}Achebe` },
  });
  const ngugi = await db.author.create({
    data: { name: `${PREFIX}Ngugi wa Thiongo`, sortName: `${PREFIX}Ngugi` },
  });

  const book = (
    title: string,
    year: number,
    authorId: string,
    description: string,
    copyStatus: "AVAILABLE" | "ON_LOAN",
  ) =>
    db.book.create({
      data: {
        title: `${PREFIX}${title}`,
        description,
        publishedOn: new Date(Date.UTC(year, 5, 1)),
        authors: { create: [{ authorId, role: "AUTHOR" }] },
        genres: { connect: [{ id: novels.id }] },
        copies: {
          create: [
            { barcode: `${PREFIX}${title.slice(0, 8)}`, status: copyStatus },
          ],
        },
      },
    });

  await book(
    "Things Fall Apart",
    1958,
    achebe.id,
    "Colonialism reaches an Igbo village.",
    "AVAILABLE",
  );
  await book(
    "Arrow of God",
    1964,
    achebe.id,
    "A priest resists colonial rule.",
    "ON_LOAN",
  );
  await book(
    "A Man of the People",
    1966,
    achebe.id,
    "Political satire.",
    "AVAILABLE",
  );
  await book(
    "Petals of Blood",
    1977,
    ngugi.id,
    "Corruption after independence.",
    "AVAILABLE",
  );
});

beforeEach(async () => {
  await db.aiCall.deleteMany({
    where: { normalizedQuery: { startsWith: PREFIX } },
  });
});

afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

const titles = (hits: { title: string }[]) =>
  hits.map((h) => h.title.replace(PREFIX, "")).sort();

describe("searchByFilter", () => {
  it("combines author, year range and availability", async () => {
    const result = await searchByFilter({
      ...EMPTY,
      author: `${PREFIX}Achebe`,
      yearFrom: 1960,
      yearTo: 1969,
      availableOnly: true,
    });
    // Arrow of God is in range but on loan; Things Fall Apart is 1958.
    expect(titles(result.hits)).toEqual(["A Man of the People"]);
    expect(result.total).toBe(1);
  });

  it("finds an author despite a misspelling", async () => {
    const result = await searchByFilter({
      ...EMPTY,
      author: `${PREFIX}Chinua Achbe`,
    });
    expect(titles(result.hits)).toEqual([
      "A Man of the People",
      "Arrow of God",
      "Things Fall Apart",
    ]);
  });

  it("matches keywords against descriptions, with stemming", async () => {
    const result = await searchByFilter({
      ...EMPTY,
      keywords: "colonial",
      genre: `${PREFIX}novels`,
    });
    expect(titles(result.hits)).toEqual(["Arrow of God", "Things Fall Apart"]);
  });

  it("treats year bounds as inclusive", async () => {
    const result = await searchByFilter({
      ...EMPTY,
      genre: `${PREFIX}novels`,
      yearFrom: 1958,
      yearTo: 1964,
    });
    expect(titles(result.hits)).toEqual(["Arrow of God", "Things Fall Apart"]);
  });

  it("returns nothing, not the whole catalogue, for an empty filter", async () => {
    await expect(searchByFilter(EMPTY)).resolves.toEqual({
      hits: [],
      total: 0,
    });
  });

  it("binds hostile text as a value", async () => {
    const result = await searchByFilter({
      ...EMPTY,
      author: `'; DROP TABLE "Book"; --`,
      keywords: "( unbalanced &&&",
    });
    expect(result.hits).toEqual([]);
    await expect(db.book.count()).resolves.toBeGreaterThan(0);
  });
});

/** A scripted interpreter that counts how often the "model" was called. */
function interpreter(result: InterpretResult) {
  const calls: string[] = [];
  const fn: Interpreter = async (query) => {
    calls.push(query);
    return result;
  };
  return { fn, calls };
}

const answered = (filter: Partial<CatalogueFilter>): InterpretResult => ({
  ok: true,
  filter: { ...EMPTY, ...filter },
  metrics: METRICS,
});

const run = (query: string, interpret: Interpreter, extra = {}) =>
  smartSearch(
    { query, userId },
    { interpret, enabled: true, dailyBudgetUsd: 1, now: NOW, ...extra },
  );

async function rows() {
  return db.aiCall.findMany({
    where: { normalizedQuery: { startsWith: PREFIX } },
    orderBy: { createdAt: "asc" },
  });
}

describe("smartSearch", () => {
  it("runs the model's filter and logs latency, tokens and cost", async () => {
    const { fn } = interpreter(
      answered({ author: `${PREFIX}Achebe`, availableOnly: true }),
    );
    const result = await run(`${PREFIX}available achebe`, fn);

    expect(result.mode).toBe("ai");
    expect(titles(result.hits)).toEqual([
      "A Man of the People",
      "Things Fall Apart",
    ]);

    const [row] = await rows();
    expect(row).toMatchObject({
      feature: FEATURE,
      userId,
      outcome: "OK",
      model: "claude-haiku-5-5",
      latencyMs: 640,
      inputTokens: 900,
      outputTokens: 120,
      costMicroUsd: 150,
      filter: { author: `${PREFIX}Achebe`, availableOnly: true },
    });
  });

  it("answers a repeated query from the cache without calling the model", async () => {
    const { fn, calls } = interpreter(answered({ author: `${PREFIX}Achebe` }));
    await run(`${PREFIX}Books by Achebe`, fn);
    // Different case and a trailing "?" normalise to the same key.
    const second = await run(`${PREFIX}books by ACHEBE?`, fn);

    expect(calls).toHaveLength(1);
    expect(second).toMatchObject({ mode: "ai", cached: true });
    expect((await rows()).map((r) => [r.outcome, r.costMicroUsd])).toEqual([
      ["OK", 150],
      ["CACHE_HIT", 0],
    ]);
  });

  it("does not cache failures", async () => {
    const { fn, calls } = interpreter({
      ok: false,
      reason: "timeout",
      detail: "request timed out",
      metrics: null,
      latencyMs: 2500,
    });
    await run(`${PREFIX}achebe`, fn);
    await run(`${PREFIX}achebe`, fn);
    expect(calls).toHaveLength(2);
  });

  it("falls back to keyword search when the model fails, and logs why", async () => {
    const { fn } = interpreter({
      ok: false,
      reason: "timeout",
      detail: "request timed out",
      metrics: null,
      latencyMs: 2500,
    });
    const result = await run(`${PREFIX}Things Fall Apart`, fn);

    expect(result).toMatchObject({ mode: "fallback", reason: "timeout" });
    // The keyword search over the original text still finds the book.
    expect(titles(result.hits)).toContain("Things Fall Apart");

    const [row] = await rows();
    expect(row).toMatchObject({
      outcome: "FALLBACK",
      failureReason: "timeout",
      latencyMs: 2500,
      costMicroUsd: 0,
      filter: null,
    });
  });

  it("charges a billed-but-rejected answer to the budget", async () => {
    const { fn } = interpreter({
      ok: false,
      reason: "implausible",
      detail: "yearFrom 1990 is after yearTo 1980",
      metrics: METRICS,
      latencyMs: 640,
    });
    await run(`${PREFIX}books from 1990 to 1980`, fn);
    expect((await rows())[0]).toMatchObject({
      outcome: "FALLBACK",
      failureReason: "implausible",
      costMicroUsd: 150,
    });
  });

  it("stops calling the model once the daily budget is spent", async () => {
    // Pre-load today's spend at exactly the budget.
    await db.aiCall.create({
      data: {
        feature: FEATURE,
        normalizedQuery: `${PREFIX}earlier`,
        promptVersion: "test",
        outcome: "OK",
        costMicroUsd: 1_000_000,
        createdAt: NOW,
      },
    });
    expect(await spentTodayMicroUsd(NOW)).toBeGreaterThanOrEqual(1_000_000);

    const { fn, calls } = interpreter(answered({ author: "x" }));
    const result = await run(`${PREFIX}achebe`, fn);

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ mode: "fallback", reason: "over_budget" });
  });

  it("counts only today, in UTC, against the budget", async () => {
    await db.aiCall.create({
      data: {
        feature: FEATURE,
        normalizedQuery: `${PREFIX}yesterday`,
        promptVersion: "test",
        outcome: "OK",
        costMicroUsd: 5_000_000,
        createdAt: new Date("2026-10-18T23:59:59Z"),
      },
    });
    const { fn, calls } = interpreter(answered({ author: `${PREFIX}Achebe` }));
    await run(`${PREFIX}achebe novels`, fn);
    expect(calls).toHaveLength(1);
  });

  it("does nothing, and logs nothing, when the feature is off", async () => {
    const { fn, calls } = interpreter(answered({ author: "x" }));
    const result = await run(`${PREFIX}Arrow of God`, fn, { enabled: false });

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ mode: "fallback", reason: "disabled" });
    expect(titles(result.hits)).toContain("Arrow of God");
    expect(await rows()).toHaveLength(0);
  });

  it("limits each member per hour, then falls back", async () => {
    const { fn } = interpreter({
      ok: false,
      reason: "unavailable",
      detail: "500",
      metrics: null,
      latencyMs: 10,
    });
    // A member of its own: the limiter is per member and in-process, and the
    // tests above have already spent some of the first member's allowance.
    const fresh = await db.user.create({
      data: { email: `${PREFIX}heavy@test`, name: "Heavy", passwordHash: "x" },
    });
    // Distinct queries so none are cache hits. The allowance is 30.
    const reasons: string[] = [];
    for (let i = 0; i < 31; i++) {
      const result = await smartSearch(
        { query: `${PREFIX}query ${i}`, userId: fresh.id },
        { interpret: fn, enabled: true, dailyBudgetUsd: 1, now: NOW },
      );
      if (result.mode === "fallback") reasons.push(result.reason);
    }
    expect(reasons.at(-1)).toBe("member_rate_limited");
    expect(reasons.filter((r) => r === "member_rate_limited")).toHaveLength(1);
  });
});
