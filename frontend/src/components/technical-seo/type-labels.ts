/**
 * components/technical-seo/type-labels.ts
 *
 * Human-readable labels for CodeChange.type. Must be kept in sync with
 * the types actually emitted by backend/src/workers/jobs/site-crawl.job.ts
 * (detectCodeChanges) — see that file's header comment for the canonical
 * list of what's currently implemented.
 */
export const TYPE_LABELS: Record<string, string> = {
  title:              'Optimize title',
  description:        'Optimize description',
  open_graph:          'Add Open Graph tags',
  canonical:           'Add canonical tag',
  alt_text:            'Add image alt text',
  link_title:          'Add link title',
  link_target:         'Add link target',
  internal_link:       'Add internal links',
  schema:              'Add schema markup',
  broken_link:         'Fix broken link',
  redirect_chain:      'Fix redirect chain',
  thin_content:        'Expand thin content',
  page_speed:          'Improve page speed',
  non_self_canonical:  'Fix canonical mismatch',
  missing_h1:          'Add H1 tag',
  schema_invalid:      'Fix invalid schema',
  page_size:           'Reduce page size',
};

/**
 * Types whose newHtml is a genuinely applied fix (real corrected
 * markup/JSON-LD generated either mechanically or by the v1 LLM tier —
 * see technical-audit.job.ts's LLM_NEEDED_TYPES/buildPageNeeds). These
 * are safe to present as "copy this in" code.
 *
 * Types NOT in this set (broken_link, thin_content, redirect_chain,
 * missing_h1, schema_invalid, page_speed, non_self_canonical, page_size,
 * and internal_link) currently have newHtml that is either empty or an
 * HTML-comment-wrapped PROSE suggestion (e.g. "<!-- SEO Fix: shorten the
 * redirect chain to 1 hop -->") — not applied/appliable markup. The UI
 * must not present these the same way real diffs are presented; showing
 * a sentence next to a "Before" code block implies it's a real After
 * value when it isn't.
 */
export const REAL_DIFF_TYPES = new Set([
  'title', 'description', 'open_graph', 'canonical',
  'alt_text', 'link_title', 'link_target', 'schema',
]);
