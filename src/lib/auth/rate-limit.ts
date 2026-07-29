import "server-only";

/**
 * Fixed-window rate limiting for credential endpoints.
 *
 * myweblib2 had none: an attacker could try passwords against
 * `POST /users/login` as fast as the event loop would accept them.
 *
 * Deliberately limited scope — this is an in-process Map, so it is per
 * instance. Behind more than one instance the effective limit multiplies by the
 * instance count. That is an acceptable trade for a single-container
 * deployment, and the interface is narrow enough that swapping the store for
 * Postgres or Redis later touches only this file.
 *
 * Login is limited on two keys at once (see the action): by IP, to slow down a
 * broad attack, and by email, so that spraying one password across many
 * accounts from a botnet still trips the per-account limit.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Bound the map so a hostile client cannot grow it without limit. */
const MAX_TRACKED_KEYS = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. Suitable for a Retry-After header. */
  retryAfterSeconds: number;
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export const LOGIN_LIMIT: RateLimitOptions = {
  limit: 10,
  windowMs: 15 * 60 * 1000,
};

export const REGISTER_LIMIT: RateLimitOptions = {
  limit: 5,
  windowMs: 60 * 60 * 1000,
};

export function rateLimit(
  key: string,
  options: RateLimitOptions,
): RateLimitResult {
  const now = Date.now();
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    if (windows.size >= MAX_TRACKED_KEYS) evictExpired(now);
    windows.set(key, { count: 1, resetAt: now + options.windowMs });
    return {
      allowed: true,
      remaining: options.limit - 1,
      retryAfterSeconds: 0,
    };
  }

  existing.count += 1;
  const remaining = Math.max(0, options.limit - existing.count);
  const allowed = existing.count <= options.limit;

  return {
    allowed,
    remaining,
    retryAfterSeconds: allowed ? 0 : Math.ceil((existing.resetAt - now) / 1000),
  };
}

/**
 * Clears a key after a successful attempt, so that someone who mistyped their
 * password four times is not still throttled once they get in.
 */
export function resetRateLimit(key: string): void {
  windows.delete(key);
}

function evictExpired(now: number): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
  // Still full of live windows: drop the oldest to keep memory bounded.
  if (windows.size >= MAX_TRACKED_KEYS) {
    const oldest = [...windows.entries()]
      .sort((a, b) => a[1].resetAt - b[1].resetAt)
      .slice(0, Math.floor(MAX_TRACKED_KEYS / 10));
    for (const [key] of oldest) windows.delete(key);
  }
}

/** Exposed for tests. */
export function __clearAllRateLimits(): void {
  windows.clear();
}
