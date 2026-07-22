# GSC Monitor: Backend Audit

**File:** `workers/jobs/gsc-monitor.job.ts`
**Status: ✅ Solid, real integration. One minor noise/dedup gap.**

## What it does
Real Google Search Console REST API integration (no SDK dependency, plain
`fetch` with Bearer token) — pulls 28-day clicks/impressions/CTR/position
per published blog URL, plus top queries per page, and generates
`BlogLearning` insights for three patterns: high-impression-low-CTR (title
problem), low-average-position (content/ranking problem), and
query-expansion opportunities (ranking for queries beyond the target
keyword).

## What stood out (good)
- This is a genuine, correctly-implemented OAuth token refresh flow (checks
  expiry with a 5-minute buffer, refreshes via the real Google OAuth token
  endpoint, persists the new token) — unlike the GEO analytics job, this one
  is doing exactly what it claims to do with real external data.
- Threshold-based insight detection is simple and explainable (not another
  LLM call) — appropriate here since these are just business-rule
  comparisons against real GSC numbers, not something that benefits from an
  LLM.
- Keyword resolution prefers the actual `Keyword.keyword` string over a
  slug-derived approximation, with a documented fallback for older blogs
  missing `keywordId` — thoughtful backward-compatibility handling.
- Per-blog and per-project failure isolation both present (missing token →
  skip project cleanly; one blog's GSC fetch failing → skip that blog only).

## Minor gap: no dedup on repeated weekly insights
`detectInsights` runs fresh every week and every match becomes a new
`BlogLearning` document via `insertMany` — there's no check for "did we
already flag this exact insight type for this blog last week." For a
chronically underperforming post, this will accumulate near-duplicate
`BlogLearning` records indefinitely (e.g. the same "high impression, low
CTR" insight recorded weekly for months). Likely fine if the UI groups/dedups
by type when displaying, but worth confirming — otherwise the learnings feed
could get noisy over time. Low priority relative to other findings.

## Open question for the team
- Does the frontend dedup/group `BlogLearning` records by type+blog when
  displaying, or would this benefit from a "don't re-flag the same insight
  within N days" guard in the job itself?
