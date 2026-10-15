# Master Audit Summary — SearchPilot Clone Backend

**Scope covered:** Full core pipeline — site crawl, business profile,
technical audit, competitor discovery, keyword research, orchestration/
queues, on-demand content generation, CMS publish (on-demand + cron), GEO
analytics, GSC monitor, all 8 CMS platform integrations, and a new
automatic weekly-generation-scheduling feature.

**Not yet covered (flagging, not forgetting):** `knowledge.service.ts` /
knowledge-loader (brand doc RAG), `audit.service.ts` / `blog.service.ts`
read-side APIs, auth, and the frontend itself (beyond the two type-only
updates needed for `mainCompetitors` and `aiDraftedSteps` — the rest of
the frontend is being handled separately).

## Overall impression
This is a genuinely well-engineered codebase — not a rough prototype. The
person(s) who built it clearly iterated against real bugs, designed for
partial failure everywhere (a recurring, deliberate philosophy: "partial
result is better than no result"), and left detailed comments explaining
*why*, not just *what*. Almost everything found across both audit passes
has now been fixed; what's left is one real product decision and a small
handful of narrow, low-severity items.

## ✅ Resolved — the three original high-priority findings

1. **GEO Analytics** now uses real live search grounding
   (`docs/08-geo-analytics-audit.md`) — `geoCitationCheck` rewritten to use
   Groq's `compound-beta` (real search + real result URLs, not LLM
   self-reporting). Whole app flipped to Groq-primary/Gemini-fallback
   (`docs/10-llm-provider-flip.md`). Follow-up `LLM_RATE_LIMIT.DELAY_MS`
   question also resolved — it was fully redundant with `lib/llm.ts`'s
   internal per-provider rate limiter, so removed rather than retuned.
   `GROQ_MODEL` itself remains a separate, still-open decision if you want
   to revisit which Groq model is used.

2. **Competitor discovery** no longer overwrites manual input
   (`docs/05-phase4-competitor-discovery-audit.md`) — `mainCompetitors` is
   now `CompetitorEntry[]` with source/verified tracking; merge-and-verify
   logic replaces the old blind overwrite. Frontend read-side (`business/page.tsx`,
   `onboarding/page.tsx`) still needs updating to the new object shape —
   you're handling that separately.

3. **`publishHourUtc` landmine** fixed at the mechanism level
   (`docs/07-...-audit.md`) — per-project BullMQ Job Schedulers replace the
   old single fixed-time daily sweep. `publishHourUtc` itself still isn't
   exposed via the API, which remains a deliberate, separate decision.

## ✅ Resolved — everything from the second audit pass (CMS + cleanup)

4. **CMS publish idempotency** — 7 of 8 platform publishers had no
   protection against creating duplicate posts on a BullMQ retry
   (`docs/11-cms-integrations-audit.md`). Fixed two ways: consolidated the
   three independently-duplicated "publish then persist" implementations
   (`blog.service.ts`, `content-generation.job.ts`, `cms-publish.job.ts`)
   into one shared `lib/blog-cms-publisher.ts` with a guard (skip if
   `Blog.cmsReference` already set); and added real upsert-by-slug logic to
   WordPress, Webflow, Wix, Shopify, and GoHighLevel individually, each
   verified against actual platform API docs. Sanity already had this.
   Framer deliberately excluded — see #14 below. Custom API given a stable
   `blogId` idempotency key for the receiving endpoint to use if it wants.
5. **`seoSchema` (JSON-LD) silently dropped** on Webflow/Wix/GoHighLevel,
   and Shopify's copy was stored but never rendered — new shared
   `lib/cms/shared.ts` `injectSchema()` helper fixes all four at once.
