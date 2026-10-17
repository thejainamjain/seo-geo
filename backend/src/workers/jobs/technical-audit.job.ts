/**
 * workers/jobs/technical-audit.job.ts
 *
 * WHAT: Generates LLM-powered SEO fixes for every crawled page.
 *       Fills newHtml on pending CodeChange records, generates FAQ Q&A pairs,
 *       generates TLDR summaries, and calculates a final SEO score for the audit.
 *
 * PIPELINE POSITION: Step 3 of 8
 * READS:  Audit (latest completed for this project, created by site-crawl)
 *         CodeChange (pending records created by site-crawl)
 *         FAQ stubs (pending, created by site-crawl)
 *         TLDR stubs (pending, created by site-crawl)
 *         Redis page cache (text content per page)
 * WRITES: CodeChange.newHtml (filled for LLM-generated types)
 *         FAQ.questions + FAQ.newHtml
 *         TLDR.tldrText + TLDR.newHtml
 *         Audit.summary.score + Audit.summary.scoreReasoning
 *
 * LLM STRATEGY — ONE CALL PER PAGE:
 *   Each page gets exactly one Gemini call that returns everything needed:
 *   title fix, description fix, OG tags, alt texts, schema, FAQ, TLDR.
 *   This is coherent (LLM sees full context once) and efficient (minimises RPM).
 *
 *   Non-LLM fixes (canonical) are already filled by site-crawl.
 *   We never call LLM for those — they are mechanical, deterministic fixes.
 *
 * WHICH TYPES NEED LLM vs MECHANICAL:
 *   LLM-generated:  title, description, open_graph, alt_text, schema, link_title
 *   Pre-filled:     canonical (site-crawl sets newHtml directly)
 *   LLM-generated:  faqQuestions (on FAQ model), tldrText (on TLDR model)
 *
 * RATE LIMITING:
 *   Sequential processing. No manual delay between pages — auditPage()
 *   enforces the global RPM ceiling internally (lib/llm.ts). To change the
 *   RPM ceiling, edit LLM_RATE_LIMIT in seo-pipeline.constants.ts.
 *
 * IDEMPOTENCY:
 *   Only processes CodeChanges with status: 'pending' and empty newHtml.
 *   Safe to retry — already-filled records are skipped.
 *   Audit is re-fetched on retry — no stale state.
 *
 * SEO SCORE CALCULATION:
 *   Deterministic weighted score computed from real per-factor check
 *   totals (Audit.summary.checkTotals, set by site-crawl.job.ts) — final
 *   score 1-100 is the rounded weighted pass rate. One LLM call adds a
 *   one-sentence explanation but does not change the number.
 *   Stored in Audit.summary.score and Audit.summary.scoreReasoning.
 *
 * ERROR HANDLING:
 *   - LLM call fails for one page → logged, page skipped, continue to next
 *     (partial audit better than no audit — user sees most fixes)
 *   - LLM returns partial JSON (missing some fields) → apply what we got
 *   - All pages fail → audit still completes with score based on detection only
 *   - Audit record missing → throws → BullMQ retries
 *   - Redis cache expired → throws → BullMQ retries
 */

import type { Job } from 'bullmq';
import { load as loadHtml } from 'cheerio';
import { logger }          from '@/open-tele';
import { Audit }           from '@/models/Audit';
import { CodeChange }      from '@/models/CodeChange';
import { FAQ }             from '@/models/FAQ';
import { TLDR }            from '@/models/TLDR';
import { Project }         from '@/models/Project';
import { getAllPages }      from '@/lib/page-selector';
import {
  cleanLlmText, escapeHtmlText, escapeHtmlAttr, jsonForScriptTag, htmlCommentSafe, setTagAttribute,
} from '@/utils/html-escape';
import { auditPage, generateSeoScore } from '@/lib/llm';
import type { PipelineJobData }        from '../seo-pipeline.worker';
import type { TieredPage }             from '@/lib/page-selector';
import type { PageAuditLlmResponse }   from '@/lib/llm';
import {
  TECHNICAL_AUDIT_CONFIG,
  CODE_CHANGE_SEVERITY_WEIGHT,
} from '@/constants/seo-pipeline.constants';

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * CodeChange types that require LLM to generate newHtml.
 * All others are either pre-filled by site-crawl or mechanical.
 */
