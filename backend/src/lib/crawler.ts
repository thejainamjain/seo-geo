/**
 * CONSUMERS:
 *   - site-crawl.job.ts       → crawls own domain (full extract)
 *   - competitor-discovery.job.ts → crawls competitor homepages (lightweight)
 *   - serp-research.job.ts    → crawls SERP result URLs for content analysis
 *  - geo-analytics.job.ts     → crawls competitor homepages (lightweight)
 *
 * WHY THIS EXISTS:
 *
 *   1. SITEMAP-FIRST DISCOVERY
 *      Parses /sitemap.xml and /sitemap_index.xml before link-following.
 *      Industry tools (Ahrefs, Screaming Frog) use sitemaps as primary
 *      URL source because they give 100% coverage of pages the site WANTS
 *      indexed — no guessing from link-following. Link-following is fallback.
 *
 *   2. RESPONSE TIME TRACKING
 *      Every page records responseTimeMs. Slow pages (>3s) are flagged as
 *      CodeChange type 'page_speed'. Technical audit uses this for scoring.
 *
 *   3. REDIRECT CHAIN DETECTION
 *      Records the full hop-by-hop chain (URL + real status code per hop),
 *      not just "was there a redirect". A 3-hop redirect is a real SEO
 *      problem — flagged as CodeChange type 'redirect_chain'. Industry
 *      standard: flag anything >1 hop.
 * 
 *   4. BROKEN LINK DETECTION
 *      For every <a href> found on a page, makes a HEAD request to check
 *      status. 404/410/5xx → CodeChange type 'broken_link'. Runs for BOTH
 *      the Cheerio and Playwright passes (see extractFromPlaywright /
 *      Playwright pass notes below), and shares one cache Map across the
 *      entire crawl run so shared nav/footer links (present on every page)
 *      are HEAD-checked once instead of once per page.
 *
 *   5. STRUCTURED DATA EXTRACTION
 *      Extracts and parses JSON-LD from <script type="application/ld+json">.
 *      Returns the actual schema objects (not just a boolean). Technical audit
 *      can validate schema type, required fields, etc.
 *
 *   6. CANONICAL CROSS-PAGE VALIDATION
 *      After all pages crawled, checks if canonical points to a DIFFERENT
 *      URL than the page itself (self-referential vs pointing elsewhere).
 *      Non-self canonicals are flagged — major SEO signal.
 *
 *   7. CRAWL BUDGET SCORING
 *      URLs are scored before crawling: depth (fewer slashes = higher priority),
 *      inlink count (more links pointing to it = crawl first), sitemap presence.
 *      Ensures we crawl the 50 most important pages, not 50 random ones.
 *
 *   8. PAGE SIZE TRACKING
 *      Records pageSizeBytes. Pages >1MB are flagged (too large for Googlebot
 *      to fully index in one crawl visit).
 *
 *   9. WORD COUNT
 *      Records wordCount. Pages <300 words are thin content — flagged as
 *      CodeChange type 'thin_content'. Industry standard threshold.
 *
 *  10. COMPETITOR / SERP PAGE MODE
 *      crawlSinglePage() — lightweight single-URL fetch for competitor
 *      homepage and SERP result crawling. No link-following, no Redis storage.
 *      Returns same PageData shape so downstream LLM prompts stay identical.
 *
 * WHAT WE STILL CANNOT HANDLE:
 *   - Cloudflare Enterprise bot protection
 *   - Login-gated pages (no credentials)
 *   - Sites blocking all crawlers
 */

import robotsParser from 'robots-parser';
import { CheerioCrawler, PlaywrightCrawler, RequestQueue } from 'crawlee';
import type { CheerioAPI } from 'cheerio';
import type { Page, Request as PWRequest, Response as PWResponse } from 'playwright';
import { logger } from '@/open-tele';

// ── Constants ──────────────────────────────────────────────────────────────

