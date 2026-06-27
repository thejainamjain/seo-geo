/**
 * workers/seo-pipeline.worker.ts
 *
 * Master BullMQ worker — orchestrates the full SEO pipeline.
 *
 * ARCHITECTURE:
 *   - One worker listens on SEO_PIPELINE queue
 *   - Each job carries { projectId, step } in its data
 *   - The worker dispatches to the correct job handler based on step
 *   - Each handler updates Project.pipeline.steps before AND after execution
 *   - On success: handler enqueues the next step
 *   - On failure: BullMQ retries with exponential backoff (config per step)
 *   - After max retries: job moves to BullMQ failed set — logged and alerted
 *
 * QUEUE SEPARATION:
 *   - SEO_PIPELINE queue : all linear pipeline steps
 *   - BLOG_GENERATION queue: 25 parallel child blog jobs via FlowProducer
 *   - PUBLISH queue      : cron-triggered, Mon–Sat 5PM UTC only
 *   - GEO_ANALYTICS queue: repeatable cron job per project (registered after CMS_PUBLISH)
 *   - GSC_MONITOR queue  : repeatable cron job per project (registered after CMS_PUBLISH)
 *
 * BLOG GENERATION FLOW (FlowProducer):
 *   handleBlogGeneration (SEO_PIPELINE)
 *     → creates FlowProducer with 1 parent + 25 child jobs (BLOG_GENERATION queue)
 *     → marks BLOG_GENERATION step COMPLETED immediately (orchestrator is done)
 *     → children run in parallel on blogWorker
 *     → when ALL children complete → BullMQ auto-completes parent
 *     → QueueEvents 'completed' fires for parent → enqueues CMS_PUBLISH
 *
 * PRIORITY (lower = higher priority):
 *   CMS_PUBLISH(1) > SITE_CRAWL(2) > most steps(3) > analytics(4) > blog(5)
 */

import { Worker, Queue, FlowProducer, QueueEvents, type Job } from 'bullmq';
import { logger } from '../open-tele';
import { getConnectionOptions } from '../loaders/redis';
import { Project } from '../models/Project';
import { Keyword } from '../models/Keyword';
import {
  QUEUE_NAMES,
  PIPELINE_STEP,
  PIPELINE_SEQUENCE,
  JOB_PRIORITY,
  JOB_RETRY_CONFIG,
  type PipelineStep,
} from '../constants/seo-pipeline.constants';
import { runSiteCrawlJob }       from './jobs/site-crawl.job';
import { runBlogGenerationJob }  from './jobs/blog-generation.job';
import { runBusinessProfileJob }  from './jobs/business-profile.job';
import { runTechnicalAuditJob } from './jobs/technical-audit.job';
import { runCompetitorDiscoveryJob } from './jobs/competitor-discovery.job';
import { runKeywordResearchJob }    from './jobs/keyword-research.job';
import { runSerpResearchJob }       from './jobs/serp-research.job';
import { runCmsPublishJob } from './jobs/cms-publish.job';
import { runGeoAnalyticsJob } from './jobs/geo-analytics.job';
import { runGscMonitorJob }   from './jobs/gsc-monitor.job';

// ── Job data shapes ────────────────────────────────────────────────────────

export interface PipelineJobData {
  projectId: string;
  step:      PipelineStep;
}

export interface BlogJobData {
  projectId: string;
  keywordId: string;
  jobIndex:  number; // 1–25
  total:     number; // actual count of keywords selected (≤ 25)
}

// ── Queue instances ────────────────────────────────────────────────────────
// Exported so job files can import and enqueue directly.

export const seoPipelineQueue = new Queue<PipelineJobData>(QUEUE_NAMES.SEO_PIPELINE, {
  connection:        getConnectionOptions(),
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 500 },
  },
});

export const blogGenerationQueue = new Queue<BlogJobData>(QUEUE_NAMES.BLOG_GENERATION, {
  connection:        getConnectionOptions(),
  defaultJobOptions: {
    removeOnComplete: { count: 200 },
    removeOnFail:     { count: 500 },
  },
});

