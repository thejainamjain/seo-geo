# Phase 3 — Technical Audit (LLM Fix Generation): Backend Audit

**File:** `workers/jobs/technical-audit.job.ts` (921 lines)
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
- **Two-stage scoring**: a deterministic weighted score from pass/fail counts
  first (`calculateWeightedScore`), then a single LLM call to calibrate that
  number against "site reputation" context. If the LLM calibration fails, it
  falls back to a safe default score (50) with a `scoreReasoning` that says
  so explicitly rather than silently returning a fake precise number.
- **Per-page failure isolation**: a failed LLM call for one page is logged
  and skipped, not fatal to the whole audit — matches the stated philosophy
  ("partial audit is better than no audit"), and BullMQ retry only
  re-processes pages that still have pending `CodeChange` records, not
  everything from scratch.
- Idempotency is real, not just claimed: `applyCodeChanges` only touches
  `CodeChange` records that are still `pending` with empty `newHtml`.

## Minor observations, not blockers
- `calculateWeightedScore` estimates "total checks per factor type" by
  dividing `totalChecks` evenly across all factor types
  (`weight * (totalChecks / Object.keys(FACTOR_WEIGHTS).length)`) rather than
  tracking how many pages actually had each specific element to check. The
  code comment admits this ("we don't know exact page count per type — use
  totalChecks as proxy"). This means the score is a reasonable approximation,
  not a precise per-factor pass rate — worth knowing if the score is ever
  shown to users as more precise than it is.
- HTML extraction helpers (`extractCurrentValueFromOldHtml`, `extractImgSrc`,
  `extractLinkRef`) use regex against stored `oldHtml` strings rather than a
  proper HTML parser. Fine here since `oldHtml` is always simple,
  single-tag content this same codebase generated (not arbitrary HTML), so
  the regex risk is low — but worth knowing if `oldHtml` format ever changes.

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

**Known remaining gap, not fixed here**: `FAQ`/`TLDR` models have no
`auditId` field (unlike `CodeChange`, which does), so their list endpoints
can only gate on "is the latest audit done," not scope precisely to
*that* audit's own records the way code-changes now can. Low-impact today
since re-crawls aren't a common path, but would need a schema
addition + migration to fully close — flagged in
`docs/15-api-reference-for-frontend.md` for whoever picks it up.

## Verdict
No changes needed here to reach "hardened" status beyond the general
observations above. This is one of the stronger-engineered files in the repo.