export const CRAWLER_UA          = 'SEOGeoBot/1.0 (+https://yourdomain.com/bot)';
export const MIN_BODY_LENGTH     = 200;        // Below → JS-rendered, needs Playwright
export const REQUEST_DELAY_MS    = 500;        // Polite crawl delay
export const MAX_REDIRECT_HOPS   = 3;          // More than this = CodeChange 'redirect_chain'
export const SLOW_PAGE_MS        = 3000;       // >3s response = CodeChange 'page_speed'
export const THIN_CONTENT_WORDS  = 300;        // <300 words = CodeChange 'thin_content'
export const MAX_PAGE_SIZE_BYTES = 1_000_000;  // >1MB = CodeChange 'page_size'
export const BROKEN_LINK_TIMEOUT = 8_000;      // HEAD request timeout for link checking

// ── Types ──────────────────────────────────────────────────────────────────

export interface RedirectHop {
  url:        string;
  statusCode: number;
}

export interface StructuredDataItem {
  type: string;   // '@type' value e.g. 'Organization', 'FAQPage', 'Product'
  raw:  unknown;  // full parsed object — technical audit validates fields
}

export interface PageData {
  // Identity
  url:         string;
  finalUrl:    string;  // after redirects
  statusCode:  number;
  renderedBy:  'cheerio' | 'playwright';

  // Content
  title:       string;
  description: string;
  h1:          string | null;
  h2s:         string[];
  textContent: string;
  wordCount:   number;

  // SEO signals
  canonical:       string | null;
  isCanonicalSelf: boolean;  // true if canonical === finalUrl (or absent)
  ogTitle:         string | null;
  ogDescription:   string | null;
  ogImage:         string | null;
  hasSchema:       boolean;
  structuredData:  StructuredDataItem[];  // parsed JSON-LD (not just boolean)

  // Links
  links:       Array<{ href: string; text: string; isExternal: boolean; title: string }>;
  brokenLinks: Array<{ href: string; statusCode: number }>;  // checked HEAD requests
  // Unique internal links actually HEAD-checked for this page (0 if the
  // broken-link check was skipped/disabled). Used as the exact denominator
  // for the "broken_link" score factor — see checkBrokenLinks' checkedCount.
  internalLinksChecked: number;

  // Images
  images: Array<{ src: string; alt: string }>;

  // Performance
  responseTimeMs:   number;
  pageSizeBytes:    number;
  redirectChain:    RedirectHop[];  // empty if no redirects
  hasRedirectChain: boolean;        // true if chain length > 1

  // Crawl metadata
  depth:       number;   // slash count in path (homepage = 0)
  inlinkCount: number;   // how many crawled pages link to this URL
  fromSitemap: boolean;  // was this URL found in sitemap.xml?
}

export interface CrawlResult {
  crawledPages:   PageData[];
  crawledUrls:    string[];
  skippedUrls:    Array<{ url: string; reason: string }>;
  jsRenderedUrls: string[];
  sitemapUrls:    string[];  // all URLs found in sitemap (even uncrawled)
}

// ── URL normalisation ──────────────────────────────────────────────────────

/**
 * Normalises a URL to the canonical domain.
 *
 * WHY: Sites often have both www and non-www variants. The project stores
 * the domain WITHOUT www (e.g. "javaria-agency.in"). Crawlee's same-domain
 * strategy treats www.javaria-agency.in and javaria-agency.in as different
 * domains, causing duplicate crawling and duplicate Redis keys.
 *
 * WHAT THIS DOES:
 *   - Strips www. prefix from hostname
 *   - Normalises trailing slash (removes it)
 *   - Lowercases hostname
 *   - Leaves path, query, hash untouched
 *
 * Used before: queuing URLs, generating Redis keys, deduplication.
 */
