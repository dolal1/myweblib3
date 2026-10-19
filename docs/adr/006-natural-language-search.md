# ADR-006: Natural-language search

**Status:** Accepted · 2026-10-19

## Context

Keyword search answers "Achebe" well and "available books by Achebe from the
1960s" badly: `websearch_to_tsquery` ANDs every word, so "available", "books"
and "1960s" each have to appear in a title or description. The information the
member gave (an author, a decade, a wish to borrow now) exists in the schema as
columns and rows, not as text.

An LLM can read the sentence. The question is how to let it help without
letting it decide what the catalogue says.

## Decision

**The model translates; it never answers.** One call to Claude Haiku 5.5 turns
the text into a `CatalogueFilter` (keywords, author, genre, year range,
available-only). Fixed, parameterised SQL runs the filter. The model does not
see the database, write SQL, or name books, so it cannot invent a title or leak
a row.

**Two layers of validation.** The filter schema goes to the API as a
structured-output format, with genre as an enum of the library's real genres.
The response is parsed again with zod, then checked for sense: a backwards year
range, a year outside 1000 to next year, or an empty filter is rejected.
Rejected output is not repaired. A guessed filter hides books that exist.

**Every failure falls back to keyword search over the original text.** The
interpreter returns a typed result, never a throw: timeout, rate limit, outage,
bad key, refusal, truncation, invalid output, implausible output, not a search.
The page names the fallback in one line and shows keyword results, which is
what the catalogue answered before this feature existed.

**Latency is bounded.** 2.5 s per attempt and one retry (the SDK retries 408,
409, 429 and 5xx), so about 5.5 s at worst before the fallback. Effort is
`low`: this is extraction, not reasoning.

**Cost is recorded per call and capped per day.** Every smart search writes an
`AiCall` row: outcome, failure reason, model, latency, input and output tokens,
and cost in integer micro-dollars, computed from the reported usage. That
includes failed calls that were still billed. The row is the source for:

- the **daily budget** (`AI_DAILY_BUDGET_USD`, default $1): once today's sum
  reaches it, search is keyword-only until midnight UTC;
- the **cache**: the same normalised query within 24 hours under the same
  `PROMPT_VERSION` replays the stored filter at no cost;
- the **admin page**: searches, cache hit rate, fallbacks by reason, p50 and
  p95 latency, cost per call.

**Signed-in members only, 30 an hour each.** Anonymous traffic cannot spend the
budget, and one member's script cannot spend all of it.

**Verified by an eval that runs in CI.** Twenty cases in
`evals/nl-search/cases.json`, graded field by field. An extra constraint the
member never asked for counts as a failure, because it hides books. CI replays
recorded API responses. A recording is only served if the request body is
byte-identical to the one recorded, so a change to the prompt, schema or model
fails CI until it is re-recorded against the real model.

## Alternatives considered

- **Let the model write SQL.** Most flexible, and impossible to make safe
  enough to be worth it: every query would need its own review.
- **Embeddings and vector search.** Good for "books like this one", poor for
  "from the 1960s, available now", which are exact constraints. They also
  need a second index and a re-embedding job. Worth revisiting for
  recommendations, not for this.
- **Tool use with a search tool.** Adds a round trip and gives the model a
  loop, for a task that needs one structured answer.

## Consequences

- A fresh clone works with no API key: the toggle is hidden and nothing
  changes.
- `PROMPT_VERSION` must be bumped when the prompt's meaning changes, or the
  cache keeps serving the old interpretations for up to a day. The eval does
  not catch this; review has to.
- The member rate limit is in-process, like the login limiter (see
  `lib/auth/rate-limit.ts`), so it multiplies with the number of instances.
  The daily budget is in Postgres and does not.
- Query text is stored in `AiCall` against the member. It is not written to
  the log line.
