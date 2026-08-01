# ADR-005: Development containers are started on demand

**Status:** Accepted · 2026-08-01

## Context

Both Postgres services carried `restart: unless-stopped`. That policy is not
"restart on failure" — it also brings the container back every time the Docker
daemon starts, which means every reboot. Nothing in the project ever took them
down again.

The effect on a machine holding a dozen checkouts is that a project nobody is
working on keeps a database running indefinitely. `myweblib3-db-test` was found
up for eleven hours with no test run in sight, holding a published port, a
tmpfs allocation and a few hundred MB of RSS. The only way to clear it was to
remember to run `docker compose down` by hand, in the right directory, for a
project you had already stopped thinking about.

The ports made it worse. 5433 and 5434 were chosen to dodge a local Postgres on
5432, but they are the next two ports every _other_ project on the same machine
reaches for, for exactly the same reason. In practice 5433 had already been
taken by another project's container.

## Decision

**A container runs only while a command needs it.**

- `restart: "no"` on both services, so a reboot does not resurrect them.
- `scripts/with-db.sh` starts the one service a command needs, waits on the
  healthcheck, and stops it again on exit. `dev`, `test` and the `db:*` scripts
  all go through it, so there is no separate "bring the database up" step.
- Published ports move to **15433** and **15434**, clear of the 5432–5434
  cluster and below the ephemeral range (32768–60999), so the kernel cannot
  hand them out to outbound connections. They come from `DB_PORT` and
  `DB_TEST_PORT` in `.env`, which compose reads, so a future clash is a
  one-file change.

`db:migrate`, `db:seed`, `db:studio` and `db:reset` are wrapped as well. They
are not long-running, but they relied on the always-on container and would
otherwise now fail with connection-refused.

### Ownership

Two behaviours were needed, and conflating them was the mistake made first.

| Command                                          | On exit                                    |
| ------------------------------------------------ | ------------------------------------------ |
| `dev`, `test` (`--own`)                          | Stop the container, whoever started it     |
| `db:migrate`, `db:seed`, `db:studio`, `db:reset` | Stop it only if this invocation started it |

The protective behaviour exists so that a migration run in a second terminal
cannot stop the database out from under a running dev server. Applying it
everywhere made the leak sticky: once a container was up for any reason — an
earlier `db:up`, a crashed run — every later `npm run dev` saw it already
running, declined to touch it, and it stayed up forever. Ending the dev server
means you are done, so `dev` owns the lifecycle outright.

## The test database now starts empty

`db-test` is tmpfs-backed. While it never stopped, a schema pushed into it once
survived indefinitely and no script had to create one. Now that it goes down
between runs, `with-db.sh --migrate` replays the migrations on the way up.

It uses `prisma migrate deploy`, not `db push`. The migrations carry
hand-written SQL — generated `tsvector` columns, GIN indexes, partial unique
indexes — that a diff from `schema.prisma` would not create, and the search and
circulation integration tests assert against exactly that SQL.

## A note on diagnosing the teardown

Recorded because the wrong answer was convincing for three rounds.

When teardown-on-exit was reported to be failing, Ctrl-C was blamed, and two
bash harnesses appeared to confirm it: the container survived the signal both
times. Both harnesses were wrong. They started the script in the background
with `&`, and a background job in a non-interactive shell inherits `SIGINT` as
`SIG_IGN` — a disposition bash then refuses to install a trap over. The signal
never reached the script at all.

Delivered as a real foreground interrupt — child in its own session with the
handler reset to `SIG_DFL`, signal sent to the process group, which is what a
tty does — every variant tore down correctly. **Bash does run an `EXIT` trap
when the script is killed by `SIGINT` or `SIGTERM`.** The actual cause was the
ownership rule above, which no signal test would ever have found.

The `INT`/`TERM`/`HUP` traps were kept regardless, but only for the exit status:
dying from a signal reports "killed by signal" to npm, which prints an error
block on an ordinary quit. Exiting with 128 + the signal number makes an
interrupted dev server read as the expected end that it is.

## Consequences

- Nothing of this project is running when you are not working on it, and
  nothing needs to be stopped by hand before another project can start.
- The first command of a session pays for a container start plus a healthcheck
  — a second or two — and `npm test` additionally replays two migrations.
- `db:up` / `db:down` remain for holding a database open across several
  commands, with the caveat that a later `npm run dev` will stop it on the way
  out, by design.
- `DB_PORT` and the port inside `DATABASE_URL` are two values that must agree.
  They are adjacent in `.env` and commented, but it is a real seam.