const LLM_NEEDED_TYPES = new Set([
  'title',
  'description',
  'open_graph',
  'alt_text',
  'schema',
  'broken_link',
  'thin_content',
  'redirect_chain',
  'missing_h1',
  'schema_invalid',
  'page_speed',
  'non_self_canonical',
  'page_size',
]);

/**
 * SEO factor weights for score calculation.
 * Higher weight = more impact on final score.
 *  (title/schema matter more than OG tags).
 */
const FACTOR_WEIGHTS: Record<string, number> = {
  title:             10,
  description:        8,
  open_graph:         6,
  canonical:          7,
  alt_text:           5,
  link_title:         3,
  schema:             9,
  broken_link:        8,
  internal_link:      4,   // Page has fewer than MIN_INTERNAL_LINKS internal links — see detectCodeChanges (site-crawl.job.ts)
  thin_content:       7,   // Thin pages hurt rankings significantly
  redirect_chain:     6,   // Multi-hop redirects waste crawl budget
  missing_h1:         8,   // H1 is a primary on-page ranking signal
  schema_invalid:     7,   // Invalid schema is worse than no schema
  page_speed:         9,   // Core Web Vitals are a direct ranking factor
  non_self_canonical: 8,   // Non-self canonicals confuse Googlebot
  page_size:          5,   // Oversized pages slow Googlebot
};

// ── Types ──────────────────────────────────────────────────────────────────

interface PageCodeChanges {
  url:         string;
  types:       string[];          // which CodeChange types are pending for this page
  changeIds:   Record<string, string[]>; // type → [_id, ...]  (alt_text can have many)
  imageSrcs:   string[];          // img srcs needing alt text (from oldHtml)
  title:       string;
  description: string;
  textContent: string;
  linkRefs:    Array<{ href: string; text: string }>; // links needing title attrs

  // Per-change lookups keyed by CodeChange _id. The LLM is asked about a
  // de-duplicated, capped list (imageSrcs / linkRefs), but every change must be
  // matched to ITS OWN image/link — never by position in those lists (a link
  // that failed to parse, a duplicate image, or the cap used to shift every
  // later change onto the wrong value).
  imageSrcById: Record<string, string>;
  linkRefById:  Record<string, { href: string; text: string }>;
  oldHtmlById:  Record<string, string>;
}

