/**
 * lib/blog-theme.ts
 *
 * WHAT: The "Make my blogs use [App]'s default theme" toggle
 * (Project.useDefaultBlogTheme). When on, applyDefaultBlogTheme() wraps a
 * blog's HTML in a scoped container and prepends a <style> block
 * controlling typography (font family, and size/weight/color for h1–h3,
 * p, span). Called once, right before content is handed to the CMS
 * publisher (see blog-cms-publisher.ts) — blog.content itself (the
 * editable draft) is never mutated by this.
 *
 * WHY SCOPED CSS INSTEAD OF INLINE STYLE ATTRIBUTES: inline styles on
 * every element would need to be threaded through every place blog HTML
 * gets produced (LLM generation, the Tiptap editor, manual edits) —
 * fragile, easy for the theme to drift out of sync in one of those paths.
 * A single scoped <style> block applied once at publish time keeps the
 * theme in exactly one place, and toggling it on/off never touches
 * stored content.
 *
 * WHY A CLASS-SCOPED BLOCK WITH TARGETED !important (NOT bare selectors,
 * NOT blanket !important): most CMS post-content wrappers — WordPress
 * themes especially — style h1/h2/p with selectors more specific than a
 * bare element selector, so an unscoped `h1 { color: ... }` would
 * usually lose the cascade. Rules here are scoped under
 * .seogeo-blog-theme and use !important only on the exact properties
 * this feature promises to control (font-family/size/weight/color/
 * line-height/margin) — a deliberate, narrow override of the host
 * theme's typography for this one block of injected content, not a
 * global override.
 *
 * CAVEAT (documented, not hidden): some CMS post editors — notably
 * classic WordPress with certain security/sanitization plugins — strip
 * <style> tags from post content by default. Where that happens, the
 * wrapper class is still present and simply inert: no broken HTML, no
 * error, just no theming. That's an accepted, safe degrade.
 */

const THEME_WRAPPER_CLASS = 'seogeo-blog-theme';

const DEFAULT_HEADING_COLOR = '#111827'; // slate-900 — used when no brandColor is set
const DEFAULT_BODY_COLOR    = '#374151'; // slate-700
const HEX6_RE = /^#[0-9A-Fa-f]{6}$/;

const FONT_STACK =
  `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

// ── Main functions ───────────────────────────────────────────────────────

/**
 * Wraps `html` in the theme container and prepends the scoped <style>
 * block. Safe to call more than once on the same string — detects the
 * wrapper class and returns the input unchanged rather than double-wrapping.
 *
 * @param html       Blog content HTML (as stored on Blog.content)
 * @param brandColor Project.brandColor if set (6-digit hex); h1/h2 use
 *                    this as their accent color, falling back to a
 *                    neutral dark slate when unset.
 */
export function applyDefaultBlogTheme(html: string, brandColor?: string): string {
  if (html.includes(`class="${THEME_WRAPPER_CLASS}"`)) return html; // already themed

  const css = buildThemeCss(resolveAccentColor(brandColor));
  return `<style>${css}</style>\n<div class="${THEME_WRAPPER_CLASS}">${html}</div>`;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveAccentColor(brandColor?: string): string {
  return brandColor && HEX6_RE.test(brandColor) ? brandColor : DEFAULT_HEADING_COLOR;
}

function buildThemeCss(accentColor: string): string {
  return [
    `.${THEME_WRAPPER_CLASS} { font-family: ${FONT_STACK} !important; }`,
    `.${THEME_WRAPPER_CLASS} h1 { font-size: 2.25rem !important; font-weight: 800 !important; color: ${accentColor} !important; line-height: 1.2 !important; margin: 1.5em 0 0.5em !important; }`,
    `.${THEME_WRAPPER_CLASS} h2 { font-size: 1.875rem !important; font-weight: 700 !important; color: ${accentColor} !important; line-height: 1.25 !important; margin: 1.4em 0 0.5em !important; }`,
    `.${THEME_WRAPPER_CLASS} h3 { font-size: 1.5rem !important; font-weight: 600 !important; color: ${DEFAULT_HEADING_COLOR} !important; line-height: 1.3 !important; margin: 1.3em 0 0.5em !important; }`,
    `.${THEME_WRAPPER_CLASS} p { font-size: 1rem !important; font-weight: 400 !important; color: ${DEFAULT_BODY_COLOR} !important; line-height: 1.75 !important; margin: 0 0 1.2em !important; }`,
    `.${THEME_WRAPPER_CLASS} span { color: inherit !important; font-weight: inherit !important; }`,
  ].join('\n');
}
