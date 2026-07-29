# ADR-002: Hand-rolled session authentication

**Status:** Accepted · 2026-07-29

## Context

myweblib2 used Passport with `passport-local` and `express-session`. The
configuration got almost everything wrong: a session secret hardcoded in source
as `'secret cat'`, `resave` and `saveUninitialized` both true, the default
in-memory store, no cookie flags, no expiry, no CSRF protection, and login
messages that distinguished an unknown email from a wrong password.

The application-level authorization was worse: `ensureAuthenticated` was written
and then applied to exactly one route, leaving every book and author mutation
open to the internet.

The Next.js documentation recommends using an auth library, and for production
work that is the right default. This project has an explicit learning goal, and
authentication is the area where v2 failed hardest.

## Decision

Implement session authentication directly: Argon2id password hashing,
database-backed sessions, and CSRF tokens.

## Consequences

- **Argon2id** at OWASP's baseline parameters (19 MiB, 2 iterations,
  parallelism 1). Memory-hard, unlike bcrypt's cost factor, so an attacker's GPU
  advantage is blunted. Parameters live in the hash string, so raising them
  later still verifies old hashes.
- **Sessions in Postgres.** The browser receives a high-entropy random token;
  the database stores only its SHA-256. A leaked database dump therefore does
  not contain usable session cookies. Sessions can be listed and revoked, which
  a signed stateless cookie cannot do.
- **Cookie flags** are set explicitly: `httpOnly`, `secure`, `sameSite=lax`, an
  explicit `maxAge`, and `path=/`.
- **Token rotation** on privilege change, to close session fixation.
- **Generic failure messages.** "Invalid email or password", always — no user
  enumeration.
- **Authorization is checked inside every Server Function.** The Next.js docs
  are explicit that Server Actions are reachable by direct `POST` and are not
  protected by a layout or by proxy-level checks. A `requireRole()` call in a
  layout guards _rendering_; it does not guard the action. This is the same
  mistake v2 made, and it would have been easy to repeat in a new form.
- **Proxy (`proxy.ts`, formerly middleware) is used only for optimistic
  redirects**, never as the authorization boundary — again per the Next.js
  guidance.

## Cost

More code to get right, and a genuine risk of getting it wrong. Mitigated by
unit tests over hashing and session lifecycle, and an end-to-end test covering
register → login → access → logout → access denied.

If this were production software serving real members, Better Auth or Auth.js
would be the correct choice, and this ADR would read differently.
