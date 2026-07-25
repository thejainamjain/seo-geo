import { initOtel, shutdownOtel, logger } from './open-tele';
initOtel();

import { connectDB }           from './loaders/db';
import { getRedis, closeRedis } from './loaders/redis';
import { createSeoPipelineWorker}   from './workers/seo-pipeline.worker';
import { createContentGenerationWorker } from './workers/content-generation.worker';
import { createKnowledgeProcessingWorker } from './workers/knowledge-processing.worker';
import { createBlogOptimizationWorker }    from './workers/blog-optimization.worker';
import { bootSchedulers }            from './workers/scheduler.worker';

async function start(): Promise<void> {
  try {
    logger.info('Worker process starting', { context: 'worker.boot' });

    await connectDB();
    getRedis();

    const seoPipelineWorker        = createSeoPipelineWorker();
    const contentGenerationWorker  = createContentGenerationWorker();
    const knowledgeProcessingWorker = createKnowledgeProcessingWorker();
    const blogOptimizationWorker    = createBlogOptimizationWorker();
    const schedulers               = await bootSchedulers();

    logger.info('All workers started', {
      context: 'worker.boot',
      workers: [
        'seoPipelineWorker',
        'contentGenerationWorker',
        'knowledgeProcessingWorker',
        'blogOptimizationWorker',
        'schedulerWorker',
        'cmsPublishWorker',
      ],
    });

    async function shutdown(signal: string): Promise<void> {
      logger.info('Shutdown signal received', { signal, context: 'worker.shutdown' });
      try {
        await seoPipelineWorker.close();
        await contentGenerationWorker.close();
        await knowledgeProcessingWorker.close();
        await blogOptimizationWorker.close();
        await schedulers.close();
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