export function normalizeUrl(url: string, domain: string): string {
  try {
    const parsed = new URL(url);
    // Always use the canonical (non-www) hostname
    parsed.hostname = parsed.hostname.replace(/^www\./, '');
    // Remove trailing slash from pathname (except root)
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Returns true if the given URL belongs to the project domain
 * (matches either www or non-www variant).
 */
export function isSameDomain(url: string, domain: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const canonical = domain.replace(/^www\./, '');
    return hostname === canonical;
  } catch {
    return false;
  }
}

// ── robots.txt ─────────────────────────────────────────────────────────────

export interface RobotsChecker {
  isAllowed: (url: string) => boolean;
}

export async function fetchRobotsTxt(baseUrl: string): Promise<RobotsChecker> {
  const robotsUrl = `${baseUrl}/robots.txt`;
  try {
    const res  = await fetch(robotsUrl, {
      headers: { 'User-Agent': CRAWLER_UA },
      signal:  AbortSignal.timeout(10_000),
    });
    const text = res.ok ? await res.text() : '';
    const robots = robotsParser(robotsUrl, text);
    logger.info('robots.txt fetched', { robotsUrl, status: res.status });
    return { isAllowed: (url: string) => robots.isAllowed(url, CRAWLER_UA) ?? true };
  } catch (err) {
    logger.warn('robots.txt fetch failed — assuming all paths allowed', {
      robotsUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return { isAllowed: () => true };
  }
}

// ── Sitemap discovery ──────────────────────────────────────────────────────

/**
 * Fetches sitemap.xml (and sitemap_index.xml children).
 * Returns deduplicated, normalised list of page URLs found.
 *
 * Industry tools use sitemaps as primary URL source because:
 *   1. 100% coverage of indexable pages (no guessing from link-following)
 *   2. Site owners only include pages they WANT crawled
 *   3. Priority + lastmod hints for crawl scheduling
 *
 * Falls back gracefully — if sitemap absent, returns [].
 */
export async function discoverSitemapUrls(baseUrl: string, domain: string): Promise<string[]> {
  const candidates = [
    `${baseUrl}/sitemap.xml`,
    `${baseUrl}/sitemap_index.xml`,
    `${baseUrl}/sitemap-index.xml`,
  ];

  const allUrls = new Set<string>();

  for (const sitemapUrl of candidates) {
    try {
      const res = await fetch(sitemapUrl, {
        headers: { 'User-Agent': CRAWLER_UA },
        signal:  AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;

      const xml = await res.text();

      // Extract <loc> tags — works for both sitemap.xml and sitemap_index.xml
      const locMatches = xml.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi);
      for (const match of locMatches) {
        const url = match[1]?.trim();
        if (!url) continue;

        // If this is a sitemap index, fetch child sitemaps
        if (url.endsWith('.xml') || url.includes('sitemap')) {
          try {
            const childRes = await fetch(url, {
              headers: { 'User-Agent': CRAWLER_UA },
              signal:  AbortSignal.timeout(10_000),
            });
            if (childRes.ok) {
              const childXml = await childRes.text();
              const childLocs = childXml.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi);
              for (const childMatch of childLocs) {
                const childUrl = childMatch[1]?.trim();
                if (childUrl && !childUrl.endsWith('.xml')) {
                  // Normalise before storing — strip www, trailing slash
                  allUrls.add(normalizeUrl(childUrl, domain));
                }
              }
            }
          } catch {
            // Child sitemap fetch failed — ignore
          }
        } else {
          // Normalise before storing
          allUrls.add(normalizeUrl(url, domain));
        }
      }

      // Found a valid sitemap — no need to check other candidates
      if (allUrls.size > 0) break;

    } catch {
      // This sitemap URL doesn't exist — try next candidate
    }
  }

  logger.info('Sitemap discovery complete', {
    baseUrl,
    urlsFound: allUrls.size,
  });

  return [...allUrls];
}

// ── Redirect chain follower ────────────────────────────────────────────────

/**
 * Follows redirect chain manually, recording each hop.
 * Returns final URL, final status code, chain of hops, and response time.
 *
 * Why manual (not fetch with redirect:'follow'):
 *   fetch() follows redirects silently — we can't see intermediate hops.
 *   We need the chain to detect 3xx loops and multi-hop chains.
 */
export async function followRedirectChain(
  url:     string,
  timeout: number = 15_000,
): Promise<{
  finalUrl:       string;
  finalStatus:    number;
  chain:          RedirectHop[];
  responseTimeMs: number;
  pageSizeBytes:  number;
}> {
  const chain: RedirectHop[] = [];
  let currentUrl = url;
  const startTime = Date.now();
  let pageSizeBytes = 0;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS + 1; hop++) {
    const res = await fetch(currentUrl, {
      redirect: 'manual',  // Don't auto-follow — we want to see each hop
      headers:  { 'User-Agent': CRAWLER_UA },
      signal:   AbortSignal.timeout(timeout),
    });

    chain.push({ url: currentUrl, statusCode: res.status });

    // Not a redirect — this is the final response
    if (res.status < 300 || res.status >= 400) {
      pageSizeBytes = parseInt(res.headers.get('content-length') ?? '0', 10);
      return {
        finalUrl:       currentUrl,
        finalStatus:    res.status,
        chain:          chain.slice(0, -1),  // Last hop is the final page, not a redirect
        responseTimeMs: Date.now() - startTime,
        pageSizeBytes,
      };
    }

    // Follow redirect
    const location = res.headers.get('location');
    if (!location) {
      return {
        finalUrl:       currentUrl,
        finalStatus:    res.status,
        chain:          chain.slice(0, -1),
        responseTimeMs: Date.now() - startTime,
        pageSizeBytes:  0,
      };
    }

    // Resolve relative redirects
    currentUrl = location.startsWith('http')
      ? location
      : new URL(location, currentUrl).toString();
  }

  // Too many hops — return what we have
  logger.warn('Redirect chain too long', { url, hops: chain.length });
  return {
    finalUrl:       currentUrl,
    finalStatus:    0,
    chain,
    responseTimeMs: Date.now() - startTime,
    pageSizeBytes:  0,
  };
}

// ── Crawl budget scorer ────────────────────────────────────────────────────

/**
 * Scores a URL for crawl priority. Higher score = crawl first.
 *
 * Factors (mirrors Screaming Frog crawl priority logic):
 *   +100  Homepage
 *   +50   In sitemap
 *   +30   Depth 1 (e.g. /about, /services)
 *   +20   Depth 2
 *   +10   Depth 3
 *   +0    Depth 4+ (deep pages)
 *   +N    Inlink count (each link pointing to this URL adds 2 points)
 *   -20   Likely asset (has extension like .pdf, .jpg)
 *   -10   Query string present (usually pagination/filters)
 */
export function scoreCrawlPriority(
  url:          string,
  baseUrl:      string,
  sitemapUrls:  Set<string>,
  inlinkCounts: Map<string, number>,
): number {
  let score = 0;

  try {
    const parsed = new URL(url);
    const path   = parsed.pathname;

    // Homepage
    if (path === '/' || path === '') score += 100;

    // Depth scoring
    const depth = path.split('/').filter(Boolean).length;
    if (depth === 0) score += 100;
    else if (depth === 1) score += 30;
    else if (depth === 2) score += 20;
    else if (depth === 3) score += 10;

    // Sitemap bonus — check both normalised and raw
    if (sitemapUrls.has(url) || sitemapUrls.has(url.replace(/^https?:\/\/www\./, 'https://'))) {
      score += 50;
    }

    // Inlink bonus
    score += (inlinkCounts.get(url) ?? 0) * 2;

    // Penalties
    if (/\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js|xml|zip|woff|woff2|ttf)$/i.test(path)) {
      score -= 20;
    }
    if (parsed.search) score -= 10;

  } catch {
    score = 0;
  }

  return score;
}

// ── Broken link checker ────────────────────────────────────────────────────

/**
 * Shared cache type for checkBrokenLinks(): href → last-checked statusCode.
 * Pass ONE instance of this, created once per crawl run, into every
 * checkBrokenLinks() call across all pages (both Cheerio and Playwright
 * passes) so links shared across pages (nav, footer, sidebar — which
 * realistically appear on every page of a site) are HEAD-checked exactly
 * once per crawl instead of once per page.
 */
export type BrokenLinkCache = Map<string, number>;

/**
 * Checks a list of links with HEAD requests.
 * Returns the broken ones (4xx/5xx) plus checkedCount — the number of
 * unique internal links referenced on THIS page. checkedCount is the exact
 * denominator for the "broken_link" score factor (see technical-audit.job.ts
 * / Audit.summary.checkTotals) — it's the same de-duplicated population
 * `broken` was filtered from, just not discarded this time.
 *
 * CRAWL-WIDE CACHE: if `cache` is provided (and shared across every page's
 * call within the same crawl run — see site-crawl.job.ts), a link already
 * checked on an earlier page reuses that result instead of being
 * HEAD-requested again. Nav/footer links repeat on every page of a typical
 * site, so without this a 50-page crawl with a 20-link nav could issue up
 * to 1000 HEAD requests for what are really only ~20 unique URLs — slower,
 * and impolite to the target server. `checkedCount` still reflects every
 * unique internal link on THIS page (whether freshly checked or served
 * from cache), since that's the correct denominator for this page's score.
 * If `cache` is omitted, a call-local Map is used (equivalent to the old
 * always-fresh behavior) — this is what crawlSinglePage() relies on, since
 * competitor/SERP single-page checks have no multi-page crawl to share a
 * cache across.
 *
 * Runs in parallel batches of 5 to stay polite.
 * Skips external links — we don't want to hammer third-party servers.
 * Skips anchors, mailto:, tel:.
 */
export async function checkBrokenLinks(
  links:   Array<{ href: string; isExternal: boolean }>,
  baseUrl: string,
  cache:   BrokenLinkCache = new Map(),
): Promise<{ broken: Array<{ href: string; statusCode: number }>; checkedCount: number }> {
  const broken: Array<{ href: string; statusCode: number }> = [];

  const internalLinks = links
    .filter(l => !l.isExternal)
    .filter(l => l.href && !l.href.startsWith('#') && !l.href.startsWith('mailto:') && !l.href.startsWith('tel:'))
    .map(l => {
      try {
        return l.href.startsWith('http')
          ? l.href
          : new URL(l.href, baseUrl).toString();
      } catch {
        return null;
      }
    })
    .filter((u): u is string => u !== null);

  const unique = [...new Set(internalLinks)];

  // Split into links already resolved earlier in this crawl (served from
  // cache, no request) vs links seen for the first time (need a real check).
  const toCheck: string[] = [];
  for (const href of unique) {
    const cached = cache.get(href);
    if (cached !== undefined) {
      if (cached === 0 || cached >= 400) broken.push({ href, statusCode: cached });
    } else {
      toCheck.push(href);
    }
  }

  const BATCH_SIZE = 5;
  for (let i = 0; i < toCheck.length; i += BATCH_SIZE) {
    const batch = toCheck.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (href) => {
        try {
          const res = await fetch(href, {
            method:   'HEAD',
            headers:  { 'User-Agent': CRAWLER_UA },
            signal:   AbortSignal.timeout(BROKEN_LINK_TIMEOUT),
            redirect: 'follow',
          });
          return { href, statusCode: res.status };
        } catch {
          return { href, statusCode: 0 };
        }
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { href, statusCode } = result.value;
        cache.set(href, statusCode);
        if (statusCode === 0 || statusCode >= 400) {
          broken.push({ href, statusCode });
        }
      }
    }

    if (i + BATCH_SIZE < toCheck.length) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  return { broken, checkedCount: unique.length };
}

// ── Structured data extraction ─────────────────────────────────────────────

/**
 * Extracts and parses all JSON-LD script tags from HTML.
 * Returns array of { type, raw } objects.
 */
export function extractStructuredData($: CheerioAPI): StructuredDataItem[] {
  const items: StructuredDataItem[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html()?.trim();
      if (!raw) return;

      const parsed = JSON.parse(raw) as Record<string, unknown>;

      const entries = parsed['@graph']
        ? (parsed['@graph'] as Array<Record<string, unknown>>)
        : [parsed];

      for (const entry of entries) {
        const type = entry['@type'];
        if (typeof type === 'string') {
          items.push({ type, raw: entry });
        } else if (Array.isArray(type)) {
          items.push({ type: type[0] ?? 'Unknown', raw: entry });
        }
      }
    } catch {
      // Invalid JSON-LD — don't crash, just skip
    }
  });

  return items;
}