interface AuditScoreInput {
  // type → real total number of checks of that type across the audit
  // (from Audit.summary.checkTotals, computed by site-crawl.job.ts from
  // actual page content — not an even split).
  totalByType:    Record<string, number>;
  failedByType:   Record<string, number>; // type → count of failures
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extracts the current title and description from a CodeChange's oldHtml.
 * Falls back to empty string if not parseable.
 *
 * Uses cheerio rather than regex against oldHtml. oldHtml is always
 * simple, single-tag content this same codebase generated in
 * detectCodeChanges (site-crawl.job.ts) — never arbitrary third-party
 * HTML — so this is a robustness upgrade for edge cases (attributes in a
 * different order, HTML-entity-encoded content, nested quotes) rather than
 * a fix for an active bug. If detectCodeChanges' oldHtml format ever
 * changes to something more complex, this parses it properly instead of
 * relying on tag order/shape assumptions.
 *
 * Examples:
 *   oldHtml: '<title>My Page</title>'         → 'My Page'
 *   oldHtml: '<meta name="description" ...>'  → content attribute value
 *   oldHtml: 'No meta description found'      → '' (not a tag, no match)
 */
function extractCurrentValueFromOldHtml(type: string, oldHtml: string): string {
  if (!oldHtml) return '';

  try {
    const $ = loadHtml(oldHtml, null, false); // fragment parse, no implicit html/head/body wrapper
    if (type === 'title') {
      return $('title').first().text().trim();
    }
    if (type === 'description') {
      return ($('meta[name="description"]').first().attr('content') ?? '').trim();
    }
  } catch {
    // Non-critical — fall back to empty
  }
  return '';
}

/**
 * Extracts image src from an alt_text CodeChange's oldHtml.
 * Example: '<img src="/hero.jpg">' → '/hero.jpg'
 */
function extractImgSrc(oldHtml: string): string {
  if (!oldHtml) return '';
  try {
    const $ = loadHtml(oldHtml, null, false);
    return ($('img').first().attr('src') ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Extracts href + link text from a link_title CodeChange's oldHtml.
 * Example: '<a href="https://x.com">Click here</a>' → { href, text }
 */
function extractLinkRef(oldHtml: string): { href: string; text: string } | null {
  if (!oldHtml) return null;
  try {
    const $ = loadHtml(oldHtml, null, false);
    const a = $('a').first();
    const href = a.attr('href');
    if (!href) return null;
    return { href: href.trim(), text: a.text().trim() };
  } catch {
    return null;
  }
}

/**
 * Calculates weighted SEO score from audit results.
 * Returns actualScore, totalPossible, and weightedPassRate — the latter is
 * rounded and clamped to become the final 1-100 score directly (see
 * runTechnicalAuditJob). All three are also passed to the LLM, which uses
 * them only to write a one-sentence explanation, not to change the score.
 *
 * Logic:
 *   Each factor has a weight and a real total check count for this audit
 *   (input.totalByType[type], computed by site-crawl.job.ts from actual
 *   page content — e.g. alt_text's total is the real number of images
 *   found, not an estimate). If it passes on all of them → full weight ×
 *   typeTotal. If it fails on N of them → those N lose the full weight.
 *   Score = (sum of passed weights) / (sum of all possible weights) × 100
 *
 * 'internal_link' IS implemented (detectCodeChanges in site-crawl.job.ts,
 * added after this comment was originally written) — checkTotals is
 * populated for it the same way as the other page-level factors above.
 */
function calculateWeightedScore(input: AuditScoreInput): {
  actualScore:      number;
  totalPossible:    number;
  weightedPassRate: number;
} {
  let actualScore   = 0;
  let totalPossible = 0;

  for (const [type, weight] of Object.entries(FACTOR_WEIGHTS)) {
    const failures  = input.failedByType[type] ?? 0;
    const typeTotal = weight * (input.totalByType[type] ?? 0);
    const typePassed = typeTotal - (weight * failures);
    actualScore   += Math.max(0, typePassed);
    totalPossible += typeTotal;
  }

  const weightedPassRate = totalPossible > 0
    ? (actualScore / totalPossible) * 100
    : 0;

  return {
    actualScore:      Math.round(actualScore),
    totalPossible:    Math.round(totalPossible),
    weightedPassRate: Math.min(100, Math.max(0, weightedPassRate)),
  };
}

/**
 * Builds the `needs` array for the LLM call — only types where LLM is needed.
 * Also builds the imageSrcs list for alt_text generation.
 */
function buildPageNeeds(pageChanges: PageCodeChanges): {
  needs:     string[];
  imageSrcs: string[];
  linkRefs: Array<{href:string;text:string}>
} {
  const needs: string[]     = [];
  const imageSrcs: string[] = [];

  for (const type of pageChanges.types) {
    if (!LLM_NEEDED_TYPES.has(type)) continue;

    if (type === 'alt_text') {
      // Image srcs already extracted into pageChanges.imageSrcs
      if (pageChanges.imageSrcs.length > 0) {
        needs.push('altTexts');
        imageSrcs.push(...pageChanges.imageSrcs);
      }
    } else if (type === 'open_graph') {
      needs.push('ogTitle', 'ogDescription');
    } else if (type === 'title') {
      needs.push('title');
    } else if (type === 'description') {
      needs.push('description');
    } else if (type === 'schema') {
      needs.push('schema');
    } else if (type === 'broken_link') {
      needs.push('brokenLinkFix');
    } else if (type === 'thin_content') {
      needs.push('contentExpansion');
    } else if (type === 'redirect_chain') {
      needs.push('redirectFix');
    } else if (type === 'missing_h1') {
      needs.push('h1Suggestion');
    } else if (type === 'schema_invalid') {
      needs.push('schemaFix');
    } else if (type === 'page_speed') {
      needs.push('speedFix');
    } else if (type === 'non_self_canonical') {
      needs.push('canonicalFix');
    } else if (type === 'page_size') {
      needs.push('pageSizeFix');
    } else if (type === 'link_title') {
      if (pageChanges.linkRefs.length > 0) {
        needs.push('linkTitles');
      }
    } 
  }
  needs.push('faqQuestions', 'tldrText');

  return { needs, imageSrcs, linkRefs: pageChanges.linkRefs };
}

// ── CodeChange updaters ────────────────────────────────────────────────────

/**
 * Applies LLM response to CodeChange records for one page.
 * Uses bulkWrite for efficiency — one DB round trip per page.
 */
async function applyCodeChanges(
  pageChanges: PageCodeChanges,
  llmResult:   PageAuditLlmResponse,
  projectId:   string,
): Promise<number> {
  const ops: Parameters<typeof CodeChange.bulkWrite>[0] = [];

  // Every LLM string is cleaned (single line, length-capped) and ESCAPED before it
  // goes into markup the customer will copy onto their live site.
  const title         = cleanLlmText(llmResult.title,         200);
  const description   = cleanLlmText(llmResult.description,   400);
  const ogTitle       = cleanLlmText(llmResult.ogTitle,       200);
  const ogDescription = cleanLlmText(llmResult.ogDescription, 400);

  // title
  if (title && pageChanges.changeIds['title']) {
    for (const id of pageChanges.changeIds['title']!) {
      ops.push({
        updateOne: {
          filter: { _id: id },
          update: { $set: { newHtml: `<title>${escapeHtmlText(title)}</title>` } },
        },
      });
    }
  }

  // description
  if (description && pageChanges.changeIds['description']) {
    for (const id of pageChanges.changeIds['description']!) {
      ops.push({
        updateOne: {
          filter: { _id: id },
          update: { $set: { newHtml: `<meta name="description" content="${escapeHtmlAttr(description)}">` } },
        },
      });
    }
  }

  // open_graph — one CodeChange record, both OG tags in newHtml
  if ((ogTitle || ogDescription) && pageChanges.changeIds['open_graph']) {
    const ogHtml = [
      ogTitle       ? `<meta property="og:title" content="${escapeHtmlAttr(ogTitle)}">` : '',
      ogDescription ? `<meta property="og:description" content="${escapeHtmlAttr(ogDescription)}">` : '',
    ].filter(Boolean).join('\n');

    for (const id of pageChanges.changeIds['open_graph']!) {
      ops.push({
        updateOne: {
          filter: { _id: id },
          update: { $set: { newHtml: ogHtml } },
        },
      });
    }
  }

  // alt_text — LLM returns { src: alt }. Each change is matched by ITS OWN
  // image (looked up by id), and the alt attribute is set on the original
  // <img> tag so its other attributes (class, width, srcset …) are preserved.
  if (llmResult.altTexts && pageChanges.changeIds['alt_text']) {
    for (const id of pageChanges.changeIds['alt_text']!) {
      const src     = pageChanges.imageSrcById[id];
      const oldHtml = pageChanges.oldHtmlById[id];
      if (!src || !oldHtml) continue;

      const alt = cleanLlmText(llmResult.altTexts[src], 200);
      if (!alt) continue;

      const newHtml = setTagAttribute(oldHtml, 'img', 'alt', alt);
      if (!newHtml) continue;

      ops.push({
        updateOne: {
          filter: { _id: id },
          update: { $set: { newHtml, htmlAttributes: { alt } } },
        },
      });
    }
  }

  // link_title — same rule: matched by id, title attribute set on the ORIGINAL
  // <a> tag so the link's inner markup (an <img>, <span>, …) is never lost.
  if (llmResult.linkTitles && pageChanges.changeIds['link_title']) {
    for (const id of pageChanges.changeIds['link_title']!) {
      const ref     = pageChanges.linkRefById[id];
      const oldHtml = pageChanges.oldHtmlById[id];
      if (!ref || !oldHtml) continue;

      const linkTitle = cleanLlmText(llmResult.linkTitles[ref.href], 120);
      if (!linkTitle) continue;

      const newHtml = setTagAttribute(oldHtml, 'a', 'title', linkTitle);
      if (!newHtml) continue;

      ops.push({
        updateOne: {
          filter: { _id: id },
          update: { $set: { newHtml } },
        },
      });
    }
  }

  // schema — stored as JSON-LD script tag
  if (llmResult.schema && pageChanges.changeIds['schema']) {
    const schemaHtml = `<script type="application/ld+json">\n${jsonForScriptTag(llmResult.schema)}\n</script>`;
    for (const id of pageChanges.changeIds['schema']!) {
      ops.push({
        updateOne: {
          filter: { _id: id },
          update: { $set: { newHtml: schemaHtml } },
        },
      });
    }
  }

  const newV2Types = [
    'broken_link', 'thin_content', 'redirect_chain', 'missing_h1',
    'schema_invalid', 'page_speed', 'non_self_canonical', 'page_size',
  ] as const;

  for (const v2type of newV2Types) {
    const suggestion = (llmResult as Record<string, unknown>)[
      v2type === 'broken_link'      ? 'brokenLinkFix'    :
      v2type === 'thin_content'     ? 'contentExpansion' :
      v2type === 'redirect_chain'   ? 'redirectFix'      :
      v2type === 'missing_h1'       ? 'h1Suggestion'     :
      v2type === 'schema_invalid'   ? 'schemaFix'        :
      v2type === 'page_speed'       ? 'speedFix'         :
      v2type === 'non_self_canonical'? 'canonicalFix'    :
      'pageSizeFix'
    ] as string | undefined;

    if (typeof suggestion === 'string' && suggestion.trim() && pageChanges.changeIds[v2type]) {
      for (const id of pageChanges.changeIds[v2type]!) {
        ops.push({
          updateOne: {
            filter: { _id: id },
            update: { $set: { newHtml: `<!-- SEO Fix: ${htmlCommentSafe(suggestion)} -->` } },
          },
        });
      }
    }
  }

  if (ops.length === 0) {
    logger.debug('No CodeChange ops to apply for page', { projectId, url: pageChanges.url });
    return 0;
  }

  const result = await CodeChange.bulkWrite(ops, { ordered: false });

  logger.debug('CodeChange records updated for page', {
    projectId,
    url:      pageChanges.url,
    modified: result.modifiedCount,
    ops:      ops.length,
  });

  return result.modifiedCount;
}

/**
 * Updates FAQ stub for a page with generated Q&A pairs.
 */
async function applyFaqUpdate(
  projectId:    string,
  auditId:      string,
  url:          string,
  llmResult:    PageAuditLlmResponse,
): Promise<void> {
  if (!llmResult.faqQuestions || llmResult.faqQuestions.length === 0) return;

  // Build FAQ schema markup + inject below page content
  const faqSchema = {
    '@context':   'https://schema.org',
    '@type':      'FAQPage',
    'mainEntity': llmResult.faqQuestions.map(q => ({
      '@type':          'Question',
      'name':           q.question,
      'acceptedAnswer': { '@type': 'Answer', 'text': q.answer },
    })),
  };

  const faqHtml = [
    '<section class="faq-section">',
    '<h2>Frequently Asked Questions</h2>',
    ...llmResult.faqQuestions.map(q =>
      `<details><summary>${q.question}</summary><p>${q.answer}</p></details>`
    ),
    '</section>',
    `<script type="application/ld+json">\n${JSON.stringify(faqSchema, null, 2)}\n</script>`,
  ].join('\n');

  await FAQ.findOneAndUpdate(
    { projectId, auditId, sourceUrl: url, status: 'pending' },
    {
      $set: {
        questions: llmResult.faqQuestions,
        newHtml:   faqHtml,
      },
    },
  );
}

/**
 * Updates TLDR stub for a page with generated summary text.
 */
async function applyTldrUpdate(
  projectId: string,
  auditId:   string,
  url:       string,
  llmResult: PageAuditLlmResponse,
): Promise<void> {
  if (!llmResult.tldrText) return;

  const tldrHtml = [
    '<div class="tldr-section" style="background:#f8f9fa;border-left:4px solid #6c757d;padding:16px;margin-bottom:24px;">',
    '<strong>TL;DR</strong>',
    `<p>${llmResult.tldrText}</p>`,
    '</div>',
  ].join('\n');

  await TLDR.findOneAndUpdate(
    { projectId, auditId, sourceUrl: url, status: 'pending' },
    {
      $set: {
        tldrText: llmResult.tldrText,
        newHtml:  tldrHtml,
      },
    },
  );
}

// ── Page grouping ──────────────────────────────────────────────────────────

/**
 * Fetches all pending CodeChanges for this audit and groups them by page URL.
 * Returns a map of url → PageCodeChanges.
 *
 * Only includes pages that have at least one LLM-needed CodeChange,
 * OR pages that have a pending FAQ/TLDR stub (always need LLM call).
 */
async function groupCodeChangesByPage(
  projectId: string,
  auditId:   string,
  pages:     TieredPage[],
): Promise<Map<string, PageCodeChanges>> {
  // 1. Fetch all pending CodeChanges for this audit
  const codeChanges = await CodeChange.find({
    projectId,
    auditId,
    status: 'pending',
  }).lean();

  logger.info('Pending CodeChanges fetched', {
    projectId,
    auditId,
    count: codeChanges.length,
  });

  // 2. Build page text map from Redis pages
  const pageTextMap = new Map<string, TieredPage>(
    pages.map(p => [p.url, p]),
  );

  // 3. Group by URL
  const grouped = new Map<string, PageCodeChanges>();

  for (const change of codeChanges) {
    const url = change.url;

    if (!grouped.has(url)) {
      const page = pageTextMap.get(url);
      grouped.set(url, {
        url,
        types:      [],
        changeIds:  {},
        imageSrcs:  [],
        title:       page?.title       ?? '',
        description: '', // extracted from CodeChange oldHtml below
        textContent: page?.textContent ?? '',
        linkRefs:    [],
        imageSrcById: {},
        linkRefById:  {},
        oldHtmlById:  {},
      });
    }

    const entry = grouped.get(url)!;

    // Track type
    if (!entry.types.includes(change.type)) {
      entry.types.push(change.type);
    }

    // Track IDs by type
    if (!entry.changeIds[change.type]) {
      entry.changeIds[change.type] = [];
    }
    entry.changeIds[change.type]!.push(String(change._id));

    // Extract description from CodeChange oldHtml if this is a description change
    if (change.type === 'description' && change.oldHtml) {
      entry.description = extractCurrentValueFromOldHtml('description', change.oldHtml);
    }

    // Extract image src for alt_text changes. Every change is recorded BY ID;
    // the list sent to the LLM is de-duplicated and capped.
    if (change.type === 'alt_text' && change.oldHtml) {
      const src = extractImgSrc(change.oldHtml);
      if (src) {
        entry.imageSrcById[String(change._id)] = src;
        entry.oldHtmlById[String(change._id)]  = change.oldHtml;
        // Cap at MAX_ALT_TEXT_IMGS — avoid huge prompts for image-heavy pages
        if (!entry.imageSrcs.includes(src) && entry.imageSrcs.length < TECHNICAL_AUDIT_CONFIG.MAX_ALT_TEXT_IMGS) {
          entry.imageSrcs.push(src);
        }
      }
    }

    // Extract href/text for link_title changes (same rule: by ID, list de-duplicated by href)
    if (change.type === 'link_title' && change.oldHtml) {
      const ref = extractLinkRef(change.oldHtml);
      if (ref) {
        entry.linkRefById[String(change._id)] = ref;
        entry.oldHtmlById[String(change._id)]  = change.oldHtml;
        if (
          !entry.linkRefs.some(r => r.href === ref.href) &&
          entry.linkRefs.length < TECHNICAL_AUDIT_CONFIG.MAX_LINK_TITLES
        ) {
          entry.linkRefs.push(ref);
        }
      }
    }

  }

  logger.info('CodeChanges grouped by page', {
    projectId,
    totalChanges: codeChanges.length,
    pagesWithChanges: grouped.size,
  });

  return grouped;
}

// ── Score calculation ──────────────────────────────────────────────────────

/**
 * Computes the raw audit score from CodeChange counts.
 * Called once after all pages are processed.
 */
async function computeAuditScoreInput(
  projectId: string,
  auditId:   string,
): Promise<AuditScoreInput> {
  // Count total CodeChanges per type (these were all pending = failures detected)
  const pipeline = [
    { $match: { projectId, auditId } },
    { $group: { _id: '$type', count: { $sum: 1 } } },
  ];

  // Use Mongoose aggregate on CodeChange
  const byType = await CodeChange.aggregate<{ _id: string; count: number }>(pipeline);

  const failedByType: Record<string, number> = {};
  let totalFailed = 0;

  for (const row of byType) {
    failedByType[row._id] = row.count;
    totalFailed += row.count;
  }

  // Real per-type totals, computed by site-crawl.job.ts from actual page
  // content and stored on the Audit record. NOT derived from
  // CodeChange.distinct('url', ...) — that would only count URLs that have
  // at least one failing check, silently excluding every page with zero
  // issues and undercounting the true page total.
  const audit = await Audit.findById(auditId).select('summary.checkTotals').lean();
  const totalByType = audit?.summary?.checkTotals ?? {};
  const totalOfAllTypes = Object.values(totalByType).reduce((sum, n) => sum + n, 0);

  logger.debug('Audit score input computed', {
    projectId,
    auditId,
    totalOfAllTypes,
    totalFailed,
    failedByType,
    totalByType,
  });

  return {
    totalByType,
    failedByType,
  };
}

// ── Main job handler ───────────────────────────────────────────────────────

export async function runTechnicalAuditJob(job: Job<PipelineJobData>): Promise<void> {
  const { projectId } = job.data;

  logger.info('Technical audit job started', { projectId, jobId: job.id });

  // 1. Load project for domain (needed for SEO score LLM call)
  const project = await Project.findById(projectId).lean();
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const siteUrl = `https://${project.domain}`;

  // 2. Find latest completed audit for this project
  //    site-crawl.job.ts creates the Audit and sets status: 'completed'
  const audit = await Audit.findOne({
    projectId,
    status: 'completed',
  }).sort({ performedAt: -1 }).lean();

  if (!audit) {
    throw new Error(
      `No completed audit found for project ${projectId}. ` +
      `Ensure SITE_CRAWL step completed successfully.`
    );
  }

  const auditId = String(audit._id);

  logger.info('Audit record found', {
    projectId,
    auditId,
    crawledPages: audit.crawledUrls?.length ?? 0,
    totalFixes:   audit.summary?.totalFixes ?? 0,
  });

  // 3. Read all pages from Redis — throws if cache expired → BullMQ retries
  const pages = await getAllPages(projectId);

  logger.info('Pages loaded from Redis', {
    projectId,
    count: pages.length,
  });

  // 4. Group pending CodeChanges by page URL
  const pageGroups = await groupCodeChangesByPage(projectId, auditId, pages);

  // 5. Build list of pages that need processing.
  //    Include ALL crawled pages — even those with no CodeChanges still need FAQ + TLDR.
  //    Pages with no changes AND no stubs → skip (nothing to do).
  const allCrawledUrls = pages.map(p => p.url);

  let totalCodeChangesUpdated = 0;
  let totalFaqsUpdated        = 0;
  let totalTldrsUpdated       = 0;
  let pagesProcessed          = 0;
  let pagesSkipped            = 0;
  let pagesFailed             = 0;

  logger.info('Starting per-page LLM processing', {
    projectId,
    totalPages:        allCrawledUrls.length,
    pagesWithChanges:  pageGroups.size,
  });

  // 6. Process each page sequentially — one LLM call per page
  for (let i = 0; i < allCrawledUrls.length; i++) {
    const url = allCrawledUrls[i]!;

    // Get CodeChange group for this page (may be undefined if no changes)
    const pageChanges = pageGroups.get(url) ?? {
      url,
      types:       [],
      changeIds:   {},
      imageSrcs:   [],
      title:        pages[i]?.title       ?? '',
      description:  '',
      textContent:  pages[i]?.textContent ?? '',
      linkRefs:     [],
      imageSrcById: {},
      linkRefById:  {},
      oldHtmlById:  {},
    };

    // Build what the LLM needs to generate for this page
    const { needs, imageSrcs } = buildPageNeeds(pageChanges);

    // If nothing to generate, skip LLM call entirely
    if (needs.length === 0) {
      logger.debug('Page has nothing for LLM to generate — skipping', {
        projectId, url, pageIndex: i + 1,
      });
      pagesSkipped++;
      continue;
    }

    logger.debug('Processing page with LLM', {
      projectId,
      url,
      pageIndex:   i + 1,
      totalPages:  allCrawledUrls.length,
      needs,
      imageSrcCount: imageSrcs.length,
    });

    try {
      // ONE LLM call per page
      const llmResult = await auditPage(
        url,
        pageChanges.title,
        pageChanges.description,
        pageChanges.textContent,
        needs,
        imageSrcs,
        pageChanges.linkRefs,
        projectId,
      );

      logger.debug('LLM audit response received for page', {
        projectId,
        url,
        hasTitle:        !!llmResult.title,
        hasDescription:  !!llmResult.description,
        hasOgTitle:      !!llmResult.ogTitle,
        hasSchema:       !!llmResult.schema,
        altTextCount:    Object.keys(llmResult.altTexts ?? {}).length,
        faqCount:        llmResult.faqQuestions?.length ?? 0,
        hasTldr:         !!llmResult.tldrText,
      });

      // Apply CodeChange updates (bulk write — one DB round trip)
      const updated = await applyCodeChanges(pageChanges, llmResult, projectId);
      totalCodeChangesUpdated += updated;

      // Apply FAQ update
      if (llmResult.faqQuestions && llmResult.faqQuestions.length > 0) {
        await applyFaqUpdate(projectId, auditId, url, llmResult);
        totalFaqsUpdated++;
      }

      // Apply TLDR update
      if (llmResult.tldrText) {
        await applyTldrUpdate(projectId, auditId, url, llmResult);
        totalTldrsUpdated++;
      }

      pagesProcessed++;

    } catch (err) {
      // Page-level failure — log and continue to next page.
      // Partial audit is better than no audit.
      // BullMQ retry will re-process only pages that still have pending CodeChanges.
      pagesFailed++;
      logger.error(
        err instanceof Error ? err : new Error(String(err)),
        {
          projectId,
          url,
          pageIndex: i + 1,
          context:   'technical-audit.page-processing',
        },
      );
    }

    // No manual rate-limit delay here — auditPage() (called above) already
    // enforces the global RPM ceiling internally via lib/llm.ts's
    // waitForRateLimit(). See LLM_RATE_LIMIT in seo-pipeline.constants.ts.
  }

  logger.info('Per-page LLM processing complete', {
    projectId,
    pagesProcessed,
    pagesSkipped,
    pagesFailed,
    totalCodeChangesUpdated,
    totalFaqsUpdated,
    totalTldrsUpdated,
  });

  // 7. Calculate SEO score
  //    Step 1: mechanical weighted score from real per-factor check totals
  //            (site-crawl.job.ts's checkTotals) — deterministic and
  //            reproducible: the same technical state always produces the
  //            same number, and each point change is attributable to an
  //            actual check passing/failing.
  //    Step 2: one LLM call for a one-sentence explanation of that score.
  //            The LLM does NOT set the score — a technical audit score
  //            shouldn't fluctuate based on an LLM's guess at "site fame"
  //            (that's how industry SEO audit tools work: Ahrefs Site
  //            Audit, SEMrush Site Health, Screaming Frog, and Lighthouse
  //            all compute their health/SEO scores mechanically from
  //            actual checks, not brand reputation).
  let score          = 1; // safe default if the mechanical calc itself fails
  let scoreReasoning = 'Score unavailable — audit calculation failed';

  try {
    const scoreInput = await computeAuditScoreInput(projectId, auditId);

    const { actualScore, totalPossible, weightedPassRate } = calculateWeightedScore(scoreInput);

    score = Math.min(100, Math.max(1, Math.round(weightedPassRate)));

    logger.info('Weighted score calculated', {
      projectId,
      actualScore,
      totalPossible,
      weightedPassRate,
      score,
    });

    // Reasoning is best-effort — if the LLM call fails we keep the real
    // mechanical score above instead of discarding it.
    try {
      const scoreLlm = await generateSeoScore(
        siteUrl,
        actualScore,
        totalPossible,
        weightedPassRate,
        projectId,
      );
      scoreReasoning = scoreLlm.reasoning;
    } catch (err) {
      scoreReasoning = `Weighted pass rate: ${weightedPassRate.toFixed(1)}% (${actualScore}/${totalPossible} weighted checks passed)`;
      logger.error(
        err instanceof Error ? err : new Error(String(err)),
        { projectId, context: 'technical-audit.score-reasoning' },
      );
    }

    logger.info('SEO score finalized', { projectId, score, scoreReasoning });

  } catch (err) {
    // Mechanical score failure is non-fatal — audit still completes with
    // the safe default above.
    logger.error(
      err instanceof Error ? err : new Error(String(err)),
      { projectId, context: 'technical-audit.score-calculation' },
    );
  }

  // 8. Update Audit summary with final counts + score
  await Audit.findByIdAndUpdate(auditId, {
    $set: {
      'summary.score':          score,
      'summary.scoreReasoning': scoreReasoning,
    },
  });

  logger.info('Technical audit job completed', {
    projectId,
    jobId:                  job.id,
    auditId,
    pagesProcessed,
    pagesSkipped,
    pagesFailed,
    totalCodeChangesUpdated,
    totalFaqsUpdated,
    totalTldrsUpdated,
    finalScore:             score,
    scoreReasoning,
  });
}
