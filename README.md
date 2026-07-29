# myweblib3

A library catalogue and circulation system: books, authors, physical copies,
lending, holds, and fines.

It is the third attempt at a project first written in 2020. The second,
[myweblib2](https://github.com/dolal1/myweblib2), is an Express + EJS + Mongoose
app that has been deliberately left exactly as it was — it is the record of
where this started. **[docs/from-v2.md](docs/from-v2.md) is the audit of what
that version got wrong**, and it is the reason this one exists and the reason it
is shaped the way it is.

## Stack

|           |                                                            |
| --------- | ---------------------------------------------------------- |
| Runtime   | Node 24                                                    |
| Framework | Next.js 16 (App Router, Server Components, Server Actions) |
| Language  | TypeScript, `strict` plus `noUncheckedIndexedAccess`       |
| Database  | PostgreSQL 18                                              |
| ORM       | Prisma 7 (driver adapters)                                 |
| Styling   | Tailwind CSS 4                                             |
| Auth      | Hand-rolled: Argon2id, database-backed sessions            |

## Getting started

Requires Node 24+ and Docker.

```bash
git clone git@github.com:dolal1/myweblib3.git
cd myweblib3
npm install

cp .env.example .env
# generate real secrets
sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=\"$(openssl rand -base64 32)\"|" .env
sed -i "s|^CRON_SECRET=.*|CRON_SECRET=\"$(openssl rand -base64 32)\"|" .env

npm run db:up        # Postgres on :5433, throwaway test DB on :5434
npm run db:migrate   # apply migrations
npm run db:seed      # realistic demo library
npm run dev
```

Then open <http://localhost:3000>. `GET /api/health` round-trips to Postgres and
returns 503 if the database is unreachable.

### Demo accounts

All use the password `correct-horse-battery-staple`.

| Email                     | Role      | State                        |
| ------------------------- | --------- | ---------------------------- |
| `admin@myweblib.test`     | ADMIN     | —                            |
| `librarian@myweblib.test` | LIBRARIAN | issued the seeded loans      |
| `ada@myweblib.test`       | MEMBER    | two active loans             |
| `brian@myweblib.test`     | MEMBER    | one overdue loan with a fine |
| `chidi@myweblib.test`     | MEMBER    | one returned loan, one hold  |
| `dana@myweblib.test`      | MEMBER    | suspended                    |

The seed is shaped rather than bulky: it deliberately contains a co-authored
book, a fully-loaned title with a two-deep hold queue, an overdue loan with a
fine, a returned loan, a book with no ISBN and no cover, and a suspended member
— so every branch of the circulation code has something real to act on.

## Scripts

| Command                     | Does                       |
| --------------------------- | -------------------------- |
| `npm run dev`               | dev server                 |
| `npm run build` / `start`   | production build and serve |
| `npm run check`             | typecheck + lint + format  |
| `npm test`                  | unit tests                 |
| `npm run test:e2e`          | Playwright                 |
| `npm run db:up` / `db:down` | Postgres containers        |
| `npm run db:migrate`        | apply migrations           |
| `npm run db:seed`           | reseed                     |
| `npm run db:studio`         | Prisma Studio              |

### The daily job

Overdue notices, due-soon reminders, hold expiry, and session pruning run from
one endpoint:

```bash
curl -X POST http://localhost:3000/api/jobs/daily \
  -H "Authorization: Bearer $CRON_SECRET"
```

It is idempotent — a re-run collides on the `dedupeKey` unique index rather than
notifying twice — and it is the one endpoint in the app that needs its own auth,
because route handlers get none of the `Origin` checking Next.js applies to
Server Actions.

## Architecture notes

Decisions are recorded in [docs/adr/](docs/adr/):

- [001 — PostgreSQL over MongoDB](docs/adr/001-postgres-over-mongodb.md)
- [002 — Hand-rolled sessions](docs/adr/002-hand-rolled-sessions.md)
- [003 — Schema design](docs/adr/003-schema-design.md)
- [004 — Dependency audit policy](docs/adr/004-dependency-audit-policy.md)

Three points worth calling out:

**A `BookCopy` is not a `Book`.** v2 conflated the catalogue record with the
lendable object, which is why it could never have grown a lending feature. Here
a `Book` is bibliographic and a `BookCopy` is a physical thing with a barcode.

**The database enforces the rules.** A partial unique index
(`Loan_one_open_per_copy`) makes double-checkout of a copy impossible rather
than merely unlikely — no application-level check can close that race. Foreign
keys with `onDelete: Restrict` refuse to delete an author who is still credited
on a book, replacing v2's `pre('remove')` hook whose error the delete route
silently swallowed.

**Authorization is checked inside every Server Function.** Server Actions are
reachable by direct `POST`, so a guard in a layout protects rendering but not
the mutation. Getting this wrong is how v2 ended up with entirely open CRUD.

## Status

Under construction.

- [x] Foundation — Next 16, TS strict, Prisma 7, Docker Postgres, validated env
- [x] Data model — schema, migrations, hand-written constraints, seed
- [x] Authentication — Argon2id, database sessions, rate limiting, role DAL
- [x] Catalogue — book and author CRUD, multi-author credits, ISBN validation,
      search, pagination
- [x] Circulation — checkout, return, renew, hold queues, overdue fines
- [x] Search and ISBN lookup — ranked full-text with typo fallback, Open
      Library metadata
- [x] Notifications and reporting — idempotent daily job, admin dashboard
- [ ] Tests, CI, deploy
