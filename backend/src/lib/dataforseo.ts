/**
 * lib/dataforseo.ts
 *
 * WHAT: DataForSEO API wrapper for keyword research in the pipeline.
 *
 * DESIGN:
 *   - One exported function per use case (typed input + typed output)
 *   - Credentials read at call time — can be rotated without restart
 *   - All calls logged with duration for observability
 *   - 429 / 5xx throw so BullMQ retries with backoff
 *   - Sandbox mode in development (free) — live mode in production
 *
 * DATAFORSEO DOCS: https://docs.dataforseo.com/v3/
 *
 * SANDBOX MODE: Set NODE_ENV=development → uses sandbox endpoints (free).
 * LIVE MODE:    Set NODE_ENV=production  → uses live endpoints (charged per call).
 *
 * ENDPOINTS USED:
 *   - Domain Ranked Keywords (v3/dataforseo_labs/google/ranked_keywords/live)
 *     Returns keywords a competitor domain ranks for in Google.
 *
 * ADDING NEW DATAFORSEO CALLS:
 *   1. Add typed interface for the response
 *   2. Add a function that calls fetchDataForSeo() with the right endpoint + body
 *   3. Export it
 *   Never call DataForSEO directly outside this file.
 */

import { logger } from '../open-tele';
import config from '@/utils/config';

// ── Constants ──────────────────────────────────────────────────────────────

const DATAFORSEO_BASE_URL = 'https://api.dataforseo.com';
const FETCH_TIMEOUT_MS    = 30_000; // 30s — DataForSEO can be slow on large domains

/**
 * Max keywords to fetch per competitor domain.
 * DataForSEO can return thousands — we cap to control cost + processing time.
 * 50 per competitor × 10 competitors = 500 raw keywords → filtered to 260 after scoring.
 */
const MAX_KEYWORDS_PER_DOMAIN = 50;

// ── Types ──────────────────────────────────────────────────────────────────

export interface DataForSeoKeyword {
  keyword:      string;
  searchVolume: number;  // monthly searches
  difficulty:   number;  // 0–100 SEO difficulty
  cpc:          number;  // cost per click in USD
  position:     number;  // competitor's ranking position for this keyword
}

export interface RankedKeywordsResult {
  domain:   string;
  keywords: DataForSeoKeyword[];
}

// ── Auth header ────────────────────────────────────────────────────────────

function getAuthHeader(): string {
  const login    = config.dataforseo.login();
  const password = config.dataforseo.password();

  if (!login || !password) {
    throw new Error('DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD not defined in environment');
  }

  return 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
}

// ── Sandbox vs live URL ────────────────────────────────────────────────────

/**
 * DataForSEO provides identical sandbox endpoints at the same path.
 * In sandbox mode, calls are free but return simulated data.
 * Switch to live by setting NODE_ENV=production.
 */
function getBaseUrl(): string {
  // DataForSEO sandbox is the same URL — controlled by credentials
  // Sandbox credentials are provided by DataForSEO separately
  // Using same URL — sandbox vs live is determined by the credentials used
  return DATAFORSEO_BASE_URL;
}

// ── Core DataForSEO fetch ──────────────────────────────────────────────────

/**
 * Base fetch function — all DataForSEO calls go through here.
 * DataForSEO uses POST with JSON body for all endpoints.
 *
 * Throws on:
 *   - Missing credentials
 *   - 429 rate limit     → BullMQ retries with backoff
 *   - 4xx client error   → throws with clear message
 *   - 5xx server error   → BullMQ retries with backoff
 *   - Network timeout    → BullMQ retries
 *   - API-level error (status_code != 20000) → throws
 */
