/**
 * workers/jobs/serp-research.job.ts
 *
 * WHAT: For each upcoming keyword, fetches the top 10 Google SERP results
 *       and runs LLM analysis to build a content brief.
 *
 * PIPELINE POSITION: Step 6 of 8
 * READS:  Keyword (status: 'upcoming', for this project)
 *         BusinessContext (for domain description — context for LLM)
 *         Project (for domain)
 * WRITES: Keyword.brief         — JSON-stringified SerpAnalysisLlmResponse
 *         Keyword.relevanceReason — overwritten with SERP-informed reasoning
 *         (status stays 'upcoming' — blog-generation.job.ts changes it to 'draft')
 *
 * WHAT "brief" STORES:
 *   A JSON string of SerpAnalysisLlmResponse.serpRelevance — an array of
 *   objects describing each top SERP result: title, topic, pageType, intent,
 *   whether it's a competitor, and relevance to the business ICP.
 *   blog-generation.job.ts reads this brief to write a better post than
 *   what already ranks.
 *
 * PROCESSING STRATEGY:
 *   Keywords are processed sequentially — each keyword = 1 SerpAPI call + 1 LLM call.
 *   Sequential (not parallel) to respect:
 *     - SerpAPI free tier: 100 searches/month
 *     - Gemini rate limit: 15 RPM (LLM_RATE_LIMIT.DELAY_MS between calls)
 *   For 25 keywords: ~25 SerpAPI calls + ~25 LLM calls.
 *   At 4.5s delay between LLM calls: ~2 minutes total. Acceptable for a pipeline step.
 *
 * PARTIAL FAILURE HANDLING:
 *   - SerpAPI fails for one keyword → log warn, skip, continue to next
 *     (keyword stays with empty brief — blog-generation still runs, just weaker)
 *   - LLM fails for one keyword → log warn, skip, continue to next
 *   - Both fail → keyword gets no brief → blog-generation uses keyword alone
 *   We never throw mid-loop — partial briefs are better than no briefs.
 *   Only throw if BusinessContext is missing (unrecoverable without retry).
 *
 * IDEMPOTENCY:
 *   Uses Keyword.findByIdAndUpdate — safe to retry.
 *   Brief is always overwritten on retry (fresh SERP data is fine).
 *
 * RATE LIMITING:
 *   LLM_RATE_LIMIT.DELAY_MS between each LLM call (4500ms).
 *   No extra delay between SerpAPI calls — free tier is per-month, not per-second.
 */

import type { Job } from 'bullmq';
import { logger }          from '@/open-tele';
import { Project }         from '@/models/Project';
import { BusinessContext } from '@/models/BusinessContext';
import { Keyword }         from '@/models/Keyword';
import { searchOrganic }   from '@/lib/serp';
import { analyzeSerpResults } from '@/lib/llm';
import { deriveCountryCodeFromRegions } from '@/lib/serp';
import type { PipelineJobData } from '../seo-pipeline.worker';
import { LLM_RATE_LIMIT }  from '@/constants/seo-pipeline.constants';

// ── Main job handler ───────────────────────────────────────────────────────

