/**
 * workers/geo-analytics.worker.ts
 *
 * Worker for the seo-geo-analytics queue.
 * Processes repeatable GEO analytics jobs — measures how often
 * the project domain is cited by AI engines for its keywords.
 *
 * CONCURRENCY: 2 — GEO jobs are LLM-heavy; limit parallelism.
 */
 
import { Worker, type Job } from 'bullmq';
import { logger }             from '@/open-tele';
import { getConnectionOptions } from '@/loaders/redis';
import { QUEUE_NAMES }          from '@/constants/seo-pipeline.constants';
import { runGeoAnalyticsJob }   from './jobs/geo-analytics.job';
 
export function createGeoAnalyticsWorker(): Worker<{ projectId: string }> {
  const worker = new Worker<{ projectId: string }>(
    QUEUE_NAMES.GEO_ANALYTICS,
    async (job: Job<{ projectId: string }>) => {
      await runGeoAnalyticsJob(job);
    },
    {
      connection:  getConnectionOptions(),
      concurrency: 2,
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
      jobId:        job.id,
      projectId:    job.data.projectId,
      attemptsMade: job.attemptsMade,
      error:        err.message,
    });
  });
 
  worker.on('error', (err) => {
    logger.error(err, { context: 'geo-analytics.worker' });
  });
 
  logger.info('GEO analytics worker started', {
    queue:       QUEUE_NAMES.GEO_ANALYTICS,
    concurrency: 2,
  });
 
  return worker;
}
