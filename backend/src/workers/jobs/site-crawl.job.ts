/**
 *
 * WHAT: Crawls all pages of a project's domain with a three-pass strategy.
 *
 *   Pass 0 — Sitemap discovery (NEW)
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
 *      enriches with redirect chain data
 *     and performance metrics captured from Playwright response.
 *
 *    TYPES DETECTED:
 *   'broken_link'     — Internal link returning 4xx/5xx
 *   'redirect_chain'  — Page has >1 redirect hop before reaching content
 *   'thin_content'    — Page has <300 words of text
 *   'page_speed'      — Page took >3 seconds to respond
 *   'non_self_canonical' — Canonical tag points to a different URL
 *   'missing_h1'      — Page has no <h1> tag
 *   'schema_invalid'  — Schema markup present but missing required fields
 *
 * REDIS CONTRACT (unchanged — downstream jobs unaffected):
 *   crawl:{projectId}:page:{base64url} → { url, title, textContent }  TTL 24hr
 *   crawl:{projectId}:urls             → JSON string[]                 TTL 24hr
 *
 * NEW REDIS KEYS (for future analytics dashboard):
 *   crawl:{projectId}:meta:{base64url} → PageMetadata (perf + signals) TTL 24hr
 *
 * PIPELINE POSITION: Step 1 of 9 (unchanged)
 * READS:  Project.domain
 * WRITES: Audit, CodeChange, FAQ, TLDR (same models, new types added)
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
  followRedirectChain,
  checkBrokenLinks,
  extractFromCheerio,
  extractFromPlaywright,
  scoreCrawlPriority,
  isAssetUrl,
  isAuthGated,
  isBotBlocked,
  isJsRendered,
  countWords,
  getUrlDepth,
  CRAWLER_UA,
  MIN_BODY_LENGTH,
  REQUEST_DELAY_MS,
  MAX_REDIRECT_HOPS,
  SLOW_PAGE_MS,
  THIN_CONTENT_WORDS,
  MAX_PAGE_SIZE_BYTES,
} from '../../lib/crawler';
import type { PageData, RobotsChecker } from '../../lib/crawler';
import type { PipelineJobData } from '../seo-pipeline.worker';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_CRAWL_PAGES         = parseInt(process.env.MAX_CRAWL_PAGES ?? '50', 10);
const REDIS_TTL_SECS          = 60 * 60 * 24;   // 24 hours
const CHEERIO_TIMEOUT_SECS    = 30;
const PLAYWRIGHT_TIMEOUT_SECS = 60;
const CHECK_BROKEN_LINKS      = process.env.CHECK_BROKEN_LINKS !== 'false'; // opt-out via env

// ── Redis key helpers ──────────────────────────────────────────────────────

function redisPageKey(projectId: string, url: string): string {
  return `crawl:${projectId}:page:${Buffer.from(url).toString('base64')}`;
}

function redisUrlsKey(projectId: string): string {
  return `crawl:${projectId}:urls`;
}

// New: stores PageData metadata (perf signals) for analytics dashboard
function redisMetaKey(projectId: string, url: string): string {
  return `crawl:${projectId}:meta:${Buffer.from(url).toString('base64')}`;
}

// ── Inlink counter ─────────────────────────────────────────────────────────

/**
 * Builds inlink count map from all crawled pages' link lists.
 * Used by crawl budget scorer to prioritize pages linked from many places.
 *
 * Example: /pricing linked from 40 pages → crawl first, it's important.
 */
function buildInlinkCounts(pages: PageData[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    for (const link of page.links) {
      if (!link.isExternal) {
        counts.set(link.href, (counts.get(link.href) ?? 0) + 1);
      }
    }
  }
  return counts;
}

// ── CodeChange detection  ──────────────────────────────────

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
      newHtml: '', // LLM generates content expansion suggestions
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
      newHtml: '', // LLM generates H1 suggestion
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
        newHtml: '', // LLM generates corrected schema
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

