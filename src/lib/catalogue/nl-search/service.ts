import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import type { Prisma } from "@/generated/prisma/client";
import { rateLimit, type RateLimitOptions } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

import { searchBooks, type SearchHit } from "../search";
import { normalizeQuery, type CatalogueFilter } from "./filter";
import {
  interpretQuery,
  MODEL,
  PROMPT_VERSION,
  type CallMetrics,
  type FailureReason,
  type Genre,
  type InterpretResult,
} from "./interpret";
import { searchByFilter } from "./query";

/**
 * Natural-language search, end to end.
 *
 * Order of checks, cheapest first, so the expensive call is the last resort:
 *
 *   1. Feature off (no key, or a budget of 0)   → keyword search
 *   2. Same query answered in the last 24h      → replay that filter, $0
 *   3. This member over their hourly allowance  → keyword search
 *   4. Today's spend at the daily budget        → keyword search
 *   5. Call the model (timeout, one retry)      → filter, or keyword search
 *
 * Every outcome writes one AiCall row, including the ones that never reached
 * the API. Those rows are what the admin page reports and what step 4 sums.
 *
 * The fallback is the existing keyword search over the original text. It is
 * not "no results": a member who typed something still gets the answer the
 * catalogue had before this feature existed.
 */

export const FEATURE = "nl-search";

/** Per member. Generous for a person, small enough that a script cannot spend the budget. */
export const SMART_SEARCH_LIMIT: RateLimitOptions = {
  limit: 30,
  windowMs: 60 * 60 * 1000,
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type FallbackReason =
  FailureReason | "disabled" | "over_budget" | "member_rate_limited";

export type SmartSearchResult =
  | {
      mode: "ai";
      filter: CatalogueFilter;
      cached: boolean;
      hits: SearchHit[];
      total: number;
    }
  | {
      mode: "fallback";
      reason: FallbackReason;
      hits: SearchHit[];
      total: number;
      usedFuzzyFallback: boolean;
    };

/** Injectable so tests can drive every outcome without an API key. */
export type Interpreter = (
  query: string,
  genres: readonly Genre[],
) => Promise<InterpretResult>;

let client: Anthropic | undefined;

const defaultInterpreter: Interpreter = (query, genres) => {
  // Built lazily: the key is optional and an unused client should cost nothing.
  // maxRetries and timeout are set per request in interpretQuery.
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return interpretQuery(query, { client, genres });
};

export function smartSearchEnabled(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY) && env.AI_DAILY_BUDGET_USD > 0;
}

function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export async function spentTodayMicroUsd(now = new Date()): Promise<number> {
  const result = await db.aiCall.aggregate({
    where: { feature: FEATURE, createdAt: { gte: startOfUtcDay(now) } },
    _sum: { costMicroUsd: true },
  });
  return result._sum.costMicroUsd ?? 0;
}

