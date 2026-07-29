import "server-only";

import { z } from "zod";

/**
 * Environment validation.
 *
 * myweblib2 read `process.env.DATABASE_URL` straight into `mongoose.connect`
 * and logged the resulting error to the console. The process then carried on
 * listening, so the app served traffic against a database it had never
 * connected to and every request failed somewhere deep in a route handler.
 *
 * Here the environment is parsed once, at import time. A missing or malformed
 * variable is a startup failure with a message naming the variable, not a
 * mystery 500 an hour later.
 */
const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) =>
        value.startsWith("postgresql://") || value.startsWith("postgres://"),
      "DATABASE_URL must be a postgresql:// connection string",
    ),

  // Used to derive CSRF tokens. 32 bytes of base64 is ~44 characters; the
  // floor of 32 rejects the "secret cat" class of value that v2 shipped
  // hardcoded in its source.
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters"),

  CRON_SECRET: z.string().min(32, "CRON_SECRET must be at least 32 characters"),

  APP_URL: z.url().default("http://localhost:3000"),

  UPLOAD_DIR: z.string().default("./uploads"),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Invalid environment configuration:\n${details}\n\n` +
        `Copy .env.example to .env and fill in the missing values.`,
    );
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