// ── URL utilities ──────────────────────────────────────────────────────────

export function getUrlDepth(url: string): number {
  try {
    const path = new URL(url).pathname;
    return path.split('/').filter(Boolean).length;
  } catch {
    return 0;
  }
}

export function isAssetUrl(url: string): boolean {
  return /\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js|xml|zip|woff|woff2|ttf|ico|mp4|mp3)$/i.test(url);
}

export function isAuthGated(url: string, textContent: string): boolean {
  const loginPatterns = ['/login', '/signin', '/sign-in', '/auth', '/account/login'];
  return loginPatterns.some(p => url.includes(p)) ||
    textContent.toLowerCase().includes('please log in') ||
    textContent.toLowerCase().includes('please sign in');
}

export function isBotBlocked(statusCode: number): boolean {
  // 503 added: Cloudflare and similar bot-challenge/interstitial pages
  // commonly respond with 503 Service Unavailable (e.g. "Checking your
  // browser..." pages), not just 403/429.
  return statusCode === 403 || statusCode === 429 || statusCode === 503;
}

/**
 * Detects if a page needs Playwright (JS-rendered, Cheerio got nothing useful).
 *
 * FIX: Check raw body text BEFORE stripping nav/header/footer.
 * The old check ran AFTER stripping, so small agency sites where most text
 * lives in nav/header/footer would always fail the threshold and get sent
 * to Playwright unnecessarily — then fail with __name error.
 *
 * We now check the raw unstripped body. If even the raw body is under
 * MIN_BODY_LENGTH, the page is genuinely JS-rendered (blank shell).
 * If raw body has content but stripped body doesn't, it's a content
 * structure issue — not a JS-rendering issue — so Cheerio result is fine.
 *
 * FIX 2: the SPA-root check below used to only run when the WHOLE page's
 * raw body text was under 500 chars. In practice almost no real page hits
 * that: even a fully client-rendered app ships nav links, a footer,
 * a cookie banner, and often a server-rendered <title>/<meta> block, which
 * together easily clear 500 chars — so this branch rarely fired and
 * genuinely JS-rendered pages (whose actual content lives inside
 * #root/#__next and is empty pre-hydration) were misclassified as static
 * and never handed to Playwright. We now check the SPA root element's OWN
 * text content against MIN_BODY_LENGTH, independent of how much chrome
 * surrounds it — a hydrated/SSR page has real content inside the root; a
 * CSR-only shell doesn't, no matter how much boilerplate is elsewhere in
 * <body>.
 */
