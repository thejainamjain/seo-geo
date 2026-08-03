/**
 * lib/keyword-generation-scheduler.ts
 *
 * WHAT: Automatically queues blog generation for every keyword's assigned
 *       content-calendar week, without requiring a manual "Generate" click.
 *
 * BEHAVIOR:
 *   - Week 1 (the project's first 5 keywords): enqueued for generation
 *     IMMEDIATELY, no delay — the user sees their first batch of content
 *     right away rather than waiting.
 *   - Every other week: ONE delayed trigger per week, firing 24 hours
 *     before that week's start date (Keyword.startDate, already computed
 *     in keyword-research.job.ts as project.createdAt + (weekNumber-1)×7
 *     days). When it fires, it looks up that week's keywords fresh from
 *     the DB and enqueues each for generation.
 *
 * WHY A 24H BUFFER (not literally the last second):
 *   Every current guide on automated content pipelines converges on the
 *   same point: even with full automation, leave a review window before
 *   content goes live. Generating at the literal last possible moment
 *   leaves zero room for that. 24h keeps content close to publish-time
 *   (still fresh, still reflects near-current SERP/competitor data) while
 *   leaving a real buffer.
 *
 * WHY DELAYED JOBS (not a repeating cron sweep):
 *   Same reasoning as lib/cms-publish-scheduler.ts — each week only needs
 *   to fire ONCE, ever, at a known fixed timestamp (weekNumber/startDate
 *   don't change after keyword-research runs). A plain BullMQ delayed job
 *   (`{ delay: ms }`) is the right primitive for a one-time future event;
 *   a cron/JobScheduler is for genuinely recurring schedules, which this
 *   isn't — CmsConfig's publish time IS recurring (see
 *   lib/cms-publish-scheduler.ts), so that one legitimately uses
 *   upsertJobScheduler instead.
 *
 * WHAT HAPPENS WHEN A TRIGGER FIRES (see runWeeklyGenerationTrigger below):
 *   Re-queries Keyword.find({ projectId, weekNumber, status: 'upcoming' })
 *   at fire time rather than using a keyword list captured at schedule
 *   time — so if a keyword was deleted, or its status already changed
 *   (e.g. manually generated early) between scheduling and fire time, it's
 *   naturally excluded. Each found keyword is enqueued onto the SAME
 *   CONTENT_GENERATION queue and reuses the exact same generate+
 *   conditional-publish logic as the manual "Generate" button
 *   (content-generation.job.ts) — no duplicated business logic here, this
 *   module only handles WHEN things get triggered, not WHAT they do.
 *
 * IDEMPOTENCY:
 *   Every enqueue (both the per-keyword CONTENT_GENERATION jobs and the
 *   per-week trigger jobs) uses a deterministic jobId
 *   (`content-generation-{keywordId}`, `weekly-trigger-{projectId}-{weekNumber}` —
 *   dashes, not colons: BullMQ rejects ':' in custom job IDs).
 *   BullMQ ignores an add() with a jobId that already exists and isn't yet
 *   completed/failed — the same dedup pattern this codebase already
 *   relies on in workers/jobs/global-scheduler.job.ts. Safe to call this
 *   on every keyword-research retry without double-scheduling anything.
 */

import { Queue } from 'bullmq';
import { logger } from '@/open-tele';
import { Keyword } from '@/models/Keyword';
import { getConnectionOptions } from '@/loaders/redis';
import { QUEUE_NAMES, JOB_RETRY_CONFIG } from '@/constants/seo-pipeline.constants';

const contentGenerationQueue = new Queue<{ projectId: string; keywordId: string }>(
  QUEUE_NAMES.CONTENT_GENERATION,
  { connection: getConnectionOptions() },
);

const weeklyTriggerQueue = new Queue<{ projectId: string; weekNumber: number }>(
  QUEUE_NAMES.WEEKLY_GENERATION_TRIGGER,
  { connection: getConnectionOptions() },
);

const GENERATION_BUFFER_MS = 24 * 60 * 60 * 1000; // 24h before week boundary

