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
import type { Browser, Page, Request as PWRequest, Response as PWResponse } from 'playwright';
import { logger } from '@/open-tele';

// ── Constants ──────────────────────────────────────────────────────────────

// Set CRAWLER_BOT_URL to a page that describes your crawler (what it is, how
// to contact you) and it is advertised in the User-Agent, as crawler etiquette
// expects. Left unset, the UA carries no URL — never a placeholder one.
const BOT_INFO_URL = process.env.CRAWLER_BOT_URL?.trim();
export const CRAWLER_UA          = BOT_INFO_URL ? `SEOGeoBot/1.0 (+${BOT_INFO_URL})` : 'SEOGeoBot/1.0';
export const CRAWLER_PRODUCT_TOKEN = 'SEOGeoBot';   // what robots.txt "User-agent:" lines match against
export const MIN_BODY_LENGTH     = 200;        // Below → JS-rendered, needs Playwright
export const REQUEST_DELAY_MS    = 500;        // Polite crawl delay
export const MAX_REDIRECT_HOPS   = 3;          // More than this = CodeChange 'redirect_chain'
export const SLOW_PAGE_MS        = 3000;       // >3s response = CodeChange 'page_speed'
export const THIN_CONTENT_WORDS  = 300;        // <300 words = CodeChange 'thin_content'
export const MAX_PAGE_SIZE_BYTES = 1_000_000;  // >1MB = CodeChange 'page_size'
export const MIN_INTERNAL_LINKS  = 3;          // <3 internal links on a page = CodeChange 'internal_link' (see detectCodeChanges in site-crawl.job.ts)
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
  links:       Array<{ href: string; text: string; isExternal: boolean; title: string; target: string }>;
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
    const target = $(el).attr('target')?.trim() ?? '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    const isExternal = href.startsWith('http') && !isSameDomain(href, domain);
    links.push({ href, text, isExternal, title, target });
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

// Tuning for crawlSinglePage(). One attempt has ONE overall deadline that
// covers every redirect hop AND reading the body — previously a redirect
// probe (15s) and a second full fetch (15s) could stack up to 30s per domain.
export const SINGLE_PAGE_TIMEOUT_MS   = 10_000;     // whole attempt, all hops + body
export const SINGLE_PAGE_MAX_ATTEMPTS = 2;          // 1 retry, temporary failures only
export const SINGLE_PAGE_MAX_BYTES    = 3_000_000;  // stop reading a body past this
const RETRY_BACKOFF_MS    = 1_000;
const MAX_RETRY_AFTER_MS  = 5_000;                  // Retry-After longer than this → give up

/**
 * Why a single-page crawl failed. The kind decides whether a retry is
 * worthwhile:
 *   temporary (worth ONE retry):  timeout, network, server_error, rate_limited
 *   permanent (never retried):    blocked (401/403/406/451/462…), not_found,
 *                                 non_html, too_many_redirects, robots_disallowed,
 *                                 invalid_target, unknown
 */
export type CrawlFailureKind =
  | 'blocked'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'non_html'
  | 'too_many_redirects'
  | 'robots_disallowed'
  | 'invalid_target'
  | 'unknown';

export interface CrawlFailure {
  kind:        CrawlFailureKind;
  statusCode?: number;
  message:     string;
  attempts:    number;
}

export type SinglePageCrawlResult =
  | { page: PageData; jsRendered: boolean; failure?: undefined }
  | { page: null;     jsRendered: false;   failure: CrawlFailure };

export function isRetryableFailure(kind: CrawlFailureKind): boolean {
  return kind === 'timeout' || kind === 'network' || kind === 'server_error' || kind === 'rate_limited';
}

function classifyHttpStatus(status: number): CrawlFailureKind {
  if (status === 404 || status === 410) return 'not_found';
  if (status === 408)                   return 'timeout';
  if (status === 429)                   return 'rate_limited';
  if (status >= 500)                    return 'server_error';
  // 401/403/406/451 and non-standard 4xx (e.g. 462) — the site is refusing us.
  return 'blocked';
}

/** Human-readable explanation, safe to show in the UI (verificationReasoning). */
export function describeCrawlFailure(f: CrawlFailure): string {
  const code = f.statusCode ? ` (HTTP ${f.statusCode})` : '';
  switch (f.kind) {
    case 'blocked':            return `This site blocks automated access${code}, so it could not be checked automatically.`;
    case 'not_found':          return `This address returned "not found"${code}, so it could not be checked automatically.`;
    case 'rate_limited':       return `This site rate-limited our request${code}, so it could not be checked automatically.`;
    case 'server_error':       return `This site returned a server error${code}, so it could not be checked automatically.`;
    case 'timeout':            return 'This site took too long to respond, so it could not be checked automatically.';
    case 'network':            return 'Could not connect to this domain, so it could not be checked automatically.';
    case 'non_html':           return 'This address did not return a web page, so it could not be checked automatically.';
    case 'too_many_redirects': return 'This address redirected too many times, so it could not be checked automatically.';
    case 'robots_disallowed':  return "This site's robots.txt asks crawlers to stay out, so it was not checked.";
    case 'invalid_target':     return 'This address is not a public website, so it was not checked.';
    default:                   return 'This site could not be checked automatically.';
  }
}

