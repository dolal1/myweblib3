# ADR-004: Dependency audit policy

**Status:** Accepted · 2026-07-29

## Context

myweblib2's frozen lockfile reports 24 vulnerabilities, 2 of them critical. That
number is the headline symptom of an abandoned project, so v3 should hold a
standard that is both high and _honest_.

Two things complicate a naive "zero vulnerabilities" rule:

1. **A freshly scaffolded Next.js 16 app already reports 12 high advisories.**
   All of them are transitive build tooling. `npm audit fix --force` "resolves"
   them by downgrading Next.js to 9.3.3 and `eslint-config-next` to 12.0.4,
   which is obviously worse than the disease.

2. **Some advisories have no clean fix.** `brace-expansion` GHSA-mh99-v99m-4gvg
   is patched only in 5.0.8, but the consumer in our tree is `minimatch@3`
   (via `eslint-config-next` → `eslint-plugin-import`), which expects the v1
   export shape. Forcing 5.0.8 across the tree makes ESLint crash with
   `TypeError: expand is not a function`. This was tried and reverted.

## Decision

**The gate is `npm audit --omit=dev`, and it must report zero.**

Development-only advisories are reported in CI but do not fail the build.

Where a transitive advisory _does_ have a working patched version, it is pinned
with an `overrides` entry rather than left alone. Currently:

```json
"overrides": {
  "postcss": "^8.5.25",
  "sharp": "^0.35.3"
}
```

Both are reachable from the production bundle, so both matter. This took the
scaffold from 12 high advisories to 6, all of them dev-only.

**ESLint 10 was tried as a route to the remaining six and reverted.** Its peer
range on `eslint-config-next@16.2.12` is `>=9.0.0` and it does move to
`minimatch@10`, which would have resolved the advisory — but ESLint 10 removed a
context API that the bundled `eslint-plugin-react` still calls, and linting dies
with `TypeError: contextOrFilename.getFilename is not a function`. Pinned back
to `eslint@^9.39.5` until `eslint-config-next` ships a compatible plugin set.

## Rationale

The question an audit gate should answer is "can this ship?". A DoS in glob
expansion, reachable only by feeding attacker-controlled patterns to ESLint on
a developer's laptop, is not a property of the deployed application. Failing the
build on it trains people to add `--force` or `audit=false`, which is how real
advisories get missed.

Splitting the gate keeps the signal meaningful: production advisories are a hard
stop; dev advisories are visible and reviewed, not silently suppressed.

## Current accepted exceptions

| Advisory                                | Path                                                          | Why accepted                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| GHSA-mh99-v99m-4gvg (`brace-expansion`) | `eslint-config-next` → `eslint-plugin-import` → `minimatch@3` | Dev-only. Patched version is incompatible with `minimatch@3`'s API. Resolves when `eslint-plugin-import` updates its `minimatch` dependency. |

Review this table whenever `npm audit` output changes.

## Also adopted

npm 12 blocks package install scripts by default. The four that are genuinely
required (`prisma`, `@prisma/engines`, `esbuild`, `unrs-resolver` — all of which
fetch platform binaries) are approved explicitly and **version-pinned** in the
`allowScripts` field of `package.json`. A new version of any of them must be
re-approved, which is a meaningful supply-chain control: v2 by contrast ran
every install script of every one of its 483 transitive packages without
question.
