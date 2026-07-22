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

## Verdict
No changes needed here to reach "hardened" status beyond the general
observations above. This is one of the stronger-engineered files in the repo.
