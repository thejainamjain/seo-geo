/**
 * workers/blog-optimization.worker.ts
 *
 * Worker for the seo-blog-optimization queue.
 * Rewrites one underperforming blog per job — the actual learning-loop
 * action gsc-monitor.job.ts triggers after recording fresh insights.
 * See: src/workers/jobs/blog-optimization.job.ts
 *
 * CONCURRENCY: 2 — each job makes up to 2 embedding calls (query embeds for
 * retrieval) + 1 rewrite LLM call (the most expensive single call in this
 * whole system — full blog body generation). Kept low deliberately.
 */

import { Worker, type Job }  from 'bullmq';
import { logger }             from '@/open-tele';
import { getConnectionOptions } from '@/loaders/redis';
import { QUEUE_NAMES, JOB_RETRY_CONFIG } from '@/constants/seo-pipeline.constants';
import {
  runBlogOptimizationJob,
  type BlogOptimizationJobData,
} from './jobs/blog-optimization.job';

export function createBlogOptimizationWorker(): Worker<BlogOptimizationJobData> {
  const worker = new Worker<BlogOptimizationJobData>(
    QUEUE_NAMES.BLOG_OPTIMIZATION,
    async (job: Job<BlogOptimizationJobData>) => {
      await runBlogOptimizationJob(job.data);
    },
    {
      connection:  getConnectionOptions(),
      concurrency: 2,
    },
  );

  worker.on('completed', (job) => {
    logger.info('Blog optimization job completed', {
      jobId:     job.id,
      projectId: job.data.projectId,
      blogId:    job.data.blogId,
    });
  });

  worker.on('failed', (job, err) => {
    if (!job) {
      logger.error(new Error('Blog optimization job failed — no job reference'), {
        error: err.message,
      });
      return;
    }
    logger.error(new Error('Blog optimization job failed'), {
      jobId:        job.id,
      projectId:    job.data.projectId,
      blogId:       job.data.blogId,
      attemptsMade: job.attemptsMade,
      error:        err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error(err, { context: 'blog-optimization.worker' });
  });

  worker.on('stalled', (jobId) => {
    logger.warn('Blog optimization job stalled', { jobId });
  });

  logger.info('Blog optimization worker started', {
    queue:       QUEUE_NAMES.BLOG_OPTIMIZATION,
    concurrency: 2,
    retryConfig: JOB_RETRY_CONFIG.BLOG_OPTIMIZATION,
  });

  return worker;
}