export const publishQueue = new Queue(QUEUE_NAMES.PUBLISH, {
  connection:        getConnectionOptions(),
  defaultJobOptions: {
    removeOnComplete: { count: 50  },
    removeOnFail:     { count: 200 },
  },
});

export const geoAnalyticsQueue = new Queue(QUEUE_NAMES.GEO_ANALYTICS, {
  connection:        getConnectionOptions(),
  defaultJobOptions: {
    removeOnComplete: { count: 50  },
    removeOnFail:     { count: 100 },
  },
});

export const gscMonitorQueue = new Queue(QUEUE_NAMES.GSC_MONITOR, {
  connection:        getConnectionOptions(),
  defaultJobOptions: {
    removeOnComplete: { count: 50  },
    removeOnFail:     { count: 100 },
  },
});

// ── FlowProducer — for blog generation parent+child jobs ──────────────────

const flowProducer = new FlowProducer({
  connection: getConnectionOptions(),
});

// ── Pipeline step helpers ──────────────────────────────────────────────────

async function markStepRunning(projectId: string, step: PipelineStep): Promise<void> {
  await Project.findByIdAndUpdate(projectId, {
    $set: {
      'pipeline.currentStep':               step,
      'pipeline.status':                    'RUNNING',
      [`pipeline.steps.${step}.status`]:    'RUNNING',
      [`pipeline.steps.${step}.startedAt`]: new Date(),
    },
  });
  logger.info('Pipeline step started', { projectId, step });
}

async function markStepCompleted(projectId: string, step: PipelineStep): Promise<void> {
  const now = new Date();

  await Project.findByIdAndUpdate(projectId, {
    $set: {
      [`pipeline.steps.${step}.status`]:      'COMPLETED',
      [`pipeline.steps.${step}.completedAt`]: now,
    },
  });

  logger.info('Pipeline step completed', { projectId, step });

  const currentIndex = PIPELINE_SEQUENCE.indexOf(step);
  const nextStep     = PIPELINE_SEQUENCE[currentIndex + 1] as PipelineStep | undefined;

  if (!nextStep) {
    // Pipeline fully complete — CMS_PUBLISH was the last step
    await Project.findByIdAndUpdate(projectId, {
      $set: {
        'pipeline.status':      'COMPLETED',
        'pipeline.completedAt': now,
      },
    });
    logger.info('Pipeline fully completed', { projectId });
    return;
  }

  // Skip enqueuing next step for BLOG_GENERATION —
  // CMS_PUBLISH is enqueued by QueueEvents when all blog children complete.
  if (step === PIPELINE_STEP.BLOG_GENERATION) {
    logger.info('BLOG_GENERATION orchestrator complete — CMS_PUBLISH will be enqueued by QueueEvents when all blog children finish', {
      projectId,
    });
    return;
  }

  const retryConfig = JOB_RETRY_CONFIG[nextStep];
  const priority    = JOB_PRIORITY[nextStep as keyof typeof JOB_PRIORITY] ?? 3;

  await seoPipelineQueue.add(
    nextStep,
    { projectId, step: nextStep },
    {
      priority,
      attempts: retryConfig.attempts,
      backoff:  { type: 'exponential', delay: retryConfig.backoffDelay },
    },
  );

  logger.info('Enqueued next pipeline step', { projectId, nextStep, priority });
}

async function markStepErrored(projectId: string, step: PipelineStep, error: string): Promise<void> {
  await Project.findByIdAndUpdate(projectId, {
    $set: {
      'pipeline.status':                 'ERRORED',
      [`pipeline.steps.${step}.status`]: 'ERRORED',
      [`pipeline.steps.${step}.error`]:  error,
    },
  });
  logger.error(new Error(`Pipeline step permanently failed: ${step}`), { projectId, step, error });
}

// ── Job handlers ───────────────────────────────────────────────────────────

async function handleSiteCrawl(job: Job<PipelineJobData>): Promise<void> {
  const { projectId, step } = job.data;
  await markStepRunning(projectId, step);
  await runSiteCrawlJob(job);
  await markStepCompleted(projectId, step);
}

