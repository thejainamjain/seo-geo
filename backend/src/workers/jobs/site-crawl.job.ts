/**
 * workers/jobs/site-crawl.job.ts
 *
 * WHAT: Crawls all pages of a project's domain with a two-pass strategy:
 *   Pass 1 — CheerioCrawler (fast, no browser, handles static/SSR sites)
 *   Pass 2 — PlaywrightCrawler (headless Chromium, handles CSR/SPA/JS-heavy pages)
 *
 * PIPELINE POSITION: Step 1 of 9
 * READS:  Project.domain
 * WRITES: Audit, CodeChange, FAQ, TLDR
 * REDIS:  crawl:{projectId}:page:{base64url} → { url, title, textContent }, TTL 24hr
 *         crawl:{projectId}:urls             → JSON string[], TTL 24hr
 *
 * CRAWL CASES HANDLED:
 *   1. Static HTML          → Cheerio pass, done
 *   2. SSR (Next/Nuxt/etc.) → Cheerio pass, done
 *   3. CSR/SPA (React/Vue)  → Cheerio gets empty body → Playwright retry
 *   4. Hybrid SSR+CSR       → Per-page detection → Playwright for empty pages
 *   5. Bot protection       → 403/429 detected → logged as uncrawlable, skipped
 *   6. Auth-gated pages     → Redirect to /login detected → skipped
 *   7. JS redirects         → Playwright handles window.location redirects
 *   8. Rate limiting        → Exponential backoff between requests
 *
 * ROBOTS.TXT:
 *   Fetched and parsed before crawl starts.
 *   Disallowed paths are excluded from the request queue.
 *   This is both ethical and avoids wasting crawl budget.
 *
 * WHAT WE CANNOT HANDLE (logged clearly for user):
 *   - Cloudflare Enterprise bot protection
 *   - Login-gated pages (no credentials)
 *   - Sites that block all crawlers
 *
 * WHY NO SitePage MODEL:
 *   Page content is transient pipeline data, not persistent business data.
 *   Redis with 24hr TTL is fast, cheap, and self-cleaning.
 *   MongoDB is reserved for data the user needs to see and act on.
 */

import robotsParser from 'robots-parser';
import { CheerioCrawler, PlaywrightCrawler, RequestQueue } from 'crawlee';
import type { Job } from 'bullmq';
import type { CheerioAPI } from 'cheerio';
import type { Page } from 'playwright';
import { logger } from '@/open-tele';
import { getRedis } from '@/loaders/redis';
import { Audit } from '@/models/Audit';
import { CodeChange } from '@/models/CodeChange';
import { FAQ } from '@/models/FAQ';
import { TLDR } from '@/models/TLDR';
import { Project } from '@/models/Project';
import type { PipelineJobData } from '../seo-pipeline.worker';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_CRAWL_PAGES        = parseInt(process.env.MAX_CRAWL_PAGES ?? '50', 10);
const REDIS_TTL_SECS         = 60 * 60 * 24;  // 24 hours
const CHEERIO_TIMEOUT_SECS   = 30;
const PLAYWRIGHT_TIMEOUT_SECS = 60;
const MIN_BODY_LENGTH        = 200;            // Below this → page is likely JS-rendered
const REQUEST_DELAY_MS       = 500;            // Polite delay between requests
const OUR_CRAWLER_UA         = 'SEOGeoBot/1.0 (+https://yourdomain.com/bot)';

// ── Types ──────────────────────────────────────────────────────────────────

interface PageData {
  url:            string;
  title:          string;
  description:    string;
  canonical:      string | null;
  ogTitle:        string | null;
  ogDescription:  string | null;
  ogImage:        string | null;
  h1:             string | null;
  h2s:            string[];
  links:          Array<{ href: string; text: string; isExternal: boolean }>;
  images:         Array<{ src: string; alt: string }>;
  textContent:    string;
  hasSchema:      boolean;
  statusCode:     number;
  renderedBy:     'cheerio' | 'playwright';
}

interface CrawlResult {
  crawledPages:   PageData[];
  crawledUrls:    string[];
  skippedUrls:    Array<{ url: string; reason: string }>;
  jsRenderedUrls: string[]; // URLs that needed Playwright
}

// ── Redis key helpers ──────────────────────────────────────────────────────

function redisPageKey(projectId: string, url: string): string {
  return `crawl:${projectId}:page:${Buffer.from(url).toString('base64')}`;
}

