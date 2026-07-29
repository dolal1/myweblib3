import { describe, expect, it } from "vitest";

import {
  MAX_PASSWORD_BYTES,
  hashPassword,
  normalizeEmail,
  verifyPassword,
} from "@/lib/auth/password";

describe("hashPassword / verifyPassword", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    await expect(
      verifyPassword(hash, "correct-horse-battery-staple"),
    ).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    await expect(
      verifyPassword(hash, "correct-horse-battery-stapl"),
    ).resolves.toBe(false);
  });

  it("produces an argon2id hash, not bcrypt", async () => {
    const hash = await hashPassword("a-sufficiently-long-password");
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("salts, so the same password hashes differently each time", async () => {
    const [a, b] = await Promise.all([
      hashPassword("the-same-password"),
      hashPassword("the-same-password"),
    ]);
    expect(a).not.toBe(b);
    await expect(verifyPassword(a, "the-same-password")).resolves.toBe(true);
    await expect(verifyPassword(b, "the-same-password")).resolves.toBe(true);
  });

  it("records the configured cost parameters in the hash", async () => {
    const hash = await hashPassword("a-sufficiently-long-password");
    // 19 MiB expressed in KiB, 2 iterations, parallelism 1 — OWASP's baseline.
    expect(hash).toContain("m=19456");
    expect(hash).toContain("t=2");
    expect(hash).toContain("p=1");
  });

  it("returns false rather than throwing on a malformed stored hash", async () => {
    // A corrupt row must read as "does not authenticate", not as a 500 that
    // tells an attacker they found something interesting.
    await expect(verifyPassword("not-a-hash", "anything")).resolves.toBe(false);
    await expect(verifyPassword("", "anything")).resolves.toBe(false);
    await expect(verifyPassword("$argon2id$broken", "x")).resolves.toBe(false);
  });

  it("handles unicode passwords", async () => {
    const password = "拿铁咖啡-🔐-passphrase";
    const hash = await hashPassword(password);
    await expect(verifyPassword(hash, password)).resolves.toBe(true);
  });

  it("refuses to hash absurdly long input", async () => {
    const huge = "a".repeat(MAX_PASSWORD_BYTES + 1);
    await expect(hashPassword(huge)).rejects.toThrow(/exceeds/);
  });

  it("rejects oversized input at verification without doing the work", async () => {
    const hash = await hashPassword("a-sufficiently-long-password");
    const huge = "a".repeat(MAX_PASSWORD_BYTES + 1);
    await expect(verifyPassword(hash, huge)).resolves.toBe(false);
  });

  it("counts the byte length, not the character count, for the cap", async () => {
    // A 4-byte emoji is one JS "character" but four bytes.
    const justOver = "🔐".repeat(MAX_PASSWORD_BYTES / 4 + 1);
    expect(justOver.length).toBeLessThan(MAX_PASSWORD_BYTES);
    await expect(hashPassword(justOver)).rejects.toThrow(/exceeds/);
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Dave@Example.COM ")).toBe("dave@example.com");
  });

  it("makes case variants collide, which is what the unique index relies on", () => {
    // myweblib2 had neither this normalisation nor a unique index, so
    // Dave@x.com and dave@x.com were two separate accounts.
    expect(normalizeEmail("Dave@x.com")).toBe(normalizeEmail("dave@X.com"));
  });
});
