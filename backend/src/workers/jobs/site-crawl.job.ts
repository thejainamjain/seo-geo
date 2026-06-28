/**
 * WHAT: Crawls all pages of a project's domain with a three-pass strategy.
 *
 *   Pass 0 — Sitemap discovery
 *     Parses sitemap.xml / sitemap_index.xml BEFORE link-following.
 *     Seeds the request queue with all sitemap URLs (100% coverage of
 *     pages the site wants indexed). Link-following catches everything else.
 *
 *   Pass 1 — CheerioCrawler (fast, handles static/SSR)
 *       - Follows redirect chains and records hops
 *       - Tracks response time per page
 *       - Extracts full structured data (not just boolean)
 *       - Checks broken links (HEAD requests, internal only)
 *       - Records word count and page size
 *       - Validates canonical (self vs non-self)
 *       - Scores URL crawl priority (sitemap + depth + inlinks)
 *
 *   Pass 2 — PlaywrightCrawler (JS-heavy pages only)
 *       - Uses page.content() + Cheerio (NOT page.evaluate — see crawler.ts)
 *       - Also enqueues internal links found on JS pages for full discovery
 *
 * TYPES DETECTED:
 *   'broken_link'        — Internal link returning 4xx/5xx
 *   'redirect_chain'     — Page has >1 redirect hop before reaching content
 *   'thin_content'       — Page has <300 words of text
 *   'page_speed'         — Page took >3 seconds to respond
 *   'non_self_canonical' — Canonical tag points to a different URL
 *   'missing_h1'         — Page has no <h1> tag
 *   'schema_invalid'     — Schema markup present but missing required fields
 *
 * REDIS CONTRACT (unchanged — downstream jobs unaffected):
 *   crawl:{projectId}:page:{base64url} → { url, title, textContent }  TTL 24hr
 *   crawl:{projectId}:urls             → JSON string[]                 TTL 24hr
 *
 * PIPELINE POSITION: Step 1 of 9 (unchanged)
 * READS:  Project.domain
 * WRITES: Audit, CodeChange, FAQ, TLDR
 */

import { CheerioCrawler, PlaywrightCrawler, RequestQueue } from 'crawlee';
import type { Job } from 'bullmq';
import { logger }     from '@/open-tele';
import { getRedis }   from '@/loaders/redis';
import { Audit }      from '@/models/Audit';
import { CodeChange } from '@/models/CodeChange';
import { FAQ }        from '@/models/FAQ';
import { TLDR }       from '@/models/TLDR';
import { Project }    from '@/models/Project';
import {
  fetchRobotsTxt,
  discoverSitemapUrls,
  checkBrokenLinks,
  extractFromCheerio,
  extractFromPlaywright,
  scoreCrawlPriority,
  normalizeUrl,
  isSameDomain,
  isAssetUrl,
  isAuthGated,
  isBotBlocked,
  isJsRendered,
  getUrlDepth,
  CRAWLER_UA,
  REQUEST_DELAY_MS,
  SLOW_PAGE_MS,
  THIN_CONTENT_WORDS,
  MAX_PAGE_SIZE_BYTES,
} from '../../lib/crawler';
import type { PageData, RobotsChecker } from '../../lib/crawler';
import type { PipelineJobData } from '../seo-pipeline.worker';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_CRAWL_PAGES         = parseInt(process.env.MAX_CRAWL_PAGES ?? '50', 10);
const REDIS_TTL_SECS          = 60 * 60 * 24;  // 24 hours
const CHEERIO_TIMEOUT_SECS    = 30;
const PLAYWRIGHT_TIMEOUT_SECS = 60;
const CHECK_BROKEN_LINKS      = process.env.CHECK_BROKEN_LINKS !== 'false';

// ── Redis key helpers ──────────────────────────────────────────────────────

/**
 * FIX: Keys now use normalised URL (www stripped, trailing slash removed).
 * Old code used raw URL — www.domain.com and domain.com got different keys,
 * causing duplicate content stored and duplicate entries in crawledUrls list.
 */
function redisPageKey(projectId: string, url: string, domain: string): string {
  return `crawl:${projectId}:page:${Buffer.from(normalizeUrl(url, domain)).toString('base64')}`;
}