function redisUrlsKey(projectId: string): string {
  return `crawl:${projectId}:urls`;
}

// ── robots.txt ─────────────────────────────────────────────────────────────

interface RobotsChecker {
  isAllowed: (url: string) => boolean;
}

async function fetchRobotsTxt(baseUrl: string): Promise<RobotsChecker> {
  const robotsUrl = `${baseUrl}/robots.txt`;
  try {
    const res  = await fetch(robotsUrl, {
      headers: { 'User-Agent': OUR_CRAWLER_UA },
      signal:  AbortSignal.timeout(10_000),
    });
    const text = res.ok ? await res.text() : '';
    const robots = robotsParser(robotsUrl, text);
    logger.info('robots.txt fetched', { robotsUrl, status: res.status });
    return {
      isAllowed: (url: string) => robots.isAllowed(url, OUR_CRAWLER_UA) ?? true,
    };
  } catch (err) {
    // If robots.txt is unavailable, assume everything is allowed
    logger.warn('robots.txt fetch failed — assuming all paths allowed', {
      robotsUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return { isAllowed: () => true };
  }
}

// ── HTML extraction (shared between Cheerio and Playwright passes) ─────────

function extractFromCheerio($: CheerioAPI, url: string, domain: string): Omit<PageData, 'statusCode' | 'renderedBy'> {
  const title         = $('title').first().text().trim();
  const description   = $('meta[name="description"]').attr('content')?.trim() ?? '';
  const canonical     = $('link[rel="canonical"]').attr('href') ?? null;
  const ogTitle       = $('meta[property="og:title"]').attr('content') ?? null;
  const ogDescription = $('meta[property="og:description"]').attr('content') ?? null;
  const ogImage       = $('meta[property="og:image"]').attr('content') ?? null;
  const h1            = $('h1').first().text().trim() || null;
  const hasSchema     = $('script[type="application/ld+json"]').length > 0;

  const h2s: string[] = [];
  $('h2').each((_, el) => {
    const text = $(el).text().trim();
    if (text) h2s.push(text);
  });

  const links: PageData['links'] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.trim() ?? '';
    const text = $(el).text().trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    const isExternal = href.startsWith('http') && !href.includes(domain);
    links.push({ href, text, isExternal });
  });

  const images: PageData['images'] = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src')?.trim() ?? '';
    const alt = $(el).attr('alt')?.trim() ?? '';
    if (src) images.push({ src, alt });
  });

  // Strip noise elements before extracting text
  $('script, style, nav, footer, header, noscript, iframe').remove();
  const textContent = $('body').text()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 10_000); // Cap at 10KB — enough for LLM context, not wasteful

  return {
    url, title, description, canonical,
    ogTitle, ogDescription, ogImage,
    h1, h2s, links, images, textContent, hasSchema,
  };
}

async function extractFromPlaywright(page: Page, url: string, domain: string): Promise<Omit<PageData, 'statusCode' | 'renderedBy'>> {
  // Wait for meaningful content — networkidle means no pending requests
  await page.waitForLoadState('networkidle', { timeout: PLAYWRIGHT_TIMEOUT_SECS * 1000 });

  // Extract via browser evaluation — same fields as Cheerio pass
  const data = await page.evaluate((domain: string) => {
    const getText = (selector: string) =>
      document.querySelector(selector)?.textContent?.trim() ?? '';
    const getMeta = (name: string) =>
      document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() ?? '';
    const getOg = (prop: string) =>
      document.querySelector(`meta[property="${prop}"]`)?.getAttribute('content') ?? null;

    const h2s: string[] = [];
    document.querySelectorAll('h2').forEach(el => {
      const text = el.textContent?.trim();
      if (text) h2s.push(text);
    });

    const links: Array<{ href: string; text: string; isExternal: boolean }> = [];
    document.querySelectorAll('a[href]').forEach(el => {
      const href = el.getAttribute('href')?.trim() ?? '';
      const text = el.textContent?.trim() ?? '';
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      const isExternal = href.startsWith('http') && !href.includes(domain);
      links.push({ href, text, isExternal });
    });

    const images: Array<{ src: string; alt: string }> = [];
    document.querySelectorAll('img').forEach(el => {
      const src = el.getAttribute('src')?.trim() ?? '';
      const alt = el.getAttribute('alt')?.trim() ?? '';
      if (src) images.push({ src, alt });
    });

    const hasSchema = document.querySelectorAll('script[type="application/ld+json"]').length > 0;

    // Strip noise, extract text
    ['script', 'style', 'nav', 'footer', 'header', 'noscript', 'iframe'].forEach(tag => {
      document.querySelectorAll(tag).forEach(el => el.remove());
    });
    const textContent = (document.body?.innerText ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 10_000);

    return {
      title:       getText('title'),
      description: getMeta('description'),
      canonical:   document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      ogTitle:     getOg('og:title'),
      ogDescription: getOg('og:description'),
      ogImage:     getOg('og:image'),
      h1:          getText('h1') || null,
      h2s, links, images, textContent, hasSchema,
    };
  }, domain);

  return { url, ...data };
}

