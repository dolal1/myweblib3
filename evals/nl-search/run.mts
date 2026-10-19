/**
 * Eval for natural-language search interpretation.
 *
 *   npm run eval:nl-search             replay recorded responses (CI; free, offline)
 *   npm run eval:nl-search -- --record call the API and re-record (needs ANTHROPIC_API_KEY)
 *
 * Both modes run the production `interpretQuery`: same prompt, same schema,
 * same validation. Only `fetch` differs. In record mode it goes to the API and
 * the exchange is saved to recordings/<case>.json. In replay mode the saved
 * response is served back, but only if the request body is byte-for-byte the
 * one that was recorded. Change the prompt, the schema or the model and every
 * recording goes stale, and the run fails until someone re-records against the
 * real model. CI can never pass on answers the current prompt did not produce.
 *
 * A recording run also writes RESULTS.md: pass rate, per-field failures,
 * latency percentiles, tokens, and cost.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
// So --record picks up ANTHROPIC_API_KEY from .env, like the app does.
import "dotenv/config";

import { formatMicroUsd } from "../../src/lib/catalogue/nl-search/cost";
import type { CatalogueFilter } from "../../src/lib/catalogue/nl-search/filter";
import {
  interpretQuery,
  MODEL,
  PROMPT_VERSION,
  type Genre,
  type InterpretResult,
} from "../../src/lib/catalogue/nl-search/interpret";

const here = path.dirname(fileURLToPath(import.meta.url));
const RECORDINGS = path.join(here, "recordings");

type Acceptable<T> = T | T[];

interface Case {
  id: string;
  query: string;
  expect: {
    kind?: "search" | "not_a_search";
    keywords?: { includes: string[]; excludes?: string[] } | null;
    author?: string | null;
    genre?: Acceptable<string | null>;
    yearFrom?: Acceptable<number | null>;
    yearTo?: Acceptable<number | null>;
    availableOnly?: boolean;
  };
}

interface Suite {
  now: string;
  genres: Genre[];
  minPassRate: number;
  cases: Case[];
}

interface Exchange {
  requestSha256: string;
  request: unknown;
  status: number;
  body: unknown;
}

interface Recording {
  case: string;
  model: string;
  promptVersion: string;
  recordedAt: string;
  /** Wall time of the whole interpretQuery call, retries included. */
  latencyMs: number;
  exchanges: Exchange[];
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Fetch that calls the API and keeps every exchange. Never stores headers, so never the key. */
function recordingFetch(exchanges: Exchange[]): typeof fetch {
  return async (input, init) => {
    const body = String(init?.body ?? "");
    const response = await fetch(input, init);
    const text = await response.clone().text();
    exchanges.push({
      requestSha256: sha256(body),
      request: JSON.parse(body),
      status: response.status,
      body: JSON.parse(text),
    });
    return response;
  };
}

/** Fetch that serves a recording back, and flags any request that differs from it. */
function replayFetch(
  recording: Recording,
  stale: { reason?: string },
): typeof fetch {
  let index = 0;
  return async (_input, init) => {
    const body = String(init?.body ?? "");
    const exchange = recording.exchanges[index++];
    if (!exchange) {
      stale.reason = "more requests than were recorded";
    } else if (exchange.requestSha256 !== sha256(body)) {
      stale.reason =
        "request differs from the recording (prompt, schema or model changed)";
    }
    if (stale.reason || !exchange) {
      // A 400 is not retried, so the run ends here and reports the staleness.
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "stale recording" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(exchange.body), {
      status: exchange.status,
      headers: { "content-type": "application/json", "retry-after-ms": "1" },
    });
  };
}

function accepts<T>(
  expected: Acceptable<T> | undefined,
  fallback: T,
  actual: T,
): boolean {
  const options =
    expected === undefined
      ? [fallback]
      : Array.isArray(expected)
        ? expected
        : [expected];
  return options.some((option) => option === actual);
}

/** Field-by-field grade. Returns the list of failures; empty means pass. */
function grade(c: Case, result: InterpretResult): string[] {
  const wantKind = c.expect.kind ?? "search";

  if (wantKind === "not_a_search") {
    if (!result.ok && result.reason === "not_a_search") return [];
    return [
      result.ok
        ? "kind: got a search filter"
        : `kind: failed as ${result.reason}`,
    ];
  }
  if (!result.ok) return [`call: ${result.reason} (${result.detail})`];

  const f: CatalogueFilter = result.filter;
  const failures: string[] = [];
  const lower = (value: string | null) => (value ?? "").toLowerCase();

  const wantAuthor = c.expect.author ?? null;
  if (
    wantAuthor === null
      ? f.author !== null
      : !lower(f.author).includes(wantAuthor)
  ) {
    failures.push(`author: got ${JSON.stringify(f.author)}`);
  }

  const wantKeywords = c.expect.keywords ?? null;
  if (wantKeywords === null) {
    if (f.keywords !== null)
      failures.push(`keywords: got ${JSON.stringify(f.keywords)}, want null`);
  } else {
    const text = lower(f.keywords);
    const missing = wantKeywords.includes.filter(
      (term) => !text.includes(term),
    );
    const extra = (wantKeywords.excludes ?? []).filter((term) =>
      text.split(/\W+/).includes(term),
    );
    if (missing.length > 0 || extra.length > 0) {
      failures.push(`keywords: got ${JSON.stringify(f.keywords)}`);
    }
  }

  for (const field of ["genre", "yearFrom", "yearTo"] as const) {
    if (!accepts<string | number | null>(c.expect[field], null, f[field])) {
      failures.push(
        `${field}: got ${JSON.stringify(f[field])}, want ${JSON.stringify(c.expect[field] ?? null)}`,
      );
    }
  }
  if (f.availableOnly !== (c.expect.availableOnly ?? false)) {
    failures.push(`availableOnly: got ${f.availableOnly}`);
  }
  return failures;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return Math.round(
    sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low),
  );
}

