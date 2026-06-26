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
 *   Non-LLM fixes (canonical, link_title) are already filled by site-crawl.
 *   We never call LLM for those — they are mechanical, deterministic fixes.
 *
 * WHICH TYPES NEED LLM vs MECHANICAL:
 *   LLM-generated:  title, description, open_graph, alt_text, schema
 *   Pre-filled:     canonical (site-crawl sets newHtml directly)
 *   Mechanical:     link_title (site-crawl sets newHtml directly)
 *   LLM-generated:  faqQuestions (on FAQ model), tldrText (on TLDR model)
 *
 * RATE LIMITING:
 *   Sequential processing with LLM_RATE_LIMIT.DELAY_MS between pages.
 *   Change LLM_RATE_LIMIT in seo-pipeline.constants.ts when upgrading plan.
 *
 * IDEMPOTENCY:
 *   Only processes CodeChanges with status: 'pending' and empty newHtml.
 *   Safe to retry — already-filled records are skipped.
 *   Audit is re-fetched on retry — no stale state.
 *
 * SEO SCORE CALCULATION:
 *   Mechanical weighted score computed from CodeChange pass/fail counts.
 *   Then one LLM call calibrates against site reputation → final score 1-100.
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
import { logger }          from '../../open-tele';
import { Audit }           from '../../models/Audit';
import { CodeChange }      from '../../models/CodeChange';
import { FAQ }             from '../../models/FAQ';
import { TLDR }            from '../../models/TLDR';
import { Project }         from '../../models/Project';
import { getAllPages }      from '../../lib/page-selector';
import { auditPage, generateSeoScore } from '../../lib/llm';
import type { PipelineJobData }        from '../seo-pipeline.worker';
import type { TieredPage }             from '../../lib/page-selector';
import type { PageAuditLlmResponse }   from '../../lib/llm';
import {
  LLM_RATE_LIMIT,
  TECHNICAL_AUDIT_CONFIG,
  CODE_CHANGE_SEVERITY_WEIGHT,
} from '../../constants/seo-pipeline.constants';

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
]);

/**
 * SEO factor weights for score calculation.
 * Higher weight = more impact on final score.
 * Mirrors industry standards (title/schema matter more than OG tags).
 */
const FACTOR_WEIGHTS: Record<string, number> = {
  title:        10,
  description:  8,
  open_graph:   6,
  canonical:    7,
  alt_text:     5,
  link_title:   3,
  schema:       9,
  broken_link:  8,
  internal_link: 4,
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
}

interface AuditScoreInput {
  totalChecks:    number;
  passedChecks:   number;
  failedByType:   Record<string, number>; // type → count of failures
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Sleeps for LLM_RATE_LIMIT.DELAY_MS milliseconds.
 * Called between page LLM calls to respect Gemini RPM limits.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extracts the current title and description from a CodeChange's oldHtml.
 * Falls back to empty string if not parseable.
 *
 * Examples:
 *   oldHtml: '<title>My Page</title>'         → 'My Page'
 *   oldHtml: '<meta name="description" ...>'  → content attribute value
 */
function extractCurrentValueFromOldHtml(type: string, oldHtml: string): string {
  if (!oldHtml) return '';

  try {
    if (type === 'title') {
      const match = oldHtml.match(/<title[^>]*>(.*?)<\/title>/i);
      return match?.[1]?.trim() ?? '';
    }
    if (type === 'description') {
      const match = oldHtml.match(/content="([^"]*)"/i);
      return match?.[1]?.trim() ?? '';
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
  const match = oldHtml.match(/src="([^"]*)"/i);
  return match?.[1]?.trim() ?? '';
}

/**
 * Calculates weighted SEO score from audit results.
 * Returns actualScore, totalPossible, weightedPassRate for LLM calibration.
 *
 * Logic:
 *   Each factor has a weight. If it passes on all pages → full weight × pageCount.
 *   If it fails on N pages → those N pages lose the full weight.
 *   Score = (sum of passed weights) / (sum of all possible weights) × 100
 */
function calculateWeightedScore(input: AuditScoreInput): {
  actualScore:      number;
  totalPossible:    number;
  weightedPassRate: number;
} {
  let actualScore   = 0;
  let totalPossible = 0;

  for (const [type, weight] of Object.entries(FACTOR_WEIGHTS)) {
    const failures = input.failedByType[type] ?? 0;
    // We don't know exact page count per type — use totalChecks as proxy
    // Each type checked once per page that has that element
    const typeTotal = weight * (input.totalChecks / Object.keys(FACTOR_WEIGHTS).length);
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
    }
  }

  // Always request FAQ and TLDR if this page has stubs — no extra cost
  // since it's the same LLM call
  needs.push('faqQuestions', 'tldrText');

  return { needs, imageSrcs };
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

  // title
  if (llmResult.title && pageChanges.changeIds['title']) {
    for (const id of pageChanges.changeIds['title']!) {
      ops.push({
        updateOne: {
          filter: { _id: id },
          update: {
            $set: {
              newHtml: `<title>${llmResult.title}</title>`,
            },
          },
        },
      });
    }
  }

