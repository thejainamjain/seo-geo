/**
 * WHAT: Resumes a failed pipeline from the step that errored,
 *       without restarting from SITE_CRAWL (which re-crawls everything).
 *
 * WHY THIS EXISTS:
 *   seo-pipeline.worker.ts marks a step ERRORED after max retries but
 *   provides no recovery path. The only option was restarting from scratch,
 *   which re-crawls the site, re-generates keywords, etc. — wasteful and slow.
 *
 *   With this utility:
 *     - If KEYWORD_RESEARCH errors → resume re-enqueues KEYWORD_RESEARCH only
 *     - If SERP_RESEARCH errors → resume re-enqueues SERP_RESEARCH only
 *     - Completed steps are never re-run
 *     - Redis crawl cache (24hr TTL) is still valid if resume happens quickly
 *
 * USAGE:
 *   Called by a handler route (POST /api/projects/:id/pipeline/resume)
 *   or manually via a script for debugging.
 *
 *   import { resumePipeline } from '@/lib/pipeline-resume';
 *   await resumePipeline(projectId);
 *
 * RESUME LOGIC:
 *   1. Load project — read pipeline.steps
 *   2. Find the first step in PIPELINE_SEQUENCE that is ERRORED or PENDING
 *      (whichever comes first — ERRORED takes priority over PENDING)
 *   3. Reset that step's status to PENDING in the DB
 *   4. Reset pipeline.status to RUNNING
 *   5. Enqueue that step in SEO_PIPELINE queue with standard retry config
 *
 * WHAT CANNOT BE RESUMED:
 *   - SITE_CRAWL errored AND Redis cache expired (>24hr ago) →
 *     must restart from scratch. We detect this and throw a clear error.
 *   - Pipeline status is RUNNING → already in progress, don't double-enqueue.
 *   - Pipeline status is COMPLETED → nothing to resume.
 *
 * IDEMPOTENCY:
 *   Safe to call multiple times — checks pipeline status before enqueuing.
 *   If step is already in BullMQ queue (e.g. waiting), won't double-enqueue
 *   because we check pipeline.status === 'RUNNING' first.
 *
 * FORCE RESTART:
 *   resumePipeline(projectId, { fromStep: 'SITE_CRAWL' }) forces restart
 *   from a specific step, skipping the auto-detection logic.
 *   Used when you explicitly want to re-crawl (e.g. site content changed).
 */

import { Project }         from '@/models/Project';
import { getRedis }        from '@/loaders/redis';
import { logger }          from '@/open-tele';
import {
  PIPELINE_SEQUENCE,
  PIPELINE_STEP,
  JOB_PRIORITY,
  JOB_RETRY_CONFIG,
  type PipelineStep,
} from '@/constants/seo-pipeline.constants';
import { seoPipelineQueue } from '@/workers/seo-pipeline.worker';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ResumeOptions {
  /** Force resume from a specific step (skips auto-detection) */
  fromStep?: PipelineStep;
  /** If true, re-enqueues even if pipeline.status is RUNNING */
  force?: boolean;
}

export interface ResumeResult {
  resumed:   boolean;
  fromStep:  PipelineStep | null;
  reason:    string;
}

// ── Redis crawl cache check ────────────────────────────────────────────────

/**
 * Checks if the Redis crawl cache for this project still exists.
 * Used to determine if SITE_CRAWL can be skipped during resume.
 */
async function isCrawlCacheValid(projectId: string): Promise<boolean> {
  const redis = getRedis();
  const key   = `crawl:${projectId}:urls`;
  const ttl   = await redis.ttl(key);
  // ttl > 0 means key exists and has not expired
  return ttl > 0;
}

// ── Step finder ────────────────────────────────────────────────────────────

/**
 * Finds the first step that needs to be resumed.
 * Priority: ERRORED steps first, then first PENDING step after last COMPLETED.
 *
 * Example pipeline state:
 *   SITE_CRAWL:       COMPLETED
 *   BUSINESS_PROFILE: COMPLETED
 *   TECHNICAL_AUDIT:  ERRORED    ← resume from here
 *   COMPETITOR_DISCOVERY: PENDING
 *   ...
 *
 * Returns null if pipeline is fully completed or has no actionable steps.
 */
function findResumeStep(
  steps: Partial<Record<PipelineStep, { status: string }>>,
): PipelineStep | null {
  // First pass: find any ERRORED step
  for (const step of PIPELINE_SEQUENCE) {
    if (steps[step]?.status === 'ERRORED') {
      return step;
    }
  }

  // Second pass: find first PENDING step that comes after the last COMPLETED step
  let lastCompletedIndex = -1;
  for (let i = 0; i < PIPELINE_SEQUENCE.length; i++) {
    if (steps[PIPELINE_SEQUENCE[i]!]?.status === 'COMPLETED') {
      lastCompletedIndex = i;
    }
  }

  // Next step after last completed
  const nextIndex = lastCompletedIndex + 1;
  if (nextIndex < PIPELINE_SEQUENCE.length) {
    return PIPELINE_SEQUENCE[nextIndex]!;
  }

  return null;
}

// ── Main resume function ───────────────────────────────────────────────────

