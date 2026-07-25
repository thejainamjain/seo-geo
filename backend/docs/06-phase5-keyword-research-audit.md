# Phase 5 — Keyword Research: Backend Audit

**Files:** `workers/jobs/keyword-research.job.ts`, `models/Keyword.ts`,
`lib/pipeline-resume.ts` (for the retry-safety question below)
**Pipeline position:** Step 5 of the 5-step auto-chain (last automatic step)
**Status: ✅ Strong implementation. One edge-case retry risk worth a decision.**

## What it does
Combines two keyword sources — LLM "market sizing" (20 fast seed keywords,
always runs first so the job isn't fully dependent on DataForSEO) and real
DataForSEO competitor keyword data (up to 50 per competitor) — deduplicates
them (DataForSEO wins on conflicts, since it's real data vs. LLM estimate),
scores all of them for business alignment via batched LLM calls, filters out
low-alignment keywords, sorts, caps at 260, and schedules them 5-per-week
against the project's creation date for the content calendar.

## What stood out (good)
- Dual-source design with graceful degradation: LLM keywords always run
  first so the pipeline never produces zero keywords just because
  DataForSEO is down or a competitor list is empty — matches the file's own
  stated philosophy ("partial data is better than no data") and is
  consistent with how the crawl and audit phases behave too.
- Per-competitor failure isolation (one competitor's DataForSEO call failing
  doesn't kill the whole job).
- Alignment scoring failures fall back to `alignmentScore: 0` rather than
  dropping the keyword outright — keeps it in the list but pushes it to the
  bottom, which is a sensible default.
- Explicit final guard: throws if *all* keywords end up below the alignment
  threshold, rather than silently completing with zero content — correctly
  treated as fatal since blog generation has nothing to work with.

## ✅ RESOLVED — keyword status reset on manual resume

The upsert in step 9 unconditionally sets `status: 'upcoming'` on every
keyword, every time this job runs — including on retry. Traced this against
`Keyword.status`'s actual lifecycle
(`upcoming → generating → draft → ready → published`) and `pipeline-resume.ts`:

- In the normal flow this is harmless — `KEYWORD_RESEARCH` is the last
  linear pipeline step, and BullMQ only retries it before it's completed, so
  no keyword could have moved past `upcoming` yet on a normal retry.
- But `pipeline-resume.ts` explicitly supports resuming from an arbitrary
  `fromStep` (`POST /pipeline/resume` accepts `{ fromStep? }` per the API
  docs), including forcing a re-run of `KEYWORD_RESEARCH` after the pipeline
  has already fully completed. If a user has since clicked "Generate" on
  some keywords (moving them to `generating`/`draft`/`ready`/`published`),
  a forced resume from `KEYWORD_RESEARCH` would run this same bulk upsert
  and silently reset those keywords back to `status: 'upcoming'` — losing
  track of drafted or even published content in the UI's "Keywords &
  Content" view (though the underlying `Blog` documents themselves aren't
  touched, since `Keyword` and `Blog` are separate collections — so no
  content is actually deleted, just the keyword's status label goes stale).

**Fix options** (flagging for a decision):
- Only `$set: { status: 'upcoming' }` via `$setOnInsert` (i.e. only on
  first creation), and leave `status` alone on update if the keyword
  already exists.
- Or explicitly exclude keywords whose current status is past `upcoming`
  from being touched by this job at all.

This is a real gap, but a narrow one — it requires someone to deliberately
force-resume from `KEYWORD_RESEARCH` after content generation has already
started, which is an admin/support action, not a normal user path.

**Fix:** moved `status: 'upcoming'` from `$set` to `$setOnInsert` in the
bulk upsert — it's now only applied the first time a keyword is created,
never on a later re-run. A forced resume no longer touches the status of
any keyword that's already progressed past `upcoming`; it survives the
re-run untouched. Also fixes a related downstream effect: the re-query
that feeds `scheduleWeeklyGeneration` (`docs/12-weekly-generation-scheduling.md`)
filters on `status: 'upcoming'`, so already-generated keywords now
correctly stay excluded from being re-scheduled too.

## Other observations (minor)
- `MAX_KEYWORDS_PER_COMP = 50` × up to 10 competitors = up to 500 raw
  keywords before scoring — reasonable cap, and DataForSEO billing is
  presumably per-call not per-keyword-returned (worth confirming actual
  DataForSEO pricing model if cost control matters here).
- Week scheduling (`assignWeekNumbers`) is a clean, deterministic
  calculation — no gaps there.

## Open question for the team
- Should keyword status be protected from being reset by a forced
  `KEYWORD_RESEARCH` resume, or is this an accepted risk given it's an
  admin-only action?
