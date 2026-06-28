/**
 * workers/content-generation.worker.ts
 *
 * Worker for the seo-content-generation queue.
 * Processes on-demand content generation jobs triggered by user clicking
 * "Generate" on a keyword in the dashboard.
 *
 * Each job runs SERP research + blog generation + optional CMS publish
 * for ONE keyword. See: src/workers/jobs/content-generation.job.ts
 *
 * CONCURRENCY: 3 — allows up to 3 keywords generating in parallel per instance.
 * Each job makes 2 LLM calls sequentially, so 3 concurrent = 6 LLM calls max.
 * At 15 RPM free tier that's fine — each call takes 3-8s so actual RPM is low.
 */

import { Worker, type Job }  from 'bullmq';
import { logger }             from '@/open-tele';
import { getConnectionOptions } from '@/loaders/redis';
import { QUEUE_NAMES, JOB_RETRY_CONFIG } from '@/constants/seo-pipeline.constants';
import {
  runContentGenerationJob,
  type ContentGenerationJobData,
} from './jobs/content-generation.job';

export function createContentGenerationWorker(): Worker<ContentGenerationJobData> {
  const worker = new Worker<ContentGenerationJobData>(
    QUEUE_NAMES.CONTENT_GENERATION,
    async (job: Job<ContentGenerationJobData>) => {
      await runContentGenerationJob(job.data);
    },
    {
      connection:  getConnectionOptions(),
      concurrency: 3,
    },
  );

  worker.on('completed', (job) => {
    logger.info('Content generation job completed', {
      jobId:     job.id,
      projectId: job.data.projectId,
      keywordId: job.data.keywordId,
    });
  });

  worker.on('failed', (job, err) => {
    if (!job) {
      logger.error(new Error('Content generation job failed — no job reference'), {
        error: err.message,
      });
      return;
    }
    logger.error(new Error('Content generation job failed'), {
      jobId:        job.id,
      projectId:    job.data.projectId,
      keywordId:    job.data.keywordId,
      attemptsMade: job.attemptsMade,
      error:        err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error(err, { context: 'content-generation.worker' });
  });

  worker.on('stalled', (jobId) => {
    logger.warn('Content generation job stalled', { jobId });
  });

  logger.info('Content generation worker started', {
    queue:       QUEUE_NAMES.CONTENT_GENERATION,
    concurrency: 3,
  });

  return worker;
}