async function handleBusinessProfile(job: Job<PipelineJobData>): Promise<void> {
  const { projectId, step } = job.data;
  await markStepRunning(projectId, step);
  await runBusinessProfileJob(job);
  await markStepCompleted(projectId, step);
}

async function handleTechnicalAudit(job: Job<PipelineJobData>): Promise<void> {
  const { projectId, step } = job.data;
  await markStepRunning(projectId, step);
  await runTechnicalAuditJob(job);
  await markStepCompleted(projectId, step);
}

async function handleCompetitorDiscovery(job: Job<PipelineJobData>): Promise<void> {
  const { projectId, step } = job.data;
  await markStepRunning(projectId, step);
  await runCompetitorDiscoveryJob(job);
  await markStepCompleted(projectId, step);
}

async function handleKeywordResearch(job: Job<PipelineJobData>): Promise<void> {
  const { projectId, step } = job.data;
  await markStepRunning(projectId, step);
  await runKeywordResearchJob(job);
  await markStepCompleted(projectId, step);
}

async function handleSerpResearch(job: Job<PipelineJobData>): Promise<void> {
  const { projectId, step } = job.data;
  await markStepRunning(projectId, step);
  await runSerpResearchJob(job);
  await markStepCompleted(projectId, step);
}

async function handleBlogGeneration(job: Job<PipelineJobData>): Promise<void> {
  const { projectId, step } = job.data;
  await markStepRunning(projectId, step);

  // 1. Select top keywords for blog generation
  //    Sort: alignmentScore desc → searchVolume desc → difficulty asc
  //    Only 'upcoming' keywords — not already drafted or published
  const keywords = await Keyword.find({
    projectId,
    status: 'upcoming',
  })
    .sort({ alignmentScore: -1, searchVolume: -1, difficulty: 1 })
    .limit(25)
    .lean();

  // 2. Guard — no keywords available
  if (keywords.length === 0) {
    const msg = `No upcoming keywords found for project ${projectId} — cannot generate blogs`;
    logger.error(new Error(msg), { projectId, step });
    await markStepErrored(projectId, step, msg);
    return;
  }

  if (keywords.length < 25) {
    logger.warn('Fewer than 25 keywords available for blog generation', {
      projectId,
      available: keywords.length,
      expected:  25,
    });
  }

  logger.info('Keywords selected for blog generation', {
    projectId,
    count: keywords.length,
    keywords: keywords.map(k => ({
      id:             String(k._id),
      keyword:        k.keyword,
      alignmentScore: k.alignmentScore,
      searchVolume:   k.searchVolume,
      difficulty:     k.difficulty,
    })),
  });

  const total = keywords.length;

  // 3. Build FlowProducer tree:
  //    One parent job + N child jobs (one per keyword)
  //    Parent job has no processor — BullMQ auto-completes it when all children finish
  //    QueueEvents listener (in createBlogWorker) detects parent completion
  //    and enqueues CMS_PUBLISH

  const retryConfig = JOB_RETRY_CONFIG[PIPELINE_STEP.BLOG_GENERATION];

  const flow = await flowProducer.add({
    // Parent job — sits in 'waiting-children' until all children complete
    name:     `blog-parent-${projectId}`,
    queueName: QUEUE_NAMES.BLOG_GENERATION,
    data:     { projectId, step: PIPELINE_STEP.BLOG_GENERATION } as unknown as BlogJobData,
    opts: {
      // Store projectId in parent job name so QueueEvents can extract it
      // Parent job itself has no processor — only children do
      priority: JOB_PRIORITY.BLOG_GENERATION,
      attempts: 1, // Parent never retries — children handle their own retries
    },
    children: keywords.map((keyword, index) => ({
      name:      `blog-child-${projectId}-${String(keyword._id)}`,
      queueName: QUEUE_NAMES.BLOG_GENERATION,
      data: {
        projectId,
        keywordId: String(keyword._id),
        jobIndex:  index + 1,
        total,
      } satisfies BlogJobData,
      opts: {
        priority: JOB_PRIORITY.BLOG_GENERATION,
        attempts: retryConfig.attempts,
        backoff:  { type: 'exponential' as const, delay: retryConfig.backoffDelay },
      },
    })),
  });

  logger.info('Blog generation flow created', {
    projectId,
    parentJobId: flow.job.id,
    childCount:  total,
  });

  // 4. Mark BLOG_GENERATION step completed — orchestrator is done.
  //    CMS_PUBLISH will be enqueued by QueueEvents when parent job completes
  //    (i.e. when all 25 children finish).
  await markStepCompleted(projectId, step);
}

