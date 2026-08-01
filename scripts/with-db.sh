#!/usr/bin/env bash
#
# Runs a command with one of this project's Postgres containers up, and stops
# the container again on the way out.
#
# The point is that myweblib3 should own no resources when nobody is working on
# it: no port held, no memory used, nothing to stop by hand before another
# project can start. compose.yaml sets `restart: "no"` so the containers never
# come back on their own after a reboot, and this script is what starts them
# when a command actually needs a database.
#
# Usage: scripts/with-db.sh <service> [--migrate] [--own] <command> [args...]
#
#   --migrate   Apply migrations before running the command. Needed for
#               db-test, which is tmpfs-backed and so comes up empty every
#               time. `migrate deploy` rather than `db push`, because the
#               migrations carry hand-written SQL — generated tsvector columns,
#               partial unique indexes — that a schema diff would not create,
#               and the search and circulation integration tests depend on
#               exactly that SQL.
#
#   --own       Stop the container on exit even if this script did not start
#               it. For `npm run dev`, which owns the session: ending the dev
#               server means you are done, so the database goes with it.
#               Without this a container left up by anything else — an earlier
#               `npm run db:up`, a crashed run — is never stopped again,
#               because every later run sees it already up and declines to
#               touch it.

set -euo pipefail

cd "$(dirname "$0")/.."

usage() {
  echo "usage: scripts/with-db.sh <service> [--migrate] [--own] <command> [args...]" >&2
  exit 64
}

[ "$#" -ge 1 ] || usage

service=$1
shift

migrate=false
own=false
while [ "$#" -gt 0 ]; do
  case "${1-}" in
    --migrate)
      migrate=true
      shift
      ;;
    --own)
      own=true
      shift
      ;;
    *) break ;;
  esac
done

[ "$#" -ge 1 ] || usage

# Without --own, a container that was already running is assumed to belong to
# someone else — most likely a dev server in another terminal — so
# `npm run db:migrate` alongside it does not stop the database out from under
# that server on the way out.
started_by_us=false
if [ -z "$(docker compose ps -q --status running "$service")" ]; then
  started_by_us=true
fi

cleanup() {
  if [ "$own" = true ] || [ "$started_by_us" = true ]; then
    docker compose stop "$service" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Bash does run the EXIT trap when the script is killed by SIGINT or SIGTERM,
# so cleanup happens either way; these are for the exit status. Dying from the
# signal reports "killed by signal" to npm, which turns it into noisy ERR
# output on an ordinary Ctrl-C. Catching them and exiting with the
# conventional 128 + signal number makes an interrupted dev server a quiet,
# expected end.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# --wait blocks on the healthcheck. Without it `up -d` returns before Postgres
# accepts connections and the first command of a session fails.
docker compose up -d --wait "$service"

if [ "$migrate" = true ]; then
  # dotenv, loaded by prisma.config.ts, does not overwrite variables already
  # present in the environment, so exporting DATABASE_URL for this one command
  # points Prisma at the test database without touching .env.
  test_url=$(grep -m1 '^TEST_DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')
  if [ -z "$test_url" ]; then
    echo "with-db.sh: TEST_DATABASE_URL is not set in .env" >&2
    exit 78
  fi
  DATABASE_URL="$test_url" npx prisma migrate deploy
fi

"$@"
