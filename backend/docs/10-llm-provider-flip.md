# LLM Provider Order Flip: Groq Primary, Gemini Fallback

**File:** `lib/llm.ts`
**Status: ✅ Implemented across all 10 call sites in one change.**

## What changed
Previously: Gemini was primary for all LLM calls; Groq was used only as a
fallback when Gemini rate-limited (429).

Now: **Groq is primary; Gemini is the fallback**, used only when Groq
rate-limits. This was a contained change because the codebase already had
the right shape for it — every typed LLM function
(`generateBusinessDescription`, `scoreKeywordAlignment`, `generateBlogPost`,
etc. — 8 of them) calls one shared dispatcher rather than talking to a
provider directly.

## Implementation
- Split the old single `callGemini()` function into three:
  - `callGeminiDirect()` — private, does the actual Gemini API call, no
    fallback logic inside.
  - `callGroqDirect()` — private, does the actual Groq API call
    (`llama-3.3-70b-versatile`), no fallback logic inside.
  - `callLLM()` — the new public dispatcher (renamed from `callGemini`).
    Tries Groq first; on a rate-limit error specifically, falls back to
    Gemini immediately (same behavior the old code had, just reversed
    direction). Any other error (bad JSON, empty response, 5xx) propagates
    so BullMQ retries against Groq again on the next attempt — matches the
    original design's philosophy exactly, just flipped.
- Updated all 8 internal call sites from `callGemini(` to `callLLM(`.
- Confirmed via repo-wide grep that `callGemini` was never imported outside
  `lib/llm.ts` — this was a safe, single-file rename with zero external
  blast radius.
- `geoCitationCheck` (GEO analytics — see `docs/08-geo-analytics-audit.md`)
  is a separate case: it calls Groq's `compound-beta` model directly, not
  through `callLLM()`, since that call needs live search grounding, not
  the plain-chat-completion shape. It deliberately has no Gemini fallback,
  documented in that file.
- Verified with `tsc --noEmit` — clean compile.

## What wasn't changed (flagging, not deciding for you)
- `GROQ_MODEL` itself (`llama-3.3-70b-versatile`) — kept as-is. Making Groq
  primary is a different decision from changing which Groq model is used;
  didn't want to bundle a model-quality change into a provider-order change
  without you weighing in separately. **Still open.**
- ✅ **RESOLVED** — the 5 files pacing calls via `LLM_RATE_LIMIT.DELAY_MS`
  (Gemini-tuned, 4500ms). Turned out to be worse than just stale: it was
  fully **redundant**. `waitForRateLimit()` inside `lib/llm.ts` already
  enforces a correct, cross-process, per-provider RPM ceiling (Redis
  sliding window) before every single LLM call, regardless of which job
  triggered it — so every job-level `await delay(LLM_RATE_LIMIT.DELAY_MS)`
  was a second, cruder limiter stacked on top of the real one, using the
  wrong (Gemini) number. Fix: removed all 8 job-level sleep call sites
  (`geo-analytics`, `technical-audit`, `serp-research` ×2,
  `keyword-research` ×2 — one of which was misapplied to throttle a
  non-LLM DataForSEO call, `content-generation`), and turned
  `LLM_RATE_LIMIT` into the actual single source of truth: it now holds
  `GROQ_RPM: 28` / `GEMINI_RPM: 14`, imported by `waitForRateLimit()`
  itself instead of those numbers being hardcoded inline. Net effect: the
  pipeline runs meaningfully faster on Groq (was throttled to Gemini's pace
  everywhere), and there's now exactly one rate limiter, not two disagreeing
  ones. See `docs/08-geo-analytics-audit.md` for where this was first
  flagged.
- No test coverage exists in this repo to run against this change (didn't
  find a test suite in the earlier file inventory) — verification here was
  limited to `tsc --noEmit` (types) and manual trace-through of both
  execution paths (Groq success, Groq rate-limit → Gemini fallback).
  Worth a real smoke test against live API keys before this ships, since
  type-checking alone doesn't prove the Groq call actually behaves as
  expected at runtime.

## Open question for the team
- Should `GROQ_MODEL` be reconsidered while we're already touching provider
  config, or is that explicitly out of scope for this pass?
