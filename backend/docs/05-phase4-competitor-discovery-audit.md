# Phase 4 — Competitor Discovery: Backend Audit

**File:** `workers/jobs/competitor-discovery.job.ts`
**Pipeline position:** Step 4 of the 5-step auto-chain (runs right after
`TECHNICAL_AUDIT`, which runs right after the user completes onboarding)
**Status: 🔴 Real conflict found — user-entered data gets silently overwritten.**

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
