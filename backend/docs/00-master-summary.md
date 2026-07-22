# Master Audit Summary — RankAI Clone Backend

**Scope covered this pass:** Full core pipeline — site crawl, business
profile, technical audit, competitor discovery, keyword research,
orchestration/queues, on-demand content generation, CMS publish (on-demand
+ cron), GEO analytics, GSC monitor.

**Not yet covered (flagging, not forgetting):** CMS platform integrations
(`lib/cms/wordpress.ts`, `webflow.ts`, `shopify.ts`, `wix.ts`, `sanity.ts`,
`framer.ts`, `gohighlevel.ts`, `custom-api.ts` — 8 separate publishers),
`knowledge.service.ts` / knowledge-loader (brand doc RAG), `audit.service.ts`
/ `blog.service.ts` (the read-side APIs the frontend actually calls), auth,
and the frontend itself. Per your earlier instruction, auth/login/signup
were deliberately deprioritized. The rest can be a follow-up pass if useful.

## Overall impression
This is a genuinely well-engineered codebase — not a rough prototype. The
person(s) who built it clearly iterated against real bugs (documented fixes
for URL normalization, esbuild/Playwright issues, JS-render false
positives), designed for partial failure everywhere (a recurring, deliberate
philosophy: "partial result is better than no result"), and left detailed
comments explaining *why*, not just *what*. Most of what I found is
refinement, not rescue work.

## 🔴 Findings that actually matter (ranked by impact)

1. ✅ **RESOLVED** — GEO Analytics now uses real live search grounding
   (`docs/08-geo-analytics-audit.md`). Rewrote `geoCitationCheck` to use
   Groq's `compound-beta` (real search + real result URLs, not LLM
   self-reporting). Also flipped the whole LLM provider order — Groq is now
   primary, Gemini fallback (`docs/10-llm-provider-flip.md`). Two follow-up
   decisions surfaced, not yet made: retuning `LLM_RATE_LIMIT.DELAY_MS` for
   Groq's higher RPM, and whether `GROQ_MODEL` itself should change.

2. ✅ **RESOLVED** — Competitor discovery no longer overwrites manual input
   (`docs/05-phase4-competitor-discovery-audit.md`). Full schema change:
   `mainCompetitors` is now `CompetitorEntry[]` with source/verified
   tracking. Merge-and-verify logic replaces the old blind overwrite —
   user/AI-drafted entries get crawled + LLM-verified, SERP matches upgrade
   existing entries instead of duplicating them, failed verifications are
   kept (not dropped) with a reasoning string. **Frontend not touched** —
   3 files (`types/api.ts`, `business/page.tsx`, `onboarding/page.tsx`)
   will need updating to read the new object shape; you're handling that
   separately.

3. **`publishHourUtc` is a latent landmine** (`docs/07-...-audit.md`). Fully
   built out in three files as if user-configurable, but never wired to the
   API — works today only because it's stuck at the default (17, matching
   the fixed daily cron hour). Will silently break the moment it's exposed,
   unless the cron-frequency fix ships in the same change.

## 🟡 Findings worth deciding on, lower urgency

4. Keyword status can be reset by a forced pipeline resume after content
   generation has already started (`docs/06-...-audit.md`) — narrow, admin-
   only trigger path.
5. `BusinessContext.completedSteps` is marked fully-done by the AI job
   before a human has reviewed anything (`docs/02-...-audit.md`) — cosmetic
   unless the wizard UI relies on it for messaging.
6. GSC learnings have no weekly dedup, could accumulate noise over time
   (`docs/09-...-audit.md`).

## 🟢 Real but minor technical debt

7. ✅ **RESOLVED** — Three dead duplicate worker files
   (`docs/03-orchestration-audit.md`) — `cms-publish.worker.ts`,
   `geo-analytics.worker.ts`, `gsc-monitor.worker.ts` were unused; deleted
   after diffing against and reconciling with the live inline versions in
   `scheduler.worker.ts` (restored missing observability, confirmed
   concurrency value with the team, verified with a clean `tsc --noEmit`).
   Related dead commented-out code from the same pipeline-split history
   (`seo-pipeline.worker.ts` handlers, stale `constants` entries) cleaned up
   in the same pass.
8. `isNowAllowedPublishTime` duplicated verbatim in two files (still open).
9. Assorted small items noted per-phase doc: hardcoded `totalInternalLinks:
   0`, weaker audit data for Playwright-rendered pages, crude
   `freeTrialAvailable` string-match, `REGION_TO_COUNTRY` only covers 9
   countries.

## What's genuinely solid, no action needed
- Site crawl (3-pass sitemap-first strategy, documented real bug fixes)
- Technical audit LLM pipeline (per-page batching, graceful score fallback)
- Content generation idempotency (status guards, blog-exists guards, clean
  rollback on failure)
- GSC monitor (real OAuth refresh, real API integration, no shortcuts)
- Orchestration's three-mechanism design (linear pipeline / on-demand queue
  / cron fan-out) is legitimately good architecture once traced fully — the
  top-level README's linear diagram is just stale relative to it.

## Suggested next step
Given the scope, I'd suggest deciding on findings #1–#3 first since they
have real product/trust implications — the rest are either narrow edge
cases or pure cleanup. Let me know which you want to tackle, or if you want
me to continue the audit into the CMS integration layer and the read-side
services next.