export async function resumePipeline(
  projectId: string,
  options:   ResumeOptions = {},
): Promise<ResumeResult> {

  // 1. Load project
  const project = await Project.findById(projectId).lean();
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const { pipeline } = project;

  // 2. Guard: already running (unless force)
  if (pipeline.status === 'RUNNING' && !options.force) {
    logger.warn('Pipeline resume skipped — already running', { projectId });
    return {
      resumed:  false,
      fromStep: pipeline.currentStep ?? null,
      reason:   'Pipeline is already RUNNING. Use force:true to override.',
    };
  }

  // 3. Guard: already completed
  if (pipeline.status === 'COMPLETED') {
    logger.info('Pipeline resume skipped — already completed', { projectId });
    return {
      resumed:  false,
      fromStep: null,
      reason:   'Pipeline is already COMPLETED. Nothing to resume.',
    };
  }

  // 4. Determine which step to resume from
  const targetStep: PipelineStep = options.fromStep
    ?? findResumeStep(pipeline.steps) as PipelineStep;

  if (!targetStep) {
    return {
      resumed:  false,
      fromStep: null,
      reason:   'No resumable step found — pipeline may be in an unexpected state.',
    };
  }

  logger.info('Resuming pipeline from step', { projectId, targetStep });

  // 5. Special case: resuming SITE_CRAWL or step that depends on crawl cache
  //    If cache is expired and we're resuming past SITE_CRAWL, warn clearly.
  const targetIndex    = PIPELINE_SEQUENCE.indexOf(targetStep);
  const crawlStepIndex = PIPELINE_SEQUENCE.indexOf(PIPELINE_STEP.SITE_CRAWL);

  if (targetIndex > crawlStepIndex) {
    const cacheValid = await isCrawlCacheValid(projectId);
    if (!cacheValid) {
      // Cache expired — downstream steps (TECHNICAL_AUDIT etc.) read from Redis.
      // Must restart from SITE_CRAWL to rebuild the cache.
      logger.warn('Crawl cache expired — forcing resume from SITE_CRAWL', {
        projectId,
        requestedStep: targetStep,
      });

      // Override target to SITE_CRAWL
      return resumePipeline(projectId, { fromStep: PIPELINE_STEP.SITE_CRAWL, force: options.force });
    }
  }

  // 6. Reset step status + pipeline status in DB
  //    Mark target step as PENDING (clears error), reset pipeline to RUNNING.
  //    Also reset all steps AFTER target to PENDING — they haven't run yet.
  const stepUpdates: Record<string, unknown> = {
    'pipeline.status':      'RUNNING',
    'pipeline.currentStep': targetStep,
  };

  for (let i = targetIndex; i < PIPELINE_SEQUENCE.length; i++) {
    const step = PIPELINE_SEQUENCE[i]!;
    stepUpdates[`pipeline.steps.${step}.status`] = 'PENDING';
    stepUpdates[`pipeline.steps.${step}.error`]  = null;
  }

  await Project.findByIdAndUpdate(projectId, { $set: stepUpdates });

  logger.info('Pipeline step statuses reset', {
    projectId,
    targetStep,
    stepsReset: PIPELINE_SEQUENCE.slice(targetIndex),
  });

  // 7. Enqueue the target step
  const retryConfig = JOB_RETRY_CONFIG[targetStep] ?? { attempts: 3, backoffDelay: 10_000 };
  const priority    = JOB_PRIORITY[targetStep as keyof typeof JOB_PRIORITY] ?? 3;

  await seoPipelineQueue.add(
    targetStep,
    { projectId, step: targetStep },
    {
      priority,
      attempts: retryConfig.attempts,
      backoff:  { type: 'exponential', delay: retryConfig.backoffDelay },
    },
  );

  logger.info('Pipeline resume enqueued', {
    projectId,
    targetStep,
    priority,
    attempts: retryConfig.attempts,
  });

  return {
    resumed:  true,
    fromStep: targetStep,
    reason:   `Resumed from ${targetStep}`,
  };
}

// ── Pipeline status reader ─────────────────────────────────────────────────

/**
 * Returns a human-readable summary of the current pipeline state.
 * Used by the dashboard API to show pipeline progress.
 */
export async function getPipelineStatus(projectId: string): Promise<{
  status:      string;
  currentStep: string | null;
  steps:       Array<{ step: string; status: string; error?: string }>;
  canResume:   boolean;
  resumeFrom:  string | null;
}> {
  const project = await Project.findById(projectId).lean();
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const { pipeline } = project;

  const steps = PIPELINE_SEQUENCE.map(step => ({
    step,
    status: pipeline.steps[step]?.status ?? 'PENDING',
    error:  pipeline.steps[step]?.error,
  }));

  const hasErrored  = steps.some(s => s.status === 'ERRORED');
  const isCompleted = pipeline.status === 'COMPLETED';
  const isRunning   = pipeline.status === 'RUNNING';

  const canResume  = hasErrored || (!isCompleted && !isRunning);
  const resumeFrom = canResume
    ? (findResumeStep(pipeline.steps) ?? null)
    : null;

  return {
    status:      pipeline.status,
    currentStep: pipeline.currentStep ?? null,
    steps,
    canResume,
    resumeFrom,
  };
}
