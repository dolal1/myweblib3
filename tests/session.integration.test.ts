import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for the session lifecycle, against a real database.
 *
 * `next/headers` cookies() only works inside a request context, so it is
 * replaced here with an in-memory store that behaves like a browser jar. That
 * keeps the test honest about everything that matters — what is written to
 * Postgres, what is set on the cookie, and when a session stops working —
 * while faking only the part that cannot exist outside a request.
 */

interface StoredCookie {
  value: string;
  options: Record<string, unknown>;
}

const jar = new Map<string, StoredCookie>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const entry = jar.get(name);
      return entry ? { name, value: entry.value } : undefined;
    },
    set: (name: string, value: string, options: Record<string, unknown> = {}) =>
      jar.set(name, { value, options }),
    delete: (name: string) => jar.delete(name),
  }),
}));

const { db } = await import("@/lib/db");
const {
  SESSION_COOKIE,
  createSession,
  destroyAllSessionsFor,
  destroySession,
  getSessionUser,
  pruneExpiredSessions,
  rotateSession,
} = await import("@/lib/auth/session");

const TEST_EMAIL = "session-test@myweblib.test";

async function makeUser() {
  return db.user.create({
    data: {
      email: TEST_EMAIL,
      name: "Session Test",
      passwordHash: "unused-for-these-tests",
      role: "MEMBER",
    },
    select: { id: true },
  });
}

beforeEach(async () => {
  jar.clear();
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
  await db.$disconnect();
});

describe("session lifecycle", () => {
  it("creates a session and resolves the user from the cookie", async () => {
    const user = await makeUser();
    await createSession(user.id);

    const resolved = await getSessionUser();
    expect(resolved?.id).toBe(user.id);
    expect(resolved?.email).toBe(TEST_EMAIL);
  });

  it("never stores the raw token in the database", async () => {
    const user = await makeUser();
    await createSession(user.id);

    const token = jar.get(SESSION_COOKIE)?.value;
    expect(token).toBeTruthy();

    const rows = await db.session.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    // The stored id is the SHA-256 of the token: 64 hex characters, and
    // crucially not the token itself. A leaked dump yields no usable cookies.
    expect(rows[0]?.id).not.toBe(token);
    expect(rows[0]?.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sets the cookie with the flags that matter", async () => {
    const user = await makeUser();
    await createSession(user.id);

    const options = jar.get(SESSION_COOKIE)?.options;
    expect(options?.["httpOnly"]).toBe(true);
    expect(options?.["sameSite"]).toBe("lax");
    expect(options?.["path"]).toBe("/");
    // v2's session cookie had no expiry at all.
    expect(options?.["expires"]).toBeInstanceOf(Date);
    expect((options?.["expires"] as Date).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it("returns null when there is no cookie", async () => {
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("returns null for a token that does not match any session", async () => {
    jar.set(SESSION_COOKIE, { value: "a-token-nobody-issued", options: {} });
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("rejects an expired session and deletes the row", async () => {
    const user = await makeUser();
    await createSession(user.id);

    await db.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(getSessionUser()).resolves.toBeNull();
    await expect(
      db.session.count({ where: { userId: user.id } }),
    ).resolves.toBe(0);
  });

  it("destroys the current session and clears the cookie", async () => {
    const user = await makeUser();
    await createSession(user.id);
    await destroySession();

    expect(jar.has(SESSION_COOKIE)).toBe(false);
    await expect(
      db.session.count({ where: { userId: user.id } }),
    ).resolves.toBe(0);
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("rotates to a brand new token, invalidating the old one", async () => {
    const user = await makeUser();
    await createSession(user.id);
    const before = jar.get(SESSION_COOKIE)?.value;
    const beforeId = (await db.session.findFirst({
      where: { userId: user.id },
    }))!.id;

    await rotateSession(user.id);
    const after = jar.get(SESSION_COOKIE)?.value;

    expect(after).not.toBe(before);
    // The pre-rotation session must be gone — this is what closes session
    // fixation after a privilege change.
    await expect(
      db.session.findUnique({ where: { id: beforeId } }),
    ).resolves.toBeNull();
    await expect(getSessionUser()).resolves.not.toBeNull();
  });

  it("revokes every session for a user", async () => {
    const user = await makeUser();
    await createSession(user.id);
    jar.clear();
    await createSession(user.id);
    jar.clear();
    await createSession(user.id);

    await expect(
      db.session.count({ where: { userId: user.id } }),
    ).resolves.toBe(3);

    const revoked = await destroyAllSessionsFor(user.id);
    expect(revoked).toBe(3);
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("prunes expired sessions and leaves live ones alone", async () => {
    const user = await makeUser();
    await createSession(user.id);
    const liveId = (await db.session.findFirst({ where: { userId: user.id } }))!
      .id;

    await db.session.create({
      data: {
        id: "0".repeat(64),
        userId: user.id,
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const pruned = await pruneExpiredSessions();
    expect(pruned).toBeGreaterThanOrEqual(1);
    await expect(
      db.session.findUnique({ where: { id: liveId } }),
    ).resolves.not.toBeNull();
  });

  it("cascades session deletion when the user is deleted", async () => {
    const user = await makeUser();
    await createSession(user.id);

    await db.user.delete({ where: { id: user.id } });

    await expect(
      db.session.count({ where: { userId: user.id } }),
    ).resolves.toBe(0);
  });
});
