/**
 * workers/jobs/geo-analytics.job.ts
 *
 * WHAT: Measures how often the project's domain is cited by AI engines
 *       when users ask queries related to the project's keywords.
 *
 * HOW IT WORKS (industry standard GEO measurement):
 *   1. Load project's published keywords (up to 20 — free Gemini tier)
 *   2. For each keyword, build a realistic user query (not the keyword itself)
 *   3. Send that query to Gemini as if a real user is asking
 *   4. Check if project's domain appears anywhere in Gemini's response
 *   5. objectivePercentage = (appearances / total prompts) * 100
 *   6. Store result in GeoAnalyticsRun for trend charts
 *
 * WHY GROQ COMPOUND-BETA FOR GEO MEASUREMENT:
 *   Groq's compound-beta model does live web search + returns real
 *   citations, which is what this needs (checking if the domain actually
 *   appears in an AI answer, not just guessing from training data).
 *   In production you'd also test ChatGPT + Perplexity for full coverage.
 *
 * RATE LIMITING:
 *   Sequential processing. No manual delay between calls — geoCitationCheck()
 *   enforces the global Groq RPM ceiling internally (lib/llm.ts).
 *
 * IDEMPOTENCY:
 *   Creates a new GeoAnalyticsRun each time — time-series data, not upserted.
 *   Safe to retry: a failed run creates a new run on retry (previous stays).
 *
 * ERROR HANDLING:
 *   - Per-keyword failure → logged, counted as failedPrompt, continue
 *   - Project/keyword missing → throws → BullMQ retries
 *   - Zero keywords → logs warning, records run with 0% score (valid state)
 */

import type { Job } from 'bullmq';
import { logger }          from '@/open-tele';
import { Project }         from '@/models/Project';
import { Keyword }         from '@/models/Keyword';
import { GeoAnalyticsRun } from '@/models/Analytics';
import { geoCitationCheck, GeoCitationLlmResponse } from '@/lib/llm';

const GEO_KEYWORD_LIMIT  = 20;   // Cap at 20 to stay within free Gemini tier
const DOMAIN_CHECK_CHARS = 4000; // Check first 4000 chars of Gemini response

/**
 * Build a realistic user query from a keyword.
 * We don't send the keyword verbatim — we simulate how a real user asks.
 */
function buildUserQuery(keyword: string): string {
  return `I'm looking for information about "${keyword}". Can you recommend the best options or resources? Please include specific websites or businesses if you know relevant ones.`;
}

/**
 * Check if the project's domain/brand appears in the LLM's structured
 * citation list, instead of substring-matching raw free text.
 * More accurate: catches brand mentions phrased differently, and avoids
 * false positives from coincidental substrings in unrelated text.
 */
function domainAppearsInCitations(
  sources: GeoCitationLlmResponse['mentionedSources'],
  domain:  string,
): boolean {
  const normalizedDomain = domain.replace(/^www\./, '').toLowerCase();
  const brandName = normalizedDomain.split('.')[0]!.replace(/-/g, ' ').toLowerCase();

  return sources.some(s => {
    const sourceDomain = s.domain?.replace(/^www\./, '').toLowerCase() ?? '';
    const sourceName   = s.name?.toLowerCase() ?? '';

    if (sourceDomain && sourceDomain.includes(normalizedDomain)) return true;
    if (brandName.length > 3 && sourceName.includes(brandName)) return true;

    return false;
  });
}

