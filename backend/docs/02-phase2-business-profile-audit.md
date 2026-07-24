# Phase 2 — Business Profile Generation: Backend Audit

**Files:** `workers/jobs/business-profile.job.ts`, `models/BusinessContext.ts`, `services/project.service.ts` (onboarding + resume logic)
**Pipeline position:** Step 2 of 9
**Status: ✅ Implemented. Data-semantics issue resolved — see below.**

## What it's supposed to do
Analyze crawled page content with an LLM and produce a structured "business
context" (company, product, customers, competition, social proof) that later
phases (keyword research, blog generation) use as grounding context.

## What's actually implemented — and how it fits the bigger picture
This isn't a standalone job — it's tied into a specific onboarding UX I had to
trace across three files to understand fully:

1. `createProject` immediately enqueues `SITE_CRAWL`, which chains to
   `BUSINESS_PROFILE`. The pipeline **pauses after BUSINESS_PROFILE**
   (confirmed intent via comment in `project.service.ts`, to verify the actual
   pause mechanism in `seo-pipeline.worker.ts` next).
2. While that runs, the user is meant to fill the 5-step onboarding wizard.
   Each step (`saveOnboardingStep`) does a **full overwrite** of that step's
   field (`company`, `product`, etc.) — not a merge — which is correct *as
   long as* the frontend always submits the complete field set for that step,
   not a partial diff.
3. `business-profile.job.ts` also writes into the exact same fields via
   `findOneAndUpdate($set: {...})` — so the intended design is: **AI drafts
   the business context first, wizard lets the user review/edit and
   overwrite it step by step.** This is a deliberate and reasonable UX
   pattern (pre-fill + human review), not a race condition, since the job
   runs once early and the user edits afterward.
4. Resume gate: `resumeAfterOnboarding` only checks `Project.isOnboardingComplete`
   (set explicitly on manual step-5 submission) and `BUSINESS_PROFILE` job
   status — **not** `BusinessContext.completedSteps`. So even though the gate
   logic is correct, there's a side effect worth flagging next.

## Gap — ✅ RESOLVED (decision made: split into two fields)

**`BusinessContext.completedSteps` used to be set to `[1,2,3,4,5]` by the
automated AI job**, before the user had looked at or approved anything. If
the onboarding wizard's frontend used `completedSteps` to render progress
(checkmarks, "step 3 of 5 done"), the UI would have shown all steps as
complete immediately after crawl finishes — before the human had actually
reviewed the AI's guesses.

Decision: split into two fields on `BusinessContext`:
- `aiDraftedSteps: number[]` — set in bulk (`[1,2,3,4,5]`) by
  `business-profile.job.ts` as soon as the AI drafts a profile. Means "AI
  has a guess for this," nothing more.
- `completedSteps: number[]` — unchanged in behavior, still only set one
  step at a time via `$addToSet` in `project.service.ts`'s
  `saveOnboardingStep`. Now means, unambiguously, "a human went through the
  wizard and confirmed this step."

`business-profile.job.ts` no longer touches `completedSteps` at all — it
only writes `aiDraftedSteps`. The onboarding wizard endpoint was already
correct (only ever `$addToSet`s one step at a time on explicit user
submission) and needed no change. Frontend `types/api.ts` updated to match;
no frontend logic currently consumes either field, so this is a
non-breaking type change — actual UI wiring (e.g. showing an "AI-drafted,
not yet reviewed" badge) is still open for whoever builds that part of the
wizard.

## Other observations
- `normalizeToString()` handles a real, documented LLM inconsistency
  (returning arrays/objects when a string was requested) — reasonable
  defensive coding, not overengineering.
- Idempotent via `upsert: true` — safe on BullMQ retry, correctly noted that
  a retried LLM call isn't literally idempotent but produces an equivalent
  result, which is an acceptable tradeoff for this use case.
- `freeTrialAvailable` inference is a crude `.includes('yes')` string check
  on the LLM's free-text answer — will misclassify anything not literally
  containing "yes" (e.g. "Yes, 14 days" works, "Free tier available" would
  not). Minor accuracy gap, not a bug. **Still open.**
