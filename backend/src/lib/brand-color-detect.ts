/**
 * lib/brand-color-detect.ts
 *
 * WHAT: Auto-detects a project's brand color from its live site, for the
 * "Detect from site" action in Settings' Image configuration.
 *
 * DESIGN:
 *   - One exported function: detectBrandColor(domain) → hex string | null
 *   - Checks two well-established, standard signals, in order:
 *       1. <meta name="theme-color" content="#..."> — the signal iOS
 *          Safari and Android Chrome use to color the browser chrome/
 *          status bar. Extremely widely adopted, trivial to read.
 *       2. Web app manifest's "theme_color" (<link rel="manifest">,
 *          fetched and JSON-parsed) — same signal PWA install prompts use.
 *   - Deliberately NOT image/pixel analysis of a logo or screenshot: that
 *     needs a native image-processing dependency (sharp, canvas, etc.),
 *     is far more failure-prone (favicon might be transparent, monochrome,
 *     or just a wordmark), and most real "brand color from URL" tools
 *     (Brandfetch-style) lean on exactly these two DOM/manifest signals
 *     first for the same reasons.
 *   - Non-fatal at every step: any fetch/parse failure returns null so the
 *     caller falls back to asking the user to enter a color manually —
 *     this mirrors fetchHeroImageUrl's posture in lib/unsplash.ts.
 *
 * NOT COVERED: sites with neither signal (older sites, some SPA shells).
 * That's an accepted gap, not a bug — it's exactly what the manual-entry
 * fallback in the Settings UI is for.
 */

import * as cheerio from 'cheerio';
import { logger } from '@/open-tele';
import { CRAWLER_UA } from './crawler';

// ── Constants ──────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB — homepage HTML, not the whole site

const HEX6_RE = /^#[0-9A-Fa-f]{6}$/;
const HEX3_RE = /^#([0-9A-Fa-f])([0-9A-Fa-f])([0-9A-Fa-f])$/;

// ── Main function ────────────────────────────────────────────────────────

/**
 * Attempts to detect a brand color for the given domain.
 *
 * @param domain - Bare domain or full URL (e.g. "example.com" or "https://example.com")
 * @returns A normalized 6-digit uppercase hex color (e.g. "#2563EB"), or
 *          null if neither signal was found/parseable.
 */
export async function detectBrandColor(domain: string): Promise<string | null> {
  const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;

  const html = await fetchText(baseUrl);
  if (!html) {
    logger.warn('detectBrandColor: could not fetch site HTML', { domain });
    return null;
  }

  const $ = cheerio.load(html);

  // ── 1. <meta name="theme-color"> ─────────────────────────────────────────

  const metaColor = $('meta[name="theme-color"]').first().attr('content');
  const fromMeta = metaColor ? normalizeHex(metaColor) : null;
  if (fromMeta) {
    logger.info('detectBrandColor: found via meta theme-color', { domain, color: fromMeta });
    return fromMeta;
  }

  // ── 2. Web app manifest's theme_color ────────────────────────────────────

  const manifestHref = $('link[rel="manifest"]').first().attr('href');
  if (manifestHref) {
    const fromManifest = await detectFromManifest(manifestHref, baseUrl, domain);
    if (fromManifest) return fromManifest;
  }

  logger.info('detectBrandColor: no theme-color signal found on site', { domain });
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function detectFromManifest(
  manifestHref: string,
  baseUrl: string,
  domain: string,
): Promise<string | null> {
  let manifestUrl: string;
  try {
    manifestUrl = new URL(manifestHref, baseUrl).toString();
  } catch {
    logger.warn('detectBrandColor: unresolvable manifest href', { domain, manifestHref });
    return null;
  }

  const manifestText = await fetchText(manifestUrl, 5_000);
  if (!manifestText) return null;

  let manifest: { theme_color?: unknown };
  try {
    manifest = JSON.parse(manifestText) as { theme_color?: unknown };
  } catch {
    logger.warn('detectBrandColor: manifest was not valid JSON', { domain, manifestUrl });
    return null;
  }

  if (typeof manifest.theme_color !== 'string') return null;

  const normalized = normalizeHex(manifest.theme_color);
  if (normalized) {
    logger.info('detectBrandColor: found via manifest theme_color', { domain, color: normalized });
  }
  return normalized;
}

/** Fetches a URL as text, capped at MAX_RESPONSE_BYTES. Returns null on any failure. */
async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': CRAWLER_UA },
      signal:  AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;

    const contentLength = res.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) return null;

    const text = await res.text();
    return text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text;
  } catch {
    return null;
  }
}

/**
 * Normalizes a CSS color string to a 6-digit uppercase hex, expanding the
 * 3-digit shorthand some sites use (e.g. theme-color content="#0af").
 * Returns null for anything not a plain hex color (named colors, rgb(),
 * css vars, etc. are intentionally not supported — a manual entry is a
 * better fallback than guessing at a color-name → hex table).
 */
function normalizeHex(raw: string): string | null {
  const trimmed = raw.trim();

  if (HEX6_RE.test(trimmed)) return trimmed.toUpperCase();

  const shortMatch = HEX3_RE.exec(trimmed);
  if (shortMatch) {
    const [, r, g, b] = shortMatch;
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }

  return null;
}
