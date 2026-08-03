/**
 * workers/jobs/keyword-ranking-sync.job.ts
 *
 * WHAT: Fetches Google Search Console's property-wide query-dimension
 *       Search Analytics data, matches each query row to a tracked
 *       Keyword by exact (case-insensitive) text match, and upserts one
 *       KeywordRanking snapshot per matched keyword per day.
 *
 * BACKS: the Analytics page's "Ranked" summary card, "Top Movers"
 *        (position improved vs. the previous snapshot), and the "Keyword
 *        Performance" table — see models/KeywordRanking.ts for why this
 *        needed its own persisted collection rather than reusing
 *        BlogLearning or computing live on page load.
 *
 * WHY A SEPARATE JOB FROM gsc-monitor.job.ts (not just added to it):
 *   gsc-monitor.job.ts queries GSC per PAGE (dimensions: ['page'] /
 *   ['page','query'] filtered to one URL) to evaluate one blog's
 *   performance for the learning/rewrite loop. This job queries GSC
 *   per QUERY, property-wide, with no page filter — a fundamentally
 *   different question ("which of our tracked keywords are appearing in
 *   search at all, and where") that doesn't fit inside the per-blog loop
 *   without either running an extra query per blog (redundant, most
 *   keywords aren't 1:1 with a single page) or restructuring that job's
 *   whole per-blog design. They do share the same GSC access token
 *   logic — see lib/gsc-client.ts, used by both.
 *
 * MATCHING: GSC returns raw query strings. We match them to Keyword docs
 * by exact, case-insensitive text match. A GSC query that doesn't match
 * any tracked keyword is not recorded — see models/KeywordRanking.ts.
 *
 * IDEMPOTENCY: upserts on { keywordId, date } (unique index on the
 * model), so re-running the same day (BullMQ retry, or a manual re-run)
 * overwrites that day's row rather than creating a duplicate.
 *
 * ERROR HANDLING: same posture as gsc-monitor.job.ts —
 *   - No GSC token → log + skip (not an error, GSC may be disconnected)
 *   - No tracked keywords → log + skip
 *   - GSC API failure → querySearchAnalytics() returns [] and this job
 *     logs zero matches; the BullMQ retry (3 attempts) handles transient
 *     failures at the fetch layer, this job doesn't need its own retry logic
 */

import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { logger } from '@/open-tele';
import { Project, Keyword, KeywordRanking } from '@/models';
import { getValidAccessToken, querySearchAnalytics } from '@/lib/gsc-client';

const LOOKBACK_DAYS = 28;   // same reporting window as gsc-monitor.job.ts
const ROW_LIMIT      = 5000; // GSC's hard cap is 25,000; no project here has anywhere near that many distinct queries

function todayUtcMidnight(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function runKeywordRankingSyncJob(job: Job<{ projectId: string }>): Promise<void> {
  const { projectId } = job.data;

  // Defense in depth — same guard as runGeoAnalyticsJob / runGscMonitorJob.
  if (!projectId) {
    throw new UnrecoverableError(
      `Keyword ranking sync job ${job.id} received no projectId — refusing to retry`,
    );
  }

  logger.info('Keyword ranking sync job started', { projectId, jobId: job.id });

  // 1. Load project
  const project = await Project.findById(projectId).lean();
  if (!project) throw new Error(`Project not found: ${projectId}`);

  // 2. Load a valid GSC access token
  const accessToken = await getValidAccessToken(projectId);
  if (!accessToken) {
    logger.warn('No GSC token found for project — skipping keyword ranking sync', { projectId });
    return; // Not an error — user may have disconnected GSC
  }

  // 3. Load tracked keywords
  const keywords = await Keyword.find({ projectId }).select('keyword').lean();
  if (keywords.length === 0) {
    logger.info('No tracked keywords for project — skipping keyword ranking sync', { projectId });
    return;
  }

  // 4. Query GSC — property-wide, query dimension, no page filter
  const siteUrl   = `sc-domain:${project.domain}`;
  const endDate   = new Date();
  const startDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const formatDate = (d: Date) => d.toISOString().split('T')[0]!;

  const rows = await querySearchAnalytics(
    siteUrl,
    accessToken,
    {
      startDate:  formatDate(startDate),
      endDate:    formatDate(endDate),
      dimensions: ['query'],
      rowLimit:   ROW_LIMIT,
      orderBy:    [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
    },
    projectId,
  );

  if (rows.length === 0) {
    logger.info('No GSC query data returned — skipping keyword ranking sync', { projectId });
    return;
  }

  // 5. Index GSC rows by lowercased query text for O(1) matching
  const rowsByQuery = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const query = row.keys[0];
    if (query) rowsByQuery.set(query.toLowerCase().trim(), row);
  }

  // 6. Match each tracked keyword to a GSC row and upsert a snapshot
  const date = todayUtcMidnight();
  let matchedCount   = 0;
  let unmatchedCount = 0;

  for (const kw of keywords) {
    const row = rowsByQuery.get(kw.keyword.toLowerCase().trim());
    if (!row) {
      unmatchedCount++;
      continue;
    }

    await KeywordRanking.findOneAndUpdate(
      { keywordId: kw._id, date },
      {
        $set: {
          projectId,
          position:    row.position,
          clicks:      row.clicks,
          impressions: row.impressions,
          ctr:         row.ctr,
        },
      },
      { upsert: true },
    );
    matchedCount++;
  }

  logger.info('Keyword ranking sync job completed', {
    projectId,
    jobId:          job.id,
    keywordsTotal:  keywords.length,
    matchedCount,
    unmatchedCount,
  });
}
