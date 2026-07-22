# Phase 4 — Competitor Discovery: Backend Audit

**File:** `workers/jobs/competitor-discovery.job.ts`
**Pipeline position:** Step 4 of the 5-step auto-chain (runs right after
`TECHNICAL_AUDIT`, which runs right after the user completes onboarding)
**Status: ✅ RESOLVED — merge + verify, no more silent overwrite.**

## What changed
Full structured schema change (per your call — not the backward-compatible
option): `BusinessContext.competition.mainCompetitors` went from
`string[]` to a `CompetitorEntry[]` — see `models/BusinessContext.ts` for
the new type:

```ts
interface CompetitorEntry {
  domain:                 string;
  source:                 'user' | 'ai_draft' | 'serp';
  verified:                boolean;
  verificationReasoning?:  string;
  addedAt:                 Date;
}
```

- **`business-profile.job.ts`** now tags its initial AI-guessed competitor
  list as `source: 'ai_draft', verified: false` — honest about the fact
  this is an unverified LLM guess, matching the same reasoning this file
  already used to justify SERP-based discovery over LLM-guessed.
- **`project.service.ts`'s `saveOnboardingStep`** now wraps a user's
  step-4 submission as `source: 'user', verified: false` before persisting
  — the API request shape is unchanged (still plain domain strings in,
  per the frontend's actual wire format, confirmed by reading
  `onboarding/page.tsx` directly rather than trusting the README's
  shorthand docs).
- **`competitor-discovery.job.ts`** rewritten to **merge, verify, never
  silently overwrite**:
  1. Loads existing entries (user + AI-draft) as the merge base.
  2. Runs the SERP search as before — any SERP domain matching an existing
     unverified entry **upgrades it in place** (real ranking data is
     stronger confirmation than an LLM check) rather than creating a
     duplicate.
  3. Remaining unverified entries get a real check: crawl the candidate's
     homepage (reusing the same `crawlSinglePage` already used for
     competitor insights) + one LLM call (`verifyCompetitor`, new function
     in `lib/llm.ts`) asking "is this plausibly a competitor, true/false +
     reasoning."
  4. A failed verification (crawl fails, LLM fails, or LLM judges "no")
     **keeps the entry** with `verified: false` and a reasoning string —
     never silently dropped, so the user can see why.
  5. Final list capped at 15, verified entries sorted first.
  6. Homepage crawls done during verification are reused for
     `competitorInsights` instead of re-crawled — avoids double-crawling
     the same domain.
- **`keyword-research.job.ts`** now only spends DataForSEO calls on
  `verified: true` competitors — avoids wasting API quota on unconfirmed
  guesses.
- Verified with `tsc --noEmit` — clean compile across all touched files.

## Scope note — frontend not touched
This was a real schema change (`string[]` → `CompetitorEntry[]`), and 3
frontend files read this field (`types/api.ts`, `business/page.tsx`,
`onboarding/page.tsx`). Per your direction, frontend updates are being
handled separately — **the onboarding wizard's write path still works
unchanged** (still submits plain domain strings, transformed server-side),
but any frontend code that *reads back* `mainCompetitors` from the API
(e.g. `business/page.tsx` displaying the list) will need updating to
handle the new object shape instead of plain strings, or it will render
incorrectly (e.g. `[object Object]` instead of a domain).

---

## Original finding (for reference)

## What it does
Extracts a "core keyword" from `BusinessContext` (priority chain: top use
cases → keywords customers use → product description → company description
→ domain name as last resort), runs it through SerpAPI to find who actually
ranks for it, filters out the project's own domain, and stores the resulting
domain list into `BusinessContext.competition.mainCompetitors`. Also does a
lightweight crawl of each competitor's homepage for extra LLM context
(`competitorInsights`).

## Why SERP-based competitor discovery is the right call
The file's own comment is correct and matches how the real RankAI product
appears to work: asking an LLM to *name* competitors risks hallucinated
companies that don't actually rank for anything. Using real-time SERP
results as ground truth avoids that. Good design choice, not a gap.

## 🔴 Real conflict: overwrites the user's manual "Competition" onboarding step

Traced the actual execution order across three files to confirm this isn't
a false alarm:

1. Onboarding **Step 4 — "Competition"** (per `backend/README.md` API
   reference) lets the user manually enter their own known competitors, and
   `saveOnboardingStep` writes that into
   `BusinessContext.competition` (full overwrite of that field, `STEP_FIELD_MAP[4] = 'competition'`).
2. Pipeline order is `SITE_CRAWL → BUSINESS_PROFILE → [pause for onboarding]
   → TECHNICAL_AUDIT → COMPETITOR_DISCOVERY → KEYWORD_RESEARCH`. So the user
   fills onboarding **during the pause**, then `resumeAfterOnboarding()`
   kicks off `TECHNICAL_AUDIT`, which auto-chains into `COMPETITOR_DISCOVERY`
   right after — **after** the user has already submitted their manual
   competitor list.
3. `competitor-discovery.job.ts` then does
   `$set: { 'competition.mainCompetitors': competitorDomains }`
   unconditionally — the code comment even says this is intentional
   ("Always overwrites mainCompetitors — safe on retry... fresh SERP data on
   retry is correct behaviour"). That reasoning is correct for *retries* of
   this same job, but doesn't account for the fact that the field was
   already populated by a **human**, not just a previous run of this job.

**Net effect:** if a user manually types in "our real competitors are X, Y,
Z" during onboarding, that list is silently replaced by whatever SerpAPI
returns for the auto-extracted core keyword — with no merge, no flag, and no
way for the user to know their input didn't stick. If the auto-extracted
core keyword is a weak signal (e.g. it fell back to `whatItSells` or even
the domain name, per the extraction priority chain), the replacement data
could be lower quality than what the user actually knows about their own
market.

## Options to fix (flagging for a decision, not picking one)
- **Merge, don't overwrite**: append SERP-discovered domains to the user's
  list (dedup), rather than replacing it.
- **Don't overwrite if user-provided**: track provenance (e.g. a
  `mainCompetitorsSource: 'user' | 'serp'` field) and only auto-overwrite if
  the current value came from SERP, never if a human entered it.
- **Show both, let user choose**: store SERP results in a separate field
  (e.g. `suggestedCompetitors`) and leave `mainCompetitors` as the
  user-editable source of truth.

## Other observations (minor, not blockers)
- `extractCoreKeyword`'s fallback chain is reasonable, but the last resort
  (turning the domain name into a keyword, e.g. `mydomain.com` →
  `mydomain`) is a genuinely weak SEO signal if it's ever reached — worth
  confirming how often it actually falls this far in practice.
- `REGION_TO_COUNTRY` is a hardcoded regex list covering 9 countries; any
  other region defaults to `'us'`. Fine for MVP, but a real limitation for
  international customers outside this list (e.g. no coverage for Brazil,
  Japan, most of Africa) — worth deciding if this needs to be a proper
  country lookup table before wider rollout.
- Zero-competitors-found case is handled gracefully (warns, doesn't block
  pipeline) — good defensive behavior, not a gap.

## Open question for the team
- Which of the three fix options above matches the intended product
  behavior — should the user's manual competitor input always win, always
  lose to fresh SERP data, or should both be shown separately?
  