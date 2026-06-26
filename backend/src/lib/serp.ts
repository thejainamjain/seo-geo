/**
 * lib/serp.ts
 *
 * WHAT: SerpAPI wrapper for all Google SERP data fetching in the pipeline.
 *
 * DESIGN:
 *   - One exported function per use case (typed input + typed output)
 *   - API key read at call time (not startup) — can be rotated without restart
 *   - All calls logged with duration for observability
 *   - 429 / 5xx throw so BullMQ retries with backoff
 *   - Results are typed — callers never deal with raw SerpAPI JSON
 *
 * SERPAPI DOCS: https://serpapi.com/search-api
 *
 * FREE TIER: 100 searches/month.
 * PAID TIER: scales up — no code changes needed, just add credits.
 *
 * ADDING NEW SERP CALLS:
 *   1. Add typed interface for the response you need
 *   2. Add a function that calls fetchSerp() with the right params
 *   3. Export it
 *   Never call SerpAPI directly outside this file.
 */

import { logger } from '../open-tele';

// ── Constants ──────────────────────────────────────────────────────────────

const SERPAPI_BASE_URL = 'https://serpapi.com/search.json';
const FETCH_TIMEOUT_MS = 15_000; // 15 seconds — SerpAPI is usually fast

/**
 * Domains that are never real competitors — they rank for everything
 * but are not businesses competing with our user.
 * Filtering these gives cleaner competitor lists.
 */
const GENERIC_DOMAINS = new Set([
  'wikipedia.org',
  'youtube.com',
  'facebook.com',
  'twitter.com',
  'instagram.com',
  'linkedin.com',
  'amazon.com',
  'amazon.in',
  'flipkart.com',
  'reddit.com',
  'quora.com',
  'pinterest.com',
  'yelp.com',
  'tripadvisor.com',
  'google.com',
  'bing.com',
  'yahoo.com',
  'trustpilot.com',
  'g2.com',
  'capterra.com',
]);

// ── Types ──────────────────────────────────────────────────────────────────

export interface OrganicResult {
  position: number;
  title:    string;
  link:     string;
  domain:   string;
  snippet:  string;
}

export interface SerpSearchResult {
  keyword:         string;
  totalResults:    number;
  organicResults:  OrganicResult[];
}

// ── Core SerpAPI fetch ─────────────────────────────────────────────────────

/**
 * Base fetch function — all SerpAPI calls go through here.
 * Handles: auth, timeout, error classification, logging.
 *
 * Throws on:
 *   - Missing API key
 *   - 429 rate limit     → BullMQ retries with backoff
 *   - 4xx client error   → throws with clear message
 *   - 5xx server error   → BullMQ retries with backoff
 *   - Network timeout    → BullMQ retries
 */
