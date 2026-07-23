/**
 * workers/scheduler.worker.ts
 *
 * WHAT: Boots the global repeatable cron jobs (schedulers) and
 *       three per-project workers that process the fanned-out jobs.
 *
 * SCHEDULERS:
 *   geo-analytics-scheduler → every Monday 10:00 UTC (global fan-out)
 *   gsc-monitor-scheduler  → every Monday 11:00 UTC (global fan-out)
 *
 *   CMS publishing is NOT a global fan-out scheduler anymore — each
 *   project has its OWN BullMQ Job Scheduler at its own publishHourUtc /
 *   allowedPublishDays, created/updated by cms.service.ts (see
 *   lib/cms-publish-scheduler.ts for why — short version: a single fixed
 *   daily trigger can't correctly serve projects with different publish
 *   hours). On boot, reconcileCmsPublishSchedules() re-asserts every
 *   autoPublish:true project's schedule — idempotent, safe on every
 *   restart, and is what migrates existing projects onto this design.
 *
 * WORKERS (process fanned-out per-project jobs):
 *   cmsPublishWorker    → processes seo-cms-publish queue
 *   geoAnalyticsWorker  → processes seo-geo-analytics queue
 *   gscMonitorWorker    → processes seo-gsc-monitor queue
 *
 * BOOT: Called once from worker.ts on startup.
 *       Registers scheduler jobs with BullMQ repeat — idempotent,
 *       safe to call on every restart.
 */

import { Worker, Queue, type Job } from 'bullmq';
import { logger }                   from '@/open-tele';
import { getConnectionOptions }     from '@/loaders/redis';
import { QUEUE_NAMES }              from '@/constants/seo-pipeline.constants';
import {
  runGeoAnalyticsScheduler,
  runGscMonitorScheduler,
} from './jobs/global-scheduler.job';
import { reconcileCmsPublishSchedules } from '@/lib/cms-publish-scheduler';
import { runWeeklyGenerationTrigger }   from '@/lib/keyword-generation-scheduler';
import { runCmsPublishJob, type CmsPublishJobData } from './jobs/cms-publish.job';
import { runGeoAnalyticsJob } from './jobs/geo-analytics.job';
import { runGscMonitorJob }   from './jobs/gsc-monitor.job';

// ── Scheduler queue ────────────────────────────────────────────────────────
// One queue for all three scheduler jobs — they're lightweight fan-out only.

const SCHEDULER_QUEUE_NAME = 'seo-global-scheduler';

const schedulerQueue = new Queue(SCHEDULER_QUEUE_NAME, {
  connection: getConnectionOptions(),
  defaultJobOptions: {
    removeOnComplete: { count: 10 },
    removeOnFail:     { count: 50 },
  },
});

// ── Register repeatable scheduler jobs ────────────────────────────────────

async function registerSchedulers(): Promise<void> {
  // GEO analytics — every Monday at 10:00 UTC
  await schedulerQueue.add(
    'geo-analytics-scheduler',
    {},
    {
      jobId:  'geo-analytics-scheduler',
      repeat: { pattern: '0 10 * * 1' },
    },
  );

  // GSC monitor — every Monday at 11:00 UTC
  await schedulerQueue.add(
    'gsc-monitor-scheduler',
    {},
    {
      jobId:  'gsc-monitor-scheduler',
      repeat: { pattern: '0 11 * * 1' },
    },
  );

  logger.info('Global schedulers registered', {
    schedulers: [
      'geo-analytics-scheduler → Mon 10:00 UTC',
      'gsc-monitor-scheduler  → Mon 11:00 UTC',
      '(CMS publish is per-project now — see reconcileCmsPublishSchedules)',
    ],
  });
}

// ── Scheduler worker ───────────────────────────────────────────────────────

function createSchedulerWorker(): Worker {
  return new Worker(
    SCHEDULER_QUEUE_NAME,
    async (job: Job) => {
      switch (job.name) {
        case 'geo-analytics-scheduler':
          await runGeoAnalyticsScheduler();
          break;
        case 'gsc-monitor-scheduler':
          await runGscMonitorScheduler();
          break;
        default:
          logger.warn('Unknown scheduler job name', { jobName: job.name });
      }
    },
    {
      connection:  getConnectionOptions(),
      concurrency: 1, // Schedulers run sequentially — they're just fan-out
    },
  );
}

// ── Per-project workers ────────────────────────────────────────────────────