6. **`BusinessContext.completedSteps`** was marked fully-done by the AI job
   before a human reviewed anything (`docs/02-...-audit.md`) — split into
   `aiDraftedSteps` (AI's unreviewed guess) and `completedSteps`
   (human-confirmed via the wizard). Frontend type updated to match.
7. **GSC learnings had no weekly dedup** (`docs/09-...-audit.md`) — added a
   30-day cooldown per blog+insight-type.
8. **Three dead duplicate worker files** (`docs/03-orchestration-audit.md`)
   — deleted after reconciling with the live versions.
9. Small items, all resolved: hardcoded `totalInternalLinks: 0`
   (`docs/01-...`) now actually summed; `REGION_TO_COUNTRY` expanded from 9
   to ~40 countries plus a dead, already-drifted duplicate copy of the same
   map deleted from `competitor-discovery.job.ts` (`docs/05-...`).

## New feature — automatic weekly generation scheduling

Not an audit finding — a feature build (`docs/12-weekly-generation-scheduling.md`).
Week 1 generates immediately on project creation; every subsequent week
schedules a delayed BullMQ trigger 24h before its start date, reusing the
existing generate+conditional-publish logic untouched.

## New feature — knowledge (RAG) + learning system

Not an audit finding — a major feature build (`docs/13-knowledge-learning-system.md`).
Two engines: real RAG retrieval over uploaded brand documents (previously
uploaded files sat unprocessed forever), and a closed GSC feedback loop
(previously `BlogLearning` insights were created but never acted on — now
they drive an actual rewrite engine, tiered by risk: tag changes auto-apply
with a rollback safety net, content rewrites need human approval).

Merged carefully against this session's CMS idempotency and content-
generation work — see the conversation for the full merge trace. The
CMS re-sync gap the doc originally flagged as a follow-up is now wired up
too — `blog-optimization.job.ts` and `optimization.service.ts` both
actually push changes to the live CMS post via a new `updateBlogOnCms()`
in `lib/blog-cms-publisher.ts`, working for 6 of 8 platforms (all except
Framer, deliberately skipped since it has no safe update path). A new
`cms-resync-retry-scheduler` (every 4 hours, `global-scheduler.job.ts`)
automatically retries any that failed the first time.

## ✅ Resolved — narrow/low-urgency items, third pass

10. `sanity.ts`'s SearchPilot-branded schema type (`SearchPilotBlogPosts`) renamed
    to `post` — matches Sanity's own official blog starter convention, so
    it now works against any Sanity project with a standard blog schema.
11. Keyword status reset on forced pipeline resume (`docs/06-...`) — moved
    `status: 'upcoming'` from `$set` to `$setOnInsert` in the bulk upsert;
    a re-run no longer touches keywords that have already progressed past
    `upcoming`.
12. `isNowAllowedPublishTime` duplication (`docs/07-...`) — extracted into
    `lib/blog-cms-publisher.ts`, both call sites now import one definition.
13. Wix content format (`docs/11-...`) — confirmed via Wix's own docs and
    developer forum threads that raw HTML in `contentText` was genuinely
    wrong (not just a hunch); now converts via Wix's own "Convert To Ricos
    Document" API before publishing, with a safe plain-text fallback if
    that call fails. Exact request schema wasn't fully confirmable without
    live API access — implemented with a well-reasoned best guess, flagged
    for a live test.

## 🔴 Still open — real, needs a decision

14. **`framer.ts` calls out to SearchPilot's actual live infrastructure**
    (`docs/11-cms-integrations-audit.md`) — not a comment, a live `fetch()`
    call in the runtime publish path. This is the one finding across all
    three passes that's a product decision, not a code fix: either this
    product needs its own Framer plugin/webhook to point at, or Framer
    needs to be disabled as a CMS option until it has one.

## 🟡 Still open — narrow, low urgency

15. Crude `freeTrialAvailable` string-match (`docs/02-...`) — documented,
    low-impact simplification, not touched.
16. Wix's Ricos conversion (item 13 above) and GoHighLevel's
    slug-existence-check response shape (`docs/11-...`) are both
    implemented and reasoned through, but honestly flagged as needing a
    real live test against each platform before being fully trusted — the
    exact request/response schemas weren't confirmable from documentation
    alone.

## ✅ Resolved — Playwright pass, fourth pass

17. Playwright-crawled pages had weaker audit data than Cheerio-crawled
    pages (`docs/01-...`) — `pageSizeBytes` and `brokenLinks` were
    hardcoded to `0`/`[]`. Fixed both (pageSizeBytes now computed from
    rendered HTML byte length — free, no extra request; brokenLinks reuses
    the same `checkBrokenLinks()` helper). Found and fixed two related
    bugs surfaced while doing this: Playwright-discovered links never fed
    the shared inlink-count map, and Cheerio pages' `inlinkCount` was
    finalized before the Playwright pass even ran — added a final re-sync
    pass after both crawl passes complete so every page's inlink count
    reflects links found by either pass.

## ✅ Resolved — technical audit scoring accuracy + determinism, fifth pass

18. **Technical audit score was an even-split approximation, and could be
    overridden by an LLM's brand-reputation guess** (`docs/04-phase3-technical-audit-audit.md`).
    Two things fixed together since they compound:
    - `calculateWeightedScore` divided `totalChecks` evenly across all 16
      factor types instead of using real per-factor totals. Fixed properly:
      `site-crawl.job.ts` now computes real totals from actual page data
      (images found, external links found, structured-data blocks found,
      internal links actually checked, and the right page-count per
      conditional factor) into a new `Audit.summary.checkTotals` field, and
      scoring reads from that. Surfaced two follow-on bugs while tracing
      this through: `totalPages` was silently undercounted (derived from
      `CodeChange.distinct('url', ...)`, which only sees pages with at
      least one failure), and `FACTOR_WEIGHTS`'s `internal_link` entry was
      dead weight — no check ever produces that CodeChange type.
    - The LLM calibration step's prompt scored famous sites 90–100 and
      niche sites 60–80 by inferred brand reputation, only loosely using
      the real pass rate for "newer" sites — meaning the score could shift
      with no underlying technical change, and wasn't reproducible. Changed
      to match how real SEO audit tools work (Ahrefs, SEMrush, Screaming
      Frog, Lighthouse all score mechanically): the final score is now
      `Math.round(weightedPassRate)` directly, and the LLM only writes a
      one-sentence explanation of it, with its own prompt now explicit
      about not proposing a different number or factoring in reputation.
    - Also replaced the three `oldHtml` regex-extraction helpers in the
      same file with `cheerio` parsing — low risk as written (`oldHtml` is
      simple, single-tag content this codebase generates itself), but more
      robust against future format changes and fixes a minor pre-existing
      gap (regex never decoded HTML entities; cheerio does).

19. **`FAQ`/`TLDR` had no `auditId` field**, unlike `CodeChange`
    (`docs/04-phase3-technical-audit-audit.md`, `docs/15-...`) — a known,
    previously-flagged gap, now closed. Added the field to both models
    (required, matching `CodeChange`'s pattern), populated at stub-creation
    time in `site-crawl.job.ts`, and threaded through
    `applyFaqUpdate`/`applyTldrUpdate`'s update filters and
    `listFAQs`/`listTLDRs`'s query filters. Turned up a real correctness
    bug the missing field caused, beyond just list-scoping: without
    `auditId`, a re-crawl's `technical-audit.job.ts` run could match and
    overwrite a stale `pending` stub left over from an earlier, incomplete
    audit run at the same URL instead of its own current stub. No
    migration for pre-existing FAQ/TLDR rows — not needed for this
    project's data.

## ✅ Resolved — sixth pass: remaining low-priority items + doc-sync cleanup

20. **`freeTrialAvailable` false-positive** (`docs/02-...`) — the
    `.includes('yes')` check misclassified answers like "No free trial,
    but yes a demo is available" as `true`. Fixed by constraining the LLM
    prompt to require an exact Yes/No prefix and switching to
    `.startsWith('yes')`.
21. **`extractCoreKeyword`'s domain-fallback TLD handling** (`docs/05-...`)
    — hardcoded TLD suffix list missed `.ai`/`.co`/`.dev`/`.app`, leaving a
    literal dot in the fallback keyword. Fixed by taking the first
    dot-separated label instead (works for any TLD). The deeper limitation
    — mashed-together domains without dashes can't be split into real
    words without real NLP — is a documented, accepted tradeoff, not
    fixed (not worth it for a rarely-hit last-resort branch).
22. **Three "dead worker files"** (`docs/03-...`) — turned out to not
    exist in the repo at all anymore; the open question about deleting
    them is moot. No code change, doc corrected.
23. **Doc-sync cleanup**: `docs/05-...`, `docs/06-...`, `docs/07-...` all
    had stale "🔴 still open" / unanswered-question sections left in place
    from earlier audit passes, even though the underlying code was already
    fixed in a later pass (confirmed by reading current source, not just
    trusting the doc text) — competitor-discovery's merge-not-overwrite
    fix, keyword-status `$setOnInsert` fix, and the per-project
    `publishHourUtc` BullMQ scheduler were all already live in code. Synced
    all three docs to match reality. (Checked `docs/08-...` too — it
    already had the correct resolved-summary-plus-preserved-history
    structure, nothing to fix there.)

**Explicitly not touched, flagged instead of guessed at:**
- **Framer/SearchPilot domain** (#14) — out of scope per your direction this
  round.
- **Approve/reject access restriction** (`docs/13-...`) — the existing code
  comment explicitly argues against building this in isolation ("no
  broader reviewer-role concept in the product yet... would be scope
  creep") and every other project-scoped service in the codebase uses the
  same any-org-member access model. Implementing it here alone would
  reverse a documented deliberate decision and make this one endpoint
  inconsistent with the rest of the app — needs your call, not a
  unilateral change.
- **`GROQ_MODEL` choice**, **`MAX_CRAWL_PAGES`/billing tie-in**, and
  **Wix/GoHighLevel live API verification** — all explicitly product
  decisions or require live credentials I don't have from here.

## What's genuinely solid, no action needed
- Site crawl (3-pass sitemap-first strategy, documented real bug fixes)
- Technical audit LLM pipeline (per-page batching; deterministic score that
  only falls back to a safe default if the mechanical calculation itself
  fails, and to a plain-text pass-rate summary if only the LLM explanation
  call fails — a valid score is never discarded just because the
  explanation call did)
- Content generation idempotency (status guards, blog-exists guards, clean
  rollback on failure)
- GSC monitor (real OAuth refresh, real API integration, no shortcuts)
- Orchestration's three-mechanism design (linear pipeline / on-demand queue
  / cron fan-out) — legitimately good architecture once traced fully
- All 8 CMS publishers: consistent error handling, timeouts, credential
  handling, and (as of this pass) idempotency and schema delivery

## Suggested next step
The one finding left with real product/trust implications is #14
(Framer/SearchPilot domain) — that needs your call on whether/how this product's
own Framer plugin gets built, not more code archaeology. Everything else
remaining is narrow edge cases, documented accepted simplifications, or
implemented-but-needs-a-live-test items.
