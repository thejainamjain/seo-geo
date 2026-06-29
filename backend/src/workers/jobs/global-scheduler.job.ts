/**
 * workers/jobs/global-scheduler.job.ts
 *
 * WHAT: Three global cron jobs that fan out work to per-project queues.
 *
 * PATTERN (industry standard):
 *   One repeatable job fires on schedule → loads all active projects →
 *   enqueues individual jobs per project → workers process with concurrency.
 *
 * WHY ONE GLOBAL JOB (not per-project crons):
 *   - 100 projects × per-project crons = 100 simultaneous bursts at schedule time
 *   - Global fan-out = controlled, rate-limited, observable
 *   - One place to change the schedule for all projects
 *   - BullMQ repeatable jobs are simpler to manage as singletons
 *
 * THREE SCHEDULERS:
 *
 *   1. CMS_PUBLISH_SCHEDULER — daily Mon–Sat at 17:00 UTC
 *      Finds all projects with CMS connected + autoPublish on
 *      Enqueues one cms-publish job per project
 *
 *   2. GEO_ANALYTICS_SCHEDULER — every Monday at 10:00 UTC
 *      Finds all projects with at least one published keyword
 *      Enqueues one geo-analytics job per project
 *
 *   3. GSC_MONITOR_SCHEDULER — every Monday at 11:00 UTC
 *      Finds all projects with GSC connected + published blogs
 *      Enqueues one gsc-monitor job per project
 *
 * IDEMPOTENCY:
 *   Per-project jobs use jobId: `{type}:{projectId}:{date}` so the same
 *   project is never double-enqueued on the same day even if scheduler retries.
 */

import { Queue }         from 'bullmq';
import { logger }        from '@/open-tele';
import { Project }       from '@/models/Project';
import { CmsConfig }     from '@/models/CmsConfig';
import { GoogleToken }   from '@/models/GoogleToken';
import { Keyword }       from '@/models/Keyword';
import { Blog }          from '@/models/Blog';
import { getConnectionOptions } from '@/loaders/redis';
import { QUEUE_NAMES }   from '@/constants/seo-pipeline.constants';

// ── Queue instances for fan-out ────────────────────────────────────────────

const cmsPublishQueue = new Queue<{ projectId: string }>(QUEUE_NAMES.CMS_PUBLISH_CRON, {
  connection: getConnectionOptions(),
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 200 },
  },
});

const geoAnalyticsQueue = new Queue<{ projectId: string }>(QUEUE_NAMES.GEO_ANALYTICS, {
  connection: getConnectionOptions(),
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 200 },
  },
});

const gscMonitorQueue = new Queue<{ projectId: string }>(QUEUE_NAMES.GSC_MONITOR, {
  connection: getConnectionOptions(),
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 200 },
  },
});

// ── Date key for idempotent job IDs ───────────────────────────────────────

function todayKey(): string {
  return new Date().toISOString().split('T')[0]!; // "2026-06-29"
}

// ── Scheduler 1: CMS publish fan-out ──────────────────────────────────────

export async function runCmsPublishScheduler(): Promise<void> {
  logger.info('CMS publish scheduler started');

  // Find all projects with CMS connected
  const cmsConfigs = await CmsConfig.find({
    cmsType:             { $exists: true, $ne: null },
    encryptedCredentials: { $exists: true, $ne: null },
    autoPublish:         true,
  }).select('projectId allowedPublishDays publishHourUtc').lean();

  if (cmsConfigs.length === 0) {
    logger.info('CMS publish scheduler: no projects with autoPublish enabled');
    return;
  }

  const todayUtc = new Date().getUTCDay();
  const hourUtc  = new Date().getUTCHours();
  const dateKey  = todayKey();

  let enqueued = 0;
  let skipped  = 0;

  for (const config of cmsConfigs) {
    const projectId  = String(config.projectId);
    const allowedDays    = config.allowedPublishDays ?? [1, 2, 3, 4, 5, 6];
    const publishHourUtc = config.publishHourUtc     ?? 17;

    // Check day + hour
    if (!allowedDays.includes(todayUtc) || hourUtc < publishHourUtc) {
      skipped++;
      continue;
    }

    await cmsPublishQueue.add(
      `cms-publish:${projectId}`,
      { projectId },
      {
        jobId:    `cms-publish:${projectId}:${dateKey}`,
        attempts: 3,
        backoff:  { type: 'exponential', delay: 30_000 },
      },
    );
    enqueued++;
  }

  logger.info('CMS publish scheduler completed', {
    total:    cmsConfigs.length,
    enqueued,
    skipped,
  });
}

// ── Scheduler 2: GEO analytics fan-out ────────────────────────────────────

export async function runGeoAnalyticsScheduler(): Promise<void> {
  logger.info('GEO analytics scheduler started');

  // Find all projects with at least one published or ready keyword
  const projectIds = await Keyword.distinct('projectId', {
    status: { $in: ['published', 'ready'] },
  }) as unknown as string[];

  if (projectIds.length === 0) {
    logger.info('GEO analytics scheduler: no projects with published keywords');
    return;
  }

  const dateKey = todayKey();
  let enqueued  = 0;

  for (const projectId of projectIds) {
    await geoAnalyticsQueue.add(
      `geo-analytics:${projectId}`,
      { projectId: String(projectId) },
      {
        jobId:    `geo-analytics:${projectId}:${dateKey}`,
        attempts: 3,
        backoff:  { type: 'exponential', delay: 15_000 },
      },
    );
    enqueued++;
  }

  logger.info('GEO analytics scheduler completed', { enqueued });
}

// ── Scheduler 3: GSC monitor fan-out ──────────────────────────────────────

export async function runGscMonitorScheduler(): Promise<void> {
  logger.info('GSC monitor scheduler started');

  // Find all projects with GSC connected (have a GoogleToken)
  const tokens = await GoogleToken.find({}).select('projectId').lean();

  if (tokens.length === 0) {
    logger.info('GSC monitor scheduler: no projects with GSC connected');
    return;
  }

  // Filter: only projects with published blogs (no point monitoring if nothing published)
  const projectIds = tokens.map(t => String(t.projectId));

  const publishedProjectIds = await Blog.distinct('projectId', {
    projectId: { $in: projectIds },
    status:    'published',
  }) as unknown as string[];

  if (publishedProjectIds.length === 0) {
    logger.info('GSC monitor scheduler: no projects with published blogs');
    return;
  }

  const dateKey = todayKey();
  let enqueued  = 0;

  for (const projectId of publishedProjectIds) {
    await gscMonitorQueue.add(
      `gsc-monitor:${projectId}`,
      { projectId: String(projectId) },
      {
        jobId:    `gsc-monitor:${projectId}:${dateKey}`,
        attempts: 3,
        backoff:  { type: 'exponential', delay: 15_000 },
      },
    );
    enqueued++;
  }

  logger.info('GSC monitor scheduler completed', { enqueued });
}
