# ADR-003: Schema design

**Status:** Accepted · 2026-07-29

## Context

v2's Mongoose models were `User`, `Author`, and `Book`. Three structural
limits followed from that shape, documented in `docs/from-v2.md`.

## Decisions

### Book ↔ Author is many-to-many, through an explicit join table

v2's `Book.author` was a single `ObjectId`. A co-authored book — Lovelace and
Babbage on the same volume, which the seed data includes precisely to prove the
point — was not representable.

`BookAuthor` is an _explicit_ join model rather than Prisma's implicit m-n,
because the relationship carries its own data: which kind of contribution
(`AUTHOR`, `EDITOR`, `TRANSLATOR`, `ILLUSTRATOR`) and the order names are
credited in. `Genre` uses an implicit m-n by contrast, because that relationship
carries nothing.

### `BookCopy` is the lendable object

This is the entity v2 lacked entirely, and its absence is why v2 could never
have grown a lending feature. A `Book` is a catalogue record; a `BookCopy` is a
physical object with a barcode, a condition, a shelf location, and a status.
Loans reference copies. Holds reference _books_, because a member waiting for a
title does not care which copy satisfies them.

### Integrity is declared, not enforced in application code

`onDelete: Restrict` on `BookAuthor.author` and `BookCopy.book` replaces v2's
`pre('remove')` hook. The database refuses; the application reports it.

### Two things Prisma cannot express

Both live in the `constraints_and_search` migration as hand-written SQL:

1. **`Loan_one_open_per_copy`** — a unique index on `copyId` with
   `WHERE "returnedAt" IS NULL`. This is the single most important line in the
   schema. Without it, two concurrent checkouts can both read "copy is
   AVAILABLE" and both insert a loan; no application-level check closes that
   window. With it, the second `INSERT` fails.
2. **Generated `tsvector` columns** on `Book` and `Author`, maintained by
   Postgres with no trigger, indexed with GIN. Title is weighted `A` and
   description `B`, so a title match outranks a passing mention.

Both must then be declared back in `schema.prisma` — as
`Unsupported("tsvector")? @default(dbgenerated())` and `@@index(..., type: Gin)`
— or `prisma migrate dev` treats them as drift and generates a migration that
drops them.

### Money is integer cents

`Fine.amountCents`, with a `CHECK (amountCents >= 0)` constraint. Floating point
has no business near an account balance.

### UUIDv7 primary keys

Time-ordered, so they index well without leaking a sequential count of the
table's rows the way an auto-increment integer does.

## Verification

The constraints were exercised directly against the database before any
application code was written: concurrent checkout of one copy, deleting a
credited author, negative fines, malformed ISBNs, and loans due before issue are
all rejected; re-lending a returned copy is allowed. These are re-asserted as
integration tests.