async function fetchSerp(
  params:  Record<string, string>,
  context: string, // for logging — e.g. "competitor-discovery:projectId"
): Promise<Record<string, unknown>> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    throw new Error('SERPAPI_KEY is not defined in environment');
  }

  const url = new URL(SERPAPI_BASE_URL);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('output', 'json');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const startedAt = Date.now();

  logger.debug('SerpAPI call started', {
    context,
    params: { ...params, api_key: '[REDACTED]' }, // Never log the API key
  });

  try {
    const response = await fetch(url.toString(), {
      method:  'GET',
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const durationMs = Date.now() - startedAt;

    if (response.status === 429) {
      throw new Error(`SerpAPI rate limit exceeded (429). Context: ${context}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(`SerpAPI auth failed (${response.status}) — check SERPAPI_KEY. Context: ${context}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `SerpAPI request failed: HTTP ${response.status}. ` +
        `Context: ${context}. Body: ${body.slice(0, 200)}`
      );
    }

    const data = await response.json() as Record<string, unknown>;

    // SerpAPI returns error field on some failures even with 200 status
    if (data['error']) {
      throw new Error(`SerpAPI error: ${String(data['error'])}. Context: ${context}`);
    }

    logger.info('SerpAPI call completed', {
      context,
      durationMs,
      status: response.status,
    });

    return data;

  } catch (err) {
    const durationMs  = Date.now() - startedAt;
    const message     = err instanceof Error ? err.message : String(err);
    const isRateLimit = message.includes('429') || message.toLowerCase().includes('rate limit');
    const isTimeout   = message.includes('timeout') || message.includes('abort');

    logger.error(
      err instanceof Error ? err : new Error(message),
      {
        context,
        durationMs,
        isRateLimit,
        isTimeout,
      },
    );

    throw err;
  }
}

// ── Domain extractor ───────────────────────────────────────────────────────

/**
 * Extracts the root domain from a URL.
 * Examples:
 *   https://www.example.com/path → example.com
 *   https://blog.example.co.uk  → example.co.uk
 */
function extractDomain(url: string): string {
  try {
    const parsed   = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, '');
    return hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

// ── Exported functions ─────────────────────────────────────────────────────

/**
 * Searches Google for a keyword and returns the top organic results.
 * Used by: competitor-discovery.job.ts, serp-research.job.ts
 *
 * @param keyword   - The search query
 * @param country   - Two-letter country code for localized results (e.g. 'in', 'us')
 * @param projectId - For logging context
 * @param limit     - Max results to return (default 10)
 */
export async function searchOrganic(
  keyword:   string,
  country:   string,
  projectId: string,
  limit = 10,
): Promise<SerpSearchResult> {
  const context = `organic-search:${projectId}:${keyword.slice(0, 40)}`;

  const data = await fetchSerp(
    {
      engine: 'google',
      q:      keyword,
      gl:     country,   // country code — 'in' for India, 'us' for USA
      hl:     'en',      // language
      num:    String(Math.min(limit, 10)), // SerpAPI max is 10 per page
    },
    context,
  );

  // Parse organic results
  const raw = (data['organic_results'] as Array<Record<string, unknown>> | undefined) ?? [];

  const organicResults: OrganicResult[] = raw
    .slice(0, limit)
    .map((item, idx) => ({
      position: (item['position'] as number | undefined) ?? idx + 1,
      title:    String(item['title']   ?? ''),
      link:     String(item['link']    ?? ''),
      domain:   extractDomain(String(item['link'] ?? '')),
      snippet:  String(item['snippet'] ?? ''),
    }))
    .filter(r => r.link); // Skip results with no URL

  // Total results is a string like "About 1,230,000,000 results" — parse number
  const totalRaw     = String(data['search_information']
    ? (data['search_information'] as Record<string, unknown>)['total_results'] ?? '0'
    : '0');
  const totalResults = parseInt(totalRaw.replace(/[^0-9]/g, ''), 10) || 0;

  logger.info('Organic search results fetched', {
    context,
    keyword,
    country,
    totalResults,
    returnedCount: organicResults.length,
    topDomains:    organicResults.slice(0, 5).map(r => r.domain),
  });

  return { keyword, totalResults, organicResults };
}

/**
 * Filters a list of domains to remove the project's own domain
 * and generic non-competitor domains (Wikipedia, YouTube, etc.).
 *
 * Returns up to `limit` clean competitor domains.
 * Used by: competitor-discovery.job.ts
 */
export function filterCompetitorDomains(
  domains:       string[],
  ownDomain:     string,
  limit        = 10,
): string[] {
  const normalizedOwn = ownDomain.replace(/^www\./, '').toLowerCase();

  const filtered = domains.filter(domain => {
    const normalized = domain.replace(/^www\./, '').toLowerCase();

    // Skip own domain
    if (normalized === normalizedOwn) return false;

    // Skip generic non-competitors
    for (const generic of GENERIC_DOMAINS) {
      if (normalized === generic || normalized.endsWith(`.${generic}`)) return false;
    }

    return true;
  });

  // Deduplicate — SerpAPI can return same domain multiple times (different subpages)
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const d of filtered) {
    const normalized = d.replace(/^www\./, '').toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      deduped.push(normalized);
    }
  }

  logger.debug('Competitor domains filtered', {
    inputCount:  domains.length,
    afterFilter: deduped.length,
    ownDomain:   normalizedOwn,
    result:      deduped.slice(0, limit),
  });

  return deduped.slice(0, limit);
}
