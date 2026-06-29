/**
 * workers/scheduler.worker.ts
 *
 * WHAT: Boots three global repeatable cron jobs (schedulers) and
 *       three per-project workers that process the fanned-out jobs.
 *
 * SCHEDULERS (singleton repeatable jobs):
 *   cms-publish-scheduler  → daily Mon–Sat 17:00 UTC
 *   geo-analytics-scheduler → every Monday 10:00 UTC
 *   gsc-monitor-scheduler  → every Monday 11:00 UTC
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
  runCmsPublishScheduler,
  runGeoAnalyticsScheduler,
  runGscMonitorScheduler,
} from './jobs/global-scheduler.job';
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
  // CMS publish — daily Mon–Sat at 17:00 UTC
  await schedulerQueue.add(
    'cms-publish-scheduler',
    {},
    {
      jobId:  'cms-publish-scheduler',
      repeat: { pattern: '0 17 * * 1-6' },
    },
  );

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
      'cms-publish-scheduler  → Mon–Sat 17:00 UTC',
      'geo-analytics-scheduler → Mon 10:00 UTC',
      'gsc-monitor-scheduler  → Mon 11:00 UTC',
    ],
  });
}

// ── Scheduler worker ───────────────────────────────────────────────────────

function createSchedulerWorker(): Worker {
  return new Worker(
    SCHEDULER_QUEUE_NAME,
    async (job: Job) => {
      switch (job.name) {
        case 'cms-publish-scheduler':
          await runCmsPublishScheduler();
          break;
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

  worker.on('failed', (job, err) => {
    if (!job) return;
    logger.error(new Error('CMS publish job failed'), {
      jobId: job.id, projectId: job.data.projectId, error: err.message,
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

  worker.on('failed', (job, err) => {
    if (!job) return;
    logger.error(new Error('GEO analytics job failed'), {
      jobId: job.id, projectId: job.data.projectId, error: err.message,
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

  worker.on('failed', (job, err) => {
    if (!job) return;
    logger.error(new Error('GSC monitor job failed'), {
      jobId: job.id, projectId: job.data.projectId, error: err.message,
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

// ── Main boot function ─────────────────────────────────────────────────────

export interface SchedulerWorkers {
  schedulerWorker:    Worker;
  cmsPublishWorker:   Worker<CmsPublishJobData>;
  geoAnalyticsWorker: Worker<{ projectId: string }>;
  gscMonitorWorker:   Worker<{ projectId: string }>;
  close: () => Promise<void>;
}

export async function bootSchedulers(): Promise<SchedulerWorkers> {
  // Register repeatable jobs — idempotent, safe on every restart
  await registerSchedulers();

  const schedulerWorker    = createSchedulerWorker();
  const cmsPublishWorker   = createCmsPublishWorker();
  const geoAnalyticsWorker = createGeoAnalyticsWorker();
  const gscMonitorWorker   = createGscMonitorWorker();

  logger.info('All scheduler workers booted', {
    workers: [
      'schedulerWorker',
      'cmsPublishWorker',
      'geoAnalyticsWorker',
      'gscMonitorWorker',
    ],
  });

  return {
    schedulerWorker,
    cmsPublishWorker,
    geoAnalyticsWorker,
    gscMonitorWorker,
    close: async () => {
      await schedulerWorker.close();
      await cmsPublishWorker.close();
      await geoAnalyticsWorker.close();
      await gscMonitorWorker.close();
      logger.info('All scheduler workers closed');
    },
  };
}
