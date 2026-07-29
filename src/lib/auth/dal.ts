import "server-only";

import { cache } from "react";
import { forbidden, unauthorized } from "next/navigation";

import { getSessionUser, type SessionUser } from "@/lib/auth/session";

/**
 * Data Access Layer for identity.
 *
 * The Next.js docs are blunt about this, and it is the single most important
 * lesson carried over from myweblib2: **rendering-time gating is not a security
 * boundary**. Server Actions are reachable by direct POST without ever touching
 * your UI, so a check in a layout protects the page but not the mutation.
 *
 * v2 made exactly this class of mistake in its own idiom — it wrote an
 * `ensureAuthenticated` middleware and then mounted it on one route out of
 * fifteen, leaving every book and author mutation open to anyone who knew the
 * URL.
 *
 * So: call requireUser() or requireRole() at the top of *every* Server Action
 * and every route handler that touches data, not just in layouts.
 *
 * `cache()` dedupes within a single request, so calling requireRole() in a
 * layout, a page, and three components costs one database round trip.
 */

export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  return getSessionUser();
});

/** Roles ordered by privilege. Each implies the ones before it. */
const ROLE_RANK = {
  MEMBER: 0,
  LIBRARIAN: 1,
  ADMIN: 2,
} as const;

export type Role = keyof typeof ROLE_RANK;

/**
 * Requires any authenticated user.
 *
 * Throws Next's `unauthorized()` interrupt, which renders app/unauthorized.tsx
 * and sends a 401, rather than redirecting. A redirect would turn a
 * programmatic POST into a confusing 200 with a login page in the body.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) unauthorized();
  return user;
}

/**
 * Requires a minimum role. ADMIN satisfies a LIBRARIAN requirement.
 */
export async function requireRole(minimum: Role): Promise<SessionUser> {
  const user = await requireUser();
  if (ROLE_RANK[user.role] < ROLE_RANK[minimum]) forbidden();
  return user;
}

/**
 * Requires a member in good standing — authenticated and not suspended.
 *
 * Circulation actions use this rather than requireUser: a suspended member can
 * still log in and browse, they just cannot borrow.
 */
export async function requireActiveMember(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.suspended) forbidden();
  return user;
}

/** Non-throwing role check, for conditionally rendering UI affordances. */
export function hasRole(user: SessionUser | null, minimum: Role): boolean {
  if (!user) return false;
  return ROLE_RANK[user.role] >= ROLE_RANK[minimum];
}
