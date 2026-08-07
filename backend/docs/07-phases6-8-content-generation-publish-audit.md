# Phases 6–8 — On-Demand Content Generation + CMS Publish: Backend Audit

**Files:** `workers/jobs/content-generation.job.ts` (on-demand SERP+blog+publish
per keyword), `workers/jobs/cms-publish.job.ts` (cron-based bulk publish),
`workers/jobs/global-scheduler.job.ts` (cron fan-out), `workers/content-generation.worker.ts`
**Status: ✅ Very solid engineering overall. Scheduling bug resolved —
`publishHourUtc` API-exposure remains open as a separate product decision.**

## What it does (confirmed architecture, not the stale README diagram)
These three README "phases" aren't separate pipeline steps — they're one
on-demand flow (`content-generation.job.ts`) triggered per keyword by
`POST /keywords/:keywordId/generate`, plus a separate always-on cron
(`cms-publish.job.ts`) that does scheduled bulk publishing of anything left
in `ready` status. See `docs/03-orchestration-audit.md` for the full
picture — this doc covers what happens inside these two paths specifically.

## What stood out (good)
- **Real idempotency, not just claimed**: status guard at the top
  (`keyword.status !== 'upcoming'` → skip) prevents duplicate triggers;
  `Blog.findOne({ keywordId })` guard skips regeneration if a blog already
  exists and jumps straight to the publish check — genuinely handles the
  retry-after-partial-failure case correctly.
- **Clean rollback on failure**: if anything throws after status is set to
  `generating`, the keyword is reset to `upcoming` in the `catch` block so
  the user can retry from the UI — no keyword gets stuck in limbo.
- **SERP failure is explicitly non-fatal** — blog generation proceeds
  without a brief rather than failing the whole job, consistent with the
  "partial is better than none" philosophy seen throughout this codebase.
- **Publish failure never blocks the content**: a blog that fails to
  publish stays in `ready` status rather than being lost or stuck — correct
  behavior, user can retry publish manually.
- Hero image fetch (`fetchHeroImageUrl`) failing is explicitly non-fatal —
  publish continues without an image rather than blocking.
- Both publish paths (on-demand `handlePublish` and cron `cms-publish.job.ts`)
  only ever touch `status: 'ready'` blogs, so there's no double-publish risk
  between the two paths — confirmed by reading both.

## ✅ RESOLVED — `publishHourUtc` > 17 used to be silently unreachable

Traced this across `scheduler.worker.ts`, `global-scheduler.job.ts`, and
`cms-publish.job.ts`:

1. The **only** cron trigger for CMS publishing used to fire once a day, at
   a **fixed** `'0 17 * * 1-6'` pattern (17:00 UTC, Mon–Sat) — registered as
   a singleton in `scheduler.worker.ts`. No second, later cron existed.
2. `global-scheduler.job.ts`'s `runCmsPublishScheduler()` checked, per
   project, `hourUtc < publishHourUtc → skip` — correct for a project
   publishing **earlier** than 17:00 UTC, but any project with
   `publishHourUtc` set **after** 17 (e.g. `20`) would always evaluate
   `hourUtc(17) < publishHourUtc(20)` → skip, every day, forever. No later
   trigger would ever catch it.

**Fix (verified in current code, `lib/cms-publish-scheduler.ts`):** matches
the third option from the original list below — the cron schedule is now
derived per-project instead of being one shared fixed trigger.
`buildCronPattern(publishHourUtc, allowedPublishDays)` builds
`` `0 ${publishHourUtc} * * ${days}` `` and `cms.service.ts` registers each
project's own BullMQ Job Scheduler at its own hour via
`upsertCmsPublishSchedule`, reconciled idempotently on every worker boot
(`reconcileCmsPublishSchedules()`). A project publishing at `20:00 UTC` now
gets its own trigger at that hour — no dependency on the old 17:00 trigger
at all.

**Still genuinely open, separate from the bug above**: `publishHourUtc`
itself still isn't exposed via the API (confirmed via repo-wide grep —
it's never written anywhere in the backend, only read, always falling back
to the model default of `17`). Whether/how to expose it remains a
deliberate, separate product decision, not a code fix.

<details>
<summary>Original fix options considered (for reference)</summary>

- Validate `publishHourUtc` server-side to reject/clamp values > 17 (or
  whatever the actual cron hour is), with a clear error message.
- Or run the cron trigger hourly instead of once daily, and let the
  per-project hour check do the real filtering.
- **Or make the cron schedule itself derived from the set of distinct
  `publishHourUtc` values in use, registering one repeatable job per
  distinct hour** — this is the one that was implemented, per-project
  rather than per-distinct-hour, which is an even finer-grained version of
  the same idea.