interface Row {
  id: string;
  query: string;
  failures: string[];
  stale?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}

async function main() {
  const record = process.argv.includes("--record");
  const only = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);

  const suite = JSON.parse(
    await readFile(path.join(here, "cases.json"), "utf8"),
  ) as Suite;
  const now = new Date(suite.now);
  const cases = suite.cases.filter((c) => !only || c.id === only);

  if (record) await mkdir(RECORDINGS, { recursive: true });

  const rows: Row[] = [];
  for (const c of cases) {
    const file = path.join(RECORDINGS, `${c.id}.json`);
    let result: InterpretResult;
    let latencyMs: number;
    const stale: { reason?: string } = {};

    if (record) {
      const exchanges: Exchange[] = [];
      // No apiKey argument: the SDK reads ANTHROPIC_API_KEY (or an `ant` profile).
      const client = new Anthropic({ fetch: recordingFetch(exchanges) });
      result = await interpretQuery(c.query, {
        client,
        genres: suite.genres,
        now,
      });
      latencyMs = result.ok ? result.metrics.latencyMs : result.latencyMs;
      const recording: Recording = {
        case: c.id,
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        recordedAt: new Date().toISOString(),
        latencyMs,
        exchanges,
      };
      await writeFile(file, `${JSON.stringify(recording, null, 2)}\n`);
    } else {
      let recording: Recording;
      try {
        recording = JSON.parse(await readFile(file, "utf8")) as Recording;
      } catch {
        rows.push({
          id: c.id,
          query: c.query,
          failures: [],
          stale: "no recording",
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          costMicroUsd: 0,
        });
        continue;
      }
      const client = new Anthropic({
        apiKey: "replay",
        fetch: replayFetch(recording, stale),
      });
      result = await interpretQuery(c.query, {
        client,
        genres: suite.genres,
        now,
      });
      latencyMs = recording.latencyMs;
    }

    const metrics = result.metrics;
    rows.push({
      id: c.id,
      query: c.query,
      failures: stale.reason ? [] : grade(c, result),
      ...(stale.reason ? { stale: stale.reason } : {}),
      latencyMs,
      inputTokens: metrics?.inputTokens ?? 0,
      outputTokens: metrics?.outputTokens ?? 0,
      costMicroUsd: metrics?.costMicroUsd ?? 0,
    });
  }

  const staleRows = rows.filter((r) => r.stale);
  const graded = rows.filter((r) => !r.stale);
  const passed = graded.filter((r) => r.failures.length === 0).length;
  const passRate = graded.length > 0 ? passed / graded.length : 0;
  const latencies = graded.map((r) => r.latencyMs);
  const cost = graded.reduce((sum, r) => sum + r.costMicroUsd, 0);
  const tokensIn = graded.reduce((sum, r) => sum + r.inputTokens, 0);
  const tokensOut = graded.reduce((sum, r) => sum + r.outputTokens, 0);

  for (const r of rows) {
    const status = r.stale
      ? "STALE"
      : r.failures.length === 0
        ? "pass "
        : "FAIL ";
    console.log(
      `${status} ${r.id.padEnd(28)} ${String(r.latencyMs).padStart(5)} ms  ${r.stale ?? r.failures.join("; ")}`,
    );
  }

  const summary = [
    `Model ${MODEL}, prompt ${PROMPT_VERSION}, ${record ? "live" : "replayed"}`,
    `Passed ${passed}/${graded.length} (${(passRate * 100).toFixed(0)}%), threshold ${(suite.minPassRate * 100).toFixed(0)}%`,
    `Latency p50 ${percentile(latencies, 50)} ms, p95 ${percentile(latencies, 95)} ms, max ${Math.max(0, ...latencies)} ms`,
    `Tokens ${tokensIn} in / ${tokensOut} out; cost ${formatMicroUsd(cost)} for ${graded.length} calls, ` +
      `about ${formatMicroUsd(graded.length > 0 ? (cost / graded.length) * 1000 : 0)} per 1,000 searches`,
  ];
  console.log(`\n${summary.join("\n")}`);

  if (record && !only) {
    const table = rows
      .map(
        (r) =>
          `| ${r.id} | ${r.query.replace(/\|/g, "\\|")} | ${r.failures.length === 0 ? "pass" : `**fail**: ${r.failures.join("; ")}`} | ${r.latencyMs} | ${r.inputTokens}/${r.outputTokens} |`,
      )
      .join("\n");
    await writeFile(
      path.join(here, "RESULTS.md"),
      `# nl-search eval results\n\nRecorded ${new Date().toISOString().slice(0, 10)} by \`npm run eval:nl-search -- --record\`. ` +
        `CI replays these exact responses on every push; see run.mts.\n\n` +
        summary.map((line) => `- ${line}`).join("\n") +
        `\n\n| Case | Query | Result | Latency (ms) | Tokens in/out |\n| --- | --- | --- | --- | --- |\n${table}\n`,
    );
  }

  if (staleRows.length > 0) {
    console.error(
      `\n${staleRows.length} case(s) have stale or missing recordings. Re-record with: npm run eval:nl-search -- --record`,
    );
    process.exit(1);
  }
  if (passRate < suite.minPassRate) {
    console.error(`\nPass rate below threshold.`);
    process.exit(1);
  }
}

await main();
