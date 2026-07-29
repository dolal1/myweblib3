import { describe, expect, it } from "vitest";

import {
  formatIsbn13,
  isValidIsbn10,
  isValidIsbn13,
  isbn10To13,
  toIsbn13,
} from "@/lib/catalogue/isbn";

// Real ISBNs, so the checksums are genuine rather than reverse-engineered from
// my own implementation.
const FRANKENSTEIN_13 = "9780141439471";
const GATSBY_10 = "0743273567";

describe("isValidIsbn13", () => {
  it("accepts a real ISBN-13", () => {
    expect(isValidIsbn13(FRANKENSTEIN_13)).toBe(true);
  });

  it("rejects a wrong check digit", () => {
    expect(isValidIsbn13("9780141439472")).toBe(false);
    expect(isValidIsbn13("9780141439470")).toBe(false);
  });

  it("catches a transposition of digits that do not differ by 5", () => {
    // 9780141439471 -> swap the 1 and 4 at indices 4 and 5.
    expect(isValidIsbn13("9780141439471")).toBe(true);
    expect(isValidIsbn13("9780411439471")).toBe(false);
  });

  it("is blind to transposed digits differing by exactly 5", () => {
    // Not a bug in this code — a documented property of the ISBN-13 checksum.
    // Adjacent positions carry weights 1 and 3, so swapping d1 and d2 changes
    // the sum by 2*(d1-d2); when |d1-d2| == 5 that is 10, which vanishes mod
    // 10. Here the 9 and 4 at indices 9 and 10 are swapped and the checksum
    // still passes.
    //
    // Worth pinning in a test so nobody "fixes" the checksum to catch it, and
    // as a reminder that a valid ISBN is not necessarily the right ISBN.
    expect(isValidIsbn13("9780141439471")).toBe(true);
    expect(isValidIsbn13("9780141434971")).toBe(true);
  });

  it("rejects wrong lengths and non-digits", () => {
    expect(isValidIsbn13("978014143947")).toBe(false);
    expect(isValidIsbn13("97801414394712")).toBe(false);
    expect(isValidIsbn13("978014143947X")).toBe(false);
    expect(isValidIsbn13("")).toBe(false);
  });
});

describe("isValidIsbn10", () => {
  it("accepts a real ISBN-10", () => {
    expect(isValidIsbn10(GATSBY_10)).toBe(true);
  });

  it("accepts an X check digit", () => {
    // 043942089X — Harry Potter and the Philosopher's Stone.
    expect(isValidIsbn10("043942089X")).toBe(true);
  });

  it("rejects a bad check digit", () => {
    expect(isValidIsbn10("0743273568")).toBe(false);
  });

  it("rejects X anywhere but the final position", () => {
    expect(isValidIsbn10("X743273567")).toBe(false);
  });
});

describe("isbn10To13", () => {
  it("prefixes 978 and recomputes the check digit", () => {
    const converted = isbn10To13(GATSBY_10);
    expect(converted.startsWith("978")).toBe(true);
    expect(converted).toHaveLength(13);
    // The conversion must produce something that validates.
    expect(isValidIsbn13(converted)).toBe(true);
  });
});

describe("toIsbn13", () => {
  it("passes through a clean ISBN-13", () => {
    expect(toIsbn13(FRANKENSTEIN_13)).toEqual({
      ok: true,
      isbn13: FRANKENSTEIN_13,
    });
  });

  it("strips hyphens and spaces", () => {
    expect(toIsbn13("978-0-14-143947-1")).toEqual({
      ok: true,
      isbn13: FRANKENSTEIN_13,
    });
    expect(toIsbn13("  978 0 14 143947 1 ")).toEqual({
      ok: true,
      isbn13: FRANKENSTEIN_13,
    });
  });

  it("upgrades an ISBN-10 to ISBN-13", () => {
    const result = toIsbn13(GATSBY_10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.isbn13).toHaveLength(13);
      expect(isValidIsbn13(result.isbn13)).toBe(true);
    }
  });

  it("upgrades a hyphenated ISBN-10", () => {
    expect(toIsbn13("0-7432-7356-7").ok).toBe(true);
  });

  it("distinguishes the reasons a value was rejected", () => {
    // The form needs to say something different for each of these.
    expect(toIsbn13("")).toEqual({ ok: false, reason: "empty" });
    expect(toIsbn13("   ")).toEqual({ ok: false, reason: "empty" });
    expect(toIsbn13("12345")).toEqual({ ok: false, reason: "length" });
    expect(toIsbn13("9780141439472")).toEqual({
      ok: false,
      reason: "checksum",
    });
  });

  it("only ever returns 13 bare digits, matching the check constraint", () => {
    // Book_isbn13_format is `~ '^[0-9]{13}$'`, so anything this function
    // returns as ok must satisfy it or inserts will fail at the database.
    for (const input of [FRANKENSTEIN_13, "978-0-14-143947-1", GATSBY_10]) {
      const result = toIsbn13(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.isbn13).toMatch(/^[0-9]{13}$/);
    }
  });
});

describe("formatIsbn13", () => {
  it("hyphenates for display", () => {
    expect(formatIsbn13(FRANKENSTEIN_13)).toBe("978-0-14-143947-1");
  });

  it("round-trips back through the parser", () => {
    expect(toIsbn13(formatIsbn13(FRANKENSTEIN_13))).toEqual({
      ok: true,
      isbn13: FRANKENSTEIN_13,
    });
  });

  it("returns anything malformed unchanged rather than mangling it", () => {
    expect(formatIsbn13("nonsense")).toBe("nonsense");
  });
});
