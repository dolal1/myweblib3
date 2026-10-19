-- CreateEnum
CREATE TYPE "AiCallOutcome" AS ENUM ('OK', 'CACHE_HIT', 'FALLBACK');

-- CreateTable
CREATE TABLE "AiCall" (
    "id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "userId" TEXT,
    "normalizedQuery" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "outcome" "AiCallOutcome" NOT NULL,
    "failureReason" TEXT,
    "model" TEXT,
    "latencyMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "filter" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiCall_feature_createdAt_idx" ON "AiCall"("feature", "createdAt");

-- CreateIndex
CREATE INDEX "AiCall_feature_normalizedQuery_promptVersion_createdAt_idx" ON "AiCall"("feature", "normalizedQuery", "promptVersion", "createdAt");

-- AddForeignKey
ALTER TABLE "AiCall" ADD CONSTRAINT "AiCall_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written: value constraints, as in constraints_and_search. A negative
-- cost or latency is a bug upstream, and the budget check sums this column.
ALTER TABLE "AiCall"
  ADD CONSTRAINT "AiCall_cost_nonnegative" CHECK ("costMicroUsd" >= 0),
  ADD CONSTRAINT "AiCall_latency_nonnegative" CHECK ("latencyMs" IS NULL OR "latencyMs" >= 0),
  ADD CONSTRAINT "AiCall_tokens_nonnegative"
    CHECK (("inputTokens" IS NULL OR "inputTokens" >= 0)
       AND ("outputTokens" IS NULL OR "outputTokens" >= 0));
