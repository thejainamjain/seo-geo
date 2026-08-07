# Deprecated code

Files here are **not imported by any live code path** — verified by
tracing actual `import`/`require` statements (not just grepping filenames),
checking for dynamic/string-based references, and confirming no BullMQ
queue or worker actually consumes them. They're kept for historical
reference (design rationale, in case old data/behavior needs to be
understood later) rather than deleted outright, but should not be
imported by anything new.

If you're about to import something from this folder, stop — that almost
certainly means you want its *replacement* instead. See each file's own
header comment for what superseded it.

## `blog-generation.job.ts`

Superseded by `workers/jobs/content-generation.job.ts`.

Verified dead as of this move:
- Never imported by any `workers/*.worker.ts` file (the only files that
  register BullMQ `Worker` processors) — `content-generation.worker.ts`
  is the one actually wired up, and it imports `content-generation.job.ts`.
- `blogGenerationQueue` (the `Queue` instance in `seo-pipeline.worker.ts`
  this job would have processed) has zero callers of `.add()` anywhere in
  the codebase — jobs were never enqueued onto it either. That queue
  declaration is now commented out in `seo-pipeline.worker.ts` rather than
  deleted, pointing here.
- `QUEUE_NAMES.BLOG_GENERATION` / `JOB_PRIORITY.BLOG_GENERATION` /
  `JOB_RETRY_CONFIG.BLOG_GENERATION` in `constants/seo-pipeline.constants.ts`
  are commented out for the same reason (NOT `PIPELINE_STEP.BLOG_GENERATION`
  — that's a different, still-meaningful enum value representing the
  conceptual pipeline phase; see that file's existing comment on
  `PIPELINE_SEQUENCE` explaining phases that moved to an on-demand path).

Key behavioral difference from its replacement, in case old data/logs
reference it: this file created blogs with `status: 'draft'`, requiring a
manual "mark as ready" review step. `content-generation.job.ts` creates
them directly as `status: 'ready'` — no manual review — which is the
current, correct, and confirmed-desired behavior.

## Also found and commented out while investigating (not moved — small, left in place)

- `constants/index.ts`'s entire `QUEUES` object — a whole separate,
  older queue-naming scheme (different string values entirely from the
  real `QUEUE_NAMES` in `constants/seo-pipeline.constants.ts`), confirmed
  unused anywhere via grep. Not just its `BLOG_GENERATION` entry — the
  whole object.
- `QUEUE_NAMES.BLOG_GENERATION` / `JOB_PRIORITY.BLOG_GENERATION` /
  `JOB_RETRY_CONFIG.BLOG_GENERATION` in `constants/seo-pipeline.constants.ts`.
- `blogGenerationQueue` + `BlogJobData` in `workers/seo-pipeline.worker.ts`.

These are small enough (a few lines each, inside otherwise-live files) that
commenting them out in place — rather than relocating them here — keeps the
explanation next to the code it's about.