function redisUrlsKey(projectId: string): string {
  return `crawl:${projectId}:urls`;
}

function redisMetaKey(projectId: string, url: string, domain: string): string {
  return `crawl:${projectId}:meta:${Buffer.from(normalizeUrl(url, domain)).toString('base64')}`;
}

// ── CodeChange detection ───────────────────────────────────────────────────

function detectCodeChanges(
  page:      PageData,
  projectId: string,
  auditId:   string,
): Array<Record<string, unknown>> {
  const changes: Array<Record<string, unknown>> = [];

  if (!page.title || page.title.length < 10) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'title',
      status:  'pending',
      oldHtml: `<title>${page.title ?? ''}</title>`,
      newHtml: '',
    });
  }

  if (!page.description || page.description.length < 50) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'description',
      status:  'pending',
      oldHtml: `<meta name="description" content="${page.description ?? ''}">`,
      newHtml: '',
    });
  }

  if (!page.ogTitle || !page.ogDescription) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'open_graph',
      status:  'pending',
      oldHtml: '',
      newHtml: '',
    });
  }

  if (!page.canonical) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'canonical',
      status:  'pending',
      oldHtml: '',
      newHtml: `<link rel="canonical" href="${page.finalUrl}">`,
    });
  }

  for (const img of page.images.filter(i => !i.alt)) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'alt_text',
      status:  'pending',
      oldHtml: `<img src="${img.src}">`,
      newHtml: '',
    });
  }

  for (const link of page.links.filter(l => l.isExternal)) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'link_title',
      status:  'pending',
      oldHtml: `<a href="${link.href}">${link.text}</a>`,
      newHtml: `<a href="${link.href}" target="_blank" rel="noopener noreferrer">${link.text}</a>`,
    });
  }

  if (!page.hasSchema) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'schema',
      status:  'pending',
      oldHtml: '',
      newHtml: '',
    });
  }

  // Broken internal links
  for (const broken of page.brokenLinks) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'broken_link',
      status:  'pending',
      oldHtml: `<a href="${broken.href}">...</a>`,
      newHtml: '', // LLM suggests replacement or removal
      htmlAttributes: { brokenHref: broken.href, statusCode: String(broken.statusCode) },
    });
  }

  // Redirect chain (>1 hop to reach this page)
  if (page.hasRedirectChain && page.redirectChain.length > 1) {
    const chainSummary = page.redirectChain
      .map(h => `${h.statusCode} → ${h.url}`)
      .join(' → ');
    changes.push({
      projectId, auditId, url: page.url,
      type:    'redirect_chain',
      status:  'pending',
      oldHtml: `<!-- Redirect chain: ${chainSummary} → ${page.finalUrl} -->`,
      newHtml: `<!-- Fix: update all links to point directly to ${page.finalUrl} -->`,
      htmlAttributes: { hops: String(page.redirectChain.length), finalUrl: page.finalUrl },
    });
  }

  // Thin content
  if (page.wordCount < THIN_CONTENT_WORDS && page.wordCount > 0) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'thin_content',
      status:  'pending',
      oldHtml: `<!-- Page has only ${page.wordCount} words (minimum: ${THIN_CONTENT_WORDS}) -->`,
      newHtml: '',
      htmlAttributes: { wordCount: String(page.wordCount) },
    });
  }

  // Slow page
  if (page.responseTimeMs > SLOW_PAGE_MS) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'page_speed',
      status:  'pending',
      oldHtml: `<!-- Page loaded in ${page.responseTimeMs}ms (target: <${SLOW_PAGE_MS}ms) -->`,
      newHtml: '', // LLM suggests optimizations
      htmlAttributes: { responseTimeMs: String(page.responseTimeMs) },
    });
  }

  // Non-self canonical (pointing to a different URL)
  if (page.canonical && !page.isCanonicalSelf) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'non_self_canonical',
      status:  'pending',
      oldHtml: `<link rel="canonical" href="${page.canonical}">`,
      newHtml: `<link rel="canonical" href="${page.finalUrl}">`,
      htmlAttributes: { currentCanonical: page.canonical, suggestedCanonical: page.finalUrl },
    });
  }

  // Missing H1
  if (!page.h1) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'missing_h1',
      status:  'pending',
      oldHtml: `<!-- No <h1> tag found on this page -->`,
      newHtml: '',
    });
  }

  // Schema present but invalid (missing required fields by type)
  for (const schema of page.structuredData) {
    const raw = schema.raw as Record<string, unknown>;
    let missingFields: string[] = [];

    switch (schema.type) {
      case 'Organization':
        missingFields = ['name', 'url', '@id'].filter(f => !raw[f]);
        break;
      case 'Product':
        missingFields = ['name', 'description', 'offers'].filter(f => !raw[f]);
        break;
      case 'FAQPage':
        if (!Array.isArray(raw['mainEntity']) || (raw['mainEntity'] as unknown[]).length === 0) {
          missingFields = ['mainEntity'];
        }
        break;
      case 'Article':
      case 'BlogPosting':
        missingFields = ['headline', 'author', 'datePublished'].filter(f => !raw[f]);
        break;
      case 'LocalBusiness':
        missingFields = ['name', 'address', 'telephone'].filter(f => !raw[f]);
        break;
    }

    if (missingFields.length > 0) {
      changes.push({
        projectId, auditId, url: page.url,
        type:    'schema_invalid',
        status:  'pending',
        oldHtml: `<script type="application/ld+json">${JSON.stringify(raw)}</script>`,
        newHtml: '',
        htmlAttributes: {
          schemaType:    schema.type,
          missingFields: missingFields.join(', '),
        },
      });
    }
  }

  // Oversized page
  if (page.pageSizeBytes > MAX_PAGE_SIZE_BYTES) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'page_size',
      status:  'pending',
      oldHtml: `<!-- Page is ${Math.round(page.pageSizeBytes / 1024)}KB (target: <1000KB) -->`,
      newHtml: '',
      htmlAttributes: { pageSizeKb: String(Math.round(page.pageSizeBytes / 1024)) },
    });
  }

  return changes;
}

