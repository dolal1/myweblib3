import path from "node:path";

import { defineConfig, devices } from "@playwright/test";
import { config as loadDotenv } from "dotenv";

/**
 * End-to-end tests run a production build against the throwaway database on
 * :15434 (compose service `db-test`), never the dev database: they check out
 * copies and sign people in, and the seed they start from is replayed fresh on
 * every run. Same reasoning as vitest.config.ts.
 *
 * Unlike there, .env is read into its own object rather than process.env. The
 * web server inherits this process's environment, and .env's
 * NODE_ENV="development" would then reach `next build`, which fails to
 * prerender with a development NODE_ENV. Next reads .env itself anyway.
 *
 * The path is resolved from this file, not the working directory: the VS Code
 * Playwright extension loads the config from the workspace folder, which may
 * be a parent of this repo, where there is no .env.
 */
const dotenv: Record<string, string> = {};
loadDotenv({
  path: path.resolve(__dirname, ".env"),
  processEnv: dotenv,
  quiet: true,
});

const testDatabaseUrl =
  process.env["TEST_DATABASE_URL"] ?? dotenv["TEST_DATABASE_URL"];
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is not set. Copy .env.example to .env.");
}

const PORT = 3100;
const isCI = Boolean(process.env["CI"]);

export default defineConfig({
  testDir: "e2e",
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // One seeded database shared by every test, as with the integration tests.
  workers: 1,
  reporter: isCI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "on-failure" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // with-db.sh starts db-test, replays the migrations into it, and stops it
    // again when Playwright shuts the server down (--own). DATABASE_URL below
    // points the seed, the build and the server at it; neither dotenv nor Next
    // overwrites a variable that is already set, so the rest of .env applies.
    command: `scripts/with-db.sh db-test --migrate --own sh -c "npx prisma db seed && npx next build && npx next start --port ${PORT}"`,
    url: `http://localhost:${PORT}/api/health`,
    env: { DATABASE_URL: testDatabaseUrl },
    // A server left over from another run would be pointed at whatever it was
    // seeded with, so always start a fresh one.
    reuseExistingServer: false,
    timeout: 240_000,
    // Playwright's default is SIGKILL, which skips with-db.sh's EXIT trap and
    // leaves db-test running. SIGTERM lets the trap stop it.
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    stdout: "pipe",
  },
});
