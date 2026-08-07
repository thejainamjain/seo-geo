# Phase 3 — Technical Audit (LLM Fix Generation): Backend Audit

**File:** `workers/jobs/technical-audit.job.ts` (964 lines)
**Pipeline position:** Step 3 of the 5-step auto-chain
**Status: ✅ Well-engineered. No blocking issues found.**

## What it does
Takes the mechanical `CodeChange`/`FAQ`/`TLDR` stubs created by Phase 1
(site-crawl) and fills them in with LLM-generated content — one Gemini call
per page, covering title/description/OG fixes, alt text, schema, FAQ Q&A,
TLDR summary — then computes a final 1–100 SEO score.

## What stood out (good)
- **One LLM call per page**, not one call per fix type — deliberate design
  to keep Gemini RPM usage down and give the LLM full page context at once.
  `buildPageNeeds()` dynamically decides what to ask the LLM for per page
  (skips the call entirely if a page needs nothing).
- **Two-stage scoring**: a deterministic weighted score from real per-factor
  check totals first (`calculateWeightedScore`), rounded directly into the
  final 1–100 score. A single LLM call adds a one-sentence explanation of
  that score — it no longer sets the number itself (see "RESOLVED" section
  below for why that changed). If the LLM explanation call fails, the real
  mechanical score is still kept; only `scoreReasoning` falls back to a
  plain-text summary of the pass rate.
- **Per-page failure isolation**: a failed LLM call for one page is logged
  and skipped, not fatal to the whole audit — matches the stated philosophy
  ("partial audit is better than no audit"), and BullMQ retry only
  re-processes pages that still have pending `CodeChange` records, not
  everything from scratch.
- Idempotency is real, not just claimed: `applyCodeChanges` only touches
  `CodeChange` records that are still `pending` with empty `newHtml`.

## ✅ RESOLVED — score was an even split across factor types, not real per-factor totals

