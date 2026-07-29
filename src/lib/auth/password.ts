// Deliberately no `server-only` marker here, unlike src/lib/env.ts and
// src/lib/db.ts. These are pure functions over strings that touch no secrets
// and no request context, so keeping them importable from plain Node lets the
// seed script and unit tests use them directly.
import { hash, verify } from "@node-rs/argon2";

/**
 * Password hashing.
 *
 * v2 used bcrypt with a cost of 10 and a callback pyramid three levels deep,
 * and — because the `if (!password)` branch pushed an error but did not
 * return — crashed outright on `password.length` when the field was missing.
 *
 * Argon2id is the current recommendation: memory-hard, so it degrades an
 * attacker's GPU advantage in a way bcrypt's cost factor cannot.
 *
 * Parameters follow OWASP's guidance (19 MiB memory, 2 iterations, 1 degree of
 * parallelism) as a minimum. They are recorded in the hash string itself, so
 * raising them later still verifies existing hashes and `needsRehash` tells us
 * which ones to upgrade on next successful login.
 */
const ARGON2_OPTIONS = {
  // 19 MiB, expressed in KiB as the library expects.
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/**
 * Argon2 has no practical input limit, but accepting unbounded input means
 * accepting unbounded work. Cap it well above any real passphrase.
 */
export const MAX_PASSWORD_BYTES = 1024;

export async function hashPassword(password: string): Promise<string> {
  assertHashable(password);
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Returns false rather than throwing on a malformed stored hash: a corrupt row
 * should read as "these credentials do not authenticate", not as a 500 that
 * tells an attacker they found something interesting.
 */
export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return false;
  }

  try {
    return await verify(storedHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

function assertHashable(password: string): void {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new Error(
      `Password exceeds ${MAX_PASSWORD_BYTES} bytes and will not be hashed.`,
    );
  }
}

/**
 * Normalises an email for storage and lookup.
 *
 * The database has a plain unique index on this column, so it is only
 * genuinely case-insensitive if every write path funnels through here. v2 had
 * neither the index nor the normalisation, so `Dave@x.com` and `dave@x.com`
 * were two accounts.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
