/**
 * worker.ts
 *
 * Separate process entry point for all BullMQ workers.
 * Run alongside app.ts as an independent process.
 *
 * WHY SEPARATE FROM app.ts:
 *   - Worker crash does not take down the API
 *   - Workers can be scaled independently
 *   - Clean separation: HTTP layer vs background processing
 *   - In production: API and worker can run on separate machines/containers
 *
 * WORKERS STARTED HERE:
 *   seoPipelineWorker  — processes linear pipeline steps (SEO_PIPELINE queue)
 *   blogWorker         — processes blog generation child jobs (BLOG_GENERATION queue)
 *   blogQueueEvents    — listens for parent job completion → enqueues CMS_PUBLISH
 *
 * BOOT ORDER (mirrors app.ts — OTel must always be first):
 *   1. initOtel()          — tracing/logging before anything else
 *   2. connectDB()         — workers read/write all models
 *   3. getRedis()          — validates Redis before starting workers
 *   4. start workers
 *   5. start QueueEvents
 */

import { initOtel, shutdownOtel, logger } from './open-tele';
initOtel(); // MUST be first line after imports

import { connectDB }    from './loaders/db';
import { getRedis, closeRedis } from './loaders/redis';
import {
  createSeoPipelineWorker,
} from './workers/seo-pipeline.worker';
import { createContentGenerationWorker } from './workers/content-generation.worker';


async function start(): Promise<void> {
  try {
    logger.info('Worker process starting', { context: 'worker.boot' });

    await connectDB();
    getRedis(); // Validates Redis connection — throws if UPSTASH_REDIS_URL missing

    // Start all workers
    const seoPipelineWorker = createSeoPipelineWorker();
    const contentGenerationWorker = createContentGenerationWorker();

    logger.info('All workers started', {
      context: 'worker.boot',
      workers: ['seoPipelineWorker', 'blogWorker', 'contentGenerationWorker'],
    });

    // ── Graceful shutdown ────────────────────────────────────────────────
    // Stop accepting new jobs, finish current jobs, then exit cleanly.
    // Order matters:
    //   1. Close workers first — stop processing new jobs
    //   2. Close QueueEvents — stop listening for events
    //   3. Close Redis — after workers are done (workers use Redis internally)
    //   4. Shutdown OTel — flush remaining traces/logs

    async function shutdown(signal: string): Promise<void> {
      logger.info('Shutdown signal received', { signal, context: 'worker.shutdown' });
      try {
        await seoPipelineWorker.close();
        logger.info('SEO pipeline worker closed', { context: 'worker.shutdown' });

        await contentGenerationWorker.close();
        logger.info('Content generation worker closed', { context: 'worker.shutdown' });

        await closeRedis();
        await shutdownOtel();

        logger.info('Worker process shut down cleanly', { context: 'worker.shutdown' });
        process.exit(0);
      } catch (err) {
        logger.error(
          err instanceof Error ? err : new Error(String(err)),
          { context: 'worker.shutdown.error' },
        );
        process.exit(1);
      }
    }

    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGINT',  () => { void shutdown('SIGINT');  });

    process.on('unhandledRejection', (reason) => {
      logger.error(
        reason instanceof Error ? reason : new Error(String(reason)),
        { context: 'worker.unhandledRejection' },
      );
    });

  } catch (err) {
    logger.error(
      err instanceof Error ? err : new Error(String(err)),
      { context: 'worker.boot.fatal' },
    );
    process.exit(1);
  }
}

void start();