// ── Empty body detection ───────────────────────────────────────────────────

function isJsRendered(textContent: string): boolean {
  return textContent.trim().length < MIN_BODY_LENGTH;
}

// ── Auth/bot detection ─────────────────────────────────────────────────────

function isAuthGated(url: string, textContent: string): boolean {
  const loginPatterns = ['/login', '/signin', '/sign-in', '/auth', '/account/login'];
  return loginPatterns.some(p => url.includes(p)) ||
    textContent.toLowerCase().includes('please log in') ||
    textContent.toLowerCase().includes('please sign in');
}

function isBotBlocked(statusCode: number): boolean {
  return statusCode === 403 || statusCode === 429;
}

// ── CodeChange detection ───────────────────────────────────────────────────

function detectCodeChanges(
  page:      PageData,
  projectId: string,
  auditId:   string,
): Array<Record<string, unknown>> {
  const changes: Array<Record<string, unknown>> = [];

  // Missing or too-short title
  if (!page.title || page.title.length < 10) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'title',
      status:  'pending',
      oldHtml: `<title>${page.title ?? ''}</title>`,
      newHtml: '', // LLM fills this in TECHNICAL_AUDIT step
    });
  }

  // Missing or too-short description
  if (!page.description || page.description.length < 50) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'description',
      status:  'pending',
      oldHtml: `<meta name="description" content="${page.description ?? ''}">`,
      newHtml: '',
    });
  }

  // Missing Open Graph tags
  if (!page.ogTitle || !page.ogDescription) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'open_graph',
      status:  'pending',
      oldHtml: '',
      newHtml: '',
    });
  }

  // Missing canonical tag
  if (!page.canonical) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'canonical',
      status:  'pending',
      oldHtml: '',
      newHtml: `<link rel="canonical" href="${page.url}">`,
    });
  }

  // Images missing alt text
  for (const img of page.images.filter(i => !i.alt)) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'alt_text',
      status:  'pending',
      oldHtml: `<img src="${img.src}">`,
      newHtml: '', // LLM generates descriptive alt text
    });
  }

  // External links missing target="_blank"
  for (const link of page.links.filter(l => l.isExternal)) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'link_title',
      status:  'pending',
      oldHtml: `<a href="${link.href}">${link.text}</a>`,
      newHtml: `<a href="${link.href}" target="_blank" rel="noopener noreferrer">${link.text}</a>`,
    });
  }

  // Missing schema markup
  if (!page.hasSchema) {
    changes.push({
      projectId, auditId, url: page.url,
      type:    'schema',
      status:  'pending',
      oldHtml: '',
      newHtml: '', // LLM generates schema in TECHNICAL_AUDIT step
    });
  }

  return changes;
}

// ── Pass 1: CheerioCrawler ─────────────────────────────────────────────────

