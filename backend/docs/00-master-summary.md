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
   primary, Gemini fallback (`docs/10-llm-provider-flip.md`). The follow-up
   `LLM_RATE_LIMIT.DELAY_MS` retuning question is also resolved — turned out
   to be fully redundant with `lib/llm.ts`'s internal per-provider rate
   limiter, so it was removed rather than retuned (see `docs/10-...` for
   detail). `GROQ_MODEL` itself remains an open, separate decision.

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

3. ✅ **RESOLVED** — `publishHourUtc` landmine fixed at the mechanism level
   (`docs/07-phases6-8-content-generation-publish-audit.md`). Replaced the
   single fixed-time daily sweep with per-project BullMQ Job Schedulers
   (`lib/cms-publish-scheduler.ts`) — each project now fires at its own
   configured hour/days natively, no polling, no "is the trigger late
   enough" check. Synced into `cms.service.ts`'s connect/update/disconnect
   flows, with idempotent reconciliation on worker boot to migrate existing
   projects. `publishHourUtc` still isn't exposed via the API — that
   remains a separate, deliberately out-of-scope decision.

## 🟡 Findings worth deciding on, lower urgency

4. Keyword status can be reset by a forced pipeline resume after content
   generation has already started (`docs/06-...-audit.md`) — narrow, admin-
   only trigger path.
5. ✅ **RESOLVED** — `BusinessContext.completedSteps` was marked fully-done
   by the AI job before a human had reviewed anything (`docs/02-...-audit.md`).
   Split into `aiDraftedSteps` (AI's guess, unreviewed) and `completedSteps`
   (human-confirmed via the wizard, unchanged behavior). Frontend type
   updated to match; no frontend logic currently consumes either field.
6. ✅ **RESOLVED** — GSC learnings had no weekly dedup, could accumulate
   noise over time (`docs/09-...-audit.md`). Added a 30-day cooldown per
   blog+insight-type.

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
9. Assorted small items noted per-phase doc — status:
   - ✅ **RESOLVED**: hardcoded `totalInternalLinks: 0` (`docs/01-...`) —
     now actually summed from crawled page data.
   - ✅ **RESOLVED**: `REGION_TO_COUNTRY` only covered 9 countries
     (`docs/05-...`) — expanded to ~40; also deleted a dead, already-drifted
     duplicate copy of the map found in `competitor-discovery.job.ts`.
   - ✅ **RESOLVED**: `seoSchema` silently dropped on webflow/wix/gohighlevel,
     and Shopify's schema stored in a metafield nobody rendered
     (`docs/11-cms-integrations-audit.md`) — all four now reliably deliver
     schema markup to the live page via a shared `injectSchema()` helper.
   - Still open: weaker audit data for Playwright-rendered pages
     (`docs/01-...`), crude `freeTrialAvailable` string-match
     (`docs/02-...`), Wix's `contentText` field format for HTML content is
     still unverified against the live API (`docs/11-...`).

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
Findings #1–#3 (the real product/trust-impacting ones) and all of the 🟡/🟢
items are now resolved. What's left, ranked:
- 🔴 **Critical, not yet fixed**: `framer.ts` hardcodes a webhook call out to
  RankAI's own live domain — a real data-handling risk, not just a code
  smell (`docs/11-cms-integrations-audit.md`).
- 🟠 **Cross-cutting, not yet fixed**: 7 of 8 CMS publishers have no
  idempotency (BullMQ retries can duplicate-publish), `isNowAllowedPublishTime`
  duplicated verbatim in two files, `sanity.ts` bakes a RankAI-specific
  schema name into the customer's Sanity project.
Recommend tackling `framer.ts` first given the live-domain exposure, then
the CMS idempotency/dedup pass.
