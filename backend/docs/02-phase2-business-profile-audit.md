# Phase 2 — Business Profile Generation: Backend Audit

**Files:** `workers/jobs/business-profile.job.ts`, `models/BusinessContext.ts`, `services/project.service.ts` (onboarding + resume logic)
**Pipeline position:** Step 2 of 9
**Status: ✅ Implemented. One data-semantics issue worth a decision, not a blocker.**

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

## Gap worth a decision

**`BusinessContext.completedSteps` is set to `[1,2,3,4,5]` by the automated AI
job**, before the user has looked at or approved anything. If the onboarding
wizard's frontend uses `completedSteps` to render progress (e.g. checkmarks,
"step 3 of 5 done"), the UI would show all steps as complete immediately
after crawl finishes — before the human has actually reviewed the AI's
guesses. Functionally harmless (the real gate is `isOnboardingComplete`), but
worth deciding: should the AI job use a separate field (e.g.
`aiDraftedSteps`) so the UI can distinguish "AI drafted this" from "human
confirmed this"? Low effort to fix, but it's a data-semantics decision, not
just a bug fix — flagging for your call rather than assuming.

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
  not). Minor accuracy gap, not a bug.

## Open question for the team
- Do we want `completedSteps` to reflect AI-drafted vs human-confirmed state
  separately, given the wizard's UI likely depends on it?