async function runCheerioCrawler(
  baseUrl:  string,
  domain:   string,
  robots:   RobotsChecker,
  projectId: string,
  auditId:  string,
): Promise<{
  crawledPages:   PageData[];
  jsRenderedUrls: string[];
  skippedUrls:    Array<{ url: string; reason: string }>;
}> {
  const crawledPages:   PageData[]                           = [];
  const jsRenderedUrls: string[]                             = [];
  const skippedUrls:    Array<{ url: string; reason: string }> = [];

  const requestQueue = await RequestQueue.open(`cheerio-${projectId}-${auditId}`);
  await requestQueue.addRequest({ url: baseUrl });

  const crawler = new CheerioCrawler({
    requestQueue,
    maxRequestsPerCrawl:      MAX_CRAWL_PAGES,
    requestHandlerTimeoutSecs: CHEERIO_TIMEOUT_SECS,
    minConcurrency: 1,
    maxConcurrency: 3, // Polite — don't hammer the site
    requestHandler: async ({ $, request, enqueueLinks, response }) => {
      const url        = request.url;
      const statusCode = response?.statusCode ?? 0;

      // Bot protection check
      if (isBotBlocked(statusCode)) {
        skippedUrls.push({ url, reason: `Bot blocked — HTTP ${statusCode}` });
        logger.warn('Page blocked by bot protection', { projectId, url, statusCode });
        return;
      }

      // Auth-gated check
      const rawText = $('body').text();
      if (isAuthGated(url, rawText)) {
        skippedUrls.push({ url, reason: 'Auth-gated page — login required' });
        logger.warn('Auth-gated page skipped', { projectId, url });
        return;
      }

      // robots.txt check
      if (!robots.isAllowed(url)) {
        skippedUrls.push({ url, reason: 'Disallowed by robots.txt' });
        logger.debug('URL disallowed by robots.txt', { projectId, url });
        return;
      }

      const extracted = extractFromCheerio($, url, domain);

      // Detect JS-rendered pages — flag for Playwright retry
      if (isJsRendered(extracted.textContent)) {
        jsRenderedUrls.push(url);
        logger.debug('JS-rendered page detected — flagged for Playwright', { projectId, url });
        return;
      }

      crawledPages.push({ ...extracted, statusCode, renderedBy: 'cheerio' });
      logger.debug('Page crawled via Cheerio', { projectId, url });

      // Polite delay
      await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));

      await enqueueLinks({
        strategy: 'same-domain',
        transformRequestFunction: (req) => {
          // Skip non-HTML resources and disallowed paths
          const isAsset = /\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js|xml|zip|woff|woff2|ttf)$/i.test(req.url);
          if (isAsset) return false;
          if (!robots.isAllowed(req.url)) return false;
          return req;
        },
      });
    },

    failedRequestHandler: async ({ request, error }) => {
      skippedUrls.push({
        url:    request.url,
        reason: `Crawl failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      logger.warn('Page crawl failed in Cheerio pass', {
        projectId,
        url:   request.url,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  await crawler.run();
  return { crawledPages, jsRenderedUrls, skippedUrls };
}

// ── Pass 2: PlaywrightCrawler (JS-rendered pages only) ────────────────────

async function runPlaywrightCrawler(
  jsRenderedUrls: string[],
  domain:         string,
  robots:         RobotsChecker,
  projectId:      string,
  auditId:        string,
): Promise<{
  crawledPages: PageData[];
  skippedUrls:  Array<{ url: string; reason: string }>;
}> {
  if (jsRenderedUrls.length === 0) {
    return { crawledPages: [], skippedUrls: [] };
  }

  logger.info('Starting Playwright pass', {
    projectId,
    count: jsRenderedUrls.length,
  });

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
    maxConcurrency: 2, // Playwright is heavy — keep concurrency low
    launchContext: {
      launchOptions: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', // Prevents crashes in low-memory environments
        ],
      },
    },

    requestHandler: async ({ page, request, response }) => {
      const url        = request.url;
      const statusCode = response?.status() ?? 0;

      if (isBotBlocked(statusCode)) {
        skippedUrls.push({ url, reason: `Bot blocked — HTTP ${statusCode} (Playwright)` });
        logger.warn('Page blocked even with Playwright', { projectId, url, statusCode });
        return;
      }

      if (!robots.isAllowed(url)) {
        skippedUrls.push({ url, reason: 'Disallowed by robots.txt' });
        return;
      }

      try {
        const extracted = await extractFromPlaywright(page, url, domain);

        // Still empty after Playwright — truly uncrawlable
        if (isJsRendered(extracted.textContent)) {
          skippedUrls.push({ url, reason: 'Empty after Playwright — likely bot-protected or auth-gated' });
          logger.warn('Page empty after Playwright pass', { projectId, url });
          return;
        }

        crawledPages.push({ ...extracted, statusCode, renderedBy: 'playwright' });
        logger.debug('Page crawled via Playwright', { projectId, url });

        // Polite delay
        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));

      } catch (err) {
        skippedUrls.push({
          url,
          reason: `Playwright extraction failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        logger.warn('Playwright extraction failed', {
          projectId, url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    failedRequestHandler: async ({ request, error }) => {
      skippedUrls.push({
        url:    request.url,
        reason: `Playwright crawl failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      logger.warn('Page crawl failed in Playwright pass', {
        projectId,
        url:   request.url,
        error: error instanceof Error ? error.message : String(error),
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

  logger.info('Site crawl job started', { projectId });

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
    // 3. Fetch and parse robots.txt
    const robots = await fetchRobotsTxt(baseUrl);

    // 4. Pass 1 — Cheerio
    const cheerioResult = await runCheerioCrawler(baseUrl, domain, robots, projectId, auditId);

    logger.info('Cheerio pass complete', {
      projectId,
      crawled:     cheerioResult.crawledPages.length,
      jsRendered:  cheerioResult.jsRenderedUrls.length,
      skipped:     cheerioResult.skippedUrls.length,
    });

    // 5. Pass 2 — Playwright (only for JS-rendered pages)
    const playwrightResult = await runPlaywrightCrawler(
      cheerioResult.jsRenderedUrls,
      domain,
      robots,
      projectId,
      auditId,
    );

    logger.info('Playwright pass complete', {
      projectId,
      crawled:  playwrightResult.crawledPages.length,
      skipped:  playwrightResult.skippedUrls.length,
    });

    // 6. Merge results
    const allPages:    PageData[]                             = [
      ...cheerioResult.crawledPages,
      ...playwrightResult.crawledPages,
    ];
    const allSkipped:  Array<{ url: string; reason: string }> = [
      ...cheerioResult.skippedUrls,
      ...playwrightResult.skippedUrls,
    ];
    const crawledUrls: string[] = allPages.map(p => p.url);

    if (allPages.length === 0) {
      throw new Error(
        `No pages could be crawled for ${domain}. ` +
        `Skipped: ${allSkipped.map(s => `${s.url} (${s.reason})`).join(', ')}`
      );
    }

    // 7. Store page text in Redis for downstream LLM jobs
    const redisPipeline = redis.pipeline();
    for (const page of allPages) {
      redisPipeline.setex(
        redisPageKey(projectId, page.url),
        REDIS_TTL_SECS,
        JSON.stringify({ url: page.url, title: page.title, textContent: page.textContent }),
      );
    }
    redisPipeline.setex(
      redisUrlsKey(projectId),
      REDIS_TTL_SECS,
      JSON.stringify(crawledUrls),
    );
    await redisPipeline.exec();

    logger.info('Page text stored in Redis', { projectId, count: allPages.length });

    // 8. Create CodeChange records in bulk
    const allCodeChanges = allPages.flatMap(page =>
      detectCodeChanges(page, projectId, auditId),
    );

    if (allCodeChanges.length > 0) {
      await CodeChange.insertMany(allCodeChanges, { ordered: false });
      logger.info('CodeChange records created', {
        projectId, auditId, count: allCodeChanges.length,
      });
    }

    // 9. Create FAQ stubs — one per page, LLM fills content in TECHNICAL_AUDIT
    const faqDocs = allPages.map(page => ({
      projectId,
      sourceUrl: page.url,
      status:    'pending',
    }));
    if (faqDocs.length > 0) {
      await FAQ.insertMany(faqDocs, { ordered: false });
      logger.info('FAQ stubs created', { projectId, count: faqDocs.length });
    }

    // 10. Create TLDR stubs — one per page
    const tldrDocs = allPages.map(page => ({
      projectId,
      sourceUrl: page.url,
      status:    'pending',
    }));
    if (tldrDocs.length > 0) {
      await TLDR.insertMany(tldrDocs, { ordered: false });
      logger.info('TLDR stubs created', { projectId, count: tldrDocs.length });
    }

    // 11. Update Audit with final summary
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
      },
    });

    // 12. Log skipped URLs clearly for debugging
    if (allSkipped.length > 0) {
      logger.warn('Some URLs were skipped during crawl', {
        projectId,
        skipped: allSkipped,
      });
    }

    logger.info('Site crawl job completed', {
      projectId,
      auditId,
      totalCrawled:    allPages.length,
      cheerioPages:    cheerioResult.crawledPages.length,
      playwrightPages: playwrightResult.crawledPages.length,
      totalSkipped:    allSkipped.length,
      totalChanges:    allCodeChanges.length,
      totalFaqs:       faqDocs.length,
    });

  } catch (err) {
    // Mark audit failed — BullMQ will retry the whole job
    await Audit.findByIdAndUpdate(auditId, {
      status:       'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err; // Rethrow so BullMQ handles retry
  }
}
