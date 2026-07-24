# GEO Analytics (AEO Measurement): Backend Audit

**Files:** `workers/jobs/geo-analytics.job.ts`, `lib/llm.ts`
**Status: ✅ RESOLVED — now uses real, live search grounding instead of
non-grounded LLM recall.**

## What was wrong (original finding)
Used a plain, non-grounded Gemini call — testing training-data brand recall,
not live AI-citation. New content would always show ~0% regardless of real
performance. Full original writeup preserved below.

## What changed
- **`geoCitationCheck()` in `lib/llm.ts` rewritten** to call Groq's
  `compound-beta` model directly — this model runs real, server-side live
  web search (via Tavily) before answering, and the SDK exposes the actual
  `executed_tools[].search_results[]` it used (real URLs, real titles),
  confirmed against the installed `groq-sdk` v1.3.0 type definitions.
- The domain-appearance check now runs against **real search result URLs**,
  not an LLM's self-reported "sources I used" JSON (which could hallucinate)
  — strictly more trustworthy than the original design even before the
  grounding issue.
- Added a `searchExecuted` flag to the return type: compound-beta can choose
  *not* to search for a given query. `geo-analytics.job.ts` now excludes
  those queries from both the numerator and denominator of the score
  (`skippedNoSearch` counter) instead of silently counting them as "checked,
  domain absent" — which would have reintroduced the same 0%-bias bug in a
  different form.
- Deliberately **no Gemini fallback** on this specific call — if Groq
  compound fails, the per-keyword failure handling already in
  `geo-analytics.job.ts` treats it as `failedPrompts++` and moves on. A
  Gemini fallback here would have silently regressed to non-grounded
  measurement, which defeats the fix. Documented directly in the function's
  code comment so this isn't accidentally "fixed" back to a fallback later.
- Verified with `tsc --noEmit` — clean compile, zero errors.

## Also changed at the same time: Groq is now the primary LLM provider
Part of the same work session — see `docs/10-llm-provider-flip.md` for the
full writeup of flipping all 10 LLM call sites from Gemini-primary to
Groq-primary (Gemini now the fallback, only used on Groq rate limit).

## ✅ RESOLVED — external pacing delay was redundant, removed
Flagged here originally: `LLM_RATE_LIMIT.DELAY_MS` (4500ms, tuned for
Gemini's 14 RPM ceiling) was used as an *external* pacing delay in 5 job
files (`geo-analytics`, `technical-audit`, `serp-research`,
`keyword-research`, `content-generation`), on top of the *internal*
Redis-based per-provider rate limiter in `lib/llm.ts` (which already
enforces the correct ceiling per provider — 14 RPM Gemini, 28 RPM Groq).

Resolved: removed the external delay entirely from all 8 call sites across
those 5 files — it was pure duplication of the internal limiter, and wrong
besides (Gemini's pace, even for Groq calls). `LLM_RATE_LIMIT` now just
holds `GROQ_RPM`/`GEMINI_RPM`, imported directly by `lib/llm.ts`'s
`waitForRateLimit()` instead of being duplicated as inline literals there.
Full writeup in `docs/10-llm-provider-flip.md`.

---

## Original finding (for reference)

## What it's supposed to measure
Per the file's own description: how often the project's domain gets cited
by AI engines when users ask AI assistants questions related to the
project's keywords — the core "AEO/GEO" value prop that differentiates this
product (and RankAI) from plain SEO tools.

## What it actually does
For each published keyword, it builds a natural-language user question and
sends it to **Gemini via a plain, non-grounded `generateContent()` call**
(confirmed by reading `callGemini` in `lib/llm.ts` — no `tools:
[{googleSearch: ...}]` or any grounding/search config is passed anywhere).
It then checks whether the project's domain appears in Gemini's response.

## 🔴 Why this is a real problem, not a style nitpick

A plain Gemini call without search grounding answers **from its frozen
training data**, not from a live web search. This means:

1. **A newly published blog post can never be detected**, no matter how
   well it's optimized or how well it ranks — the LLM has no way to know
   the page exists, because its training data predates the page's
   existence. For a brand-new site (which is the exact customer this
   product targets — "grow your website from scratch"), this metric would
   show ~0% forever, regardless of actual SEO/AEO performance.
2. It's measuring **"does this brand already exist prominently enough in
   Gemini's training data to be recalled from memory,"** which is closer to
   brand awareness than to answer-engine citation performance — a
   completely different (and much slower-moving) signal than what
   "AEO/GEO score" implies to a user looking at a dashboard.
3. Real GEO/AEO measurement tools (and what "AEO" means in the RankAI
   product this is modeled on) work by querying **search-grounded**
   AI systems — ChatGPT with browsing, Perplexity, or Gemini/Vertex AI
   *with the Google Search grounding tool enabled* — specifically because
   those systems can surface and cite content that didn't exist at training
   time. That capability exists in the Gemini SDK already in use here
   (`@google/generative-ai` supports grounding), it's just not being used
   for this call.

## What I'd flag to the team, not assume a fix for
This might be a deliberate v1/MVP simplification (the file comment does say
"For v1, Gemini-only gives a meaningful directional signal") — but "Gemini
without grounding" isn't a weaker version of citation tracking, it's testing
a **different thing entirely** that happens to produce a percentage that
looks like the real metric on a dashboard. That distinction matters a lot
if this number is shown to users as "your AI visibility score," since it
could be actively misleading for exactly the newest, most-invested
customers (ones who just had content generated and published).

**Recommended direction to discuss:**
- Enable Google Search grounding on the Gemini call (available in the SDK
  already in use) — closest fix, keeps single-provider simplicity.
- Or be explicit in the UI that this measures brand/training-data recall,
  not live citation, if grounding is out of scope for now.
- Longer-term (matches the file's own comment): add real ChatGPT/Perplexity
  query testing for actual multi-engine AEO coverage, since that's
  presumably the real differentiator being sold.

## Other observations (secondary to the main finding)
- `domainAppearsInCitations` matching logic (domain substring + brand-name
  substring against the LLM's self-reported source list) is reasonable
  *given* the LLM actually has real information to report — the matching
  logic itself isn't the problem.
- `GEO_KEYWORD_LIMIT = 20` is a sensible free-tier cost cap, not a gap.
- Per-keyword failure isolation and the "zero keywords → valid 0% run,
  not a crash" handling are both consistent with the rest of the codebase's
  defensive style — good practice, unrelated to the grounding issue.

## Open question for the team
- Was non-grounded Gemini a deliberate, known-limitation MVP choice, or an
  oversight? This affects whether the fix is "add grounding" (code change)
  or "relabel the metric" (product/UX change) as the immediate next step.
  