import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LOGIN_LIMIT,
  __clearAllRateLimits,
  rateLimit,
  resetRateLimit,
} from "@/lib/auth/rate-limit";

const OPTIONS = { limit: 3, windowMs: 60_000 };

beforeEach(() => {
  __clearAllRateLimits();
  vi.useRealTimers();
});

describe("rateLimit", () => {
  it("allows attempts up to the limit and blocks the next", () => {
    expect(rateLimit("k", OPTIONS).allowed).toBe(true);
    expect(rateLimit("k", OPTIONS).allowed).toBe(true);
    expect(rateLimit("k", OPTIONS).allowed).toBe(true);
    expect(rateLimit("k", OPTIONS).allowed).toBe(false);
  });

  it("counts down remaining attempts", () => {
    expect(rateLimit("k", OPTIONS).remaining).toBe(2);
    expect(rateLimit("k", OPTIONS).remaining).toBe(1);
    expect(rateLimit("k", OPTIONS).remaining).toBe(0);
  });

  it("keeps separate counters per key", () => {
    rateLimit("a", OPTIONS);
    rateLimit("a", OPTIONS);
    rateLimit("a", OPTIONS);
    expect(rateLimit("a", OPTIONS).allowed).toBe(false);
    // A different address must not inherit the first one's exhausted budget.
    expect(rateLimit("b", OPTIONS).allowed).toBe(true);
  });

  it("reports a retry-after only once blocked", () => {
    expect(rateLimit("k", OPTIONS).retryAfterSeconds).toBe(0);
    rateLimit("k", OPTIONS);
    rateLimit("k", OPTIONS);
    const blocked = rateLimit("k", OPTIONS);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("lets attempts through again once the window expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    rateLimit("k", OPTIONS);
    rateLimit("k", OPTIONS);
    rateLimit("k", OPTIONS);
    expect(rateLimit("k", OPTIONS).allowed).toBe(false);

    vi.advanceTimersByTime(OPTIONS.windowMs + 1);
    expect(rateLimit("k", OPTIONS).allowed).toBe(true);
  });

  it("clears a key on reset, so a successful login un-throttles the user", () => {
    rateLimit("k", OPTIONS);
    rateLimit("k", OPTIONS);
    resetRateLimit("k");
    expect(rateLimit("k", OPTIONS).remaining).toBe(2);
  });

  it("uses a login budget that is usable but not brute-forceable", () => {
    // Guards against someone "fixing a flaky test" by loosening these.
    expect(LOGIN_LIMIT.limit).toBeLessThanOrEqual(10);
    expect(LOGIN_LIMIT.windowMs).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });
});