async function findCached(
  normalizedQuery: string,
  now: Date,
): Promise<CatalogueFilter | null> {
  const row = await db.aiCall.findFirst({
    where: {
      feature: FEATURE,
      normalizedQuery,
      promptVersion: PROMPT_VERSION,
      outcome: "OK",
      createdAt: { gte: new Date(now.getTime() - CACHE_TTL_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: { filter: true },
  });
  return (row?.filter as CatalogueFilter | null | undefined) ?? null;
}

interface LogEntry {
  userId: string;
  normalizedQuery: string;
  outcome: "OK" | "CACHE_HIT" | "FALLBACK";
  failureReason?: FallbackReason;
  metrics?: CallMetrics | null;
  /** Wall time of a failed call that billed nothing (a timeout, say). */
  latencyMs?: number;
  filter?: CatalogueFilter;
}

async function record(entry: LogEntry): Promise<void> {
  const { metrics } = entry;
  // A failed call with a latency was still sent to the model; a fallback
  // decided before any request (budget, allowance) names no model.
  const model =
    metrics?.model ?? (entry.latencyMs !== undefined ? MODEL : null);
  const latencyMs = metrics?.latencyMs ?? entry.latencyMs ?? null;

  // One structured line per search for whatever collects stdout in production,
  // and the database row for the admin page and the budget. No query text in
  // the log line: logs travel further than the database does.
  console.info(
    JSON.stringify({
      event: "ai_call",
      feature: FEATURE,
      outcome: entry.outcome,
      reason: entry.failureReason ?? null,
      model,
      latencyMs,
      inputTokens: metrics?.inputTokens ?? null,
      outputTokens: metrics?.outputTokens ?? null,
      costMicroUsd: metrics?.costMicroUsd ?? 0,
    }),
  );

  await db.aiCall.create({
    data: {
      feature: FEATURE,
      userId: entry.userId,
      normalizedQuery: entry.normalizedQuery,
      promptVersion: PROMPT_VERSION,
      outcome: entry.outcome,
      failureReason: entry.failureReason ?? null,
      model,
      latencyMs,
      inputTokens: metrics?.inputTokens ?? null,
      outputTokens: metrics?.outputTokens ?? null,
      costMicroUsd: metrics?.costMicroUsd ?? 0,
      ...(entry.filter
        ? { filter: entry.filter as unknown as Prisma.InputJsonValue }
        : {}),
    },
  });
}

export async function smartSearch(
  {
    query,
    userId,
    limit = 12,
    offset = 0,
  }: { query: string; userId: string; limit?: number; offset?: number },
  {
    interpret = defaultInterpreter,
    enabled = smartSearchEnabled(),
    dailyBudgetUsd = env.AI_DAILY_BUDGET_USD,
    now = new Date(),
  }: {
    interpret?: Interpreter;
    enabled?: boolean;
    dailyBudgetUsd?: number;
    now?: Date;
  } = {},
): Promise<SmartSearchResult> {
  const normalizedQuery = normalizeQuery(query);

  const fallback = async (
    reason: FallbackReason,
    logged: Omit<LogEntry, "userId" | "normalizedQuery" | "outcome"> = {},
  ): Promise<SmartSearchResult> => {
    // A disabled feature is not an event worth a row per search.
    if (reason !== "disabled") {
      await record({
        userId,
        normalizedQuery,
        outcome: "FALLBACK",
        failureReason: reason,
        ...logged,
      });
    }
    const result = await searchBooks({ query, limit, offset });
    return { mode: "fallback", reason, ...result };
  };

  if (!enabled || normalizedQuery === "") return fallback("disabled");

  const cached = await findCached(normalizedQuery, now);
  if (cached) {
    await record({
      userId,
      normalizedQuery,
      outcome: "CACHE_HIT",
      filter: cached,
    });
    const result = await searchByFilter(cached, { limit, offset });
    return { mode: "ai", filter: cached, cached: true, ...result };
  }

  // Paging through results re-runs the search. Only the first page counts
  // against the allowance; later pages are a cache hit above anyway.
  if (offset === 0) {
    const limited = rateLimit(`nl-search:${userId}`, SMART_SEARCH_LIMIT);
    if (!limited.allowed) return fallback("member_rate_limited");
  }

  if ((await spentTodayMicroUsd(now)) >= dailyBudgetUsd * 1_000_000) {
    return fallback("over_budget");
  }

  const genres = await db.genre.findMany({
    select: { slug: true, name: true },
    orderBy: { slug: "asc" },
  });

  const interpreted = await interpret(query, genres);
  if (!interpreted.ok) {
    return fallback(interpreted.reason, {
      metrics: interpreted.metrics,
      latencyMs: interpreted.latencyMs,
    });
  }

  await record({
    userId,
    normalizedQuery,
    outcome: "OK",
    metrics: interpreted.metrics,
    filter: interpreted.filter,
  });

  const result = await searchByFilter(interpreted.filter, { limit, offset });
  return { mode: "ai", filter: interpreted.filter, cached: false, ...result };
}

/** What the page says when it fell back. Never blames the member for an outage. */
export function explainFallback(reason: FallbackReason): string | null {
  switch (reason) {
    case "disabled":
      return null;
    case "not_a_search":
      return "That did not read as a book search, so these are plain keyword results.";
    case "member_rate_limited":
      return "You have used smart search a lot this hour, so these are keyword results. It resets within the hour.";
    case "over_budget":
      return "Smart search is paused for today. These are keyword results.";
    case "implausible":
    case "invalid_output":
    case "truncated":
    case "refused":
      return "Smart search could not make sense of that, so these are keyword results.";
    case "timeout":
    case "rate_limited":
    case "unavailable":
    case "misconfigured":
    case "api_error":
      return "Smart search is unavailable right now, so these are keyword results.";
  }
}