export async function runSerpResearchJob(job: Job<PipelineJobData>): Promise<void> {
  const { projectId } = job.data;

  logger.info('SERP research job started', { projectId, jobId: job.id });

  // 1. Load project
  const project = await Project.findById(projectId).lean();
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  // 2. Load BusinessContext — needed for domain description (LLM context)
  const bc = await BusinessContext.findOne({ projectId }).lean();
  if (!bc) {
    throw new Error(
      `BusinessContext not found for project ${projectId}. ` +
      `Ensure BUSINESS_PROFILE step completed successfully.`
    );
  }

  // Build domain description for LLM — same pattern as keyword-research.job.ts
  const domainDescription = [
    bc.product?.whatItSells,
    bc.customers?.topUseCases,
    bc.competition?.differentiation,
  ].filter(Boolean).join('\n');

  // Derive country code for localised SERP results
  const countryCode = deriveCountryCodeFromRegions(
    bc.company?.targetRegions as string[] | undefined,
    projectId,
  );

  // 3. Load all upcoming keywords for this project
  //    These are the keywords keyword-research.job.ts created.
  //    We only process 'upcoming' — if retried, skip already-briefed keywords
  //    by checking brief field (re-fetch is fine — SERP data refreshes are good).
  const keywords = await Keyword.find({
    projectId,
    status: 'upcoming',
  })
    .sort({ alignmentScore: -1 }) // highest alignment first — most important keywords briefed first
    .lean();

  if (keywords.length === 0) {
    logger.warn('No upcoming keywords found for SERP research — step completes with no-op', {
      projectId,
    });
    return;
  }

  logger.info('Keywords loaded for SERP research', {
    projectId,
    keywordCount: keywords.length,
    countryCode,
    domainDescriptionLength: domainDescription.length,
  });

  // 4. Process each keyword — SerpAPI fetch + LLM analysis
  let successCount = 0;
  let skipCount    = 0;

  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i]!;
    const kwId = String(kw._id);

    logger.debug('Processing keyword for SERP research', {
      projectId,
      keywordId:    kwId,
      keyword:      kw.keyword,
      index:        i + 1,
      total:        keywords.length,
    });

    // ── Step A: Fetch SERP results ─────────────────────────────────────

    let serpResults: Awaited<ReturnType<typeof searchOrganic>> | null = null;

    try {
      serpResults = await searchOrganic(
        kw.keyword,
        countryCode,
        projectId,
        10, // top 10 results — standard for content brief analysis
      );

      logger.debug('SERP results fetched for keyword', {
        projectId,
        keywordId:    kwId,
        keyword:      kw.keyword,
        resultCount:  serpResults.organicResults.length,
        totalResults: serpResults.totalResults,
      });

    } catch (err) {
      // Non-fatal — skip this keyword's brief, continue pipeline
      logger.warn('SerpAPI call failed for keyword — skipping brief', {
        projectId,
        keywordId: kwId,
        keyword:   kw.keyword,
        error:     err instanceof Error ? err.message : String(err),
      });
      skipCount++;
      continue;
    }

    // ── Step B: Format SERP results for LLM ───────────────────────────

    // Serialize organic results into a string the LLM prompt can consume.
    // Format: numbered list of title + URL + snippet per result.
    const serpResultsText = serpResults.organicResults
      .map((r, idx) =>
        `${idx + 1}. Title: ${r.title}\n   URL: ${r.link}\n   Snippet: ${r.snippet}`
      )
      .join('\n\n');

    if (!serpResultsText.trim()) {
      logger.warn('SERP results empty for keyword — skipping LLM analysis', {
        projectId,
        keywordId: kwId,
        keyword:   kw.keyword,
      });
      skipCount++;
      continue;
    }

    // ── Step C: LLM analysis ───────────────────────────────────────────

    let analysis: Awaited<ReturnType<typeof analyzeSerpResults>> | null = null;

    try {
      analysis = await analyzeSerpResults(
        kw.keyword,
        serpResultsText,
        domainDescription,
        projectId,
      );

      logger.debug('LLM SERP analysis completed for keyword', {
        projectId,
        keywordId:       kwId,
        keyword:         kw.keyword,
        serpRelevanceCount: analysis.serpRelevance.length,
      });

    } catch (err) {
      // Non-fatal — keyword gets no brief, blog-generation will still run
      logger.warn('LLM SERP analysis failed for keyword — skipping brief', {
        projectId,
        keywordId: kwId,
        keyword:   kw.keyword,
        error:     err instanceof Error ? err.message : String(err),
      });
      skipCount++;

      // Still apply rate limit delay before next iteration
      if (i < keywords.length - 1) {
        await new Promise(resolve => setTimeout(resolve, LLM_RATE_LIMIT.DELAY_MS));
      }
      continue;
    }

    // ── Step D: Persist brief to Keyword ──────────────────────────────

    // brief: JSON string of serpRelevance array
    // relevanceReason: summary of whether top results are relevant to ICP
    // — overwrite the alignment-scoring reason with SERP-informed reasoning
    const relevantCount = analysis.serpRelevance.filter(r => r.isRelevantToICP).length;
    const serpReason = `${relevantCount}/${analysis.serpRelevance.length} top SERP results relevant to ICP.`;

    try {
      await Keyword.findByIdAndUpdate(
        kw._id,
        {
          $set: {
            brief:           JSON.stringify(analysis.serpRelevance),
            relevanceReason: serpReason,
          },
        },
        { runValidators: false },
      );

      successCount++;

      logger.debug('Keyword brief saved', {
        projectId,
        keywordId:      kwId,
        keyword:        kw.keyword,
        relevantCount,
        totalResults:   analysis.serpRelevance.length,
      });

    } catch (err) {
      // DB write failure — log and continue (brief missing is non-fatal)
      logger.warn('Failed to save SERP brief for keyword', {
        projectId,
        keywordId: kwId,
        keyword:   kw.keyword,
        error:     err instanceof Error ? err.message : String(err),
      });
      skipCount++;
    }

    // ── Step E: Rate limit delay ───────────────────────────────────────
    // Apply after LLM call, skip after last keyword
    if (i < keywords.length - 1) {
      await new Promise(resolve => setTimeout(resolve, LLM_RATE_LIMIT.DELAY_MS));
    }
  }

  logger.info('SERP research job completed', {
    projectId,
    jobId:        job.id,
    total:        keywords.length,
    successCount,
    skipCount,
    briefCoverage: `${successCount}/${keywords.length}`,
  });
}