// NOTE: jobId must not contain ':' — BullMQ uses it as an internal Redis
// key delimiter and Job.validateOptions() throws "Custom Id cannot contain
// :" if you pass one. This function previously returned a colon-separated
// id, which meant EVERY call to enqueueContentGeneration() below threw —
// including the week-1 "immediate" branch, which runs first in
// scheduleWeeklyGeneration()'s loop. That's why automatic blog generation
// silently stopped working: this exception propagated out of
// scheduleWeeklyGeneration() and up into keyword-research.job.ts, which is
// also why KEYWORD_RESEARCH pipeline steps were failing permanently even
// though the keywords themselves had already been upserted successfully.
function contentGenerationJobId(keywordId: string): string {
  return `content-generation-${keywordId}`;
}

async function enqueueContentGeneration(projectId: string, keywordId: string): Promise<void> {
  const retryConfig = JOB_RETRY_CONFIG['CONTENT_GENERATION']!;
  await contentGenerationQueue.add(
    'content-generation',
    { projectId, keywordId },
    {
      jobId:    contentGenerationJobId(keywordId),
      attempts: retryConfig.attempts,
      backoff:  { type: 'exponential', delay: retryConfig.backoffDelay },
    },
  );
}

/**
 * Called once from keyword-research.job.ts right after keywords are
 * upserted. Schedules the whole project's content calendar in one pass —
 * week 1 immediate, every other week as a delayed trigger.
 */
export async function scheduleWeeklyGeneration(
  projectId: string,
  keywords: Array<{ _id: unknown; weekNumber?: number; startDate?: Date }>,
): Promise<void> {
  const byWeek = new Map<number, Array<{ _id: unknown; startDate?: Date }>>();
  for (const kw of keywords) {
    if (!kw.weekNumber) continue; // shouldn't happen — defensive skip
    if (!byWeek.has(kw.weekNumber)) byWeek.set(kw.weekNumber, []);
    byWeek.get(kw.weekNumber)!.push(kw);
  }

  let immediateCount = 0;
  let scheduledWeeks = 0;

  for (const [weekNumber, weekKeywords] of byWeek) {
    if (weekNumber === 1) {
      for (const kw of weekKeywords) {
        await enqueueContentGeneration(projectId, String(kw._id));
        immediateCount++;
      }
      continue;
    }

    const startDate = weekKeywords[0]?.startDate;
    if (!startDate) continue; // defensive — shouldn't happen, startDate always set alongside weekNumber

    const fireAt = startDate.getTime() - GENERATION_BUFFER_MS;
    const delay  = Math.max(0, fireAt - Date.now());

    await weeklyTriggerQueue.add(
      'weekly-generation-trigger',
      { projectId, weekNumber },
      {
        // See contentGenerationJobId() above — jobId can't contain ':'.
        jobId:    `weekly-trigger-${projectId}-${weekNumber}`,
        delay,
        attempts: 3,
        backoff:  { type: 'exponential', delay: 30_000 },
      },
    );
    scheduledWeeks++;
  }

  logger.info('Weekly generation schedule created', {
    projectId,
    totalWeeks:     byWeek.size,
    immediateCount, // week 1, enqueued now
    scheduledWeeks, // weeks 2+, delayed triggers
  });
}

/**
 * Processor for WEEKLY_GENERATION_TRIGGER jobs — called from a Worker
 * registered in scheduler.worker.ts. Fires once per project per week
 * (weeks 2+), 24h before that week's start date.
 */
export async function runWeeklyGenerationTrigger(data: {
  projectId:  string;
  weekNumber: number;
}): Promise<void> {
  const { projectId, weekNumber } = data;

  // Re-query fresh — don't trust a keyword list captured at schedule time.
  const keywords = await Keyword.find({
    projectId,
    weekNumber,
    status: 'upcoming', // skip anything already generated early, deleted, etc.
  }).select('_id').lean();

  if (keywords.length === 0) {
    logger.info('Weekly generation trigger fired — no upcoming keywords to enqueue', {
      projectId, weekNumber,
    });
    return;
  }

  for (const kw of keywords) {
    await enqueueContentGeneration(projectId, String(kw._id));
  }

  logger.info('Weekly generation trigger enqueued content generation', {
    projectId, weekNumber, count: keywords.length,
  });
}
