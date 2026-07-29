# ADR-001: PostgreSQL and Prisma, not MongoDB

**Status:** Accepted · 2026-07-29

## Context

myweblib2 used MongoDB via Mongoose 5. The data it stored — books, authors,
copies, loans — is relational in the ordinary sense: it is mostly joins and
constraints, with very little document-shaped nesting.

Two v2 defects came directly from the storage choice:

- `models/Author.js` used a `pre('remove')` hook to stop an author being deleted
  while books referenced them. The hook ran in application code, its error was
  swallowed by the delete route's bare `catch`, and in Mongoose 7 it stopped
  firing at all.
- `pageCount` was written by the routes and read by the views but absent from
  the schema, so Mongoose silently discarded it on every save.

Neither is possible against a database that enforces its own constraints.

## Decision

PostgreSQL 18, accessed through Prisma 7.

## Consequences

**What this buys us**

- Foreign keys with `onDelete: Restrict` replace the hand-rolled hook. Deleting
  a credited author now fails at the database, and the failure is visible.
- Partial unique indexes make "at most one open loan per copy" a guarantee
  rather than a hope. This is what makes concurrent checkout safe; no amount of
  application-level checking closes that race.
- Check constraints reject negative fines, malformed ISBNs, and loans due before
  they were issued.
- Real transactions across `Loan`, `BookCopy`, and `Hold` — circulation is
  multi-table by nature.
- Full-text search with ranking, via generated `tsvector` columns and GIN
  indexes, replacing v2's unindexable and ReDoS-prone `new RegExp(userInput)`.
- The Prisma client is generated from the schema, so a field that does not exist
  is a compile error rather than data quietly vanishing.

**What it costs**

- Migrations are now a real artefact that must be reviewed, not an implicit
  consequence of editing a schema file. This is a feature, but it is friction.
- Two things Prisma cannot express — partial unique indexes and generated
  `tsvector` columns — live in hand-written SQL in the
  `constraints_and_search` migration. They must be declared back in
  `schema.prisma` (as `Unsupported` columns and `type: Gin` indexes) or Prisma
  reports them as drift and offers to drop them.
- A shadow database is required for `prisma migrate dev` to diff a migration
  history containing raw SQL. See `prisma.config.ts`.

## Alternatives considered

**Stay on MongoDB, upgrade to Mongoose 8.** Cheapest migration, and the schemas
would have carried over nearly unchanged. Rejected because it keeps integrity in
application code, which is the root of two of the four design limits identified
in `docs/from-v2.md`. Learning the relational model was also an explicit goal.

**Drizzle instead of Prisma.** Closer to SQL and lighter at runtime. Prisma won
on the strength of its migration tooling and generated types, which matter more
here than raw query control.