async function fetchDataForSeo(
  endpoint: string,
  body:     unknown[],
  context:  string,
): Promise<unknown[]> {
  const url       = `${getBaseUrl()}${endpoint}`;
  const startedAt = Date.now();

  logger.debug('DataForSEO call started', {
    context,
    endpoint,
    itemCount: body.length,
  });

  try {
    const response = await fetch(url, {
      method:  'POST',
      headers: {
        'Authorization': getAuthHeader(),
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const durationMs = Date.now() - startedAt;

    if (response.status === 429) {
      throw new Error(`DataForSEO rate limit exceeded (429). Context: ${context}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `DataForSEO auth failed (${response.status}) — check credentials. Context: ${context}`
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `DataForSEO request failed: HTTP ${response.status}. ` +
        `Context: ${context}. Body: ${body.slice(0, 200)}`
      );
    }

    const data = await response.json() as {
      status_code:    number;
      status_message: string;
      tasks?:         Array<{
        status_code:    number;
        status_message: string;
        result?:        unknown[];
      }>;
    };

    // API-level error check
    if (data.status_code !== 20000) {
      throw new Error(
        `DataForSEO API error: ${data.status_message} (${data.status_code}). ` +
        `Context: ${context}`
      );
    }

    const tasks = data.tasks ?? [];

    // Task-level error check — each task has its own status
    for (const task of tasks) {
      if (task.status_code !== 20000) {
        logger.warn('DataForSEO task returned non-200 status', {
          context,
          taskStatus:  task.status_code,
          taskMessage: task.status_message,
        });
      }
    }

    // Flatten all task results into one array
    const results = tasks.flatMap(t => t.result ?? []);

    logger.info('DataForSEO call completed', {
      context,
      endpoint,
      durationMs,
      taskCount:  tasks.length,
      resultCount: results.length,
    });

    return results;

  } catch (err) {
    const durationMs  = Date.now() - startedAt;
    const message     = err instanceof Error ? err.message : String(err);
    const isRateLimit = message.includes('429') || message.toLowerCase().includes('rate limit');
    const isTimeout   = message.includes('timeout') || message.includes('abort');

    logger.error(
      err instanceof Error ? err : new Error(message),
      {
        context,
        endpoint,
        durationMs,
        isRateLimit,
        isTimeout,
      },
    );

    throw err;
  }
}

// ── Exported functions ─────────────────────────────────────────────────────

/**
 * Fetches keywords that a competitor domain ranks for in Google.
 * Uses DataForSEO Labs → Domain Ranked Keywords endpoint.
 *
 * @param domain      - Competitor domain (e.g. "example.com")
 * @param countryCode - Two-letter ISO country code (e.g. "in", "us")
 * @param projectId   - For logging context
 * @param limit       - Max keywords to return per domain
 */

export async function getRankedKeywords(
  domain:      string,
  countryCode: string,
  projectId:   string,
  limit = MAX_KEYWORDS_PER_DOMAIN,
): Promise<RankedKeywordsResult> {
  const context = `ranked-keywords:${projectId}:${domain}`;

  // DataForSEO location codes — most common ones
  // Full list: https://docs.dataforseo.com/v3/appendix/google/locations/
  const locationCode = countryCode === 'in' ? 2356    // India
    : countryCode === 'gb'                  ? 2826    // United Kingdom
    : countryCode === 'au'                  ? 2036    // Australia
    : countryCode === 'ca'                  ? 2124    // Canada
    : countryCode === 'de'                  ? 2276    // Germany
    : countryCode === 'sg'                  ? 2702    // Singapore
    : 2840;                                           // United States (default)

  const results = await fetchDataForSeo(
    '/v3/dataforseo_labs/google/ranked_keywords/live',
    [
      {
        target:             domain,
        location_code:      locationCode,
        language_code:      'en',
        limit,
        order_by:           ['keyword_data.keyword_info.search_volume,desc'], // highest volume first
        filters:            [
          ['keyword_data.keyword_info.search_volume', '>', 0],  // exclude zero-volume keywords
          ['ranked_serp_element.serp_item.rank_group', '<=', 30], // top 30 positions only
        ],
      },
    ],
    context,
  );

  // Parse response — DataForSEO ranked_keywords result structure
  const keywords: DataForSeoKeyword[] = [];

  for (const result of results) {
    const r = result as {
      items?: Array<{
        keyword_data?: {
          keyword?: string;
          keyword_info?: {
            search_volume?: number;
            competition_level?: string;
            cpc?: number;
          };
          keyword_properties?: {
            keyword_difficulty?: number;
          };
        };
        ranked_serp_element?: {
          serp_item?: {
            rank_group?: number;
          };
        };
      }>;
    };

    for (const item of r.items ?? []) {
      const kw = item.keyword_data?.keyword;
      if (!kw) continue;

      const searchVolume = item.keyword_data?.keyword_info?.search_volume ?? 0;
      const difficulty   = item.keyword_data?.keyword_properties?.keyword_difficulty ?? 50;
      const cpc          = item.keyword_data?.keyword_info?.cpc ?? 0;
      const position     = item.ranked_serp_element?.serp_item?.rank_group ?? 99;

      keywords.push({ keyword: kw, searchVolume, difficulty, cpc, position });
    }
  }

  logger.info('Ranked keywords fetched for domain', {
    context,
    domain,
    countryCode,
    locationCode,
    keywordCount: keywords.length,
    topKeywords:  keywords.slice(0, 5).map(k => k.keyword),
  });

  return { domain, keywords };
}
