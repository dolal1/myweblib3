import { z } from "zod";

import { toIsbn13 } from "@/lib/catalogue/isbn";

/**
 * Catalogue input validation.
 *
 * Every field the database constrains is constrained here too, so the user gets
 * a field-level message instead of a 500 from a check-constraint violation. The
 * database remains the authority — this layer exists to make its refusals
 * legible, not to replace them.
 */

/** Turns "" into undefined, so empty optional inputs are absent, not blank. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === "" ? undefined : value))
    .optional();

export const authorSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(200, "Name is too long"),
  sortName: optionalText(200),
  bio: optionalText(5000),
  birthYear: yearField("Birth year"),
  deathYear: yearField("Death year"),
});

function yearField(label: string) {
  return z
    .string()
    .trim()
    .transform((value) => (value === "" ? undefined : Number(value)))
    .refine(
      (value) => value === undefined || Number.isInteger(value),
      `${label} must be a whole number`,
    )
    .refine(
      (value) =>
        value === undefined || (value >= -3000 && value <= currentYear() + 1),
      `${label} looks implausible`,
    )
    .optional();
}

function currentYear(): number {
  return new Date().getUTCFullYear();
}

export const authorFormSchema = authorSchema.refine(
  (data) =>
    data.birthYear === undefined ||
    data.deathYear === undefined ||
    data.deathYear >= data.birthYear,
  { message: "Death year cannot precede birth year", path: ["deathYear"] },
);

/**
 * ISBN is validated by checksum, not just by shape.
 *
 * The database check constraint can only confirm thirteen digits; whether those
 * digits form a real ISBN is arithmetic, and belongs here.
 */
const isbnField = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (value === "") return undefined;

    const result = toIsbn13(value);
    if (result.ok) return result.isbn13;

    ctx.addIssue({
      code: "custom",
      message:
        result.reason === "checksum"
          ? "That ISBN's check digit is wrong — it may be mistyped"
          : "Enter a 10- or 13-digit ISBN",
    });
    return z.NEVER;
  })
  .optional();

export const bookSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Title is required")
    .max(500, "Title is too long"),
  subtitle: optionalText(500),
  isbn13: isbnField,
  description: optionalText(10000),
  publisher: optionalText(300),
  language: z
    .string()
    .trim()
    .min(2)
    .max(10)
    .default("en")
    // BCP-47-ish: two or three letters, optionally a region subtag.
    .refine(
      (value) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(value),
      "Use a language code such as en or pt-BR",
    ),
  // Matches the Book_page_count_positive check constraint.
  pageCount: z
    .string()
    .trim()
    .transform((value) => (value === "" ? undefined : Number(value)))
    .refine(
      (value) => value === undefined || (Number.isInteger(value) && value > 0),
      "Page count must be a positive whole number",
    )
    .optional(),
  publishedOn: z
    .string()
    .trim()
    .transform((value) => (value === "" ? undefined : value))
    .refine(
      (value) => value === undefined || !Number.isNaN(Date.parse(value)),
      "Enter a valid date",
    )
    .optional(),
  /**
   * At least one author. v2 could only ever store one; here the form posts a
   * repeated field, so a book can be credited to several people.
   */
  authorIds: z
    .array(z.string().min(1))
    .min(1, "Choose at least one author")
    .max(20, "That is a lot of authors"),
  genreIds: z.array(z.string().min(1)).max(20).default([]),
});

export type AuthorInput = z.infer<typeof authorFormSchema>;
export type BookInput = z.infer<typeof bookSchema>;

/** Result shape returned by the catalogue actions. */
export interface ActionState {
  errors?: Record<string, string[]>;
  message?: string;
  ok?: boolean;
}

export function toFieldErrors(error: z.ZodError): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    (errors[key] ??= []).push(issue.message);
  }
  return errors;
}

/**
 * Derives a sortable form of a name ("Ada Lovelace" -> "Lovelace, Ada") when
 * the librarian has not supplied one.
 */
export function deriveSortName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  const parts = trimmed.split(" ");
  if (parts.length < 2) return trimmed;

  const last = parts.at(-1) as string;
  const rest = parts.slice(0, -1).join(" ");
  return `${last}, ${rest}`;
}
