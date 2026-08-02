/**
 * lib/text-card-image.ts
 *
 * WHAT: Generates the "text_card" hero image fallback — an on-brand image
 * built from the blog's title and the project's brandColor, used when
 * Project.heroImageFallbackMode is 'text_card' and the image pool has
 * nothing left (see lib/hero-image-resolver.ts for where this sits in the
 * overall resolution order).
 *
 * PIPELINE: build an SVG string (gradient background + wrapped title
 * text) → rasterize to PNG with @resvg/resvg-js (a Rust SVG renderer with
 * prebuilt native bindings — no headless browser, no system Cairo/Pango
 * install required) → upload the PNG to Cloudinary via the existing
 * uploadToCloudinary helper. This is the same technique behind most
 * server-side "OG image" generators (e.g. Vercel's satori+resvg
 * pipeline) — SVG is the easy part to template, and a real rasterizer
 * turns it into a normal image file every CMS/social platform can render,
 * which raw SVG often can't (many hosts block SVG upload/delivery as an
 * XSS vector).
 *
 * WHY NOT UPLOAD THE SVG DIRECTLY: Cloudinary (and most CMSes) disable
 * SVG delivery as an image by default for security reasons (inline
 * <script> risk) — relying on that account setting being enabled would
 * make this feature silently fail on some accounts. Rasterizing to PNG
 * sidesteps that entirely.
 *
 * TEXT WRAPPING: SVG <text> has no native word-wrap, so lines are wrapped
 * here using an average-character-width heuristic (~0.55× font-size for
 * this font stack) — a standard, well-known approximation for this exact
 * "no full text-shaping engine" situation, not a hack unique to this file.
 */

import { Resvg } from '@resvg/resvg-js';
import { uploadToCloudinary } from './cloudinary';
import { logger } from '@/open-tele';

// ── Constants ──────────────────────────────────────────────────────────────

const CARD_WIDTH  = 1200;
const CARD_HEIGHT = 630; // standard OG-image / hero-image aspect ratio (1.91:1)

const DEFAULT_BRAND_COLOR = '#2563EB'; // used when the project has no brandColor set
const HEX6_RE = /^#[0-9A-Fa-f]{6}$/;

const FONT_FAMILY   = 'Arial, "Helvetica Neue", Helvetica, sans-serif'; // resvg ships without custom font loading by default; system sans is the safe choice
const FONT_SIZE     = 56;
const LINE_HEIGHT   = FONT_SIZE * 1.2;
const MAX_LINES     = 4;
const HORIZONTAL_PADDING = 100;
const AVG_CHAR_WIDTH_RATIO = 0.55; // heuristic for this font stack at this weight

// ── Main function ────────────────────────────────────────────────────────

/**
 * Generates and uploads a text-card hero image for the given title.
 *
 * @param title      Blog title to render on the card
 * @param brandColor Project.brandColor (6-digit hex) if set; falls back
 *                    to a neutral default so the feature still works for
 *                    projects that haven't picked a color yet
 * @param projectId  Used only to namespace the Cloudinary filename
 * @returns Cloudinary URL of the generated PNG, or null on failure
 *          (non-fatal — same posture as fetchHeroImageUrl, so a broken
 *          render never blocks publishing; the caller falls back further)
 */
export async function generateTextCardImage(
  title:      string,
  brandColor: string | undefined,
  projectId:  string,
): Promise<string | null> {
  try {
    const color = brandColor && HEX6_RE.test(brandColor) ? brandColor : DEFAULT_BRAND_COLOR;
    const svg   = buildSvg(title, color);

    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: CARD_WIDTH },
    });
    const png = resvg.render().asPng();

    const { url } = await uploadToCloudinary(
      png,
      `${projectId}-text-card-${Date.now()}.png`,
      { folder: 'blog-text-card-images', resourceType: 'image' },
    );

    logger.info('Text-card hero image generated', { projectId, title, url });
    return url;
  } catch (err) {
    logger.error(err instanceof Error ? err : new Error(String(err)), {
      context: 'generateTextCardImage', projectId, title,
    });
    return null;
  }
}

// ── SVG composition ─────────────────────────────────────────────────────

function buildSvg(title: string, brandColor: string): string {
  const { light, dark } = deriveGradientStops(brandColor);
  const lines = wrapText(title, CARD_WIDTH - HORIZONTAL_PADDING * 2, FONT_SIZE);

  const blockHeight = lines.length * LINE_HEIGHT;
  const startY = (CARD_HEIGHT - blockHeight) / 2 + FONT_SIZE * 0.8; // baseline offset

  const textLines = lines
    .map((line, i) => {
      const y = startY + i * LINE_HEIGHT;
      return `<text x="${CARD_WIDTH / 2}" y="${y}" text-anchor="middle" font-family='${FONT_FAMILY}' font-size="${FONT_SIZE}" font-weight="700" fill="#FFFFFF">${escapeXml(line)}</text>`;
    })
    .join('\n');

  // Two soft, offset circles for visual interest — deliberately abstract
  // rather than any real logo/photo, keeping this fully deterministic and
  // license-free.
  return `
<svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${dark}" />
      <stop offset="100%" stop-color="${light}" />
    </linearGradient>
  </defs>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#bg)" />
  <circle cx="${CARD_WIDTH * 0.88}" cy="${CARD_HEIGHT * 0.12}" r="180" fill="#FFFFFF" opacity="0.06" />
  <circle cx="${CARD_WIDTH * 0.08}" cy="${CARD_HEIGHT * 0.92}" r="240" fill="#000000" opacity="0.08" />
  ${textLines}
</svg>`.trim();
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Escapes the 5 XML-significant characters so titles with & < > " ' render correctly. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Greedy word-wrap using an average-character-width estimate (no text
 * measurement API available outside a browser/canvas). Caps at MAX_LINES;
 * if the title still doesn't fit, the last line is truncated with an
 * ellipsis rather than overflowing the card.
 */
function wrapText(title: string, maxWidth: number, fontSize: number): string[] {
  const avgCharWidth = fontSize * AVG_CHAR_WIDTH_RATIO;
  const maxCharsPerLine = Math.max(1, Math.floor(maxWidth / avgCharWidth));

  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
    if (lines.length === MAX_LINES) break;
  }
  if (current && lines.length < MAX_LINES) lines.push(current);

  if (lines.length === MAX_LINES) {
    const last = lines[MAX_LINES - 1];
    const consumed = lines.slice(0, MAX_LINES - 1).join(' ').length + last.length;
    if (consumed < title.length) {
      lines[MAX_LINES - 1] = last.length > 3 ? `${last.slice(0, -3).trimEnd()}…` : `${last}…`;
    }
  }

  return lines;
}

/** Derives a light/dark gradient pair from a base hex color via simple HSL lightness shifts. */
function deriveGradientStops(hex: string): { light: string; dark: string } {
  const { h, s, l } = hexToHsl(hex);
  return {
    light: hslToHex(h, s, Math.min(l + 18, 88)),
    dark:  hslToHex(h, s, Math.max(l - 18, 12)),
  };
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l: l * 100 };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h: number;
  switch (max) {
    case r:  h = ((g - b) / d + (g < b ? 6 : 0)); break;
    case g:  h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  h *= 60;

  return { h, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
  const sNorm = s / 100;
  const lNorm = l / 100;

  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lNorm - c / 2;

  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }

  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}