export function isJsRendered(visibleBodyText: string, $?: CheerioAPI): boolean {
  if (visibleBodyText.trim().length < MIN_BODY_LENGTH) return true;

  if ($) {
    const spaRoot = $('#root, #app, #__next, #gatsby-focus-wrapper, [data-reactroot]').first();
    if (spaRoot.length > 0 && spaRoot.text().trim().length < MIN_BODY_LENGTH) return true;
  }
  return false;
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ── HTML extraction ────────────────────────────────────────────────────────

/**
 * Extracts all SEO-relevant data from a Cheerio-parsed page.
 *
 * FIX: Now returns rawBodyText separately so the caller can run
 * isJsRendered() on the UNSTRIPPED body before we remove nav/header/footer.
 * This prevents small sites from being falsely flagged as JS-rendered.
 */
export function extractFromCheerio(
  $:      CheerioAPI,
  url:    string,
  domain: string,
): Omit<PageData,
  | 'statusCode' | 'renderedBy' | 'finalUrl' | 'redirectChain'
  | 'hasRedirectChain' | 'responseTimeMs' | 'pageSizeBytes'
  | 'depth' | 'inlinkCount' | 'fromSitemap' | 'brokenLinks' | 'internalLinksChecked'
> & { rawBodyText: string } {
  const title         = $('title').first().text().trim();
  const description   = $('meta[name="description"]').attr('content')?.trim() ?? '';
  const canonical     = $('link[rel="canonical"]').attr('href') ?? null;
  const ogTitle       = $('meta[property="og:title"]').attr('content') ?? null;
  const ogDescription = $('meta[property="og:description"]').attr('content') ?? null;
  const ogImage       = $('meta[property="og:image"]').attr('content') ?? null;
  const h1            = $('h1').first().text().trim() || null;

  // Canonical self-check
  let isCanonicalSelf = true;
  if (canonical) {
    try {
      const canonNorm = new URL(canonical).href.replace(/\/$/, '');
      const urlNorm   = new URL(url).href.replace(/\/$/, '');
      isCanonicalSelf = canonNorm === urlNorm;
    } catch {
      isCanonicalSelf = false;
    }
  }

  const h2s: string[] = [];
  $('h2').each((_, el) => {
    const text = $(el).text().trim();
    if (text) h2s.push(text);
  });

  const links: PageData['links'] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.trim() ?? '';
    const text = $(el).text().trim();
    const title = $(el).attr('title')?.trim() ?? '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    const isExternal = href.startsWith('http') && !isSameDomain(href, domain);
    links.push({ href, text, isExternal, title });
  });

  const images: PageData['images'] = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src')?.trim() ?? '';
    const alt = $(el).attr('alt')?.trim() ?? '';
    if (src) images.push({ src, alt });
  });

  // Extract structured data BEFORE stripping scripts
  const structuredData = extractStructuredData($);
  const hasSchema = structuredData.length > 0;

  // Strip scripts/styles first to get true visible text for JS-render detection.
  // $('body').text() includes <script> content — a React bundle easily adds
  // 900+ chars making the page look content-rich when the body is actually empty.
  $('script, style, noscript, iframe').remove();
  const rawBodyText = $('body').text().replace(/\s+/g, ' ').trim();

  // Now also strip nav/header/footer for the LLM-bound textContent
  $('nav, footer, header').remove();

  const textContent = $('body').text()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 10_000);

  const wordCount = countWords(textContent);

  return {
    url,
    title,
    description,
    canonical,
    isCanonicalSelf,
    ogTitle,
    ogDescription,
    ogImage,
    h1,
    h2s,
    links,
    images,
    textContent,
    wordCount,
    hasSchema,
    structuredData,
    rawBodyText,  // Extra field — used by caller for JS-render detection, not stored in Redis
  };
}

