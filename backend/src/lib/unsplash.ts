/**
 * lib/unsplash.ts
 *
 * WHAT: Fetches a relevant hero image URL from Unsplash for a blog post.
 *
 * DESIGN:
 *   - One exported function: fetchHeroImageUrl(keyword) → string | null
 *   - Returns the raw Unsplash CDN URL (no Cloudinary upload — WP uploader handles it)
 *   - Non-fatal: returns null on any failure so publish continues without hero
 *   - Access key read at call time via config (can be rotated without restart)
 *
 * UNSPLASH API DOCS: https://unsplash.com/documentation#search-photos
 *
 * AUTH: Client-ID header with access key (read-only, no OAuth needed)
 *
 * IMAGE SELECTION:
 *   - Searches by keyword (falls back to "business technology" if no results)
 *   - Picks the first result (highest relevance score from Unsplash)
 *   - Uses "regular" size (~1080px wide) — good balance of quality vs speed
 *
 * RATE LIMITS:
 *   - Demo: 50 requests/hour
 *   - Production: 5000 requests/hour (after Unsplash app approval)
 *   - One call per blog publish — well within limits
 */

import { logger } from '@/open-tele';
import config     from '@/utils/config';

// ── Constants ──────────────────────────────────────────────────────────────

const UNSPLASH_BASE_URL  = 'https://api.unsplash.com';
const FETCH_TIMEOUT_MS   = 10_000;
const FALLBACK_QUERY     = 'business technology';

// ── Types ──────────────────────────────────────────────────────────────────

interface UnsplashSearchResponse {
  results: Array<{
    urls: {
      regular: string;
      full:    string;
      small:   string;
    };
    alt_description: string | null;
    description:     string | null;
  }>;
  total: number;
}

// ── Main function ──────────────────────────────────────────────────────────

/**
 * Fetches a hero image URL from Unsplash for a given keyword.
 *
 * @param keyword - The blog keyword to search for (e.g. "freelance web developer")
 * @param context - Logging context string (e.g. "cms-publish:projectId:blogId")
 * @returns Unsplash CDN URL (regular size) or null if fetch fails
 */
export async function fetchHeroImageUrl(
  keyword: string,
  context: string,
): Promise<string | null> {
  const accessKey = config.unsplash.accessKey();

  // ── 1. Try keyword search ────────────────────────────────────────────────

  const url = fetchUnsplashUrl(keyword);

  logger.debug('Fetching hero image from Unsplash', { context, keyword });

  try {
    const imageUrl = await searchUnsplash(url, accessKey, context);

    if (imageUrl) {
      logger.info('Hero image fetched from Unsplash', { context, keyword, imageUrl });
      return imageUrl;
    }

    // ── 2. Fallback: generic business query ─────────────────────────────────

    logger.warn('No Unsplash results for keyword — trying fallback query', {
      context,
      keyword,
      fallback: FALLBACK_QUERY,
    });

    const fallbackUrl = fetchUnsplashUrl(FALLBACK_QUERY);
    const fallbackImageUrl = await searchUnsplash(fallbackUrl, accessKey, context);

    if (fallbackImageUrl) {
      logger.info('Hero image fetched from Unsplash (fallback)', {
        context,
        fallback: FALLBACK_QUERY,
        imageUrl: fallbackImageUrl,
      });
      return fallbackImageUrl;
    }

    logger.warn('No Unsplash results even for fallback query — publishing without hero image', {
      context,
    });
    return null;

  } catch (err) {
    // Non-fatal — blog publishes without hero image
    logger.warn('Unsplash fetch threw — publishing without hero image', {
      context,
      keyword,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fetchUnsplashUrl(query: string): string {
  const params = new URLSearchParams({
    query,
    per_page:    '1',
    orientation: 'landscape', // hero images are always landscape
    content_filter: 'high',   // safe content only
  });
  return `${UNSPLASH_BASE_URL}/search/photos?${params.toString()}`;
}

async function searchUnsplash(
  url:       string,
  accessKey: string,
  context:   string,
): Promise<string | null> {
  const response = await fetch(url, {
    headers: {
      'Authorization': `Client-ID ${accessKey}`,
      'Accept-Version': 'v1',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (response.status === 401) {
    throw new Error(`Unsplash auth failed (401) — check UNSPLASH_ACCESS_KEY. Context: ${context}`);
  }

  if (response.status === 429) {
    throw new Error(`Unsplash rate limit exceeded (429). Context: ${context}`);
  }

  if (!response.ok) {
    throw new Error(
      `Unsplash API error: HTTP ${response.status}. Context: ${context}`
    );
  }

  const data = await response.json() as UnsplashSearchResponse;

  if (!data.results || data.results.length === 0) {
    return null;
  }

  return data.results[0].urls.regular;
}
