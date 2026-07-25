/**
 * workers/knowledge-processing.worker.ts
 *
 * Worker for the seo-knowledge-processing queue.
 * Processes uploaded ProjectKnowledgeFile records: extract → classify →
 * chunk → embed. See: src/workers/jobs/knowledge-processing.job.ts
 *
 * CONCURRENCY: 2 — each job makes 1 classification LLM call + N embedding
 * calls (batched, see embeddings.ts). Kept lower than content-generation's
 * 3 since a single large file can mean many embedding batches in flight.
 */

import { Worker, type Job }  from 'bullmq';
import { logger }             from '@/open-tele';
import { getConnectionOptions } from '@/loaders/redis';
import { QUEUE_NAMES, JOB_RETRY_CONFIG } from '@/constants/seo-pipeline.constants';
import {
  runKnowledgeProcessingJob,
  type KnowledgeProcessingJobData,
} from './jobs/knowledge-processing.job';

export function createKnowledgeProcessingWorker(): Worker<KnowledgeProcessingJobData> {
  const worker = new Worker<KnowledgeProcessingJobData>(
    QUEUE_NAMES.KNOWLEDGE_PROCESSING,
    async (job: Job<KnowledgeProcessingJobData>) => {
      await runKnowledgeProcessingJob(job.data);
    },
    {
      connection:  getConnectionOptions(),
      concurrency: 2,
    },
  );

  worker.on('completed', (job) => {
    logger.info('Knowledge processing job completed', {
      jobId:     job.id,
      projectId: job.data.projectId,
      fileId:    job.data.fileId,
    });
  });

  worker.on('failed', (job, err) => {
    if (!job) {
      logger.error(new Error('Knowledge processing job failed — no job reference'), {
        error: err.message,
      });
      return;
    }
    logger.error(new Error('Knowledge processing job failed'), {
      jobId:        job.id,
      projectId:    job.data.projectId,
      fileId:       job.data.fileId,
      attemptsMade: job.attemptsMade,
      error:        err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error(err, { context: 'knowledge-processing.worker' });
  });

  worker.on('stalled', (jobId) => {
    logger.warn('Knowledge processing job stalled', { jobId });
  });

  logger.info('Knowledge processing worker started', {
    queue:       QUEUE_NAMES.KNOWLEDGE_PROCESSING,
    concurrency: 2,
    retryConfig: JOB_RETRY_CONFIG.KNOWLEDGE_PROCESSING,
  });

  return worker;
}