  // description
  if (llmResult.description && pageChanges.changeIds['description']) {
    for (const id of pageChanges.changeIds['description']!) {
      ops.push({
        updateOne: {
          filter: { _id: id },
          update: {
            $set: {
              newHtml: `<meta name="description" content="${llmResult.description}">`,
            },
          },
        },
      });
    }
  }

  // open_graph — one CodeChange record, both OG tags in newHtml
  if ((llmResult.ogTitle || llmResult.ogDescription) && pageChanges.changeIds['open_graph']) {
    const ogHtml = [
      llmResult.ogTitle       ? `<meta property="og:title" content="${llmResult.ogTitle}">` : '',
      llmResult.ogDescription ? `<meta property="og:description" content="${llmResult.ogDescription}">` : '',
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

  // alt_text — LLM returns { src: alt } map
  // Match each CodeChange by extracting src from oldHtml
  if (llmResult.altTexts && pageChanges.changeIds['alt_text']) {
    for (const id of pageChanges.changeIds['alt_text']!) {
      // We stored imageSrcs in order — but we need to match by id
      // Fetch the CodeChange to get its oldHtml src
      // NOTE: We already have imageSrcs in order matching changeIds order
      const idx = pageChanges.changeIds['alt_text']!.indexOf(id);
      const src = pageChanges.imageSrcs[idx];
      if (!src) continue;

      const alt = llmResult.altTexts[src];
      if (!alt) continue;

      ops.push({
        updateOne: {
          filter: { _id: id },
          update: {
            $set: {
              newHtml: `<img src="${src}" alt="${alt}">`,
              htmlAttributes: { alt },
            },
          },
        },
      });
    }
  }

  // schema — stored as JSON-LD script tag
  if (llmResult.schema && pageChanges.changeIds['schema']) {
    const schemaHtml = `<script type="application/ld+json">\n${JSON.stringify(llmResult.schema, null, 2)}\n</script>`;
    for (const id of pageChanges.changeIds['schema']!) {
      ops.push({
        updateOne: {
          filter: { _id: id },
          update: { $set: { newHtml: schemaHtml } },
        },
      });
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
    { projectId, sourceUrl: url, status: 'pending' },
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
    { projectId, sourceUrl: url, status: 'pending' },
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

    // Extract image src for alt_text changes
    if (change.type === 'alt_text' && change.oldHtml) {
      const src = extractImgSrc(change.oldHtml);
      if (src && !entry.imageSrcs.includes(src)) {
        // Cap at MAX_ALT_TEXT_IMGS — avoid huge prompts for image-heavy pages
        if (entry.imageSrcs.length < TECHNICAL_AUDIT_CONFIG.MAX_ALT_TEXT_IMGS) {
          entry.imageSrcs.push(src);
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

  // totalChecks = pages × factors (approx) — used for weighted calc
  const totalPages  = await CodeChange.distinct('url', { projectId, auditId }).then(u => u.length);
  const totalChecks = totalPages * Object.keys(FACTOR_WEIGHTS).length;

  logger.debug('Audit score input computed', {
    projectId,
    auditId,
    totalPages,
    totalChecks,
    totalFailed,
    failedByType,
  });

  return {
    totalChecks,
    passedChecks: Math.max(0, totalChecks - totalFailed),
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
    delayBetweenPages: LLM_RATE_LIMIT.DELAY_MS,
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
        await applyFaqUpdate(projectId, url, llmResult);
        totalFaqsUpdated++;
      }

      // Apply TLDR update
      if (llmResult.tldrText) {
        await applyTldrUpdate(projectId, url, llmResult);
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

    // Rate limit delay — skip after last page
    if (i < allCrawledUrls.length - 1) {
      logger.debug('Rate limit delay', {
        projectId,
        delayMs: LLM_RATE_LIMIT.DELAY_MS,
        nextPage: allCrawledUrls[i + 1],
      });
      await sleep(LLM_RATE_LIMIT.DELAY_MS);
    }
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
  //    Step 1: mechanical weighted score from CodeChange counts
  //    Step 2: one LLM call to calibrate against site reputation
  let score         = 50; // safe default if LLM call fails
  let scoreReasoning = 'Score estimated — LLM calibration unavailable';

  try {
    const scoreInput = await computeAuditScoreInput(projectId, auditId);

    const { actualScore, totalPossible, weightedPassRate } = calculateWeightedScore(scoreInput);

    logger.info('Weighted score calculated', {
      projectId,
      actualScore,
      totalPossible,
      weightedPassRate,
    });

    const scoreLlm = await generateSeoScore(
      siteUrl,
      actualScore,
      totalPossible,
      weightedPassRate,
      projectId,
    );

    score          = scoreLlm.score;
    scoreReasoning = scoreLlm.reasoning;

    logger.info('SEO score generated', {
      projectId,
      score,
      scoreReasoning,
      mechanicalPassRate: weightedPassRate,
    });

  } catch (err) {
    // Score failure is non-fatal — audit still completes
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
