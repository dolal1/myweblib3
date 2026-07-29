import { describe, expect, it } from "vitest";

import {
  loginSchema,
  registerSchema,
  toFormErrors,
} from "@/lib/auth/validation";

describe("registerSchema", () => {
  const valid = {
    name: "Ada Nwosu",
    email: "ada@example.com",
    password: "a-perfectly-fine-password",
    confirmPassword: "a-perfectly-fine-password",
  };

  it("accepts a well-formed registration", () => {
    expect(registerSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects mismatched passwords, reported on the confirm field", () => {
    const result = registerSchema.safeParse({
      ...valid,
      confirmPassword: "something-else-entirely",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(toFormErrors(result.error)["confirmPassword"]).toBeDefined();
    }
  });

  it("rejects short passwords", () => {
    const result = registerSchema.safeParse({
      ...valid,
      password: "short",
      confirmPassword: "short",
    });
    expect(result.success).toBe(false);
  });

  it("does not throw when the password is missing entirely", () => {
    // This is the v2 bug reproduced as a test: routes/users.js:31 read
    // `password.length` after only pushing an error for the missing field,
    // producing a TypeError on undefined. Schema parsing cannot do that.
    expect(() =>
      registerSchema.safeParse({ name: "A", email: "a@b.com" }),
    ).not.toThrow();
    expect(
      registerSchema.safeParse({ name: "A", email: "a@b.com" }).success,
    ).toBe(false);
  });

  it("rejects malformed emails", () => {
    for (const email of ["", "not-an-email", "a@", "@b.com", "a b@c.com"]) {
      expect(registerSchema.safeParse({ ...valid, email }).success).toBe(false);
    }
  });

  it("trims surrounding whitespace from name and email", () => {
    const result = registerSchema.safeParse({
      ...valid,
      name: "  Ada Nwosu  ",
      email: "  ada@example.com  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Ada Nwosu");
      expect(result.data.email).toBe("ada@example.com");
    }
  });

  it("rejects an over-long email", () => {
    const email = `${"a".repeat(250)}@example.com`;
    expect(registerSchema.safeParse({ ...valid, email }).success).toBe(false);
  });
});

describe("loginSchema", () => {
  it("accepts any non-empty password", () => {
    // Applying the registration minimum here would lock out anyone whose
    // password predates a policy change, and would leak the policy itself.
    const result = loginSchema.safeParse({
      email: "ada@example.com",
      password: "short",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty password", () => {
    const result = loginSchema.safeParse({
      email: "ada@example.com",
      password: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("toFormErrors", () => {
  it("groups messages by field name", () => {
    const result = registerSchema.safeParse({
      name: "",
      email: "nope",
      password: "x",
      confirmPassword: "y",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = toFormErrors(result.error);
      expect(Object.keys(errors)).toEqual(
        expect.arrayContaining(["name", "email", "password"]),
      );
      expect(Array.isArray(errors["email"])).toBe(true);
    }
  });
});
