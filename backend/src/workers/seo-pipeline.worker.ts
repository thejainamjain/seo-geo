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
 *   - GEO_ANALYTICS queue: repeatable cron job per project 
 *   - GSC_MONITOR queue  : repeatable cron job per project 
 *
 * BLOG GENERATION FLOW (FlowProducer):
 *   handleBlogGeneration (SEO_PIPELINE)
 *     → creates FlowProducer with 1 parent + 25 child jobs (BLOG_GENERATION queue)
 *     → marks BLOG_GENERATION step COMPLETED immediately (orchestrator is done)
 *     → children run in parallel on blogWorker
 *     → when ALL children complete → BullMQ auto-completes parent
 *     → QueueEvents 'completed' fires for parent → enqueues CMS_PUBLISH
 */

import { Worker, Queue, type Job } from 'bullmq';
import { logger } from '../open-tele';
import { getConnectionOptions } from '../loaders/redis';
import { Project } from '../models/Project';
import {
  QUEUE_NAMES,
  PIPELINE_STEP,
  PIPELINE_SEQUENCE,
  JOB_PRIORITY,
  JOB_RETRY_CONFIG,
  type PipelineStep,
} from '../constants/seo-pipeline.constants';
import { runSiteCrawlJob }       from './jobs/site-crawl.job';
import { runBusinessProfileJob }  from './jobs/business-profile.job';
import { runTechnicalAuditJob } from './jobs/technical-audit.job';
import { runCompetitorDiscoveryJob } from './jobs/competitor-discovery.job';
import { runKeywordResearchJob }    from './jobs/keyword-research.job';

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
    await Project.findByIdAndUpdate(projectId, {
      $set: {
        'pipeline.status':      'COMPLETED',
        'pipeline.completedAt': now,
      },
    });
    logger.info('Pipeline fully completed', { projectId });
    return;
  }

  // After BUSINESS_PROFILE: pause pipeline and wait for user to complete onboarding wizard.
  // Frontend polls pipeline status — when BUSINESS_PROFILE is COMPLETED and
  // pipeline.status is PENDING, it shows the pre-filled wizard.
  // resumeAfterOnboarding() in project.service.ts enqueues TECHNICAL_AUDIT when user is done.
  if (step === PIPELINE_STEP.BUSINESS_PROFILE) {
    await Project.findByIdAndUpdate(projectId, {
      $set: {
        'pipeline.status':      'PENDING',
        'pipeline.currentStep': null,
      },
    });
    logger.info('Pipeline paused after BUSINESS_PROFILE — waiting for onboarding completion', {
      projectId,
    });
    return;
  }

  // Pipeline fully complete — KEYWORD_RESEARCH was the last step.
  // Content generation now happens on-demand per keyword.

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
  logger.error(new Error(`Pipeline step permanently failed: ${step}`), {
    projectId, step, error,
    resumeHint: `POST /api/projects/${projectId}/pipeline/resume to retry from this step`,
  });
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

// NOTE: GEO_ANALYTICS and GSC_MONITOR are NOT handled here. They run as
// separate repeatable cron jobs on their own queues (seo-geo-analytics,
// seo-gsc-monitor), processed by scheduler.worker.ts's createGeoAnalyticsWorker
// and createGscMonitorWorker. They were removed from this linear pipeline
// worker when the architecture split into three mechanisms — see
// docs/03-orchestration-audit.md for the full picture.

// ── Step dispatcher ────────────────────────────────────────────────────────

const STEP_HANDLERS: Partial<Record<PipelineStep, (job: Job<PipelineJobData>) => Promise<void>>> = {
  [PIPELINE_STEP.SITE_CRAWL]:           handleSiteCrawl,
  [PIPELINE_STEP.BUSINESS_PROFILE]:     handleBusinessProfile,
  [PIPELINE_STEP.TECHNICAL_AUDIT]:      handleTechnicalAudit,
  [PIPELINE_STEP.COMPETITOR_DISCOVERY]: handleCompetitorDiscovery,
  [PIPELINE_STEP.KEYWORD_RESEARCH]:     handleKeywordResearch,
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
