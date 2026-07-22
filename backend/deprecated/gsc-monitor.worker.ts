/**
 * workers/gsc-monitor.worker.ts
 *
 * Worker for the seo-gsc-monitor queue.
 * Processes repeatable GSC monitor jobs — fetches Google Search Console
 * data for published blogs and generates BlogLearning documents.
 *
 * CONCURRENCY: 2 — GSC jobs make multiple API calls per blog.
 */
 
import { Worker, type Job } from 'bullmq';
import { logger }             from '@/open-tele';
import { getConnectionOptions } from '@/loaders/redis';
import { QUEUE_NAMES }          from '@/constants/seo-pipeline.constants';
import { runGscMonitorJob }     from './jobs/gsc-monitor.job';
 
export function createGscMonitorWorker(): Worker<{ projectId: string }> {
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
      jobId:        job.id,
      projectId:    job.data.projectId,
      attemptsMade: job.attemptsMade,
      error:        err.message,
    });
  });
 
  worker.on('error', (err) => {
    logger.error(err, { context: 'gsc-monitor.worker' });
  });
 
  logger.info('GSC monitor worker started', {
    queue:       QUEUE_NAMES.GSC_MONITOR,
    concurrency: 2,
  });
 
  return worker;
}