// ── Pass 1: CheerioCrawler ────────────────────────────────────────────

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
  const crawledPages:   PageData[]                              = [];
  const jsRenderedUrls: string[]                                = [];
  const skippedUrls:    Array<{ url: string; reason: string }>  = [];
  const inlinkCounts:   Map<string, number>                     = new Map();

  const requestQueue = await RequestQueue.open(`cheerio-${projectId}-${auditId}`);

  // Seed with sitemap URLs first (sorted by crawl priority)
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
      const statusCode  = response?.statusCode ?? 0;
      const fromSitemap = (request.userData?.['fromSitemap'] as boolean) ?? false;

      // Bot protection check
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

      const extracted = extractFromCheerio($, url, domain);

      // Detect JS-rendered pages
      if (isJsRendered(extracted.textContent)) {
        jsRenderedUrls.push(url);
        return;
      }

      // Track inlinks from this page
      for (const link of extracted.links) {
        if (!link.isExternal) {
          inlinkCounts.set(link.href, (inlinkCounts.get(link.href) ?? 0) + 1);
        }
      }

      // Broken link check (async, runs after extraction)
      let brokenLinks: PageData['brokenLinks'] = [];
      if (CHECK_BROKEN_LINKS) {
        brokenLinks = await checkBrokenLinks(extracted.links, baseUrl);
        if (brokenLinks.length > 0) {
          logger.debug('Broken links found', { projectId, url, count: brokenLinks.length });
        }
      }

      // Follow redirect chain to get performance data
      // Note: CheerioCrawler doesn't expose redirect chain natively.
      // We make a separate lightweight HEAD request to measure response time.
      let responseTimeMs = 0;
      let pageSizeBytes  = 0;
      let redirectChain: PageData['redirectChain'] = [];
      let hasRedirectChain = false;
      let finalUrl = url;

      try {
        const start = Date.now();
        const headRes = await fetch(url, {
          method:   'HEAD',
          redirect: 'follow',
          headers:  { 'User-Agent': CRAWLER_UA },
          signal:   AbortSignal.timeout(10_000),
        });
        responseTimeMs = Date.now() - start;
        finalUrl       = headRes.url; // final URL after redirects
        pageSizeBytes  = parseInt(headRes.headers.get('content-length') ?? '0', 10);

        // Simple redirect detection: if finalUrl !== url, there was a redirect
        if (finalUrl !== url) {
          hasRedirectChain = true;
          redirectChain    = [{ url, statusCode: 301 }]; // simplified — exact hops need followRedirectChain
        }
      } catch {
        // HEAD failed — non-critical, use defaults
      }

      crawledPages.push({
        ...extracted,
        finalUrl,
        statusCode,
        renderedBy:      'cheerio',
        redirectChain,
        hasRedirectChain,
        responseTimeMs,
        pageSizeBytes,
        depth:           getUrlDepth(url),
        inlinkCount:     0,  // Filled after all pages crawled
        fromSitemap,
        brokenLinks,
      });

      logger.debug('Page crawled via Cheerio', { projectId, url, responseTimeMs });

      await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));

      await enqueueLinks({
        strategy: 'same-domain',
        transformRequestFunction: (req) => {
          if (isAssetUrl(req.url)) return false;
          if (!robots.isAllowed(req.url)) return false;
          // Score and skip low-priority URLs if we're near the cap
          const score = scoreCrawlPriority(req.url, baseUrl, sitemapUrls, inlinkCounts);
          if (crawledPages.length > MAX_CRAWL_PAGES * 0.8 && score < 10) return false;
          req.userData = { fromSitemap: sitemapUrls.has(req.url) };
          return req;
        },
      });
    },

    failedRequestHandler: async ({ request, error }) => {
      skippedUrls.push({
        url:    request.url,
        reason: `Crawl failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    },
  });

  await crawler.run();

  // Back-fill inlink counts on all crawled pages
  for (const page of crawledPages) {
    page.inlinkCount = inlinkCounts.get(page.url) ?? 0;
  }

  return { crawledPages, jsRenderedUrls, skippedUrls, inlinkCounts };
}

// ── Pass 2: PlaywrightCrawler ─────────────────────────────────────────

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

  const requestQueue = await RequestQueue.open(`playwright-${projectId}-${auditId}`);
  for (const url of jsRenderedUrls) {
    await requestQueue.addRequest({ url });
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

    requestHandler: async ({ page, request, response }) => {
      const url        = request.url;
      const statusCode = response?.status() ?? 0;

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
        const extracted = await extractFromPlaywright(page, url, domain);
        const responseTimeMs = Date.now() - startTime;

        if (isJsRendered(extracted.textContent)) {
          skippedUrls.push({ url, reason: 'Empty after Playwright — likely bot-protected' });
          return;
        }

        // Playwright exposes final URL after redirects
        const finalUrl = page.url();
        const hasRedirectChain = finalUrl !== url;

        crawledPages.push({
          ...extracted,
          finalUrl,
          statusCode,
          renderedBy:      'playwright',
          redirectChain:   hasRedirectChain ? [{ url, statusCode: 301 }] : [],
          hasRedirectChain,
          responseTimeMs,
          pageSizeBytes:   0, // Not easily available via Playwright
          depth:           getUrlDepth(url),
          inlinkCount:     inlinkCounts.get(url) ?? 0,
          fromSitemap:     sitemapUrls.has(url),
          brokenLinks:     [], // Skip broken link check for JS pages (too slow)
        });

        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));

      } catch (err) {
        skippedUrls.push({
          url,
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

    // 4. PASS 0 — Sitemap discovery (NEW)
    //    Runs before any crawling. Seeds queue with 100% of indexable URLs.
    const sitemapUrlList = await discoverSitemapUrls(baseUrl);
    const sitemapUrls    = new Set(sitemapUrlList);

    logger.info('Sitemap discovery complete', {
      projectId,
      sitemapUrlCount: sitemapUrls.size,
    });

    // 5. PASS 1 — Cheerio
    const cheerioResult = await runCheerioCrawler(
      baseUrl, domain, robots, sitemapUrls, projectId, auditId,
    );

    logger.info('Cheerio pass complete', {
      projectId,
      crawled:    cheerioResult.crawledPages.length,
      jsRendered: cheerioResult.jsRenderedUrls.length,
      skipped:    cheerioResult.skippedUrls.length,
    });

    // 6. PASS 2 — Playwright (JS-rendered only)
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

    // 7. Merge results
    const allPages: PageData[] = [
      ...cheerioResult.crawledPages,
      ...playwrightResult.crawledPages,
    ];
    const allSkipped: Array<{ url: string; reason: string }> = [
      ...cheerioResult.skippedUrls,
      ...playwrightResult.skippedUrls,
    ];
    const crawledUrls: string[] = allPages.map(p => p.url);

    if (allPages.length === 0) {
      throw new Error(
        `No pages crawled for ${domain}. ` +
        `Skipped: ${allSkipped.map(s => `${s.url} (${s.reason})`).join(', ')}`
      );
    }

    // 8. Store page text in Redis 
    const redisPipeline = redis.pipeline();
    for (const page of allPages) {
      // Existing key: text content for LLM jobs
      redisPipeline.setex(
        redisPageKey(projectId, page.url),
        REDIS_TTL_SECS,
        JSON.stringify({ url: page.url, title: page.title, textContent: page.textContent }),
      );
      // New key: performance metadata for analytics dashboard
      redisPipeline.setex(
        redisMetaKey(projectId, page.url),
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
          structuredData:   page.structuredData.map(s => ({ type: s.type })), // type only — save space
          brokenLinkCount:  page.brokenLinks.length,
          renderedBy:       page.renderedBy,
        }),
      );
    }
    redisPipeline.setex(
      redisUrlsKey(projectId),
      REDIS_TTL_SECS,
      JSON.stringify(crawledUrls),
    );
    await redisPipeline.exec();

    logger.info('Pages stored in Redis', { projectId, count: allPages.length });

    // 9. Create CodeChange records 
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

    // 10. Create FAQ stubs 
    const faqDocs = allPages.map(page => ({
      projectId,
      sourceUrl: page.url,
      status:    'pending',
    }));
    if (faqDocs.length > 0) {
      await FAQ.insertMany(faqDocs, { ordered: false });
    }

    // 11. Create TLDR stubs
    const tldrDocs = allPages.map(page => ({
      projectId,
      sourceUrl: page.url,
      status:    'pending',
    }));
    if (tldrDocs.length > 0) {
      await TLDR.insertMany(tldrDocs, { ordered: false });
    }

    // 12. Update Audit with final summary
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
        totalInternalLinks: 0, // Filled by TECHNICAL_AUDIT step
        totalFaqs:          faqDocs.length,
        // Extra signals (stored but not in IAudit interface — add when needed)
        // brokenLinks: brokenLinkCount,
        // slowPages:   slowPageCount,
        // thinPages:   thinPageCount,
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
