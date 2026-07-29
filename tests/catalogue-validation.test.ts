import { describe, expect, it } from "vitest";

import {
  authorFormSchema,
  bookSchema,
  deriveSortName,
} from "@/lib/catalogue/validation";

describe("deriveSortName", () => {
  it("moves the last word to the front", () => {
    expect(deriveSortName("Ada Lovelace")).toBe("Lovelace, Ada");
  });

  it("keeps middle names with the forenames", () => {
    expect(deriveSortName("Mary Wollstonecraft Shelley")).toBe(
      "Shelley, Mary Wollstonecraft",
    );
  });

  it("leaves a mononym alone", () => {
    expect(deriveSortName("Voltaire")).toBe("Voltaire");
  });

  it("collapses stray whitespace", () => {
    expect(deriveSortName("  Jane   Austen  ")).toBe("Austen, Jane");
  });
});

describe("authorFormSchema", () => {
  const valid = {
    name: "Ada Lovelace",
    sortName: "",
    bio: "",
    birthYear: "1815",
    deathYear: "1852",
  };

  it("accepts a well-formed author", () => {
    const result = authorFormSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.birthYear).toBe(1815);
      // Blank optional text becomes undefined, not "".
      expect(result.data.bio).toBeUndefined();
      expect(result.data.sortName).toBeUndefined();
    }
  });

  it("requires a name", () => {
    expect(authorFormSchema.safeParse({ ...valid, name: "  " }).success).toBe(
      false,
    );
  });

  it("rejects a death year before the birth year", () => {
    const result = authorFormSchema.safeParse({
      ...valid,
      birthYear: "1900",
      deathYear: "1850",
    });
    expect(result.success).toBe(false);
  });

  it("allows either year to be omitted", () => {
    expect(
      authorFormSchema.safeParse({ ...valid, deathYear: "" }).success,
    ).toBe(true);
    expect(
      authorFormSchema.safeParse({ ...valid, birthYear: "", deathYear: "" })
        .success,
    ).toBe(true);
  });

  it("rejects implausible and non-numeric years", () => {
    expect(
      authorFormSchema.safeParse({ ...valid, birthYear: "99999" }).success,
    ).toBe(false);
    expect(
      authorFormSchema.safeParse({ ...valid, birthYear: "eighteen" }).success,
    ).toBe(false);
  });
});

describe("bookSchema", () => {
  const valid = {
    title: "Frankenstein",
    subtitle: "",
    isbn13: "",
    description: "",
    publisher: "",
    language: "en",
    pageCount: "280",
    publishedOn: "1818-01-01",
    authorIds: ["author-1"],
    genreIds: [],
  };

  it("accepts a well-formed book", () => {
    const result = bookSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.pageCount).toBe(280);
  });

  it("requires at least one author", () => {
    // The whole reason BookAuthor exists — but a book with zero credits is
    // still nonsense.
    expect(bookSchema.safeParse({ ...valid, authorIds: [] }).success).toBe(
      false,
    );
  });

  it("accepts several authors", () => {
    const result = bookSchema.safeParse({
      ...valid,
      authorIds: ["author-1", "author-2"],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.authorIds).toHaveLength(2);
  });

  it("normalises a hyphenated ISBN to 13 bare digits", () => {
    const result = bookSchema.safeParse({
      ...valid,
      isbn13: "978-0-14-143947-1",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.isbn13).toBe("9780141439471");
  });

  it("upgrades an ISBN-10", () => {
    const result = bookSchema.safeParse({ ...valid, isbn13: "0743273567" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.isbn13).toMatch(/^978\d{10}$/);
  });

  it("rejects an ISBN with a bad check digit, with a specific message", () => {
    const result = bookSchema.safeParse({ ...valid, isbn13: "9780141439472" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/check digit/i);
    }
  });

  it("treats a blank ISBN as absent rather than invalid", () => {
    const result = bookSchema.safeParse({ ...valid, isbn13: "   " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.isbn13).toBeUndefined();
  });

  it("rejects a zero or negative page count", () => {
    // Mirrors the Book_page_count_positive check constraint, so the user gets a
    // field error instead of a 500.
    expect(bookSchema.safeParse({ ...valid, pageCount: "0" }).success).toBe(
      false,
    );
    expect(bookSchema.safeParse({ ...valid, pageCount: "-5" }).success).toBe(
      false,
    );
    expect(bookSchema.safeParse({ ...valid, pageCount: "1.5" }).success).toBe(
      false,
    );
  });

  it("allows an absent page count", () => {
    // v2 wrote this field but never declared it, so it silently vanished on
    // every save. Here it is optional-but-real.
    const result = bookSchema.safeParse({ ...valid, pageCount: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.pageCount).toBeUndefined();
  });

  it("requires a title", () => {
    expect(bookSchema.safeParse({ ...valid, title: " " }).success).toBe(false);
  });

  it("rejects an invalid date", () => {
    expect(
      bookSchema.safeParse({ ...valid, publishedOn: "not-a-date" }).success,
    ).toBe(false);
  });

  it("validates the language code shape", () => {
    expect(bookSchema.safeParse({ ...valid, language: "pt-BR" }).success).toBe(
      true,
    );
    expect(
      bookSchema.safeParse({ ...valid, language: "english" }).success,
    ).toBe(false);
  });
});
