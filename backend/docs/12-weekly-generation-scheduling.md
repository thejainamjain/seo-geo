# Automatic Weekly Blog Generation Scheduling (new feature)

**Files:** `lib/keyword-generation-scheduler.ts` (new), `workers/jobs/keyword-research.job.ts`,
`workers/scheduler.worker.ts`, `services/keyword.service.ts`,
`constants/seo-pipeline.constants.ts`
**Status: ✅ Implemented — new feature, not a bug fix.**

## What existed before
Generation was 100% manual — `weekNumber`/`startDate` were already computed
per keyword (5/week, relative to project creation date) and used for
filtering/display in the "Keywords & Content" view, but **nothing ever
read them to trigger anything**. Confirmed by grep before building this —
`POST /keywords/:keywordId/generate` was the only way content generation
ever ran.

## What this adds
- **Week 1** (the project's first 5 keywords): enqueued for generation
  **immediately** when keyword-research finishes — no delay. First-content
  moment, no waiting.
- **Every other week**: one delayed BullMQ job per week, firing **24 hours
  before** that week's `startDate`. Chose a 24h buffer over a literal
  last-second trigger based on how automated content pipelines are
  generally run elsewhere — leaving *some* review window before publish is
  the consistent theme, even in fully-automated setups; zero buffer
  removes that entirely.
- When a week's trigger fires, it re-queries `Keyword.find({projectId,
  weekNumber, status:'upcoming'})` fresh (not a list captured at schedule
  time) and enqueues each found keyword onto the **same** CONTENT_GENERATION
  queue, running through the **exact same** `content-generation.job.ts`
  logic the manual button already uses — no new business logic duplicated,
  only the trigger/timing is new.

## Publish behavior — reused, not rebuilt
Confirmed `content-generation.job.ts` already does "publish immediately if
CMS is connected and within the allowed publish window, otherwise leave
`status: 'ready'`" — this was already built for the manual-click path and
needed zero changes. Your question about "what if the user adds a CMS
integration later" is also already answered by existing code:
`cms-publish.job.ts`'s recurring per-project schedule (see
`docs/07-phases6-8-content-generation-publish-audit.md`) sweeps **all**
`ready` blogs for a project, not just newly-generated ones — so any backlog
of generated-but-unpublished content gets picked up automatically the next
time that project's publish schedule fires, once a CMS is connected and
`autoPublish` is turned on. No new backfill logic was needed.

## Design choices worth knowing about
- **Delayed jobs, not a cron/JobScheduler** — unlike the CMS publish fix
  (`lib/cms-publish-scheduler.ts`), this doesn't need `upsertJobScheduler`.
  Each week fires exactly once, ever, at a fixed known timestamp that
  doesn't change after keyword-research runs — a plain BullMQ delayed job
  is the right primitive. A recurring cron would be the wrong tool here.
- **Idempotency via deterministic jobIds** — `content-generation:{keywordId}`
  and `weekly-trigger:{projectId}:{weekNumber}`. This is the same
  jobId-dedup pattern this codebase already trusts elsewhere
  (`global-scheduler.job.ts`'s per-project-per-day jobIds) — re-running
  keyword-research (e.g. on retry) won't double-schedule anything.
- **Manual "Generate" button now uses the same jobId scheme too**
  (`keyword.service.ts`) — a narrow defense-in-depth fix so a manual click
  racing the automatic trigger for the same keyword can't double-enqueue.
- Up to 52 weeks (260 keywords ÷ 5/week, matching the existing keyword cap)
  means up to 52 delayed jobs scheduled per project at once — cheap for
  BullMQ (just Redis sorted-set entries), not a concern.

## Not changed
- `keyword.service.ts`'s `addKeyword` (a user manually adding one keyword
  outside the pipeline) doesn't assign a `weekNumber`, so it's correctly
  never auto-scheduled — stays manual-generate-only, matching existing
  behavior. Not something this change touched or needed to.
- Verified with `tsc --noEmit` — clean compile.

## Open item, not addressed here
No test suite exists in this repo (noted before, in
`docs/10-llm-provider-flip.md`) — this was verified via type-checking and
manual trace-through of the scheduling math, not a live run against real
BullMQ/Redis. Worth a real smoke test (create a test project, confirm week
1 fires immediately and a week-2 delayed job appears in Redis with the
right timestamp) before this ships.
