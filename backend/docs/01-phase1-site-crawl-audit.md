# Phase 1 — Site Crawl: Backend Audit

**Files:** `workers/jobs/site-crawl.job.ts`, `lib/crawler.ts`
**Pipeline position:** Step 1 of 9
**Status: ✅ Implemented, production-plausible. Minor gaps noted below.**

## What it's supposed to do (per backend/README.md)
Crawl the project's domain, find all pages, detect SEO issues (broken links,
redirect chains, thin content, slow pages, missing metadata, invalid schema).

## What's actually implemented
- **3-pass strategy**, sitemap-first:
  1. Parses `sitemap.xml` / `sitemap_index.xml` and seeds the crawl queue with those URLs (prioritized by depth) — this is correct against how real crawlers (Screaming Frog etc.) work, not just "guessing from links."
  2. `CheerioCrawler` pass for static/SSR pages — extracts full metadata, structured data (JSON-LD), broken links (HEAD requests, internal only, batched at 5 concurrent), redirect detection.
  3. `PlaywrightCrawler` pass, but **only** for pages flagged as JS-rendered (empty visible body after stripping scripts) — real cost control, not brute-forcing every page through a browser.
- URL normalization (`normalizeUrl`) strips `www.` and trailing slashes consistently before using URLs as Redis keys or dedup keys. There are comments describing a past bug (www vs non-www treated as different domains → duplicate content/duplicate Redis entries) that this fixes.
- JS-render detection bug fix documented: script/style content used to inflate `body.text()` length, causing false negatives. Now strips `<script>` first, checks visible text only.
- Real Playwright bug fix documented: `page.evaluate()` broke under `tsx`/esbuild (`__name is not defined`). Replaced with `page.content()` + Cheerio parsing — avoids evaluating serialized functions inside the browser context entirely.
- Writes crawled page content + per-page metadata into Redis with a 24h TTL (used by downstream phases), and creates `CodeChange`, `FAQ`, `TLDR` **stub** records (status: `pending`) that Phase 3 (technical-audit) later fills in with LLM-generated fixes. Confirmed this isn't duplicated work — `technical-audit.job.ts` explicitly reads these pending stubs and only fills `newHtml`/LLM content; mechanical detection stays in this file, LLM generation stays in Phase 3. Clean separation.
- Detects: broken links, redirect chains (>1 hop), thin content (<300 words), slow pages (>3s), missing/invalid meta (title/description/OG), non-self canonical, missing H1, invalid schema (per-schema-type required-field checks for Organization/Product/FAQPage/Article/LocalBusiness), oversized pages (>1MB).
- On failure, marks `Audit.status = 'failed'` with the error message and re-throws so BullMQ retries — this feeds `pipeline-resume.ts` (resume-from-failed-step logic mentioned in README).

## Gaps / things worth flagging

1. ✅ **RESOLVED** — `Audit.summary.totalInternalLinks` was hardcoded to `0` (site-crawl.job.ts line ~821), even though `page.links[].isExternal` already told us which links were internal. Now summed across all crawled pages (`allPages.reduce(...)`) into the audit summary.
2. ✅ **RESOLVED** — Playwright-pass pages had weaker metadata than
   Cheerio-pass pages: `pageSizeBytes` was hardcoded to `0`, `brokenLinks`
   was hardcoded to `[]`. Fixed both, plus two related gaps found while
   fixing them:
   - `pageSizeBytes` now computed from the rendered HTML's byte length
     (`extractFromPlaywright` already has the full HTML in memory from
     `page.content()` — no extra network request needed). Deliberately a
     different measurement basis than the Cheerio pass (which uses a HEAD
     request's `Content-Length` — the pre-JS transfer size): for a
     JS-rendered page, the pre-render HTML is often a near-empty SPA
     shell, so measuring that would defeat the point of running Playwright
     on the page at all. Rendered DOM size is the more honest signal here.
   - `brokenLinks` now uses the same `checkBrokenLinks()` helper the
     Cheerio pass already used — no more free pass on broken-link
     detection for JS-heavy sites.
   - Found in the process: the Playwright pass never fed its discovered
     links into the shared `inlinkCounts` map, so a page only discoverable
     via a JS-rendered page's links got no inlink credit from it. Fixed —
     now tracks inlinks the same way the Cheerio pass does.
   - Found a second, related bug this interacted with: Cheerio pages'
     `inlinkCount` was finalized *inside* `runCheerioCrawler`, which
     returns and finishes **before** the Playwright pass even starts — so
     any inlinks a Playwright-crawled page contributed to a
     Cheerio-crawled page could never reach it, even with the fix above.
     Added a final re-sync pass after both passes complete and merge,
     using the fully-populated `inlinkCounts` map, so every page's
     `inlinkCount` now reflects links discovered by both passes, not just
     whichever pass happened to crawl that specific page.
   - Redirect-chain detection was NOT changed — on closer look, the
     existing `page.url()` comparison is already roughly equivalent in
     accuracy to the Cheerio pass's own HEAD-request approach (both only
     produce a synthetic single-hop chain entry, not a real multi-hop
     chain — that was a pre-existing simplification on both passes, not a
     Playwright-specific gap).
   - The "Playwright too slow for bulk link checking" tradeoff comment
     that originally justified skipping this is gone — `checkBrokenLinks`
     is now called for both passes identically.
3. **Dedup logic when Cheerio and Playwright both crawl the same URL**: Cheerio result wins (documented as intentional — "more reliable"). Fine, but means if a page starts server-rendering minimal content and expands via JS, it's classified as Cheerio-only and might miss content Playwright would have seen. Edge case, low priority.
4. **No stated limit/backoff behavior if the target site itself rate-limits or blocks the crawler mid-run** beyond generic `failedRequestHandler` logging into `skippedUrls`. Worth a manual test against a real site with aggressive bot protection (e.g. Cloudflare) — the file header actually already admits this ("WHAT WE STILL CANNOT HANDLE: Cloudflare Enterprise bot protection"), so it's a known, documented limitation rather than a silent gap.
5. **`MAX_CRAWL_PAGES` default of 50** (from `.env`) — fine for MVP/demo, but worth deciding explicitly what the production limit should be and how it interacts with billing/plan tiers, since this isn't currently tied to any subscription/plan concept in the models reviewed so far (to be confirmed once we look at `Project`/`Organization` models).

6. ✅ **RESOLVED** — `Audit.summary` now also stores `checkTotals`: real
   per-CodeChange-type totals computed from the actual crawled page data
   (total images, total external links, total structured-data blocks, total
   unique internal links HEAD-checked, and page counts for the page-level
   and conditional factors). This replaced an even-split approximation that
   `technical-audit.job.ts`'s scoring step used to rely on — full write-up
   (including the `checkBrokenLinks()` return-shape change and the
   `PageData.internalLinksChecked` field this needed) is in
   `docs/04-phase3-technical-audit-audit.md`, since the scoring logic itself
   lives there.

## Open questions for the team
- What should `MAX_CRAWL_PAGES` be tied to — a flat config value, or plan-based limits?
