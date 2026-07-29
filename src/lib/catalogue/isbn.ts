/**
 * ISBN normalisation and validation.
 *
 * The database stores ISBN-13 as 13 bare digits, enforced by a check
 * constraint (`Book_isbn13_format`). Everything a human might type —
 * "978-0-14-143951-8", an ISBN-10, a trailing X check digit — has to be
 * funnelled through here first.
 *
 * v2 had no ISBN field at all, so there is no direct predecessor to compare
 * against. It is included because a catalogue without one cannot deduplicate
 * titles or look up metadata, and because the checksum makes a nice example of
 * validation the database cannot do for you: a regex can confirm thirteen
 * digits, but only arithmetic can tell you they are a real ISBN.
 */

/** Strips hyphens, spaces, and non-significant characters. */
export function normalizeIsbnInput(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * ISBN-13 check digit: alternating weights of 1 and 3 across the first twelve
 * digits, and the result must make the total a multiple of 10.
 */
export function isbn13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const digit = Number(first12[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidIsbn13(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  return isbn13CheckDigit(value.slice(0, 12)) === Number(value[12]);
}

/**
 * ISBN-10 check digit: weights 10 down to 2, modulo 11, where 10 is written
 * as 'X'.
 */
export function isValidIsbn10(value: string): boolean {
  if (!/^\d{9}[\dX]$/.test(value)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    sum += Number(value[i]) * (10 - i);
  }
  const check = value[9] === "X" ? 10 : Number(value[9]);
  return (sum + check) % 11 === 0;
}

/** Converts a valid ISBN-10 to its ISBN-13 equivalent by prefixing 978. */
export function isbn10To13(isbn10: string): string {
  const body = `978${isbn10.slice(0, 9)}`;
  return `${body}${isbn13CheckDigit(body)}`;
}

export type IsbnResult =
  | { ok: true; isbn13: string }
  | { ok: false; reason: "empty" | "length" | "checksum" };

/**
 * Accepts an ISBN-10 or ISBN-13 in any common punctuation, and returns the
 * bare 13-digit form the database expects.
 *
 * Returns a discriminated result rather than throwing, because "the user typed
 * a bad ISBN" is an expected form-validation outcome, not an exception.
 */
export function toIsbn13(input: string): IsbnResult {
  const cleaned = normalizeIsbnInput(input);

  if (cleaned === "") return { ok: false, reason: "empty" };

  if (cleaned.length === 13) {
    return isValidIsbn13(cleaned)
      ? { ok: true, isbn13: cleaned }
      : { ok: false, reason: "checksum" };
  }

  if (cleaned.length === 10) {
    return isValidIsbn10(cleaned)
      ? { ok: true, isbn13: isbn10To13(cleaned) }
      : { ok: false, reason: "checksum" };
  }

  return { ok: false, reason: "length" };
}

/** Formats a stored 13-digit ISBN for display: 978-0-14-143951-8. */
export function formatIsbn13(isbn13: string): string {
  if (!/^\d{13}$/.test(isbn13)) return isbn13;
  return [
    isbn13.slice(0, 3),
    isbn13.slice(3, 4),
    isbn13.slice(4, 6),
    isbn13.slice(6, 12),
    isbn13.slice(12),
  ].join("-");
}
