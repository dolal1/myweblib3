import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { env, isProduction } from "@/lib/env";

/**
 * Prisma client singleton.
 *
 * Next.js hot-reloads modules in development, which would otherwise construct a
 * fresh PrismaClient (and a fresh connection pool) on every edit until Postgres
 * refuses new connections. Stashing the instance on globalThis survives the
 * reload.
 *
 * Prisma 7 connects through a driver adapter rather than its own engine
 * binary, so the pg pool is configured here explicitly.
 */
const createPrismaClient = () =>
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
    log: isProduction ? ["error", "warn"] : ["error", "warn"],
  });

type PrismaClientSingleton = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClientSingleton | undefined;
};

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (!isProduction) {
  globalForPrisma.prisma = db;
}
