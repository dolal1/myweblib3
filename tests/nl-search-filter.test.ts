import { describe, expect, it } from "vitest";

import { costMicroUsd, formatMicroUsd } from "@/lib/catalogue/nl-search/cost";
import {
  buildFilterSchema,
  checkFilter,
  describeFilter,
  normalizeQuery,
  type InterpretedQuery,
} from "@/lib/catalogue/nl-search/filter";

const NOW = new Date("2026-10-19T12:00:00Z");

const base: InterpretedQuery = {
  kind: "search",
  keywords: null,
  author: null,
  genre: null,
  yearFrom: null,
  yearTo: null,
  availableOnly: false,
};

describe("buildFilterSchema", () => {
  it("only accepts genres the library has", () => {
    const schema = buildFilterSchema(["fiction", "poetry"]);
    expect(schema.safeParse({ ...base, genre: "poetry" }).success).toBe(true);
    expect(schema.safeParse({ ...base, genre: "romance" }).success).toBe(false);
  });

  it("forces genre to null when the library has none", () => {
    const schema = buildFilterSchema([]);
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, genre: "fiction" }).success).toBe(false);
  });

  it("rejects fractional years and missing fields", () => {
    const schema = buildFilterSchema([]);
    expect(schema.safeParse({ ...base, yearFrom: 1990.5 }).success).toBe(false);
    const missing: Partial<InterpretedQuery> = { ...base };
    delete missing.availableOnly;
    expect(schema.safeParse(missing).success).toBe(false);
  });
});

describe("checkFilter", () => {
  it("passes a sensible filter through, trimmed", () => {
    const result = checkFilter(
      { ...base, author: "  Chinua   Achebe ", yearFrom: 1960, yearTo: 1969 },
      NOW,
    );
    expect(result).toEqual({
      ok: true,
      filter: {
        keywords: null,
        author: "Chinua Achebe",
        genre: null,
        yearFrom: 1960,
        yearTo: 1969,
        availableOnly: false,
      },
    });
  });

  it("rejects a backwards year range instead of swapping it", () => {
    const result = checkFilter({ ...base, yearFrom: 1990, yearTo: 1980 }, NOW);
    expect(result).toMatchObject({ ok: false, reason: "implausible" });
  });

  it("rejects years outside the plausible window", () => {
    for (const year of [3, 999, 2028, 9999]) {
      expect(checkFilter({ ...base, yearFrom: year }, NOW)).toMatchObject({
        ok: false,
        reason: "implausible",
      });
    }
    // Next year is allowed: forthcoming titles are catalogued early.
    expect(checkFilter({ ...base, yearTo: 2027 }, NOW).ok).toBe(true);
  });

  it("treats an empty filter as not a search", () => {
    expect(checkFilter(base, NOW)).toMatchObject({
      ok: false,
      reason: "not_a_search",
    });
    // Whitespace-only strings are empty too.
    expect(checkFilter({ ...base, keywords: "   " }, NOW)).toMatchObject({
      ok: false,
      reason: "not_a_search",
    });
  });

  it("accepts availableOnly on its own", () => {
    expect(checkFilter({ ...base, availableOnly: true }, NOW).ok).toBe(true);
  });

  it("honours the model saying it is not a search", () => {
    expect(
      checkFilter({ ...base, kind: "not_a_search", keywords: "weather" }, NOW),
    ).toMatchObject({ ok: false, reason: "not_a_search" });
  });

  it("rejects runaway text fields", () => {
    expect(
      checkFilter({ ...base, keywords: "a".repeat(201) }, NOW),
    ).toMatchObject({ ok: false, reason: "implausible" });
  });
});

describe("describeFilter", () => {
  it("labels each constraint, using genre names", () => {
    expect(
      describeFilter(
        {
          keywords: "colonialism",
          author: "Achebe",
          genre: "fiction",
          yearFrom: 1960,
          yearTo: 1969,
          availableOnly: true,
        },
        new Map([["fiction", "Fiction"]]),
      ),
    ).toEqual([
      "About “colonialism”",
      "By Achebe",
      "Fiction",
      "1960–1969",
      "Available now",
    ]);
  });

  it("describes open-ended and single-year ranges", () => {
    const empty = {
      keywords: null,
      author: null,
      genre: null,
      availableOnly: false,
    };
    expect(describeFilter({ ...empty, yearFrom: 1991, yearTo: null })).toEqual([
      "From 1991",
    ]);
    expect(describeFilter({ ...empty, yearFrom: null, yearTo: 1949 })).toEqual([
      "Up to 1949",
    ]);
    expect(describeFilter({ ...empty, yearFrom: 1818, yearTo: 1818 })).toEqual([
      "Published 1818",
    ]);
  });
});

describe("normalizeQuery", () => {
  it("ignores case, spacing and trailing punctuation", () => {
    expect(normalizeQuery("  Books by   ACHEBE?! ")).toBe("books by achebe");
  });
});

describe("costMicroUsd", () => {
  it("prices Haiku 5.5 at $0.10 in / $0.50 out per million tokens", () => {
    // 1,000 in + 200 out = 100 + 100 micro-dollars.
    expect(
      costMicroUsd("claude-haiku-5-5", {
        input_tokens: 1000,
        output_tokens: 200,
      }),
    ).toBe(200);
  });

  it("refuses to guess the price of an unknown model", () => {
    expect(() =>
      costMicroUsd("claude-unknown", { input_tokens: 1, output_tokens: 1 }),
    ).toThrow(/No price configured/);
  });

  it("formats small amounts without rounding them to zero", () => {
    expect(formatMicroUsd(0)).toBe("$0");
    expect(formatMicroUsd(200)).toBe("$0.00020");
    expect(formatMicroUsd(1_250_000)).toBe("$1.25");
  });
});
