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

const DATAFORSEO_LIVE_BASE_URL    = 'https://api.dataforseo.com';
const DATAFORSEO_SANDBOX_BASE_URL = 'https://sandbox.dataforseo.com';
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
 * DataForSEO's sandbox is a genuinely separate host — per their docs
 * (docs.dataforseo.com/v3/appendix-sandbox), the ONLY thing that changes
 * between sandbox and live is the hostname: api.dataforseo.com vs
 * sandbox.dataforseo.com. Request/response shape and credentials are
 * identical; sandbox just returns canned data at zero cost.
 *
 * FIX: this previously always returned the live URL and left a comment
 * claiming "sandbox vs live is determined by the credentials used" — that
 * isn't how DataForSEO's sandbox works, and the module docblock at the top
 * of this file already documented the INTENDED behavior ("NODE_ENV=development
 * → uses sandbox endpoints (free)") that this function never implemented.
 * The result: every call in local development was silently hitting the
 * live, billed endpoint.
 */
function getBaseUrl(): string {
  return config.env === 'production' ? DATAFORSEO_LIVE_BASE_URL : DATAFORSEO_SANDBOX_BASE_URL;
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

// ── Location code mapping ──────────────────────────────────────────────────

/**
 * DataForSEO location codes — most common ones.
 * Full list: https://docs.dataforseo.com/v3/appendix/google/locations/
 * Shared by every function below that needs country targeting.
 */
function countryCodeToLocationCode(countryCode: string): number {
  return countryCode === 'in' ? 2356    // India
    : countryCode === 'gb'                  ? 2826    // United Kingdom
    : countryCode === 'au'                  ? 2036    // Australia
    : countryCode === 'ca'                  ? 2124    // Canada
    : countryCode === 'de'                  ? 2276    // Germany
    : countryCode === 'sg'                  ? 2702    // Singapore
    : 2840;                                           // United States (default)
}

export async function getRankedKeywords(
  domain:      string,
  countryCode: string,
  projectId:   string,
  limit = MAX_KEYWORDS_PER_DOMAIN,
): Promise<RankedKeywordsResult> {
  const context = `ranked-keywords:${projectId}:${domain}`;

  const locationCode = countryCodeToLocationCode(countryCode);

  const results = await fetchDataForSeo(
    '/v3/dataforseo_labs/google/ranked_keywords/live',
    [
      {
        target:             domain,
        location_code:      locationCode,
        language_code:      'en',
        limit,
        order_by:           ['keyword_data.keyword_info.search_volume,desc'], // highest volume first
        // DataForSEO requires an explicit "and"/"or" string BETWEEN filter
        // conditions — [cond1, cond2] with nothing between them is invalid
        // and returns their 40501 "Invalid Field: 'filters'" error (which is
        // exactly what was happening here: every call silently failed and
        // fell back to 0 results). See:
        // https://dataforseo.com/help-center/using-filters
        filters:            [
          ['keyword_data.keyword_info.search_volume', '>', 0],  // exclude zero-volume keywords
          'and',
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

export interface SearchVolumeResult {
  keyword:      string;
  searchVolume: number | null; // null = lookup failed/unavailable, distinct from a genuine 0
  cpc:          number;
  competition:  string | null; // 'LOW' | 'MEDIUM' | 'HIGH', as returned by Google Ads
}

/**
 * Looks up real Google Ads search volume for a single, specific keyword —
 * different from getRankedKeywords() above, which finds keywords a
 * COMPETITOR DOMAIN ranks for. This is for verifying one exact phrase a
 * user typed in themselves (services/keyword.service.ts's addKeyword()),
 * where we need data on that literal keyword, not a list of suggestions.
 *
 * Uses DataForSEO's Keyword Data API (Search Volume endpoint), a
 * different DataForSEO product from the Labs API used above — confirmed
 * against DataForSEO's own docs:
 * POST /v3/keywords_data/google_ads/search_volume/live
 * Body: [{ location_code, keywords: string[] }]
 *
 * Returns `searchVolume: null` (not `0`) if the lookup itself fails or
 * the keyword isn't found in the response — callers should NOT treat a
 * failed lookup the same as a confirmed-zero-volume keyword. A billing
 * issue or a transient API error shouldn't be indistinguishable from
 * "this keyword genuinely gets zero searches."
 */
export async function getSearchVolume(
  keyword:     string,
  countryCode: string,
  projectId:   string,
): Promise<SearchVolumeResult> {
  const context = `search-volume:${projectId}:${keyword}`;
  const locationCode = countryCodeToLocationCode(countryCode);

  try {
    const results = await fetchDataForSeo(
      '/v3/keywords_data/google_ads/search_volume/live',
      [
        {
          location_code: locationCode,
          keywords:      [keyword],
        },
      ],
      context,
    );

    // Response items are flat objects per keyword (unlike ranked_keywords'
    // nested keyword_data.keyword_info structure) — parsed defensively
    // since the exact response shape wasn't independently verified beyond
    // DataForSEO's own documented examples.
    const item = results[0] as {
      keyword?:      string;
      search_volume?: number | null;
      cpc?:          number | null;
      competition?:  string | null;
    } | undefined;

    if (!item) {
      logger.warn('Search volume lookup returned no result', { context, keyword });
      return { keyword, searchVolume: null, cpc: 0, competition: null };
    }

    return {
      keyword,
      searchVolume: item.search_volume ?? null,
      cpc:          item.cpc ?? 0,
      competition:  item.competition ?? null,
    };

  } catch (err) {
    // Non-fatal by design — see file header "ADDING NEW DATAFORSEO CALLS"
    // philosophy elsewhere in this file. A failed volume lookup shouldn't
    // block a user from adding a keyword; it should just mean "we don't
    // have volume data for this," which the caller treats as
    // fail-open, not fail-closed.
    logger.warn('Search volume lookup failed — treating as unavailable', {
      context, keyword, error: err instanceof Error ? err.message : String(err),
    });
    return { keyword, searchVolume: null, cpc: 0, competition: null };
  }
}
