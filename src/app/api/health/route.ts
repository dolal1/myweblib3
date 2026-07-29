import { NextResponse } from "next/server";

import { db } from "@/lib/db";

/**
 * Liveness/readiness probe.
 *
 * It actually round-trips to Postgres rather than just returning 200, because
 * the failure this needs to catch is "the process is up but the database is
 * not" — which is precisely the state myweblib2 would happily serve traffic in
 * after logging a connection error and carrying on listening.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = performance.now();

  try {
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: "ok",
      database: "up",
      latencyMs: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    console.error("Health check failed", error);
    return NextResponse.json(
      { status: "error", database: "down" },
      { status: 503 },
    );
  }
}
