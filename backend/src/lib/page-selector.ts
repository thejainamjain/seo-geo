/**
 * lib/page-selector.ts
 *
 * WHAT: Classifies and selects crawled pages by tier for different consumers.
 *
 * WHY: Different pipeline steps need different subsets of crawled pages:
 *   - business-profile.job.ts → needs homepage + about + services (tier 1-3)
 *     to understand what the business does. Blog posts add noise.
 *   - technical-audit.job.ts  → needs ALL pages to check SEO factors on each.
 *
 * TIER SYSTEM (mirrors industry standard — Screaming Frog, Ahrefs use same):
 *   Tier 1: Homepage
 *   Tier 2: Core business pages (about, services, products, pricing)
 *   Tier 3: Trust/contact pages (contact, faq, team, location)
 *   Tier 4: Content pages (blog posts, articles, resources, news)
 *   Tier 5: Legal/utility pages (privacy, terms, sitemap, cart, login)
 *
 * PAGE ORDER FOR UI:
 *   Audit.crawledUrls is stored in tier order by site-crawl.job.ts.
 *   Users see homepage first, then core pages, then content, then legal.
 *   This matches what RankAI and Ahrefs show in their page lists.
 *
 * REDIS SLIDING TTL:
 *   Every time pages are read from Redis, TTL is refreshed to 24hrs.
 *   This prevents cache expiry during a normally-running pipeline.
 *   Pipeline runs end-to-end in hours — 24hr TTL is more than enough.
 */

import { getRedis } from '../loaders/redis';
import { logger }   from '../open-tele';

// ── Constants ──────────────────────────────────────────────────────────────

const REDIS_TTL_SECS = 60 * 60 * 24; // 24 hours — refresh on every read

// Tier 2: core business path segments
const TIER_2_PATTERNS = [
  'about', 'services', 'service', 'products', 'product',
  'pricing', 'price', 'prices', 'solutions', 'solution',
  'features', 'feature', 'how-it-works', 'what-we-do',
  'offering', 'offerings', 'portfolio', 'work',
];

// Tier 3: trust and contact path segments
const TIER_3_PATTERNS = [
  'contact', 'faq', 'faqs', 'team', 'about-us',
  'location', 'locations', 'store', 'support',
  'help', 'why-us', 'our-story',
];

// Tier 4: content path segments
const TIER_4_PATTERNS = [
  'blog', 'blogs', 'article', 'articles', 'post', 'posts',
  'news', 'resources', 'resource', 'guide', 'guides',
  'case-study', 'case-studies', 'insights', 'learn',
];

// Tier 5: legal and utility path segments
const TIER_5_PATTERNS = [
  'privacy', 'terms', 'legal', 'sitemap', 'cart',
  'login', 'register', 'signup', 'sign-up', 'account',
  'checkout', 'cookie', 'gdpr', 'refund', 'returns',
];

// ── Types ──────────────────────────────────────────────────────────────────

export interface CachedPage {
  url:         string;
  title:       string;
  textContent: string;
}

export interface TieredPage extends CachedPage {
  tier: 1 | 2 | 3 | 4 | 5;
}

// ── URL normalization ──────────────────────────────────────────────────────

/**
 * Normalizes a URL for tier classification.
 * - Strips protocol and domain → just the path
 * - Strips trailing slash
 * - Strips query string and hash
 * - Lowercases
 *
 * Examples:
 *   https://example.com/          → ""
 *   https://example.com/About-Us/ → "about-us"
 *   https://example.com/blog/post?page=1 → "blog/post"
 */
function normalizePath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname
      .replace(/^\//, '')   // strip leading slash
      .replace(/\/$/, '')   // strip trailing slash
      .toLowerCase();
  } catch {
    // Not a valid URL — return as-is lowercased
    return url.toLowerCase();
  }
}

// ── Tier classification ────────────────────────────────────────────────────

/**
 * Classifies a URL into a tier 1-5.
 * Used for page ordering in UI and LLM context selection.
 */
export function classifyPageTier(url: string): 1 | 2 | 3 | 4 | 5 {
  const path = normalizePath(url);

  // Tier 1: homepage — empty path after normalization
  if (path === '' || path === 'index' || path === 'home') return 1;

  // Check path segments against each tier's patterns
  const segments = path.split('/');
  const firstSegment = segments[0] ?? '';

  if (TIER_2_PATTERNS.some(p => firstSegment.includes(p))) return 2;
  if (TIER_3_PATTERNS.some(p => firstSegment.includes(p))) return 3;
  if (TIER_4_PATTERNS.some(p => firstSegment.includes(p))) return 4;
  if (TIER_5_PATTERNS.some(p => firstSegment.includes(p))) return 5;

  // Unknown path — default to tier 4 (treat as content page)
  // Better to include than exclude — downstream jobs can filter further
  return 4;
}

// ── Redis key helpers (mirrors site-crawl.job.ts) ─────────────────────────

function redisPageKey(projectId: string, url: string): string {
  return `crawl:${projectId}:page:${Buffer.from(url).toString('base64')}`;
}

function redisUrlsKey(projectId: string): string {
  return `crawl:${projectId}:urls`;
}

// ── Core page reader ───────────────────────────────────────────────────────

