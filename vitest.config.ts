import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { defineConfig } from "vitest/config";

/**
 * Loaded here, in the config module itself, rather than in a setupFile: the
 * config is evaluated before any test module is imported, and src/lib/env.ts
 * validates process.env at import time. A setupFile would run too late.
 */
loadDotenv();

/**
 * Integration tests point at the throwaway database on :15434 (compose service
 * `db-test`, tmpfs-backed), never at the dev database. Tests delete rows, and
 * doing that to the seeded demo data would be tedious at best.
 */
const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
if (testDatabaseUrl) {
  process.env["DATABASE_URL"] = testDatabaseUrl;
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Argon2id at OWASP parameters is intentionally slow; the default 5s
    // timeout is tight once a test hashes a handful of passwords.
    testTimeout: 20_000,
    // Integration tests share one database, so parallel files would race on
    // the same rows.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only`'s main entry throws on import; only the `react-server`
      // export condition resolves to a harmless no-op. Setting
      // `resolve.conditions` is not enough, because the package is reached
      // through CJS `require`, which reads `main` and ignores the exports map.
      // Aliasing straight to the empty entry is what actually works, and lets
      // tests import server-marked modules like lib/auth/session.ts.
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
});
