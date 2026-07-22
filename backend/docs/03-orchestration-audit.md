# Orchestration Layer — Backend Audit

**Files:** `workers/seo-pipeline.worker.ts`, `workers/scheduler.worker.ts`,
`workers/content-generation.worker.ts`, `constants/seo-pipeline.constants.ts`,
plus three **dead files**: `workers/cms-publish.worker.ts`,
`workers/geo-analytics.worker.ts`, `workers/gsc-monitor.worker.ts`
**Status: ✅ Core design is sound and deliberate. 🟡 One real cleanup item found.**

## Actual architecture (confirmed by tracing imports, not just filenames)

The pipeline is **not** the naive linear 9-step chain the top-level README's
diagram implies. It's actually three separate mechanisms, and this is a
deliberate, sensible design once you trace it:

1. **`seoPipelineQueue`** — linear, auto-chaining steps, but only 5:
   `SITE_CRAWL → BUSINESS_PROFILE → TECHNICAL_AUDIT → COMPETITOR_DISCOVERY → KEYWORD_RESEARCH`.
   Pipeline explicitly **pauses** after `BUSINESS_PROFILE` for onboarding
   review (see Phase 2 doc), then auto-continues after resume.
   `PIPELINE_SEQUENCE` intentionally stops at `KEYWORD_RESEARCH` — confirmed
   by a comment directly in the constants file, not a guess.
2. **`CONTENT_GENERATION` queue** — SERP research, blog generation, and CMS
   publish for **one keyword at a time**, triggered on-demand by
   `POST /keywords/:keywordId/generate`. This is why `SERP_RESEARCH`,
   `BLOG_GENERATION`, `CMS_PUBLISH` have no entry in `STEP_HANDLERS` in
   `seo-pipeline.worker.ts` — they were deliberately pulled out of the linear
   pipeline, not forgotten.
3. **Cron schedulers** (`bootSchedulers`) — three repeatable BullMQ jobs
   (`cms-publish-scheduler` Mon–Sat 17:00 UTC, `geo-analytics-scheduler` /
   `gsc-monitor-scheduler` Mon 10:00/11:00 UTC) that fan out per-project jobs
   onto their own queues.

This means the top-level README's "Phase 1 → Phase 9" linear diagram is
**stale/aspirational** relative to the actual code — worth updating so new
engineers don't get confused the way I initially did tracing this.

## ✅ RESOLVED — dead duplicate worker files removed

`workers/cms-publish.worker.ts`, `workers/geo-analytics.worker.ts`, and
`workers/gsc-monitor.worker.ts` each exported a `create*Worker()` function
that was **never imported anywhere** — confirmed via repo-wide grep
(including `package.json` scripts, `ecosystem.config.js`, `Dockerfile.worker`
— only one worker process is ever deployed, and it uses the inline versions
in `scheduler.worker.ts`).

**Action taken:**
- Diffed each dead file against its live counterpart in `scheduler.worker.ts`.
  Found the live versions had silently dropped the `'completed'` event
  logger and the `attemptsMade` field on `'failed'` logs compared to the
  dead files — restored both to the live code (strictly better
  observability, no behavior risk).
- Found one real value conflict: dead `cms-publish.worker.ts` used
  `concurrency: 2`, live code uses `3`. Confirmed with the team: **keep 3**
  (current live behavior is correct/intentional).
- Deleted all three dead files.
- Re-ran `tsc --noEmit` after deletion — **zero errors**, confirming they
  were genuinely unreferenced.
- Also cleaned up the related dead code from the same pipeline-split history:
  commented-out `handleGeoAnalytics`/`handleGscMonitor` handlers and
  `STEP_HANDLERS` entries in `seo-pipeline.worker.ts` (replaced with a clear
  note explaining GEO/GSC now run via `scheduler.worker.ts`'s own queues),
  and commented-out `QUEUE_NAMES.PUBLISH`, `JOB_PRIORITY.CMS_PUBLISH`,
  `JOB_RETRY_CONFIG.CMS_PUBLISH` in `constants/seo-pipeline.constants.ts`
  (confirmed zero live references before removing), plus fixed a stale doc
  comment above `JOB_PRIORITY` that referenced CMS_PUBLISH priority as if it
  were still read from that constant.

## Other observations
- Retry/backoff config is per-step and reasonably tuned (fewer retries for
  `SITE_CRAWL` since retrying a down site repeatedly wastes time; more
  retries for LLM/external-API-dependent steps).
- `LLM_RATE_LIMIT` is explicitly tied to Gemini's free-tier 15 RPM limit,
  with a comment flagging exactly what to change when upgrading — good
  operational hygiene, this is a real cost/plan lever, not a hardcoded
  magic number.
- `markStepErrored` logs a `resumeHint` pointing at the actual resume
  endpoint — nice touch for on-call debugging.
- Worker concurrency is set per-worker-type (5 for pipeline, 3 for CMS
  publish, 2 for GEO/GSC which are LLM-heavy) — deliberate resource
  budgeting, not arbitrary.

## Open question for the team
- Should the three dead worker files be deleted, or is there a reason
  they're being kept (e.g. mid-refactor, or reserved for a future
  standalone-deploy scenario where scheduler and per-queue workers run in
  separate processes)?
  