async function handleCmsPublish(job: Job<PipelineJobData>): Promise<void> {
  const { projectId, step } = job.data;
  await markStepRunning(projectId, step);
  await runCmsPublishJob(job);
  await markStepCompleted(projectId, step);

  // Register repeatable cron jobs for this project now that pipeline is complete.
  // jobId is stable per project — prevents duplicate registrations if
  // CMS_PUBLISH ever runs again (e.g. manual re-trigger).
  // No Sunday publishing — pattern '0 17 * * 1-6' = Mon–Sat 5PM UTC.

  await geoAnalyticsQueue.add(
    'geo-analytics',
    { projectId },
    {
      repeat:  { pattern: '0 17 * * 1-6' }, // Mon–Sat 5PM UTC — no Sunday
      jobId:   `geo-${projectId}`,           // Stable ID — deduplicates on re-register
    },
  );

  logger.info('GEO analytics repeatable job registered', {
    projectId,
    pattern: '0 17 * * 1-6',
    jobId:   `geo-${projectId}`,
  });

  await gscMonitorQueue.add(
    'gsc-monitor',
    { projectId },
    {
      repeat: { pattern: '0 10 * * 1' },  // Every Monday 10AM UTC
      jobId:  `gsc-${projectId}`,          // Stable ID — deduplicates on re-register
    },
  );

  logger.info('GSC monitor repeatable job registered', {
    projectId,
    pattern: '0 10 * * 1',
    jobId:   `gsc-${projectId}`,
  });
}

async function handleGeoAnalytics(job: Job<PipelineJobData>): Promise<void> {
  const { projectId } = job.data;
  logger.info('GEO analytics handler started', { projectId });
  await runGeoAnalyticsJob(job as unknown as Job<{ projectId: string }>);
  logger.info('GEO analytics handler completed', { projectId });
}

async function handleGscMonitor(job: Job<PipelineJobData>): Promise<void> {
  const { projectId } = job.data;
  logger.info('GSC monitor handler started', { projectId });
  await runGscMonitorJob(job as unknown as Job<{ projectId: string }>);
  logger.info('GSC monitor handler completed', { projectId });
}

// ── Step dispatcher ────────────────────────────────────────────────────────

const STEP_HANDLERS: Record<PipelineStep, (job: Job<PipelineJobData>) => Promise<void>> = {
  [PIPELINE_STEP.SITE_CRAWL]:           handleSiteCrawl,
  [PIPELINE_STEP.BUSINESS_PROFILE]:     handleBusinessProfile,
  [PIPELINE_STEP.TECHNICAL_AUDIT]:      handleTechnicalAudit,
  [PIPELINE_STEP.COMPETITOR_DISCOVERY]: handleCompetitorDiscovery,
  [PIPELINE_STEP.KEYWORD_RESEARCH]:     handleKeywordResearch,
  [PIPELINE_STEP.SERP_RESEARCH]:        handleSerpResearch,
  [PIPELINE_STEP.BLOG_GENERATION]:      handleBlogGeneration,
  [PIPELINE_STEP.CMS_PUBLISH]:          handleCmsPublish,
  [PIPELINE_STEP.GEO_ANALYTICS]:        handleGeoAnalytics,
  [PIPELINE_STEP.GSC_MONITOR]:          handleGscMonitor,
};

// ── SEO Pipeline worker factory ────────────────────────────────────────────

