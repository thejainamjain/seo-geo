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

1. **`Audit.summary.totalInternalLinks` is hardcoded to `0`** (site-crawl.job.ts line ~821), even though `inlinkCount` is computed and tracked per page via `inlinkCounts`. This looks like a leftover stub — the data exists, it's just not summed into the audit summary. Low-effort fix.
2. **Playwright-pass pages have weaker metadata than Cheerio-pass pages**: `pageSizeBytes` hardcoded to `0`, `brokenLinks` hardcoded to `[]`, no HEAD-based redirect-chain detection (only compares `page.url()` to requested URL, so multi-hop chains before the final JS-rendered page aren't captured). This is called out in the code as a deliberate tradeoff ("Playwright is too slow for bulk link checking") — reasonable, but worth confirming with the team that it's an accepted tradeoff and not an oversight, since it means JS-heavy sites get less complete audits than static/SSR sites.
3. **Dedup logic when Cheerio and Playwright both crawl the same URL**: Cheerio result wins (documented as intentional — "more reliable"). Fine, but means if a page starts server-rendering minimal content and expands via JS, it's classified as Cheerio-only and might miss content Playwright would have seen. Edge case, low priority.
4. **No stated limit/backoff behavior if the target site itself rate-limits or blocks the crawler mid-run** beyond generic `failedRequestHandler` logging into `skippedUrls`. Worth a manual test against a real site with aggressive bot protection (e.g. Cloudflare) — the file header actually already admits this ("WHAT WE STILL CANNOT HANDLE: Cloudflare Enterprise bot protection"), so it's a known, documented limitation rather than a silent gap.
5. **`MAX_CRAWL_PAGES` default of 50** (from `.env`) — fine for MVP/demo, but worth deciding explicitly what the production limit should be and how it interacts with billing/plan tiers, since this isn't currently tied to any subscription/plan concept in the models reviewed so far (to be confirmed once we look at `Project`/`Organization` models).

## Open questions for the team
- Is the Playwright-pass metadata gap (point 2) accepted, or should broken-link/redirect checks be extended to JS-rendered pages too (at the cost of crawl speed)?
- What should `MAX_CRAWL_PAGES` be tied to — a flat config value, or plan-based limits?