`calculateWeightedScore` used to estimate "total checks per factor type" by
dividing `totalChecks` evenly across all 16 factor types
(`weight * (totalChecks / Object.keys(FACTOR_WEIGHTS).length)`) rather than
tracking how many pages/elements actually had each specific thing to check.
The code comment admitted this ("we don't know exact page count per type —
use totalChecks as proxy").

Fixed properly rather than just documented, since it turned out to need
real data, not just a formula tweak:

- `site-crawl.job.ts` now computes real per-factor totals from the actual
  crawled page data — total images found (for `alt_text`), total external
  links found (for `link_title`), total structured-data blocks found (for
  `schema_invalid`), total unique internal links actually HEAD-checked (for
  `broken_link`), and the right page-count for each conditional factor
  (`thin_content` only counts pages with `wordCount > 0`, `non_self_canonical`
  only counts pages that have a canonical tag at all — matching the exact
  guards `detectCodeChanges` uses for those checks). Stored on the new
  `Audit.summary.checkTotals` field.
- `calculateWeightedScore` now multiplies each factor's weight by its real
  total from `checkTotals` instead of the even split.
- Found and fixed two bugs while tracing this through:
  - `computeAuditScoreInput`'s old `totalPages` came from
    `CodeChange.distinct('url', ...)` — distinct URLs that have **at least
    one failing check**. Pages with zero failures never get a `CodeChange`
    record, so they were silently excluded, undercounting the true page
    total and skewing every score downward slightly.
  - `FACTOR_WEIGHTS` includes `internal_link: 4`, but no check in
    `detectCodeChanges` has ever produced that CodeChange type — it was
    dead weight that, under the old even-split formula, inflated every
    audit's denominator by a factor that could never fail. Left the entry
    in place (not something worth deleting outright — may be intentionally
    reserved for a future check) but it now correctly contributes 0 to
    both sides of the ratio since there's no real total to multiply by.
- `checkBrokenLinks` (`lib/crawler.ts`) previously computed the de-duplicated
  count of internal links it was about to check, then discarded it after
  filtering to just the broken ones. Now returns `{ broken, checkedCount }`
  so that count can be used as the exact `broken_link` denominator instead
  of being thrown away.

## ✅ RESOLVED — LLM was allowed to override the mechanical score based on "site reputation"

Beyond the approximation above, the score itself had a deeper design issue:
the LLM calibration step's system prompt scored famous sites 90–100 and
niche sites 60–80 based on inferred brand reputation/fame, using the
mechanical weighted pass rate as only a loose guide for "newer" sites. That
meant a technically broken site with strong brand recognition could get a
high score, and the number could change between audits with no underlying
technical change on the site at all.

Real SEO audit tools (Ahrefs Site Audit, SEMrush Site Health, Screaming
Frog, Lighthouse) compute their health/SEO scores mechanically from actual
checks — deterministic and reproducible, so the same site state always
produces the same score and every point change is attributable to a
specific check passing or failing. Changed to match:

- The final `score` is now `Math.round(weightedPassRate)` (clamped 1–100)
  directly — no LLM involvement in the number.
- The LLM call (`generateSeoScore` / `SEO_SCORE_SYSTEM` prompt) now only
  produces `scoreReasoning`, a one-sentence explanation of the mechanical
  score. Its system prompt explicitly says not to propose a different score
  and not to factor in reputation, fame, or traffic.
- The reasoning call's try/catch is now separate from the mechanical
  calculation's, so a reasoning-generation failure no longer discards a
  valid score. Previously the entire score fell back to a hardcoded `50`
  whenever the single combined LLM call failed for any reason, even though
  the real mechanical score had already been computed successfully.

## ✅ RESOLVED — HTML extraction helpers used regex instead of a proper parser

`extractCurrentValueFromOldHtml`, `extractImgSrc`, and `extractLinkRef` used
regex against stored `oldHtml` strings. Low risk as written — `oldHtml` is
always simple, single-tag content this same codebase generates in
`detectCodeChanges` (site-crawl.job.ts), never arbitrary third-party HTML —
but fragile against future changes to that format (attribute order, nested
quotes, HTML-entity-encoded content). Replaced with `cheerio` fragment
parsing (`load(html, null, false)`), which the codebase already depends on
via `crawlee`/`lib/crawler.ts` — added as an explicit direct dependency
rather than relying on it being resolved transitively. Verified against
every real `oldHtml` shape the crawler generates, including the non-HTML
`"No meta description found"` fallback string. As a side effect this also
fixed a small pre-existing gap: the regex version never decoded HTML
entities (e.g. `&amp;` stayed as `&amp;` instead of becoming `&`); cheerio
does this correctly.

## ✅ RESOLVED — frontend was only rendering type+status, not the before/after data already being sent

Prompted by a real client screenshot comparison against RankAI's own UI:
our Technical SEO page was only showing a fix's category label ("Add
canonical tag") and a "Pending" badge — not the actual before/after
markup RankAI displays (`NEW: <meta ...>` / `PREVIOUS: ...`). Traced this
all the way through before assuming it was a backend gap: **it wasn't** —
`CodeChange.oldHtml`/`.newHtml` were already populated with real markup for
every fix type, and `listCodeChanges()` already returned them completely
unfiltered (no `.select()` projection stripping them). This was a pure
frontend rendering gap.

Two real backend issues did turn up while checking, though, and both are
now fixed:

1. **Empty-string placeholders instead of friendly "not found" text.**
   `oldHtml` was a bare `''` for open_graph, canonical, and schema when
   nothing existed before the fix (and an ugly `<meta name="description"
   content="">` for description) — now real placeholder strings like
   `"No canonical tag found"`, matching RankAI's own pattern, so the
   frontend can render the field as-is with no special-case fallback logic.

2. **A genuine timing/data-integrity gap**: `site-crawl.job.ts` creates
   `CodeChange`/`FAQ`/`TLDR` stub records immediately, but the *next*
   pipeline step (this file, `technical-audit.job.ts`) fills in the real
   `newHtml` afterward. `listCodeChanges`/`listFAQs`/`listTLDRs` in
   `audit.service.ts` had no check against the parent `Audit.status` at
   all — so a frontend polling those endpoints while this step was still
   running would get back partially-generated records (empty `newHtml`,
   `status: 'pending'` — indistinguishable from a genuinely finished one).
   Fixed by gating all three list endpoints on the latest **completed**
   audit, returning `auditReady: false` + an empty array until it's safe
   to render everything at once — see `docs/15-api-reference-for-frontend.md`
   for the exact contract. Incidentally also fixes a second, latent issue:
   `Audit` documents aren't capped at one per project (a project can be
   re-crawled), and the old query had no audit-scoping at all, so results
   from an earlier audit run could have mixed in with a newer one.

**Update — this gap is now closed**: `FAQ`/`TLDR` both gained a required
`auditId` field (matching `CodeChange`'s pattern exactly), populated at
stub-creation time in `site-crawl.job.ts` (where `auditId` was already in
scope) and threaded through `applyFaqUpdate`/`applyTldrUpdate`'s
`findOneAndUpdate` filters in this file. `listFAQs`/`listTLDRs` in
`audit.service.ts` now scope by `auditId: latestAudit._id`, same as
`listCodeChanges` already did. This also fixed a real correctness bug the
missing field caused, not just a listing-scope gap: without `auditId` in
the filter, `applyFaqUpdate`/`applyTldrUpdate` could match and overwrite a
stale `status: 'pending'` stub left over from an earlier, incomplete audit
run at the same URL, instead of the stub the current run actually created.
No migration for pre-existing FAQ/TLDR documents — decided not needed for
this project's data, so older rows without `auditId` simply won't surface
in list queries anymore (not deleted, just orphaned from future results).

## Verdict
Was already one of the stronger-engineered files in the repo at initial
review; the two "minor observations" flagged then (score approximation,
regex extraction) plus a deeper scoring-design issue found while fixing
them have since been resolved above. No open items remain here.