export function createSeoPipelineWorker(): Worker<PipelineJobData> {
  const worker = new Worker<PipelineJobData>(
    QUEUE_NAMES.SEO_PIPELINE,
    async (job: Job<PipelineJobData>) => {
      const { projectId, step } = job.data;

      logger.info('Processing pipeline job', {
        jobId:   job.id,
        projectId,
        step,
        attempt: job.attemptsMade + 1,
      });

      const handler = STEP_HANDLERS[step];

      if (!handler) {
        // Unknown step — code bug, do not retry
        throw new Error(`No handler registered for pipeline step: ${step}`);
      }

      await handler(job);
    },
    {
      connection:  getConnectionOptions(),
      concurrency: 5,
    },
  );

  worker.on('completed', (job) => {
    logger.info('Pipeline job completed', {
      jobId:     job.id,
      projectId: job.data.projectId,
      step:      job.data.step,
    });
  });

  worker.on('failed', async (job, err) => {
    if (!job) {
      logger.error(new Error('Pipeline job failed with no job reference'), { error: err.message });
      return;
    }

    const { projectId, step } = job.data;
    const maxAttempts         = JOB_RETRY_CONFIG[step]?.attempts ?? 3;
    const attemptsLeft        = maxAttempts - job.attemptsMade;

    if (attemptsLeft > 0) {
      logger.warn('Pipeline job failed — retrying', {
        jobId:        job.id,
        projectId,
        step,
        attemptsMade: job.attemptsMade,
        attemptsLeft,
        error:        err.message,
      });
    } else {
      logger.error(new Error(`Pipeline step permanently failed: ${step}`), {
        jobId:     job.id,
        projectId,
        step,
        error:     err.message,
      });
      await markStepErrored(projectId, step, err.message);
    }
  });

  worker.on('error', (err) => {
    logger.error(err, { context: 'seo-pipeline.worker' });
  });

  worker.on('stalled', (jobId) => {
    logger.warn('Pipeline job stalled', { jobId, context: 'seo-pipeline.worker' });
  });

  logger.info('SEO pipeline worker started', {
    queue:       QUEUE_NAMES.SEO_PIPELINE,
    concurrency: 5,
  });

  return worker;
}

// ── Blog worker factory ────────────────────────────────────────────────────
//
// Listens on BLOG_GENERATION queue.
// Handles TWO job types on the same queue:
//
//   CHILD jobs — have job.data.keywordId set → dispatched to runBlogGenerationJob
//   PARENT jobs — have no keywordId (they are flow parents, auto-completed by BullMQ)
//                 Parent processor runs but immediately returns — BullMQ moves it
//                 to completed only after all children are done.
//                 QueueEvents then fires 'completed' for the parent → enqueues CMS_PUBLISH.
//
// WHY SAME QUEUE FOR PARENT AND CHILD:
//   FlowProducer requires parent and children to be on the same queue.
//   We distinguish them by presence of keywordId in job data.

