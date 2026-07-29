# What myweblib2 got wrong

myweblib3 exists because of [myweblib2](https://github.com/dolal1/myweblib2), an
Express + EJS + Mongoose library app written in June–July 2020. That repository
is deliberately frozen — it is a record of where this started, and nothing in it
has been changed.

This document is the audit that justified a rewrite. Every item was verified
against the v2 source rather than assumed, and each one maps to a specific
decision in this codebase.

---

## Security

| Issue                                                                                                                                                                                                                        | Where in v2                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **All book and author CRUD was unauthenticated.** An `ensureAuthenticated` middleware existed but was applied to exactly one route, `/dashboard`. Anyone who knew the URLs could create, edit, or delete any book or author. | `config/userAuth.js`, `routes/index.js:10`, `server.js:68-69` |
| **No CSRF protection** on any state-changing form.                                                                                                                                                                           | all of `views/`                                               |
| **Session secret hardcoded** in source as `'secret cat'`, with `resave` and `saveUninitialized` both true, the default in-memory store, and no cookie flags or expiry.                                                       | `server.js:44-48`                                             |
| **Regex injection / ReDoS.** Query strings were compiled straight into `new RegExp(...)`. `.*(a+)+$` in the search box was a denial of service.                                                                              | `routes/books.js:11`, `routes/authors.js:10`                  |
| **Passwords echoed back into HTML.** When registration validation failed, the submitted password was rendered into the form's `value=` attribute.                                                                            | `routes/users.js:36-42`, `views/register.ejs:39`              |
| **No unique index on `User.email`.** Two concurrent registrations produced two accounts for one address.                                                                                                                     | `models/User.js:8`                                            |
| **User enumeration.** Login helpfully distinguished "That email is not registered" from "Password is incorrect".                                                                                                             | `config/passport.js:15`                                       |
| No helmet, no rate limiting, no request validation.                                                                                                                                                                          | `server.js`                                                   |
| Unpinned, un-SRI'd CDN scripts — `unpkg.com/filepond` with no version resolves to whatever is newest, forever.                                                                                                               | `views/layout.ejs:6-13`                                       |
| `npm audit` on the frozen lockfile: **24 vulnerabilities, 2 critical, 10 high**.                                                                                                                                             | `package-lock.json`                                           |

## Correctness

- **`pageCount` was never in the schema.** The routes wrote it and the views
  read it, but `models/Book.js` had no such field, so Mongoose dropped it on
  every save. The book page rendered a blank page count for the project's entire
  life and nobody noticed.
- **Registration crashed on a missing password.** `routes/users.js:31` called
  `password.length` after merely _pushing_ a validation error for the missing
  field without returning — a `TypeError` on `undefined`.
- **The "published before" filter never worked.** It checked
  `req.query.publishedBefore` and then read `req.query.publisedBefore`.
  (`routes/books.js:13-15`)
- **The book search box never repopulated** — it read `searchOptions.name` for a
  field named `title`, and appended a stray space inside date `value`
  attributes. (`views/books/index.ejs:12,18`)
- **`res.redirect(url, { error_msg })`** — the second argument to `res.redirect`
  is an HTTP status code, so both author error paths threw rather than
  redirecting. (`routes/authors.js:104,125`)
- **Cover data URIs were malformed**, containing literal newlines and a space
  after `data:`. (`models/Book.js:37-39`)
- **A typo excluded GIFs**: the allowed MIME list contained `'images/gif'`.
  (`routes/books.js:5`)
- **Unhandled promise rejections** — `findOne().then()` chains with no `.catch`.
  (`routes/users.js:45`, `routes/authors.js:46`)
- **Bare `catch {}` swallowed every error** and redirected to `/`, making a
  genuine database failure indistinguishable from a missing record.
- Dead code: `config/keys.js` was referenced nowhere; `User.role` was declared,
  defaulted, and never read; a second `DELETE /:id` route was permanently
  shadowed by the first.

## It no longer runs

Mongoose 5.13 is end of life. `Document.prototype.remove()`, used by both delete
routes, was removed in Mongoose 7. The callback form of `findById` in
`config/passport.js:38` was removed too. The `pre('remove')` hook in
`models/Author.js` no longer fires. Passport 0.6 made `req.logout()` async, so
`routes/users.js:94` would break on upgrade.

## Design limits

These are the interesting ones — not bugs, but choices that capped what the app
could ever become.

1. **A book had exactly one author.** `Book.author` was a single `ObjectId`. A
   co-authored book was not representable.
2. **There was no concept of a physical copy.** A "book" was simultaneously the
   catalogue record and the thing you would lend. You could not own two copies,
   so lending could not be built on top of it.
3. **Cover images were `Buffer`s inside documents**, base64-inlined into the
   HTML on every render — uncacheable, unresizable, and arriving through a form
   body with a 10 MB limit standing in for real uploads.
4. **Referential integrity lived in application code** — a `pre('remove')` hook
   raising "This author has books still" — and the delete route caught that
   error and redirected, so the user saw a silent no-op.

---

## How v3 answers each of these

| v2 problem                           | v3 response                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| One author per book                  | `BookAuthor` join table with a contribution role — see `prisma/schema.prisma`                                 |
| No physical copies                   | `BookCopy`, with `Loan`/`Hold`/`Fine` hanging off it                                                          |
| Integrity in app code                | `onDelete: Restrict` foreign keys; deleting a credited author is refused by Postgres                          |
| Double checkout possible             | `Loan_one_open_per_copy` partial unique index — see the `constraints_and_search` migration                    |
| Regex search                         | Generated `tsvector` columns with GIN indexes and `websearch_to_tsquery`, plus a `pg_trgm` fallback for typos |
| Silent schema mismatch (`pageCount`) | TypeScript strict mode plus a generated Prisma client — the field either exists or the build fails            |
| Hardcoded weak secret                | `SESSION_SECRET` validated at startup with a 32-character floor (`src/lib/env.ts`)                            |
| bcrypt cost 10, callback pyramid     | Argon2id at OWASP parameters (`src/lib/auth/password.ts`)                                                     |
| Auth on one route                    | Auth checked inside every Server Function, not just in layouts — Server Actions are directly POST-reachable   |
| Errors swallowed by `catch {}`       | Errors surface to the user; the database rejects invalid states outright                                      |
| Money as a float                     | `amountCents` integers with a non-negative check constraint                                                   |
| App starts against a dead database   | Environment parsed and validated at import time; startup fails loudly                                         |
