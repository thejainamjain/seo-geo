/**
 * lib/serp-utils.ts
 *
 * WHAT: Shared utilities used by competitor-discovery.job.ts and
 *       keyword-research.job.ts. Extracted to avoid duplication (DRY).
 *
 * WHY SEPARATE FROM serp.ts:
 *   serp.ts = API calls (network I/O, has side effects).
 *   serp-utils.ts = pure functions (no I/O, easy to unit test).
 *   Keeping them separate makes testing and reasoning about each easier.
 */

import { logger } from '../open-tele';

// ── Country code derivation ────────────────────────────────────────────────

/**
 * Country code map — derived from common region strings in BusinessContext.
 * Covers the most common cases. Falls back to 'us' if no match.
 * SerpAPI country codes: https://serpapi.com/google-countries
 */
const REGION_TO_COUNTRY: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /india|rajasthan|udaipur|mumbai|delhi|bangalore|hyderabad|chennai|kolkata/i, code: 'in' },
  { pattern: /united kingdom|uk|england|scotland|wales/i,                                  code: 'gb' },
  { pattern: /australia|sydney|melbourne|brisbane/i,                                       code: 'au' },
  { pattern: /canada|toronto|vancouver|montreal/i,                                         code: 'ca' },
  { pattern: /germany|berlin|munich|frankfurt/i,                                           code: 'de' },
  { pattern: /france|paris|lyon|marseille/i,                                               code: 'fr' },
  { pattern: /singapore/i,                                                                  code: 'sg' },
  { pattern: /uae|dubai|abu dhabi/i,                                                       code: 'ae' },
  { pattern: /united states|usa|new york|california|texas/i,                              code: 'us' },
];

/**
 * Derives a SerpAPI/DataForSEO country code from BusinessContext.company.targetRegions.
 * Falls back to 'us' if no match found.
 *
 * Example: ["Udaipur, Rajasthan, India"] → 'in'
 *
 * Used by: competitor-discovery.job.ts, keyword-research.job.ts
 */
export function deriveCountryCodeFromRegions(
  targetRegions: string[] | undefined,
  projectId:     string,
): string {
  if (!targetRegions || targetRegions.length === 0) {
    logger.debug('No target regions set — defaulting country to us', { projectId });
    return 'us';
  }

  const regionText = targetRegions.join(' ');

  for (const { pattern, code } of REGION_TO_COUNTRY) {
    if (pattern.test(regionText)) {
      logger.debug('Country code derived from target regions', {
        projectId,
        regionText,
        countryCode: code,
      });
      return code;
    }
  }

  logger.warn('Could not derive country code from target regions — defaulting to us', {
    projectId,
    targetRegions,
  });
  return 'us';
}