export function createBlogWorker(): Worker<BlogJobData> {
  const worker = new Worker<BlogJobData>(
    QUEUE_NAMES.BLOG_GENERATION,
    async (job: Job<BlogJobData>) => {
      const { projectId, keywordId } = job.data;

      // Parent job — no keywordId, just return.
      // BullMQ will auto-complete it once all children finish.
      if (!keywordId) {
        logger.debug('Blog parent job processor called — returning immediately', {
          jobId: job.id,
          projectId,
        });
        return;
      }

      // Child job — generate one blog post
      logger.info('Blog child job started', {
        jobId:    job.id,
        projectId,
        keywordId,
        jobIndex: job.data.jobIndex,
        total:    job.data.total,
      });

      await runBlogGenerationJob(job);
    },
    {
      connection:  getConnectionOptions(),
      concurrency: 10, // 10 parallel blog generations — LLM calls are I/O bound
    },
  );

  worker.on('completed', (job) => {
    logger.info('Blog job completed', {
      jobId:     job.id,
      projectId: job.data.projectId,
      keywordId: job.data.keywordId ?? 'parent',
      jobIndex:  job.data.jobIndex,
      total:     job.data.total,
    });
  });

  worker.on('failed', (job, err) => {
    if (!job) {
      logger.error(new Error('Blog job failed with no job reference'), { error: err.message });
      return;
    }
    logger.error(new Error('Blog job failed'), {
      jobId:        job.id,
      projectId:    job.data.projectId,
      keywordId:    job.data.keywordId,
      jobIndex:     job.data.jobIndex,
      attemptsMade: job.attemptsMade,
      error:        err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error(err, { context: 'blog.worker' });
  });

  worker.on('stalled', (jobId) => {
    logger.warn('Blog job stalled', { jobId, context: 'blog.worker' });
  });

  logger.info('Blog generation worker started', {
    queue:       QUEUE_NAMES.BLOG_GENERATION,
    concurrency: 10,
  });

  return worker;
}

// ── QueueEvents factory ────────────────────────────────────────────────────
//
// Listens for events on BLOG_GENERATION queue.
// When the PARENT job completes (all 25 children done) → enqueues CMS_PUBLISH.
//
// HOW WE DETECT PARENT VS CHILD completion:
//   Parent job data has no keywordId.
//   We parse the completed job's data to check.
//   If keywordId is absent → it's the parent → enqueue CMS_PUBLISH.
//
// WHY QueueEvents AND NOT worker 'completed' event:
//   worker.on('completed') fires for every job processed by THIS worker instance.
//   QueueEvents listens at the Redis level — fires for ALL completions on the queue,
//   including jobs processed by other worker instances/processes.
//   This is the correct pattern for cross-worker coordination in BullMQ.

export function createBlogQueueEvents(): QueueEvents {
  const queueEvents = new QueueEvents(QUEUE_NAMES.BLOG_GENERATION, {
    connection: getConnectionOptions(),
  });

  queueEvents.on('completed', async ({ jobId, returnvalue }) => {
    try {
      // Fetch the completed job to inspect its data
      const job = await blogGenerationQueue.getJob(jobId);
      if (!job) {
        logger.warn('QueueEvents: completed job not found in queue', {
          jobId,
          context: 'blog.queue-events',
        });
        return;
      }

      const { projectId, keywordId } = job.data;

      // Child job completed — log progress, nothing else to do
      if (keywordId) {
        logger.debug('Blog child job completed via QueueEvents', {
          jobId,
          projectId,
          keywordId,
          jobIndex: job.data.jobIndex,
          total:    job.data.total,
        });
        return;
      }

      // Parent job completed — all children finished
      // Enqueue CMS_PUBLISH as the next pipeline step
      logger.info('Blog parent job completed — all blogs generated, enqueuing CMS_PUBLISH', {
        jobId,
        projectId,
        context: 'blog.queue-events',
      });

      const retryConfig = JOB_RETRY_CONFIG[PIPELINE_STEP.CMS_PUBLISH];
      const priority    = JOB_PRIORITY.CMS_PUBLISH;

      await seoPipelineQueue.add(
        PIPELINE_STEP.CMS_PUBLISH,
        { projectId, step: PIPELINE_STEP.CMS_PUBLISH },
        {
          priority,
          attempts: retryConfig.attempts,
          backoff:  { type: 'exponential', delay: retryConfig.backoffDelay },
        },
      );

      logger.info('CMS_PUBLISH enqueued after blog generation complete', {
        projectId,
        priority,
        context: 'blog.queue-events',
      });

    } catch (err) {
      logger.error(
        err instanceof Error ? err : new Error(String(err)),
        { jobId, context: 'blog.queue-events.completed' },
      );
    }
  });

  queueEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error(new Error('Blog queue job failed (QueueEvents)'), {
      jobId,
      failedReason,
      context: 'blog.queue-events',
    });
  });

  queueEvents.on('error', (err) => {
    logger.error(err, { context: 'blog.queue-events.error' });
  });

  logger.info('Blog QueueEvents listener started', {
    queue: QUEUE_NAMES.BLOG_GENERATION,
  });

  return queueEvents;
}