/**
 * Reads ALL crawled pages from Redis for a project.
 * Refreshes TTL on every key read (sliding expiration).
 *
 * Throws if:
 *   - URL list key missing → crawl cache expired → caller should fail job
 *   - Zero pages loaded → all page keys expired → caller should fail job
 *
 * Partial expiry (some page keys missing) → logs warning, returns what exists.
 * Downstream jobs work with partial data — better than failing entirely.
 */
async function readAllPagesFromRedis(projectId: string): Promise<CachedPage[]> {
  const redis = getRedis();

  // 1. Read URL list
  const urlsRaw = await redis.get(redisUrlsKey(projectId));
  if (!urlsRaw) {
    throw new Error(
      `Crawl cache expired for project ${projectId}. ` +
      `Redis key missing: ${redisUrlsKey(projectId)}. ` +
      `Re-run pipeline from SITE_CRAWL step.`
    );
  }

  // Refresh TTL on URL list key (sliding expiration)
  await redis.expire(redisUrlsKey(projectId), REDIS_TTL_SECS);

  const urls: string[] = JSON.parse(urlsRaw) as string[];
  logger.debug('URL list read from Redis', { projectId, count: urls.length });

  // 2. Read each page — use pipeline for efficiency (one round trip)
  const redisPipeline = redis.pipeline();
  for (const url of urls) {
    redisPipeline.get(redisPageKey(projectId, url));
  }
  const results = await redisPipeline.exec();

  const pages: CachedPage[] = [];
  let missingCount = 0;

  for (let i = 0; i < urls.length; i++) {
    const result = results?.[i];
    const raw    = result?.[1] as string | null;

    if (!raw) {
      missingCount++;
      logger.debug('Page cache miss — key expired or missing', {
        projectId,
        url: urls[i],
      });
      continue;
    }

    try {
      const page = JSON.parse(raw) as CachedPage;
      pages.push(page);

      // Refresh TTL on each page key (sliding expiration)
      await redis.expire(redisPageKey(projectId, urls[i] ?? ''), REDIS_TTL_SECS);
    } catch {
      missingCount++;
      logger.warn('Page cache parse failed', { projectId, url: urls[i] });
    }
  }

  if (missingCount > 0) {
    logger.warn('Some page cache keys were missing — partial data', {
      projectId,
      total:   urls.length,
      loaded:  pages.length,
      missing: missingCount,
    });
  }

  if (pages.length === 0) {
    throw new Error(
      `All page cache keys expired for project ${projectId}. ` +
      `Re-run pipeline from SITE_CRAWL step.`
    );
  }

  logger.info('Pages read from Redis', {
    projectId,
    total:   urls.length,
    loaded:  pages.length,
    missing: missingCount,
  });

  return pages;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns ALL crawled pages sorted by tier (tier 1 first).
 * Used by: technical-audit.job.ts
 *
 * Sort order: tier asc → URL length asc (shorter URLs = more important pages)
 */
export async function getAllPages(projectId: string): Promise<TieredPage[]> {
  const pages = await readAllPagesFromRedis(projectId);

  const tiered: TieredPage[] = pages.map(p => ({
    ...p,
    tier: classifyPageTier(p.url),
  }));

  tiered.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.url.length - b.url.length; // shorter URL = higher priority within tier
  });

  logger.debug('All pages sorted by tier', {
    projectId,
    count: tiered.length,
    tierBreakdown: {
      tier1: tiered.filter(p => p.tier === 1).length,
      tier2: tiered.filter(p => p.tier === 2).length,
      tier3: tiered.filter(p => p.tier === 3).length,
      tier4: tiered.filter(p => p.tier === 4).length,
      tier5: tiered.filter(p => p.tier === 5).length,
    },
  });

  return tiered;
}

/**
 * Returns pages relevant for business profile generation (tier 1-3 only).
 * Concatenates text up to charLimit for LLM context.
 * Used by: business-profile.job.ts
 *
 * Page order: tier 1 → tier 2 → tier 3
 * Within each tier: shorter URL first (homepage before /home/index)
 */
export async function getBusinessPages(
  projectId: string,
  charLimit = 12_000,
): Promise<{ pages: TieredPage[]; concatenatedText: string }> {
  const allPages = await getAllPages(projectId);

  // Filter to tier 1-3 only
  const businessPages = allPages.filter(p => p.tier <= 3);

  if (businessPages.length === 0) {
    // Fallback — if no tier 1-3 pages found (unusual), use tier 4
    logger.warn('No tier 1-3 pages found — falling back to tier 4', { projectId });
    const tier4 = allPages.filter(p => p.tier === 4).slice(0, 5);
    businessPages.push(...tier4);
  }

  // Concatenate text up to charLimit
  let concatenatedText = '';
  const selectedPages: TieredPage[] = [];

  for (const page of businessPages) {
    const chunk = `URL: ${page.url}\nTitle: ${page.title}\n${page.textContent}\n\n`;
    if (concatenatedText.length + chunk.length > charLimit) break;
    concatenatedText += chunk;
    selectedPages.push(page);
  }

  logger.info('Business pages selected for LLM context', {
    projectId,
    totalAvailable: businessPages.length,
    selected:       selectedPages.length,
    charCount:      concatenatedText.length,
    charLimit,
  });

  return { pages: selectedPages, concatenatedText };
}
