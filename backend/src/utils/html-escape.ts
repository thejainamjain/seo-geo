/**
 * utils/html-escape.ts
 *
 * LLM output must never be pasted into HTML as-is. The "After — copy this in"
 * markup the audit generates is meant to be copied onto a customer's live
 * site, so a stray quote, ampersand or "</script>" in a generated value would
 * break the tag (or worse). Everything the model writes goes through here.
 */

/** Keeps only a plain, single-line string: strips control chars, collapses whitespace, caps length. */
export function cleanLlmText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
}

/** For text between tags, e.g. <title>…</title>. */
export function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** For attribute values, e.g. content="…" / title="…". */
export function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** JSON for a <script type="application/ld+json"> block that cannot close the tag early. */
export function jsonForScriptTag(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Text safe inside <!-- … -->: no "--" and no ">" that could end the comment early. */
export function htmlCommentSafe(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/-{2,}/g, '-').replace(/>/g, '').trim();
}

/**
 * Sets (or replaces) one attribute on the FIRST <tag …> in `html`, leaving
 * everything else — other attributes AND inner markup — exactly as it was.
 * Returns null if the tag isn't there. Quotes inside attribute values are
 * respected, so  <a href="x>y">  is handled correctly.
 */
export function setTagAttribute(html: string, tag: string, attr: string, value: string): string | null {
  const start = new RegExp(`<${tag}(?=[\\s/>])`, 'i').exec(html);
  if (!start) return null;

  // Find the end of the start tag, ignoring ">" inside quoted values.
  let i = start.index + 1 + tag.length;
  let quote: string | null = null;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') break;
  }
  if (i >= html.length) return null;               // unterminated tag

  let tagText = html.slice(start.index, i + 1);
  const selfClosing = /\/\s*>$/.test(tagText);

  const quoted  = new RegExp(`\\s${attr}\\s*=\\s*("[^"]*"|'[^']*')`, 'i');
  const bare    = new RegExp(`\\s${attr}\\s*=\\s*[^\\s>"']+`, 'i');
  const boolean = new RegExp(`\\s${attr}(?=[\\s/>])`, 'i');
  tagText = tagText.replace(quoted, '').replace(bare, '').replace(boolean, '');

  tagText = tagText.replace(/\s*\/?\s*>$/, '');
  const rebuilt = `${tagText} ${attr}="${escapeHtmlAttr(value)}"${selfClosing ? ' />' : '>'}`;

  return html.slice(0, start.index) + rebuilt + html.slice(i + 1);
}
