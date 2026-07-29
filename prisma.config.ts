import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 moved the datasource URL out of schema.prisma and into this file.
 *
 * The shadow database is required because the constraints_and_search migration
 * contains hand-written SQL (generated tsvector columns, partial unique
 * indexes). Prisma replays the migration history into the shadow database to
 * work out what has actually changed; without one it cannot diff a migrations
 * directory at all.
 */
/**
 * This file is loaded by the Prisma CLI before the app's own environment
 * validation in src/lib/env.ts, so it does its own minimal check. Failing here
 * with a named variable beats Prisma reporting a confusing connection error.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: required("DATABASE_URL"),
    shadowDatabaseUrl: required("SHADOW_DATABASE_URL"),
  },
});