export async function runGeoAnalyticsJob(job: Job<{ projectId: string }>): Promise<void> {
  const { projectId } = job.data;

  logger.info('GEO analytics job started', { projectId, jobId: job.id });

  // 1. Load project
  const project = await Project.findById(projectId).lean();
  if (!project) throw new Error(`Project not found: ${projectId}`);

  // 2. Load previous run for prevObjectivePercentage trend
  const previousRun = await GeoAnalyticsRun.findOne({ projectId, status: 'completed' })
    .sort({ runAt: -1 })
    .lean();

  const prevObjectivePercentage = previousRun?.objectivePercentage ?? 0;

  // 3. Determine periodIndex
  const totalRuns  = await GeoAnalyticsRun.countDocuments({ projectId });
  const periodIndex = totalRuns; // 0-indexed: first run = 0, second = 1, etc.

  // 4. Create GeoAnalyticsRun record — status: running
  const run = await GeoAnalyticsRun.create({
    projectId,
    status:                  'running',
    periodIndex,
    prevObjectivePercentage,
    runAt:                   new Date(),
  });

  logger.info('GeoAnalyticsRun created', {
    projectId,
    runId:       String(run._id),
    periodIndex,
    prevScore:   prevObjectivePercentage,
  });

  // 5. Load published keywords — these are the ones we have content for
  const keywords = await Keyword.find({
    projectId,
    status: { $in: ['published', 'ready'] },
  })
    .sort({ alignmentScore: -1 })
    .limit(GEO_KEYWORD_LIMIT)
    .lean();

  if (keywords.length === 0) {
    logger.warn('No published keywords found for GEO analytics — recording 0% score', {
      projectId,
      runId: String(run._id),
    });

    await GeoAnalyticsRun.findByIdAndUpdate(run._id, {
      status:              'completed',
      evaluationPoolSize:  0,
      successfulPrompts:   0,
      failedPrompts:       0,
      totalAttempts:       0,
      objectivePercentage: 0,
      completedAt:         new Date(),
    });
    return;
  }

  logger.info('Keywords loaded for GEO evaluation', {
    projectId,
    runId:        String(run._id),
    keywordCount: keywords.length,
    keywords:     keywords.map(k => k.keyword),
  });

  // 6. For each keyword: send a user query to Groq compound-beta (live
  //    search + real citations), check if domain appears in actual results.
  let successfulPrompts = 0;
  let failedPrompts     = 0;
  let skippedNoSearch   = 0; // model answered without running search — excluded from the score, not a failure
  let domainAppearances = 0;

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i]!;
    const context = `geo-analytics:${projectId}:${keyword.keyword}`;

    try {
      const userQuery = buildUserQuery(keyword.keyword);

      logger.debug('Sending GEO query to Groq compound-beta (live search)', {
        projectId,
        keyword:   keyword.keyword,
        jobIndex:  i + 1,
        total:     keywords.length,
      });

      const citationResult = await geoCitationCheck(userQuery, projectId, keyword.keyword);

      // If the model didn't actually run a search, we have no real signal
      // for this query — don't count it as "checked, domain absent."
      // That would silently bias the score toward 0% exactly like the old
      // non-grounded bug this replaced. Exclude it instead.
      if (!citationResult.searchExecuted) {
        skippedNoSearch++;
        logger.warn('GEO query answered without executing a live search — excluding from score', {
          projectId,
          keyword: keyword.keyword,
        });
        continue;
      }

      const appeared = domainAppearsInCitations(citationResult.mentionedSources, project.domain);
      if (appeared) {
        domainAppearances++;
        logger.info('Domain appeared in live GEO search results', {
          projectId,
          keyword:  keyword.keyword,
          domain:   project.domain,
          appeared: true,
        });
      } else {
        logger.debug('Domain did not appear in live GEO search results', {
          projectId,
          keyword:  keyword.keyword,
          appeared: false,
        });
      }

      successfulPrompts++;

    } catch (err) {
      failedPrompts++;
      logger.warn('GEO prompt failed for keyword', {
        projectId,
        keyword: keyword.keyword,
        error:   err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 7. Calculate GEO score
  //    Denominator is successfulPrompts only — queries where search never
  //    ran (skippedNoSearch) are excluded from both numerator and
  //    denominator, since we have no real data for them either way.
  const totalAttempts        = successfulPrompts + failedPrompts + skippedNoSearch;
  const objectivePercentage  = successfulPrompts > 0
    ? Math.round((domainAppearances / successfulPrompts) * 100)
    : 0;

  // 8. Update run to completed
  await GeoAnalyticsRun.findByIdAndUpdate(run._id, {
    status:              'completed',
    evaluationPoolSize:  keywords.length,
    successfulPrompts,
    failedPrompts,
    totalAttempts,
    objectivePercentage,
    completedAt:         new Date(),
  });

  logger.info('GEO analytics job completed', {
    projectId,
    runId:               String(run._id),
    jobId:               job.id,
    keywordsEvaluated:   keywords.length,
    successfulPrompts,
    failedPrompts,
    skippedNoSearch,
    domainAppearances,
    objectivePercentage,
    prevScore:           prevObjectivePercentage,
    trend:               objectivePercentage - prevObjectivePercentage,
  });
}