</details>

## Other observations (minor)
- ✅ **RESOLVED** — `isNowAllowedPublishTime` was duplicated verbatim across
  `content-generation.job.ts` and `cms-publish.job.ts`. Extracted into
  `lib/blog-cms-publisher.ts` (the shared module both files already import
  from for the publish-idempotency fix — see `docs/11-...`), both call
  sites now import the one definition instead.
- `MIN_CONTENT_LENGTH = 500` chars as the validity check on generated blog
  content is a reasonable sanity floor, not a real gap.
- Slug collision handling (`${slug}-${Date.now()}`) is simple and correct
  for avoiding unique-index violations, if `Blog.slug` has a
  `{projectId, slug}` unique index — worth confirming that index actually
  exists in the `Blog` model (not yet checked in this pass).

## ✅ RESOLVED — moved to per-project BullMQ Job Schedulers

Per your direction: fixed the mechanism now (industry-standard pattern —
BullMQ's native `upsertJobScheduler`, the same primitive behind most
"publish at your preferred time" SaaS features), without adding a new
settings UI for `publishHourUtc` yet.

**What changed:**
- New module `lib/cms-publish-scheduler.ts` — each project gets its own
  recurring BullMQ Job Scheduler with a cron pattern built from *that
  project's* `publishHourUtc`/`allowedPublishDays`
  (`0 ${hour} * * ${days}`, `tz: 'UTC'`, confirmed against the actual
  installed `bullmq`/`cron-parser` type definitions, not guessed). No
  sweep, no polling, no "does the single daily trigger happen to be late
  enough" check — each project fires at exactly its own configured time,
  structurally independent of every other project's.
- `cms.service.ts`'s `updateCmsConfig` now keeps the schedule in sync:
  `autoPublish` turned on (or `allowedPublishDays` changed while on) →
  upsert; turned off → remove. `disconnectCms` always removes it.
- `scheduler.worker.ts` calls `reconcileCmsPublishSchedules()` once on
  every boot — idempotent (upsert-based), so it both migrates existing
  `autoPublish:true` projects onto this design on first deploy AND
  recovers if Redis's scheduler data was ever lost, without a separate
  one-off migration script.
- Removed the old fixed-time daily sweep (`runCmsPublishScheduler` in
  `global-scheduler.job.ts`, and its `'0 17 * * 1-6'` registration in
  `scheduler.worker.ts`) — GEO analytics and GSC monitor schedulers were
  untouched, since they don't have this per-project-custom-time problem
  (they run at the same global time for every project by design).
- `cms-publish.job.ts` (the actual per-project publish handler) needed no
  changes — it already just processes `{projectId}` regardless of what
  triggered it.
- Verified with `tsc --noEmit` — clean compile.

**Still not exposed:** `publishHourUtc` remains not settable via the API
(same as before) — this fix makes the mechanism correct for whenever that
changes, without building UI for it now, per your call.

---

## Original finding (for reference)

Checked `services/cms.service.ts` — **`publishHourUtc` is not currently
exposed** via `connectCms` or `updateCmsConfig` (only `autoPublish`,
`allowedPublishDays`, `blogPostPath` are settable today). It always sits at
the model default of `17`, which happens to exactly match the fixed cron
hour. So **this bug is currently dormant, not active** — every project today
effectively has `publishHourUtc === 17`, so `hourUtc(17) >= publishHourUtc(17)`
always passes.

This changes the finding from "active bug" to **"latent landmine"**: the
per-project custom-hour logic is fully built out in three separate files
(`content-generation.job.ts`, `cms-publish.job.ts`,
`global-scheduler.job.ts`) as if `publishHourUtc` were meant to be
user-configurable, but the field was never wired up to the API. Someone
clearly intended to expose this and either hasn't gotten to it yet, or it
was deliberately held back — worth a direct question rather than assuming
either way. If/when it is exposed, the fix above becomes necessary before
launch, not optional.

## Open question for the team — still genuinely open
- Was `publishHourUtc` meant to be user-editable (the code strongly
  suggests yes) and just not wired into the API yet, or is a fixed
  default of 17:00 UTC intentional for now? (The scheduling mechanism
  itself no longer constrains this either way — see RESOLVED section
  above — so this is purely an API/product-surface decision now, not
  something that needs to land alongside another fix.)
- Confirmed via repo-wide grep: `publishHourUtc` is never **written**
  anywhere in the backend — only read (always falling back to the model
  default of `17`). So it's fully dormant today, not partially exposed
  somewhere I missed.
  