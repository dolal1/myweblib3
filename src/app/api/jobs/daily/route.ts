import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { runDailyJob } from "@/lib/notifications/service";
import { env } from "@/lib/env";

/**
 * Daily maintenance, triggered by cron.
 *
 * **This is the case where the framework does not protect us.** Next.js checks
 * `Origin` against `Host` for every Server Action, which is why ADR-002 records
 * that hand-rolled CSRF tokens were unnecessary there. Route handlers get no
 * such treatment: this is a bare POST endpoint on the public internet, and if it
 * were unauthenticated anyone could run the job repeatedly.
 *
 * So it carries a bearer secret, compared in constant time. The endpoint is
 * idempotent anyway — dedupeKey sees to that — but "the damage is limited" is
 * not the same as "it is protected".
 *
 * Vercel Cron and most schedulers send `Authorization: Bearer <secret>`; the
 * secret is CRON_SECRET, validated at startup by lib/env.ts with a 32-character
 * floor.
 */

export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;

  const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(env.CRON_SECRET, "utf8");

  // Length must match before timingSafeEqual, which throws otherwise. Comparing
  // lengths first leaks only the length, not the contents.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    // 401 with no detail. Telling an unauthenticated caller *why* it failed is
    // free reconnaissance.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = performance.now();

  try {
    const summary = await runDailyJob();
    return NextResponse.json({
      ok: true,
      durationMs: Math.round(performance.now() - startedAt),
      ...summary,
    });
  } catch (error) {
    console.error("Daily job failed", error);
    return NextResponse.json({ error: "job-failed" }, { status: 500 });
  }
}

/**
 * GET is rejected explicitly rather than left to 405.
 *
 * A job that mutates state must not be reachable by anything that follows
 * links, prefetches, or gets pasted into a browser bar.
 */
export function GET() {
  return NextResponse.json(
    { error: "method-not-allowed", hint: "POST with a bearer token" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