// ── Safety: only crawl public internet hosts ──────────────────────────────

/**
 * Rejects hosts that must never be fetched on a user's behalf (SSRF): localhost,
 * private / link-local / loopback IPv4 ranges (incl. cloud metadata
 * 169.254.169.254), IPv6 literals, and internal-only names. Competitor domains
 * come from user input and SERP results, so this runs on the start URL, on
 * every redirect hop, and on every browser sub-request.
 *
 * NOTE: this checks the hostname text only — it does not resolve DNS, so a
 * public-looking name that resolves to a private address is not caught here.
 */
export function isPublicHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h || !h.includes('.')) return false;              // "localhost", "intranet", IPv6 "::1" …
  if (h.includes(':') || h.startsWith('[')) return false; // IPv6 literal
  if (/\.(localhost|local|internal|localdomain|lan|home\.arpa)$/.test(h)) return false;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254)           return false;   // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31)  return false;
    if (a === 192 && b === 168)           return false;
    if (a === 100 && b >= 64 && b <= 127) return false;   // carrier-grade NAT
    if (a >= 224)                         return false;   // multicast / reserved
  }
  return true;
}

// ── robots.txt for single-page crawls ──────────────────────────────────────

const ROBOTS_TTL_MS      = 60 * 60 * 1000;
const ROBOTS_TIMEOUT_MS  = 5_000;
const ROBOTS_MAX_BYTES   = 500_000;
const ROBOTS_CACHE_LIMIT = 500;

const robotsCache = new Map<string, { isAllowed: (url: string) => boolean; expiresAt: number }>();

/**
 * Honours an explicit "Disallow" for our crawler. Like Google/Bing:
 *   - robots.txt missing (4xx)            → everything allowed
 *   - robots.txt present                  → rules apply
 *   - robots.txt unreachable / 5xx / slow → we still proceed (lenient): if the
 *     site is really down, the page fetch itself will fail and be classified.
 * Cached per origin for an hour so one run never fetches it twice.
 */
async function isAllowedByRobots(url: string): Promise<boolean> {
  let origin: string;
  try { origin = new URL(url).origin; } catch { return true; }

  const cached = robotsCache.get(origin);
  if (cached && cached.expiresAt > Date.now()) return cached.isAllowed(url);

  let isAllowed: (u: string) => boolean = () => true;
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': CRAWLER_UA },
      signal:  AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
    });

    let finalHost = '';
    try { finalHost = new URL(res.url).hostname; } catch { /* keep empty */ }

    if (res.ok && isPublicHostname(finalHost)) {
      const text   = (await res.text()).slice(0, ROBOTS_MAX_BYTES);
      const robots = robotsParser(`${origin}/robots.txt`, text);
      isAllowed = (u: string) => robots.isAllowed(u, CRAWLER_PRODUCT_TOKEN) ?? true;
    } else {
      await res.body?.cancel().catch(() => {});
    }
  } catch (err) {
    logger.debug('robots.txt unavailable — proceeding', {
      origin,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (robotsCache.size >= ROBOTS_CACHE_LIMIT) robotsCache.clear();
  robotsCache.set(origin, { isAllowed, expiresAt: Date.now() + ROBOTS_TTL_MS });
  return isAllowed(url);
}

// ── Headless-browser rendering (JS-only pages) ─────────────────────────────

const RENDER_TIMEOUT_MS    = 15_000;
const RENDER_IDLE_CLOSE_MS = 20_000;

let browserPromise: Promise<Browser> | null = null;
let activeRenders = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function getRenderBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = import('playwright')
      .then(pw => pw.chromium.launch({
        headless: true,
        // same flags the site-crawl job launches Chromium with
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      }))
      .catch(err => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

/** Closes the shared render browser. Also closes itself after ~20s idle. */
export async function closeRenderBrowser(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const pending = browserPromise;
  browserPromise = null;
  if (pending) {
    try { await (await pending).close(); } catch { /* already gone */ }
  }
}

/**
 * Loads a page in headless Chromium and returns its rendered HTML, or null if
 * anything goes wrong (browser missing, timeout, blocked, error status) — the
 * caller then keeps its plain-HTTP result. Images/media/fonts are not loaded,
 * and requests to non-public hosts are aborted.
 */
async function renderWithBrowser(
  url: string,
): Promise<{ html: string; finalUrl: string; status: number } | null> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  activeRenders++;

  try {
    const browser = await getRenderBrowser();
    const context = await browser.newContext({ userAgent: CRAWLER_UA });
    try {
      const page = await context.newPage();
      await page.route('**/*', route => {
        const req = route.request();
        const type = req.resourceType();
        if (type === 'image' || type === 'media' || type === 'font') return route.abort();
        let host = '';
        try { host = new URL(req.url()).hostname; } catch { /* leave empty */ }
        if (!isPublicHostname(host)) return route.abort();
        return route.continue();
      });

      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
      const status = response?.status() ?? 200;
      if (status >= 400) return null;                       // error / challenge page — not useful

      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => { /* chatty sites never idle */ });
      return { html: await page.content(), finalUrl: page.url(), status };
    } finally {
      await context.close().catch(() => {});
    }
  } catch (err) {
    logger.warn('Browser render failed — keeping the plain-HTTP result', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    activeRenders--;
    if (activeRenders === 0) {
      idleTimer = setTimeout(() => { void closeRenderBrowser(); }, RENDER_IDLE_CLOSE_MS);
      idleTimer.unref?.();
    }
  }
}

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

type FetchOutcome =
  | {
      ok:             true;
      finalUrl:       string;
      status:         number;
      chain:          RedirectHop[];
      html:           string;
      responseTimeMs: number;
      pageSizeBytes:  number;
    }
  | {
      ok:            false;
      kind:          CrawlFailureKind;
      statusCode?:   number;
      message:       string;
      retryAfterMs?: number;
    };

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Reads at most maxBytes of a response body (decoded as UTF-8). */
async function readBodyCapped(
  res:      FetchResponse,
  maxBytes: number,
): Promise<{ text: string; bytes: number }> {
  if (!res.body) {
    const text = await res.text();
    return { text, bytes: Buffer.byteLength(text, 'utf-8') };
  }

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(Buffer.from(value));
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }

  return { text: Buffer.concat(chunks).toString('utf-8'), bytes: total };
}

function classifyThrown(err: unknown): FetchOutcome {
  const name    = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { ok: false, kind: 'timeout', message: 'Request timed out' };
  }
  return { ok: false, kind: 'network', message };
}