/**
 * Extracts SEO data from a Playwright page.
 *
 * FIX: Replaced page.evaluate() with page.content() + Cheerio.
 *
 * WHY THE OLD CODE BROKE:
 *   page.evaluate() serialises the callback and runs it inside the browser's
 *   V8 engine. tsx compiles via esbuild, which injects a __name() helper for
 *   Function.name support. The browser has no __name global, so every
 *   page.evaluate() call threw: ReferenceError: __name is not defined.
 *
 * WHY page.content() + Cheerio WORKS:
 *   page.content() returns the fully rendered HTML as a plain string — no
 *   function serialisation, no esbuild artefacts sent to the browser.
 *   We parse it on the Node side with Cheerio, reusing extractFromCheerio.
 *   This also eliminates 80 lines of duplicated extraction logic.
 *
 * pageSizeBytes: computed from the RENDERED HTML's byte length, not a
 * network Content-Length header. Deliberately different from the Cheerio
 * pass's measurement basis (which uses a HEAD request's Content-Length —
 * the pre-JS-execution transfer size). For a JS-rendered page, the
 * pre-render HTML is often just a near-empty SPA shell — measuring THAT
 * would defeat the point of running Playwright on this page in the first
 * place. The rendered DOM size is the more honest "how much page is
 * there" signal for these pages specifically. This also comes for free —
 * no extra network request needed, since Playwright already has the full
 * rendered HTML in memory from page.content() above.
 */
