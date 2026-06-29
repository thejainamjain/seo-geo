/**
 * workers/cms-publish.worker.ts
 *
 * Worker for the seo-cms-publish queue.
 * Processes scheduled CMS publish jobs — publishes all ready blogs
 * for a project on the configured schedule (Mon–Sat at publishHourUtc UTC).
 *
 * CONCURRENCY: 2 — allows 2 projects to publish simultaneously.
 * Publishing is network-bound (CMS API calls), not CPU-bound.
 */
 
import { Worker, type Job } from 'bullmq';
import { logger }             from '@/open-tele';
import { getConnectionOptions } from '@/loaders/redis';
import { QUEUE_NAMES }          from '@/constants/seo-pipeline.constants';
import {
  runCmsPublishJob,
  type CmsPublishJobData,
} from './jobs/cms-publish.job';
 
export function createCmsPublishWorker(): Worker<CmsPublishJobData> {
  const worker = new Worker<CmsPublishJobData>(
    QUEUE_NAMES.CMS_PUBLISH_CRON,
    async (job: Job<CmsPublishJobData>) => {
      await runCmsPublishJob(job.data);
    },
    {
      connection:  getConnectionOptions(),
      concurrency: 2,
    },
  );
 
  worker.on('completed', (job) => {
    logger.info('CMS publish cron job completed', {
      jobId:     job.id,
      projectId: job.data.projectId,
    });
  });
 
  worker.on('failed', (job, err) => {
    if (!job) return;
    logger.error(new Error('CMS publish cron job failed'), {
      jobId:        job.id,
      projectId:    job.data.projectId,
      attemptsMade: job.attemptsMade,
      error:        err.message,
    });
  });
 
  worker.on('error', (err) => {
    logger.error(err, { context: 'cms-publish.worker' });
  });
 
  logger.info('CMS publish worker started', {
    queue:       QUEUE_NAMES.CMS_PUBLISH_CRON,
    concurrency: 2,
  });
 
  return worker;
}
