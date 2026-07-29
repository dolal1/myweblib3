import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";

import { db } from "@/lib/db";
import { isProduction } from "@/lib/env";

/**
 * Database-backed sessions.
 *
 * The browser holds a random token. The database stores only its SHA-256, so a
 * leaked dump contains no usable session cookies — the same reasoning that says
 * never store plaintext passwords, applied to the thing that actually grants
 * access.
 *
 * SHA-256 rather than Argon2 here is deliberate: the token is 256 bits of
 * CSPRNG output, not a low-entropy human secret, so there is nothing to brute
 * force and no reason to pay a memory-hard cost on every single request.
 *
 * Contrast myweblib2: a signed cookie over an in-memory store, the signing key
 * hardcoded in the repository as 'secret cat', no expiry, and no way to revoke
 * anything.
 */

export const SESSION_COOKIE = "myweblib_session";

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
/** Sessions past half their life get extended on use, so active users stay in. */
const RENEW_AFTER_MS = SESSION_TTL_MS / 2;

const TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Compares two session id hashes without leaking position information through
 * timing. Both are fixed-length hex, so a length mismatch is itself a mismatch.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: "MEMBER" | "LIBRARIAN" | "ADMIN";
  suspended: boolean;
}

/**
 * Issues a session and sets the cookie.
 *
 * Call this *after* a successful credential check, and again after any
 * privilege change — see rotateSession.
 */
export async function createSession(
  userId: string,
  context: { ipAddress?: string; userAgent?: string } = {},
): Promise<void> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.session.create({
    data: {
      id: hashToken(token),
      userId,
      expiresAt,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true, // not readable by document.cookie
    secure: isProduction, // https only outside local dev
    sameSite: "lax", // blocks cross-site POSTs, keeps top-level nav working
    expires: expiresAt, // explicit, unlike v2's session cookie with no expiry
    path: "/",
  });
}

/**
 * Resolves the current session. Returns null for absent, unknown, or expired
 * tokens, and deletes the row when it has expired.
 *
 * Does not throw on a missing cookie — "not logged in" is a normal state, not
 * an error.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const sessionId = hashToken(token);

  const session = await db.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      expiresAt: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          suspended: true,
        },
      },
    },
  });

  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    // Expired: clean up rather than leaving rows to accumulate.
    await db.session.delete({ where: { id: session.id } }).catch(() => {
      // Already gone (concurrent request). Nothing to do.
    });
    return null;
  }

  // Sliding expiry, but only past the halfway mark so we are not writing to the
  // database on every single request.
  if (session.expiresAt.getTime() - Date.now() < RENEW_AFTER_MS) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.session
      .update({ where: { id: session.id }, data: { expiresAt } })
      .catch(() => {});
    cookieStore.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      expires: expiresAt,
      path: "/",
    });
  }

  return session.user;
}

/** Logs out the current browser only, leaving the user's other sessions alone. */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    await db.session
      .delete({ where: { id: hashToken(token) } })
      .catch(() => {});
  }

  cookieStore.delete(SESSION_COOKIE);
}

/**
 * Replaces the current session with a fresh one for the same user.
 *
 * Use after a password change or role change: it closes session fixation, and
 * means a stolen pre-change token stops working.
 */
export async function rotateSession(
  userId: string,
  context: { ipAddress?: string; userAgent?: string } = {},
): Promise<void> {
  await destroySession();
  await createSession(userId, context);
}

/** Revokes every session for a user — "sign out everywhere". */
export async function destroyAllSessionsFor(userId: string): Promise<number> {
  const { count } = await db.session.deleteMany({ where: { userId } });
  return count;
}

/**
 * Deletes expired rows. Called by the scheduled job; sessions are also cleaned
 * up lazily on use, but abandoned ones would otherwise linger forever.
 */
export async function pruneExpiredSessions(): Promise<number> {
  const { count } = await db.session.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  return count;
}
