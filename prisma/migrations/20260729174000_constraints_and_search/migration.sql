-- Hand-written migration for guarantees the Prisma schema language cannot
-- express. Kept separate from the generated `init` migration so the SQL below
-- is easy to find and reason about.

-- ---------------------------------------------------------------------------
-- 1. At most one open loan per copy.
--
-- This is the constraint that makes double-checkout impossible rather than
-- merely unlikely. Without it, two requests can both read "copy is AVAILABLE"
-- and both insert a loan. Application-level checks cannot close that window;
-- a partial unique index can, because the second INSERT fails at the database.
--
-- Prisma has no syntax for a WHERE clause on a unique index, hence raw SQL.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "Loan_one_open_per_copy"
  ON "Loan" ("copyId")
  WHERE "returnedAt" IS NULL;

-- ---------------------------------------------------------------------------
-- 2. A member may hold a given title only once while the hold is live.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "Hold_one_active_per_member_book"
  ON "Hold" ("bookId", "memberId")
  WHERE "status" IN ('WAITING', 'READY');

-- ---------------------------------------------------------------------------
-- 3. Value constraints. Cheap to add, and they turn whole classes of bug into
--    an immediate error instead of corrupt data discovered months later.
-- ---------------------------------------------------------------------------
ALTER TABLE "Fine"
  ADD CONSTRAINT "Fine_amount_non_negative" CHECK ("amountCents" >= 0);

ALTER TABLE "Loan"
  ADD CONSTRAINT "Loan_renewal_count_non_negative" CHECK ("renewalCount" >= 0);

ALTER TABLE "Loan"
  ADD CONSTRAINT "Loan_due_after_checkout" CHECK ("dueAt" > "checkedOutAt");

ALTER TABLE "Loan"
  ADD CONSTRAINT "Loan_returned_after_checkout"
  CHECK ("returnedAt" IS NULL OR "returnedAt" >= "checkedOutAt");

ALTER TABLE "Book"
  ADD CONSTRAINT "Book_page_count_positive"
  CHECK ("pageCount" IS NULL OR "pageCount" > 0);

-- ISBN-13 is stored digits-only; reject anything else at the door.
ALTER TABLE "Book"
  ADD CONSTRAINT "Book_isbn13_format"
  CHECK ("isbn13" IS NULL OR "isbn13" ~ '^[0-9]{13}$');

-- ---------------------------------------------------------------------------
-- 4. Full-text search.
--
-- A generated tsvector column keeps the index in lockstep with the row without
-- triggers. Title is weighted 'A' and description 'B' so a title match ranks
-- above a passing mention in the blurb.
--
-- v2 "searched" by interpolating the raw query string into `new RegExp(...)`,
-- which was both unindexable and a ReDoS vector. This is neither.
-- ---------------------------------------------------------------------------
ALTER TABLE "Book"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("subtitle", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("publisher", '')), 'C')
  ) STORED;

CREATE INDEX "Book_searchVector_idx" ON "Book" USING GIN ("searchVector");

-- Author names are searched separately and joined in, since a generated column
-- cannot reach across a table boundary.
ALTER TABLE "Author"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce("name", ''))
  ) STORED;

CREATE INDEX "Author_searchVector_idx" ON "Author" USING GIN ("searchVector");

-- Trigram index for fuzzy title matching ("the great gastby" should still find
-- The Great Gatsby), used as a fallback when full-text returns nothing.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Book_title_trgm_idx" ON "Book" USING GIN ("title" gin_trgm_ops);