export async function extractFromPlaywright(
  page:   Page,
  url:    string,
  domain: string,
): Promise<Omit<PageData,
  | 'statusCode' | 'renderedBy' | 'finalUrl' | 'redirectChain'
  | 'hasRedirectChain' | 'responseTimeMs'
  | 'depth' | 'inlinkCount' | 'fromSitemap' | 'brokenLinks' | 'internalLinksChecked'
> & { rawBodyText: string }> {
  // Wait for JS to finish rendering
  await page.waitForLoadState('networkidle', { timeout: 60_000 });

  // Get fully rendered HTML — no page.evaluate(), no esbuild artefacts in browser
  const html = await page.content();

  // Parse on Node side with Cheerio — reuses all extraction logic
  const { load } = await import('cheerio');
  const $ = load(html);

  const extracted = extractFromCheerio($, url, domain);

  return {
    ...extracted,
    pageSizeBytes: Buffer.byteLength(html, 'utf-8'),
  };
}

/**
 * Builds the real, hop-by-hop redirect chain for a Playwright navigation.
 *
 * WHY THIS EXISTS / WHY IT'S ACCURATE:
 *   Playwright's browser engine (via CDP) already follows HTTP redirects
 *   itself during `page.goto()` and retains the full chain internally.
 *   `response.request()` gives the Request for the FINAL response;
 *   `Request.redirectedFrom()` walks backwards through every intermediate
 *   hop; each intermediate hop's own `.response()` gives its REAL status
 *   code (301/302/307/308 — whatever it actually was, never assumed).
 */
