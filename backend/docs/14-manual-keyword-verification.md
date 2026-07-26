# Manual Keyword Verification (new feature)

**Files:** `services/keyword.service.ts` (`addKeyword`), `lib/dataforseo.ts`
(new `getSearchVolume`), reuses existing `scoreKeywordAlignment` (`lib/llm.ts`)
**Status: ✅ Implemented — new feature, not a bug fix.**

## What existed before
`addKeyword` accepted whatever the user typed with zero verification —
`alignmentScore` was hardcoded to `100` regardless of the keyword, no
search volume, no relevance check. A typo or a dead keyword would eat one
of the project's 5 weekly content slots with no warning.

## What this adds
Real-time (synchronous) verification on add:
- **Search volume** — a new `getSearchVolume()` in `lib/dataforseo.ts`,
  using a different DataForSEO product (Keyword Data API's Search Volume
  endpoint, `POST /v3/keywords_data/google_ads/search_volume/live`) than
  the one already in use (`getRankedKeywords()` uses the Labs API's Ranked
  Keywords endpoint — that finds keywords a *domain* ranks for; this one
  gets volume for one *specific phrase* the user typed).
- **Relevance** — reuses the existing `scoreKeywordAlignment()` (already
  built for the automated keyword-research pipeline) against this
  project's real business context, rather than writing a second, separate
  relevance-checking function.

## The blocking rule — hard-block only on a confirmed double-failure
Per your call: reject only when **both** signals clearly fail — confirmed
zero search volume **and** judged irrelevant. Either signal alone is not
enough to reject:
- A real product/brand name can show near-zero "search volume" in keyword
  tools while still being exactly the right keyword to target.
- A broad, clearly relevant term might have volume data temporarily
  unavailable.

## Fail-open, not fail-closed
If either check itself fails — DataForSEO down, rate limited, LLM call
errors — that's treated as **"unknown,"** never as **"confirmed bad."**
Both checks run via `Promise.allSettled`, and:
- A failed volume lookup returns `searchVolume: null` (distinct from a
  genuine `0`) — `null` can never trigger the block.
- A failed alignment check falls back to `alignmentScore: 100` (same
  default as before this feature existed) — the user isn't penalized for
  our infrastructure being down.

This matters because a verification-infrastructure problem on our side
should never be the reason a user's own keyword gets rejected.

## What the user sees on success
The created `Keyword` now carries real data instead of placeholder values:
`searchVolume`, `cpc`, `alignmentScore`, and `relevanceReason` — the same
fields already populated for pipeline-discovered keywords, so the
"Keywords & Content" view doesn't need to distinguish user-added from
auto-discovered keywords in how it displays this data.

## Not changed
- API request contract is unchanged (`POST /keywords` still just takes
  `{ keyword: string }`) — all the new logic is internal to the service
  method, no route/validation-schema changes needed.
- Verified with `tsc --noEmit` — clean compile.

## Open item, not addressed here
No test suite exists in this repo (same caveat as previous features) —
verification here was type-checking and manual trace-through, not a live
smoke test against real DataForSEO/LLM calls. Worth a real test (add a
keyword with obviously good data, one with obviously bad data, and one
where the two signals disagree) before trusting this in production.