/**
 * ONE attempt at fetching a page: follows redirects manually (so every hop and
 * its real status code is recorded) and reads the final body in the SAME
 * request chain — no separate "probe" request followed by a second download.
 * One shared `signal` bounds the whole attempt.
 */
async function fetchPageOnce(startUrl: string, signal: AbortSignal): Promise<FetchOutcome> {
  const startedAt = Date.now();
  const chain: RedirectHop[] = [];
  let currentUrl = startUrl;

  try {
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS + 1; hop++) {
      let hopHost = '';
      try { hopHost = new URL(currentUrl).hostname; } catch { /* leave empty */ }
      if (!isPublicHostname(hopHost)) {
        return { ok: false, kind: 'invalid_target', message: 'Blocked: address is not a public website' };
      }

      const res = await fetch(currentUrl, {
        redirect: 'manual',
        headers:  { 'User-Agent': CRAWLER_UA, Accept: 'text/html,application/xhtml+xml' },
        signal,
      });

      // Redirect → record the hop and follow it.
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location) {
          return { ok: false, kind: 'unknown', statusCode: res.status, message: `HTTP ${res.status} redirect without a Location header` };
        }
        chain.push({ url: currentUrl, statusCode: res.status });
        try {
          currentUrl = new URL(location, currentUrl).toString();
        } catch {
          return { ok: false, kind: 'unknown', statusCode: res.status, message: 'Redirect pointed to an invalid URL' };
        }
        continue;
      }

      // Error status → classify; never download an error page's body.
      if (res.status >= 400) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        await res.body?.cancel().catch(() => {});
        return {
          ok:           false,
          kind:         classifyHttpStatus(res.status),
          statusCode:   res.status,
          message:      `HTTP ${res.status}`,
          retryAfterMs,
        };
      }

      // Success → must be an HTML document.
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType && !/html/i.test(contentType)) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, kind: 'non_html', statusCode: res.status, message: `Unexpected content-type: ${contentType}` };
      }

      const { text, bytes } = await readBodyCapped(res, SINGLE_PAGE_MAX_BYTES);
      return {
        ok:             true,
        finalUrl:       currentUrl,
        status:         res.status,
        chain,
        html:           text,
        responseTimeMs: Date.now() - startedAt,
        // Real bytes read, not a Content-Length header (often absent → was 0).
        pageSizeBytes:  bytes,
      };
    }

    return { ok: false, kind: 'too_many_redirects', message: 'Too many redirects' };
  } catch (err) {
    return classifyThrown(err);
  }
}

export interface SinglePageCrawlOptions {
  /** Use a headless browser when the page is JS-rendered. Default true. */
  allowRender?: boolean;
}