// ── Pass 1: CheerioCrawler ─────────────────────────────────────────────────

async function runCheerioCrawler(
  baseUrl:     string,
  domain:      string,
  robots:      RobotsChecker,
  sitemapUrls: Set<string>,
  projectId:   string,
  auditId:     string,
): Promise<{
  crawledPages:   PageData[];
  jsRenderedUrls: string[];
  skippedUrls:    Array<{ url: string; reason: string }>;
  inlinkCounts:   Map<string, number>;
}> {
  const crawledPages:   PageData[]                             = [];
  const jsRenderedUrls: string[]                               = [];
  const skippedUrls:    Array<{ url: string; reason: string }> = [];
  const inlinkCounts:   Map<string, number>                    = new Map();

  // Track normalised URLs we've already crawled to skip duplicates
  const crawledNormalized = new Set<string>();

  const requestQueue = await RequestQueue.open(`cheerio-${projectId}-${auditId}`);

  // Seed with sitemap URLs (already normalised in discoverSitemapUrls)
  const sitemapArr = [...sitemapUrls];
  if (sitemapArr.length > 0) {
    // Sort by depth (shallower = higher priority)
    const sorted = sitemapArr
      .filter(u => !isAssetUrl(u) && robots.isAllowed(u))
      .sort((a, b) => getUrlDepth(a) - getUrlDepth(b))
      .slice(0, MAX_CRAWL_PAGES);

    for (const url of sorted) {
      await requestQueue.addRequest({ url, userData: { fromSitemap: true } });
    }
    logger.info('Seeded queue with sitemap URLs', { projectId, count: sorted.length });
  }

  // Always add homepage as fallback seed
  await requestQueue.addRequest({
    url:      baseUrl,
    userData: { fromSitemap: sitemapUrls.has(baseUrl) || sitemapUrls.has(`${baseUrl}/`) },
  });

  const crawler = new CheerioCrawler({
    requestQueue,
    maxRequestsPerCrawl:       MAX_CRAWL_PAGES,
    requestHandlerTimeoutSecs: CHEERIO_TIMEOUT_SECS,
    minConcurrency: 1,
    maxConcurrency: 3,

    requestHandler: async ({ $, request, enqueueLinks, response }) => {
      const url         = request.url;
      const normUrl     = normalizeUrl(url, domain);
      const statusCode  = response?.statusCode ?? 0;
      const fromSitemap = (request.userData?.['fromSitemap'] as boolean) ?? false;

      // FIX: Skip if we already crawled the normalised version of this URL
      // (handles www vs non-www duplicates)
      if (crawledNormalized.has(normUrl)) {
        logger.debug('Skipping duplicate URL (normalised)', { url, normUrl });
        return;
      }

      if (isBotBlocked(statusCode)) {
        skippedUrls.push({ url, reason: `Bot blocked — HTTP ${statusCode}` });
        return;
      }

      // Auth-gated check
      const rawText = $('body').text();

      if (isAuthGated(url, rawText)) {
        skippedUrls.push({ url, reason: 'Auth-gated page — login required' });
        return;
      }

      // robots.txt check
      if (!robots.isAllowed(url)) {
        skippedUrls.push({ url, reason: 'Disallowed by robots.txt' });
        return;
      }

      const extracted = extractFromCheerio($, normUrl, domain);
      const { rawBodyText, ...pageFields } = extracted;

      // FIX: Always enqueue links BEFORE the isJsRendered early return.
      // Old code returned early and never called enqueueLinks, so pages
      // only reachable via links from JS-rendered pages were never discovered.
      await enqueueLinks({
        strategy: 'all',  // FIX: 'same-domain' in Crawlee treats www as different domain
        transformRequestFunction: (req) => {
          // Manually filter to same domain (handles www normalisation)
          if (!isSameDomain(req.url, domain)) return false;
          if (isAssetUrl(req.url)) return false;
          if (!robots.isAllowed(req.url)) return false;
          const score = scoreCrawlPriority(req.url, baseUrl, sitemapUrls, inlinkCounts);
          if (crawledPages.length > MAX_CRAWL_PAGES * 0.8 && score < 10) return false;
          req.userData = { fromSitemap: sitemapUrls.has(normalizeUrl(req.url, domain)) };
          return req;
        },
      });

      if (isJsRendered(rawBodyText, $)) {
        jsRenderedUrls.push(normUrl);
        return;
      }

      // Mark as crawled AFTER the JS-render check
      crawledNormalized.add(normUrl);

      // Track inlinks
      for (const link of pageFields.links) {
        if (!link.isExternal) {
          const normLink = normalizeUrl(link.href, domain);
          inlinkCounts.set(normLink, (inlinkCounts.get(normLink) ?? 0) + 1);
        }
      }

      // Broken link check (async, runs after extraction)
      let brokenLinks: PageData['brokenLinks'] = [];
      if (CHECK_BROKEN_LINKS) {
        brokenLinks = await checkBrokenLinks(pageFields.links, baseUrl);
        if (brokenLinks.length > 0) {
          logger.debug('Broken links found', { projectId, url: normUrl, count: brokenLinks.length });
        }
      }

      let responseTimeMs = 0;
      let pageSizeBytes  = 0;
      let redirectChain: PageData['redirectChain'] = [];
      let hasRedirectChain = false;
      let finalUrl = normUrl;

      try {
        const start = Date.now();
        const headRes = await fetch(url, {
          method:   'HEAD',
          redirect: 'follow',
          headers:  { 'User-Agent': CRAWLER_UA },
          signal:   AbortSignal.timeout(10_000),
        });
        responseTimeMs = Date.now() - start;
        finalUrl       = normalizeUrl(headRes.url, domain);
        pageSizeBytes  = parseInt(headRes.headers.get('content-length') ?? '0', 10);

        if (finalUrl !== normUrl) {
          hasRedirectChain = true;
          redirectChain    = [{ url: normUrl, statusCode: 301 }];
        }
      } catch {
        // HEAD failed — non-critical
      }

      crawledPages.push({
        ...pageFields,
        url:             normUrl,
        finalUrl,
        statusCode,
        renderedBy:      'cheerio',
        redirectChain,
        hasRedirectChain,
        responseTimeMs,
        pageSizeBytes,
        depth:           getUrlDepth(normUrl),
        inlinkCount:     0,
        fromSitemap,
        brokenLinks,
      });

      logger.debug('Page crawled via Cheerio', { projectId, url: normUrl, responseTimeMs });

      await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
    },

    failedRequestHandler: async ({ request, error }) => {
      skippedUrls.push({
        url:    request.url,
        reason: `Crawl failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    },
  });

  await crawler.run();

  // Back-fill inlink counts
  for (const page of crawledPages) {
    page.inlinkCount = inlinkCounts.get(page.url) ?? 0;
  }

  return { crawledPages, jsRenderedUrls, skippedUrls, inlinkCounts };
}

// ── Pass 2: PlaywrightCrawler ──────────────────────────────────────────────

async function runPlaywrightCrawler(
  jsRenderedUrls: string[],
  domain:         string,
  robots:         RobotsChecker,
  sitemapUrls:    Set<string>,
  inlinkCounts:   Map<string, number>,
  projectId:      string,
  auditId:        string,
): Promise<{
  crawledPages: PageData[];
  skippedUrls:  Array<{ url: string; reason: string }>;
}> {
  if (jsRenderedUrls.length === 0) {
    return { crawledPages: [], skippedUrls: [] };
  }

  logger.info('Starting Playwright pass', { projectId, count: jsRenderedUrls.length });

  const crawledPages: PageData[]                             = [];
  const skippedUrls:  Array<{ url: string; reason: string }> = [];
  const crawledNormalized = new Set<string>();

  const requestQueue = await RequestQueue.open(`playwright-${projectId}-${auditId}`);
  for (const url of jsRenderedUrls) {
    await requestQueue.addRequest({ url, userData: { fromSitemap: sitemapUrls.has(url) } });
  }

  const crawler = new PlaywrightCrawler({
    requestQueue,
    requestHandlerTimeoutSecs: PLAYWRIGHT_TIMEOUT_SECS,
    minConcurrency: 1,
    maxConcurrency: 2,
    launchContext: {
      launchOptions: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    },

    requestHandler: async ({ page, request, response, enqueueLinks }) => {
      const url        = request.url;
      const normUrl    = normalizeUrl(url, domain);
      const statusCode = response?.status() ?? 0;
      const fromSitemap = (request.userData?.['fromSitemap'] as boolean) ?? false;

      if (crawledNormalized.has(normUrl)) {
        logger.debug('Playwright: skipping duplicate URL', { url, normUrl });
        return;
      }

      if (isBotBlocked(statusCode)) {
        skippedUrls.push({ url, reason: `Bot blocked — HTTP ${statusCode} (Playwright)` });
        return;
      }
      if (!robots.isAllowed(url)) {
        skippedUrls.push({ url, reason: 'Disallowed by robots.txt' });
        return;
      }

      try {
        const startTime = Date.now();

        // FIX: extractFromPlaywright now uses page.content() + Cheerio internally.
        // No more page.evaluate() — no more __name ReferenceError.
        const { rawBodyText, ...extracted } = await extractFromPlaywright(page, normUrl, domain);
        const responseTimeMs = Date.now() - startTime;

        // FIX: Enqueue internal links found on JS-rendered pages so we discover
        // pages that are only reachable via JS-rendered pages.
        await enqueueLinks({
          strategy: 'all',
          transformRequestFunction: (req) => {
            if (!isSameDomain(req.url, domain)) return false;
            if (isAssetUrl(req.url)) return false;
            if (!robots.isAllowed(req.url)) return false;
            req.userData = { fromSitemap: sitemapUrls.has(normalizeUrl(req.url, domain)) };
            return req;
          },
        });

        if (isJsRendered(rawBodyText)) {
          skippedUrls.push({ url: normUrl, reason: 'Empty after Playwright — likely bot-protected' });
          return;
        }

        crawledNormalized.add(normUrl);

        const finalUrl = normalizeUrl(page.url(), domain);
        const hasRedirectChain = finalUrl !== normUrl;

        crawledPages.push({
          ...extracted,
          url:             normUrl,
          finalUrl,
          statusCode,
          renderedBy:      'playwright',
          redirectChain:   hasRedirectChain ? [{ url: normUrl, statusCode: 301 }] : [],
          hasRedirectChain,
          responseTimeMs,
          pageSizeBytes:   0,
          depth:           getUrlDepth(normUrl),
          inlinkCount:     inlinkCounts.get(normUrl) ?? 0,
          fromSitemap,
          brokenLinks:     [],
        });

        logger.debug('Page crawled via Playwright', { projectId, url: normUrl, responseTimeMs });

        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));

      } catch (err) {
        skippedUrls.push({
          url:    normUrl,
          reason: `Playwright extraction failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },

    failedRequestHandler: async ({ request, error }) => {
      skippedUrls.push({
        url:    request.url,
        reason: `Playwright crawl failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    },
  });

  await crawler.run();
  return { crawledPages, skippedUrls };
}

// ── Main job handler ───────────────────────────────────────────────────────

export async function runSiteCrawlJob(job: Job<PipelineJobData>): Promise<void> {
  const { projectId } = job.data;
  const redis          = getRedis();

  logger.info('Site crawl job started (v2)', { projectId });

  // 1. Load project
  const project = await Project.findById(projectId).lean();
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const domain  = project.domain;
  const baseUrl = `https://${domain}`;

  // 2. Create Audit record
  const audit   = await Audit.create({
    projectId,
    status:      'running',
    performedAt: new Date(),
  });
  const auditId = (audit._id as { toString(): string }).toString();

  logger.info('Audit created', { projectId, auditId, domain });

  try {
    // 3. Fetch robots.txt
    const robots = await fetchRobotsTxt(baseUrl);

    // Pass 0 — Sitemap discovery (URLs are normalised inside discoverSitemapUrls)
    const sitemapUrlList = await discoverSitemapUrls(baseUrl, domain);
    const sitemapUrls    = new Set(sitemapUrlList);

    logger.info('Sitemap discovery complete', { projectId, sitemapUrlCount: sitemapUrls.size });

    // Pass 1 — Cheerio
    const cheerioResult = await runCheerioCrawler(
      baseUrl, domain, robots, sitemapUrls, projectId, auditId,
    );

    logger.info('Cheerio pass complete', {
      projectId,
      crawled:    cheerioResult.crawledPages.length,
      jsRendered: cheerioResult.jsRenderedUrls.length,
      skipped:    cheerioResult.skippedUrls.length,
    });

    // Pass 2 — Playwright (JS-rendered only)
    const playwrightResult = await runPlaywrightCrawler(
      cheerioResult.jsRenderedUrls,
      domain,
      robots,
      sitemapUrls,
      cheerioResult.inlinkCounts,
      projectId,
      auditId,
    );

    logger.info('Playwright pass complete', {
      projectId,
      crawled: playwrightResult.crawledPages.length,
      skipped: playwrightResult.skippedUrls.length,
    });

    // Merge and deduplicate by normalised URL
    // FIX: Cheerio result takes priority over Playwright for same URL.
    // If both crawled the same page, keep Cheerio version (more reliable).
    const pagesByNormUrl = new Map<string, PageData>();

    for (const page of cheerioResult.crawledPages) {
      pagesByNormUrl.set(normalizeUrl(page.url, domain), page);
    }
    for (const page of playwrightResult.crawledPages) {
      const key = normalizeUrl(page.url, domain);
      if (!pagesByNormUrl.has(key)) {
        pagesByNormUrl.set(key, page);
      }
    }

    const allPages = [...pagesByNormUrl.values()];
    const allSkipped: Array<{ url: string; reason: string }> = [
      ...cheerioResult.skippedUrls,
      ...playwrightResult.skippedUrls,
    ];

    if (allPages.length === 0) {
      throw new Error(
        `No pages crawled for ${domain}. ` +
        `Skipped: ${allSkipped.map(s => `${s.url} (${s.reason})`).join(', ')}`,
      );
    }

    // Store in Redis — keys use normalised URL, no duplicates
    const redisPipeline = redis.pipeline();
    for (const page of allPages) {
      redisPipeline.setex(
        redisPageKey(projectId, page.url, domain),
        REDIS_TTL_SECS,
        JSON.stringify({ url: page.url, title: page.title, textContent: page.textContent }),
      );
      redisPipeline.setex(
        redisMetaKey(projectId, page.url, domain),
        REDIS_TTL_SECS,
        JSON.stringify({
          url:              page.url,
          finalUrl:         page.finalUrl,
          statusCode:       page.statusCode,
          responseTimeMs:   page.responseTimeMs,
          pageSizeBytes:    page.pageSizeBytes,
          wordCount:        page.wordCount,
          depth:            page.depth,
          inlinkCount:      page.inlinkCount,
          fromSitemap:      page.fromSitemap,
          hasRedirectChain: page.hasRedirectChain,
          redirectChain:    page.redirectChain,
          isCanonicalSelf:  page.isCanonicalSelf,
          hasSchema:        page.hasSchema,
          structuredData:   page.structuredData.map(s => ({ type: s.type })),
          brokenLinkCount:  page.brokenLinks.length,
          renderedBy:       page.renderedBy,
        }),
      );
    }

    const crawledUrls = allPages.map(p => p.url);
    redisPipeline.setex(
      redisUrlsKey(projectId),
      REDIS_TTL_SECS,
      JSON.stringify(crawledUrls),
    );
    await redisPipeline.exec();

    logger.info('Pages stored in Redis', { projectId, count: allPages.length });

    // CodeChange detection
    const allCodeChanges = allPages.flatMap(page =>
      detectCodeChanges(page, projectId, auditId),
    );

    if (allCodeChanges.length > 0) {
      await CodeChange.insertMany(allCodeChanges, { ordered: false });
      logger.info('CodeChange records created', {
        projectId,
        auditId,
        count: allCodeChanges.length,
        byType: allCodeChanges.reduce<Record<string, number>>((acc, c) => {
          const type = c['type'] as string;
          acc[type] = (acc[type] ?? 0) + 1;
          return acc;
        }, {}),
      });
    }

    // FAQ stubs
    const faqDocs = allPages.map(page => ({
      projectId,
      sourceUrl: page.url,
      status:    'pending',
    }));
    if (faqDocs.length > 0) {
      await FAQ.insertMany(faqDocs, { ordered: false });
    }

    // TLDR stubs
    const tldrDocs = allPages.map(page => ({
      projectId,
      sourceUrl: page.url,
      status:    'pending',
    }));
    if (tldrDocs.length > 0) {
      await TLDR.insertMany(tldrDocs, { ordered: false });
    }

    // Final audit summary
    const brokenLinkCount = allPages.reduce((sum, p) => sum + p.brokenLinks.length, 0);
    const slowPageCount   = allPages.filter(p => p.responseTimeMs > SLOW_PAGE_MS).length;
    const thinPageCount   = allPages.filter(p => p.wordCount < THIN_CONTENT_WORDS && p.wordCount > 0).length;

    await Audit.findByIdAndUpdate(auditId, {
      status:      'completed',
      completedAt: new Date(),
      crawledUrls,
      summary: {
        totalPages:         allPages.length,
        totalFixes:         allCodeChanges.length,
        totalSchemas:       allPages.filter(p => p.hasSchema).length,
        totalInternalLinks: 0,
        totalFaqs:          faqDocs.length,
      },
    });

    if (allSkipped.length > 0) {
      logger.warn('Some URLs skipped during crawl', { projectId, skipped: allSkipped });
    }

    logger.info('Site crawl job completed (v2)', {
      projectId,
      auditId,
      totalCrawled:    allPages.length,
      sitemapUrls:     sitemapUrls.size,
      cheerioPages:    cheerioResult.crawledPages.length,
      playwrightPages: playwrightResult.crawledPages.length,
      totalSkipped:    allSkipped.length,
      totalChanges:    allCodeChanges.length,
      brokenLinks:     brokenLinkCount,
      slowPages:       slowPageCount,
      thinPages:       thinPageCount,
      totalFaqs:       faqDocs.length,
    });

  } catch (err) {
    await Audit.findByIdAndUpdate(auditId, {
      status:       'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