function createCmsPublishWorker(): Worker<CmsPublishJobData> {
  const worker = new Worker<CmsPublishJobData>(
    QUEUE_NAMES.CMS_PUBLISH_CRON,
    async (job: Job<CmsPublishJobData>) => {
      await runCmsPublishJob(job.data);
    },
    {
      connection:  getConnectionOptions(),
      concurrency: 3,
    },
  );

  worker.on('completed', (job) => {
    logger.info('CMS publish job completed', {
      jobId:     job.id,
      projectId: job.data.projectId,
    });
  });

  worker.on('failed', (job, err) => {
    if (!job) return;
    logger.error(new Error('CMS publish job failed'), {
      jobId: job.id, projectId: job.data.projectId, attemptsMade: job.attemptsMade, error: err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error(err, { context: 'cms-publish.worker' });
  });

  logger.info('CMS publish worker started', {
    queue: QUEUE_NAMES.CMS_PUBLISH_CRON, concurrency: 3,
  });

  return worker;
}

function createGeoAnalyticsWorker(): Worker<{ projectId: string }> {
  const worker = new Worker<{ projectId: string }>(
    QUEUE_NAMES.GEO_ANALYTICS,
    async (job: Job<{ projectId: string }>) => {
      await runGeoAnalyticsJob(job);
    },
    {
      connection:  getConnectionOptions(),
      concurrency: 2, // LLM-heavy — limit parallelism
    },
  );

  worker.on('completed', (job) => {
    logger.info('GEO analytics job completed', {
      jobId:     job.id,
      projectId: job.data.projectId,
    });
  });

  worker.on('failed', (job, err) => {
    if (!job) return;
    logger.error(new Error('GEO analytics job failed'), {
      jobId: job.id, projectId: job.data.projectId, attemptsMade: job.attemptsMade, error: err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error(err, { context: 'geo-analytics.worker' });
  });

  logger.info('GEO analytics worker started', {
    queue: QUEUE_NAMES.GEO_ANALYTICS, concurrency: 2,
  });

  return worker;
}

function createGscMonitorWorker(): Worker<{ projectId: string }> {
  const worker = new Worker<{ projectId: string }>(
    QUEUE_NAMES.GSC_MONITOR,
    async (job: Job<{ projectId: string }>) => {
      await runGscMonitorJob(job);
    },
    {
      connection:  getConnectionOptions(),
      concurrency: 2,
    },
  );

  worker.on('completed', (job) => {
    logger.info('GSC monitor job completed', {
      jobId:     job.id,
      projectId: job.data.projectId,
    });
  });

  worker.on('failed', (job, err) => {
    if (!job) return;
    logger.error(new Error('GSC monitor job failed'), {
      jobId: job.id, projectId: job.data.projectId, attemptsMade: job.attemptsMade, error: err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error(err, { context: 'gsc-monitor.worker' });
  });

  logger.info('GSC monitor worker started', {
    queue: QUEUE_NAMES.GSC_MONITOR, concurrency: 2,
  });

  return worker;
}

function createWeeklyGenerationTriggerWorker(): Worker<{ projectId: string; weekNumber: number }> {
  const worker = new Worker<{ projectId: string; weekNumber: number }>(
    QUEUE_NAMES.WEEKLY_GENERATION_TRIGGER,
    async (job: Job<{ projectId: string; weekNumber: number }>) => {
      await runWeeklyGenerationTrigger(job.data);
    },
    {
      connection:  getConnectionOptions(),
      concurrency: 5, // lightweight — just enqueues onto CONTENT_GENERATION, no LLM calls itself
    },
  );

  worker.on('completed', (job) => {
    logger.info('Weekly generation trigger completed', {
      jobId:      job.id,
      projectId:  job.data.projectId,
      weekNumber: job.data.weekNumber,
    });
  });

  worker.on('failed', (job, err) => {
    if (!job) return;
    logger.error(new Error('Weekly generation trigger failed'), {
      jobId: job.id, projectId: job.data.projectId, weekNumber: job.data.weekNumber,
      attemptsMade: job.attemptsMade, error: err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error(err, { context: 'weekly-generation-trigger.worker' });
  });

  logger.info('Weekly generation trigger worker started', {
    queue: QUEUE_NAMES.WEEKLY_GENERATION_TRIGGER, concurrency: 5,
  });

  return worker;
}

// ── Main boot function ─────────────────────────────────────────────────────

export interface SchedulerWorkers {
  schedulerWorker:              Worker;
  cmsPublishWorker:             Worker<CmsPublishJobData>;
  geoAnalyticsWorker:           Worker<{ projectId: string }>;
  gscMonitorWorker:             Worker<{ projectId: string }>;
  weeklyGenerationTriggerWorker: Worker<{ projectId: string; weekNumber: number }>;
  close: () => Promise<void>;
}

export async function bootSchedulers(): Promise<SchedulerWorkers> {
  // Register repeatable jobs — idempotent, safe on every restart
  await registerSchedulers();

  // Re-assert every autoPublish:true project's own CMS publish schedule.
  // Idempotent (upsert) — safe on every restart, and is what migrates
  // existing projects onto the per-project scheduler design on first boot
  // after this change. See lib/cms-publish-scheduler.ts.
  await reconcileCmsPublishSchedules();

  const schedulerWorker    = createSchedulerWorker();
  const cmsPublishWorker   = createCmsPublishWorker();
  const geoAnalyticsWorker = createGeoAnalyticsWorker();
  const gscMonitorWorker   = createGscMonitorWorker();
  const weeklyGenerationTriggerWorker = createWeeklyGenerationTriggerWorker();

  logger.info('All scheduler workers booted', {
    workers: [
      'schedulerWorker',
      'cmsPublishWorker',
      'geoAnalyticsWorker',
      'gscMonitorWorker',
      'weeklyGenerationTriggerWorker',
    ],
  });

  return {
    schedulerWorker,
    cmsPublishWorker,
    geoAnalyticsWorker,
    gscMonitorWorker,
    weeklyGenerationTriggerWorker,
    close: async () => {
      await schedulerWorker.close();
      await cmsPublishWorker.close();
      await geoAnalyticsWorker.close();
      await gscMonitorWorker.close();
      await weeklyGenerationTriggerWorker.close();
      logger.info('All scheduler workers closed');
    },
  };
}
