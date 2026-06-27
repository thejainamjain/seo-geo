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
 * WHY GEMINI FOR GEO MEASUREMENT:
 *   We use the same Gemini API we already have — no extra cost.
 *   In production you'd also test ChatGPT + Perplexity for full coverage.
 *   For v1, Gemini-only gives a meaningful directional signal.
 *
 * RATE LIMITING:
 *   Sequential processing with delay between calls.
 *   Gemini free tier: 15 RPM → 4000ms delay between calls is safe.
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
import { callGemini }      from '@/lib/llm';
import { LLM_RATE_LIMIT }  from '@/constants/seo-pipeline.constants';

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
 * Check if the project's domain appears in the AI response.
 * Checks the first DOMAIN_CHECK_CHARS characters — AI citations are usually near the top.
 */
function domainAppearsInResponse(response: string, domain: string): boolean {
  const haystack = response.slice(0, DOMAIN_CHECK_CHARS).toLowerCase();

  // Strip www. for flexible matching
  const normalizedDomain = domain.replace(/^www\./, '').toLowerCase();

  // Check 1: exact domain mention (example.com)
  if (haystack.includes(normalizedDomain)) return true;

  // Check 2: brand name extracted from domain
  // "cleaningpro.in" → "cleaningpro", "rank-ai.com" → "rank ai"
  const brandName = normalizedDomain
    .split('.')[0]!
    .replace(/-/g, ' ')
    .toLowerCase();

  if (brandName.length > 3 && haystack.includes(brandName)) return true;

  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // 6. For each keyword: send a user query to Gemini, check if domain appears
  let successfulPrompts = 0;
  let failedPrompts     = 0;
  let domainAppearances = 0;

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i]!;
    const context = `geo-analytics:${projectId}:${keyword.keyword}`;

    // Rate limit — stay under Gemini free tier (15 RPM)
    if (i > 0) {
      await delay(LLM_RATE_LIMIT.DELAY_MS);
    }

    try {
      const userQuery = buildUserQuery(keyword.keyword);

      logger.debug('Sending GEO query to Gemini', {
        projectId,
        keyword:   keyword.keyword,
        jobIndex:  i + 1,
        total:     keywords.length,
      });

      // Send as a plain conversation — no JSON extraction needed
      // We're measuring if the domain appears in free-form AI response
      const response = await callGemini(
        `You are a helpful AI assistant. Answer the user's question naturally and helpfully. Include specific website recommendations if you know relevant ones.`,
        userQuery,
        context,
      );

      const appeared = domainAppearsInResponse(response, project.domain);

      if (appeared) {
        domainAppearances++;
        logger.info('Domain appeared in GEO response', {
          projectId,
          keyword:  keyword.keyword,
          domain:   project.domain,
          appeared: true,
        });
      } else {
        logger.debug('Domain did not appear in GEO response', {
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
  const totalAttempts        = successfulPrompts + failedPrompts;
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
    domainAppearances,
    objectivePercentage,
    prevScore:           prevObjectivePercentage,
    trend:               objectivePercentage - prevObjectivePercentage,
  });
}