/**
 * Crawls a single URL and returns the parsed page — or a classified failure.
 * No link-following, no Redis storage, no CodeChange detection.
 * Used by competitor-discovery.
 *
 * Before any request: the host must be a public internet address, and the
 * site's robots.txt must not disallow our crawler.
 *
 * Strategy: plain HTTP + Cheerio first. If the page is JS-rendered (a blank
 * shell), it is rendered once in headless Chromium and the richer result is
 * used when the browser got more content (renderedBy: 'playwright'). If the
 * browser is unavailable or fails, the thin Cheerio result is returned with
 * jsRendered: true so callers can tell the content is incomplete.
 *
 * Retries: at most ONE retry, and only for temporary failures (timeout,
 * network error, 5xx, 429 with a short Retry-After). Permanent refusals
 * (403, 404, 410, 462, robots.txt, non-HTML, redirect loops) are never retried.
 */
export async function crawlSinglePage(
  url:     string,
  domain:  string,
  options: SinglePageCrawlOptions = {},
): Promise<SinglePageCrawlResult> {
  const refuse = (kind: CrawlFailureKind, message: string): SinglePageCrawlResult => ({
    page: null,
    jsRendered: false,
    failure: { kind, message, attempts: 0 },
  });

  let hostname: string;
  try { hostname = new URL(url).hostname; } catch { return refuse('invalid_target', 'Invalid URL'); }
  if (!isPublicHostname(hostname))   return refuse('invalid_target', 'Address is not a public website');
  if (!(await isAllowedByRobots(url))) return refuse('robots_disallowed', 'robots.txt disallows this crawler');

  let failure: CrawlFailure | undefined;

  for (let attempt = 1; attempt <= SINGLE_PAGE_MAX_ATTEMPTS; attempt++) {
    const outcome = await fetchPageOnce(url, AbortSignal.timeout(SINGLE_PAGE_TIMEOUT_MS));

    if (outcome.ok) {
      const { load } = await import('cheerio');
      const $ = load(outcome.html);
      const { rawBodyText, ...extracted } = extractFromCheerio($, outcome.finalUrl, domain);
      let jsRendered = isJsRendered(rawBodyText, $);

      const meta = (
        finalUrl:   string,
        statusCode: number,
        sizeBytes:  number,
        renderedBy: 'cheerio' | 'playwright',
      ) => ({
        finalUrl,
        statusCode,
        renderedBy,
        redirectChain:        outcome.chain,
        hasRedirectChain:     outcome.chain.length > 0,
        responseTimeMs:       outcome.responseTimeMs,
        pageSizeBytes:        sizeBytes,
        depth:                getUrlDepth(finalUrl),
        inlinkCount:          0,
        fromSitemap:          false,
        brokenLinks:          [] as PageData['brokenLinks'],
        internalLinksChecked: 0,
      });

      let page: PageData = {
        ...extracted,
        ...meta(outcome.finalUrl, outcome.status, outcome.pageSizeBytes, 'cheerio'),
      };

      if (jsRendered && options.allowRender !== false) {
        const rendered = await renderWithBrowser(outcome.finalUrl);
        if (rendered) {
          const $r = load(rendered.html);
          const { rawBodyText: renderedText, ...renderedExtracted } =
            extractFromCheerio($r, rendered.finalUrl, domain);

          // Only switch if the browser actually found more content.
          if (renderedText.length > rawBodyText.length) {
            page = {
              ...renderedExtracted,
              ...meta(rendered.finalUrl, rendered.status, Buffer.byteLength(rendered.html, 'utf-8'), 'playwright'),
            };
            jsRendered = isJsRendered(renderedText, $r);
            logger.debug('Single page crawl — browser render used', { url, stillThin: jsRendered });
          }
        }
      }

      if (jsRendered) {
        logger.debug('Single page crawl — content still thin (JS-rendered)', { url });
      }
      return { page, jsRendered };
    }

    failure = {
      kind:       outcome.kind,
      statusCode: outcome.statusCode,
      message:    outcome.message,
      attempts:   attempt,
    };

    const retryAfterOk = outcome.retryAfterMs === undefined || outcome.retryAfterMs <= MAX_RETRY_AFTER_MS;
    const willRetry =
      isRetryableFailure(outcome.kind) && retryAfterOk && attempt < SINGLE_PAGE_MAX_ATTEMPTS;

    logger.warn('Single page crawl failed', {
      url,
      kind:       outcome.kind,
      statusCode: outcome.statusCode,
      message:    outcome.message,
      attempt,
      willRetry,
    });

    if (!willRetry) break;

    await new Promise(resolve =>
      setTimeout(resolve, Math.max(RETRY_BACKOFF_MS, outcome.retryAfterMs ?? 0)),
    );
  }

  return { page: null, jsRendered: false, failure: failure! };
}
