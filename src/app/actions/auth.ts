"use server";

import { randomBytes } from "node:crypto";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  hashPassword,
  normalizeEmail,
  verifyPassword,
} from "@/lib/auth/password";
import {
  LOGIN_LIMIT,
  REGISTER_LIMIT,
  rateLimit,
  resetRateLimit,
} from "@/lib/auth/rate-limit";
import { createSession, destroySession } from "@/lib/auth/session";
import {
  loginSchema,
  registerSchema,
  toFormErrors,
  type AuthFormState,
} from "@/lib/auth/validation";
import { db } from "@/lib/db";

/**
 * Authentication actions.
 *
 * Next.js checks Origin against Host on every Server Action, so these are not
 * vulnerable to the classic cross-site form post and do not need a
 * hand-rolled CSRF token — a route handler would.
 *
 * Everything else is our problem, and is handled below: validation, rate
 * limiting, constant-ish response behaviour, and never leaking which half of a
 * credential pair was wrong.
 */

async function requestContext(): Promise<{
  ipAddress?: string;
  userAgent?: string;
}> {
  const headerList = await headers();

  // x-forwarded-for is client-controllable unless a trusted proxy overwrites
  // it. It is used here only for rate-limit bucketing and audit display, never
  // for authorization.
  const forwarded = headerList.get("x-forwarded-for");
  const ipAddress = forwarded?.split(",")[0]?.trim() ?? undefined;
  const userAgent = headerList.get("user-agent") ?? undefined;

  return {
    ...(ipAddress ? { ipAddress } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

export async function register(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const raw = {
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  };

  // Note the shape of every early return: `values` carries back the name and
  // email so the form repopulates, and never the password. v2 rendered the
  // submitted password straight into a `value=` attribute.
  const echo = { values: { name: raw.name, email: raw.email } };

  const parsed = registerSchema.safeParse(raw);
  if (!parsed.success) {
    return { errors: toFormErrors(parsed.error), ...echo };
  }

  const context = await requestContext();
  const limit = rateLimit(
    `register:${context.ipAddress ?? "unknown"}`,
    REGISTER_LIMIT,
  );
  if (!limit.allowed) {
    return {
      message: `Too many accounts created from this address. Try again in ${Math.ceil(
        limit.retryAfterSeconds / 60,
      )} minutes.`,
      ...echo,
    };
  }

  const email = normalizeEmail(parsed.data.email);
  const passwordHash = await hashPassword(parsed.data.password);

  let userId: string;
  try {
    const user = await db.user.create({
      data: { email, name: parsed.data.name, passwordHash, role: "MEMBER" },
      select: { id: true },
    });
    userId = user.id;
  } catch (error) {
    // Rely on the unique index rather than a check-then-insert, which races.
    // v2 did `findOne` then `save`, so two simultaneous registrations both saw
    // "no existing user" and both succeeded — it had no unique index either.
    if (isUniqueViolation(error)) {
      return {
        errors: { email: ["That email is already registered"] },
        ...echo,
      };
    }
    throw error;
  }

  await createSession(userId, context);
  redirect("/");
}

export async function login(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const raw = {
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  };
  const echo = { values: { email: raw.email } };

  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) {
    return { errors: toFormErrors(parsed.error), ...echo };
  }

  const email = normalizeEmail(parsed.data.email);
  const context = await requestContext();

  // Two buckets: by address, and by account. The second is what stops a
  // distributed attempt at one specific account.
  const ipKey = `login:ip:${context.ipAddress ?? "unknown"}`;
  const emailKey = `login:email:${email}`;
  const ipLimit = rateLimit(ipKey, LOGIN_LIMIT);
  const emailLimit = rateLimit(emailKey, LOGIN_LIMIT);

  if (!ipLimit.allowed || !emailLimit.allowed) {
    const retry = Math.max(
      ipLimit.retryAfterSeconds,
      emailLimit.retryAfterSeconds,
    );
    return {
      message: `Too many attempts. Try again in ${Math.ceil(retry / 60)} minutes.`,
      ...echo,
    };
  }

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true },
  });

  // Always run a verification, even when no such user exists, so that the
  // response time does not distinguish "unknown email" from "wrong password".
  // v2 said the quiet part out loud — "That email is nor registered" — which is
  // a free account-enumeration oracle.
  const valid = user
    ? await verifyPassword(user.passwordHash, parsed.data.password)
    : await verifyPassword(await getDummyHash(), parsed.data.password);

  if (!user || !valid) {
    return { message: "Invalid email or password", ...echo };
  }

  resetRateLimit(ipKey);
  resetRateLimit(emailKey);

  await createSession(user.id, context);
  redirect("/");
}

export async function logout(): Promise<never> {
  await destroySession();
  redirect("/login");
}

/**
 * A genuine Argon2id hash of a random value nobody knows, so that a login
 * attempt against a nonexistent account costs the same as one against a real
 * account. It has to be a *real* hash — a made-up string would fail to parse
 * and return in microseconds, which is exactly the timing signal this is meant
 * to remove.
 *
 * Computed once, lazily, and shared by every subsequent request.
 */
let dummyHashPromise: Promise<string> | undefined;

function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString("base64url"));
  return dummyHashPromise;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
