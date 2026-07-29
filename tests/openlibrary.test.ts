import { describe, expect, it, vi } from "vitest";

import {
  explainLookupFailure,
  lookupByIsbn,
  parsePublishDate,
} from "@/lib/catalogue/openlibrary";

/**
 * Open Library client, with a stubbed fetch.
 *
 * Deliberately never hits the network: a test suite that depends on somebody
 * else's uptime fails for reasons that have nothing to do with the code. The
 * failure paths — timeout, 500, HTML error page, malformed JSON — matter more
 * here than the happy path, and can only be exercised with a stub.
 */

const ISBN_13 = "9780141439471";
const BIBKEY = `ISBN:${ISBN_13}`;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const fullRecord = {
  [BIBKEY]: {
    title: "Frankenstein",
    subtitle: "or, The Modern Prometheus",
    number_of_pages: 280,
    publish_date: "1818",
    authors: [{ name: "Mary Wollstonecraft Shelley" }],
    publishers: [{ name: "Penguin Classics" }],
    cover: {
      small: "https://covers.example/s.jpg",
      medium: "https://covers.example/m.jpg",
      large: "https://covers.example/l.jpg",
    },
  },
};

describe("lookupByIsbn", () => {
  it("maps a full record onto our shape", async () => {
    const result = await lookupByIsbn(ISBN_13, async () =>
      jsonResponse(fullRecord),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      isbn13: ISBN_13,
      title: "Frankenstein",
      subtitle: "or, The Modern Prometheus",
      authorNames: ["Mary Wollstonecraft Shelley"],
      publisher: "Penguin Classics",
      publishedOn: "1818-01-01",
      pageCount: 280,
      coverUrl: "https://covers.example/l.jpg",
    });
  });

  it("accepts a hyphenated ISBN-10 and queries the ISBN-13", async () => {
    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      // The request must use the normalised 13-digit form.
      expect(String(url)).toContain("9780743273565");
      return jsonResponse({
        "ISBN:9780743273565": { title: "The Great Gatsby" },
      });
    });

    const result = await lookupByIsbn("0-7432-7356-7", fetchSpy as never);
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("rejects a bad ISBN without making a request", async () => {
    const fetchSpy = vi.fn();
    const result = await lookupByIsbn("12345", fetchSpy as never);

    expect(result).toEqual({ ok: false, reason: "invalid-isbn" });
    // No point troubling someone else's server with input we know is wrong.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports not-found for the empty object Open Library returns", async () => {
    // It answers 200 with {} for an unknown ISBN rather than a 404.
    const result = await lookupByIsbn(ISBN_13, async () => jsonResponse({}));
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("reports not-found when the record has no title", async () => {
    const result = await lookupByIsbn(ISBN_13, async () =>
      jsonResponse({ [BIBKEY]: { number_of_pages: 280 } }),
    );
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("degrades gracefully on a 500", async () => {
    const result = await lookupByIsbn(ISBN_13, async () =>
      jsonResponse({ error: "boom" }, 500),
    );
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("degrades gracefully when the connection fails", async () => {
    const result = await lookupByIsbn(ISBN_13, async () => {
      throw new TypeError("fetch failed");
    });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("degrades gracefully on a timeout", async () => {
    const result = await lookupByIsbn(ISBN_13, async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("degrades gracefully on an HTML error page", async () => {
    // A proxy returning HTML is the classic way a JSON client explodes.
    const result = await lookupByIsbn(
      ISBN_13,
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token '<'");
          },
        }) as unknown as Response,
    );
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("degrades gracefully when the payload has the wrong shape", async () => {
    for (const payload of [
      null,
      "a string",
      42,
      [1, 2, 3],
      { [BIBKEY]: { title: 12345 } },
      { [BIBKEY]: { title: "ok", authors: "not-an-array" } },
    ]) {
      const result = await lookupByIsbn(ISBN_13, async () =>
        jsonResponse(payload),
      );
      expect(result.ok).toBe(false);
    }
  });

  it("passes an abort signal, so a hung server cannot hang the form", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse(fullRecord);
    });

    await lookupByIsbn(ISBN_13, fetchSpy as never);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("copes with a record missing every optional field", async () => {
    const result = await lookupByIsbn(ISBN_13, async () =>
      jsonResponse({ [BIBKEY]: { title: "Bare Minimum" } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.title).toBe("Bare Minimum");
    expect(result.data.authorNames).toEqual([]);
    expect(result.data.publisher).toBeUndefined();
    expect(result.data.pageCount).toBeUndefined();
    expect(result.data.coverUrl).toBeUndefined();
  });

  it("prefers the largest available cover", async () => {
    const result = await lookupByIsbn(ISBN_13, async () =>
      jsonResponse({
        [BIBKEY]: {
          title: "T",
          cover: { small: "https://c/s.jpg", medium: "https://c/m.jpg" },
        },
      }),
    );
    if (result.ok) expect(result.data.coverUrl).toBe("https://c/m.jpg");
  });

  it("rejects a negative or zero page count from upstream", async () => {
    // The schema requires a positive int, matching Book_page_count_positive.
    const result = await lookupByIsbn(ISBN_13, async () =>
      jsonResponse({ [BIBKEY]: { title: "T", number_of_pages: 0 } }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("parsePublishDate", () => {
  it("expands a bare year to January 1st", () => {
    expect(parsePublishDate("1818")).toBe("1818-01-01");
    expect(parsePublishDate("  1945  ")).toBe("1945-01-01");
  });

  it("parses a full date", () => {
    expect(parsePublishDate("Jan 01, 1818")).toBe("1818-01-01");
    expect(parsePublishDate("1818-03-11")).toBe("1818-03-11");
    expect(parsePublishDate("1 January 1818")).toBe("1818-01-01");
    expect(parsePublishDate("January 1 1818")).toBe("1818-01-01");
    expect(parsePublishDate("March 1818")).toBe("1818-03-01");
  });

  it("builds dates in UTC, not local time", () => {
    // Date.parse("Jan 01, 1818") is interpreted locally, so on a UTC+3 machine
    // it became 1817-12-31 once round-tripped through toISOString.
    expect(parsePublishDate("Jan 01, 1818")).toBe("1818-01-01");
    expect(parsePublishDate("Dec 31, 1999")).toBe("1999-12-31");
  });

  it("rejects impossible calendar dates instead of rolling them over", () => {
    // new Date(Date.UTC(2001, 1, 31)) silently becomes 3 March.
    expect(parsePublishDate("2001-02-31")).toBeUndefined();
    expect(parsePublishDate("1818-13-01")).toBeUndefined();
  });

  it("drops anything it cannot parse rather than guessing", () => {
    // A wrong date silently entering the catalogue is worse than a blank one.
    for (const raw of [
      undefined,
      "",
      "no idea",
      "circa 1818",
      "18th century",
    ]) {
      expect(parsePublishDate(raw)).toBeUndefined();
    }
  });

  it("rejects implausible years", () => {
    expect(parsePublishDate("0001")).toBeUndefined();
    expect(parsePublishDate("9999")).toBeUndefined();
  });

  it("always returns a value the date input accepts", () => {
    for (const raw of ["1818", "Jan 01, 1900", "2001-09-11"]) {
      const parsed = parsePublishDate(raw);
      expect(parsed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("explainLookupFailure", () => {
  it("explains each reason in prose", () => {
    for (const reason of [
      "invalid-isbn",
      "not-found",
      "unavailable",
    ] as const) {
      const message = explainLookupFailure(reason);
      expect(message.length).toBeGreaterThan(15);
      expect(message).toMatch(/[.!]$/);
    }
  });
});