export async function buildRedirectChainFromPlaywrightResponse(
  response: PWResponse | null,
): Promise<{ chain: RedirectHop[]; finalUrl: string }> {
  if (!response) return { chain: [], finalUrl: '' };

  // Walk backwards from the final request to the original one.
  const hopsNewestFirst: PWRequest[] = [];
  let current: PWRequest | null = response.request().redirectedFrom();
  while (current) {
    hopsNewestFirst.push(current);
    current = current.redirectedFrom();
  }
  const hopsChronological = hopsNewestFirst.reverse();

  const chain: RedirectHop[] = [];
  for (const hop of hopsChronological) {
    let hopResponse: PWResponse | null = null;
    try {
      hopResponse = await hop.response();
    } catch {
      // Hop response no longer retrievable — skip rather than guess a code.
    }
    chain.push({ url: hop.url(), statusCode: hopResponse?.status() ?? 0 });
  }

  return { chain, finalUrl: response.url() };
}

// ── Single page crawl (for competitor / SERP jobs) ────────────────────────

/**
 * Crawls a single URL and returns PageData.
 * No link-following, no Redis storage, no CodeChange detection.
 * Used by competitor-discovery and serp-research jobs.
 *
 * Strategy: Cheerio first (fast), Playwright fallback if JS-rendered.
 */
export async function crawlSinglePage(
  url:    string,
  domain: string,
): Promise<PageData | null> {
  // 1. Follow redirect chain first
  let redirect: Awaited<ReturnType<typeof followRedirectChain>>;
  try {
    redirect = await followRedirectChain(url);
  } catch (err) {
    logger.warn('Single page crawl — redirect chain failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const { finalUrl, finalStatus, chain, responseTimeMs, pageSizeBytes } = redirect;

  if (finalStatus >= 400 || finalStatus === 0) {
    logger.warn('Single page crawl — page returned error status', { url, finalStatus });
    return null;
  }

  // 2. Fetch HTML
  let html = '';
  try {
    const res = await fetch(finalUrl, {
      headers: { 'User-Agent': CRAWLER_UA },
      signal:  AbortSignal.timeout(15_000),
    });
    html = await res.text();
  } catch (err) {
    logger.warn('Single page crawl — fetch failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // 3. Parse with Cheerio
  const { load } = await import('cheerio');
  const $ = load(html);
  const { rawBodyText, ...extracted } = extractFromCheerio($, finalUrl, domain);

  const depth = getUrlDepth(finalUrl);
  const hasRedirectChain = chain.length > 0;

  if (isJsRendered(rawBodyText, $)) {
    logger.debug('Single page crawl — JS-rendered, returning Cheerio partial', { url });
  }

  return {
    ...extracted,
    finalUrl,
    statusCode:      finalStatus,
    renderedBy:      'cheerio',
    redirectChain:   chain,
    hasRedirectChain,
    responseTimeMs,
    pageSizeBytes,
    depth,
    inlinkCount:          0,
    fromSitemap:          false,
    brokenLinks:          [],
    internalLinksChecked: 0,
  };
}
