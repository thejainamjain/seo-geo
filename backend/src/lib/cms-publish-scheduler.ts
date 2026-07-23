/**
 * lib/cms-publish-scheduler.ts
 *
 * WHAT: Manages per-project CMS publish schedules using BullMQ's native
 *       Job Scheduler primitive (upsertJobScheduler) — one recurring,
 *       self-maintaining cron schedule PER PROJECT, each running at that
 *       project's own publishHourUtc / allowedPublishDays.
 *
 * WHY THIS EXISTS (replacing the old fixed-time daily sweep):
 *   The previous design (global-scheduler.job.ts's runCmsPublishScheduler)
 *   was a single daily cron trigger fixed at 17:00 UTC, which then checked
 *   `hourUtc < publishHourUtc → skip` per project. That only works if
 *   every project's publishHourUtc is <= 17 — a project configured later
 *   in the day would never get picked up, since there's no later trigger
 *   to catch it. See docs/07-phases6-8-content-generation-publish-audit.md
 *   for the full history — publishHourUtc isn't exposed via the API today
 *   so this was dormant, not active, but it was a landmine waiting for
 *   whenever that field gets exposed.
 *
 *   This design fixes that structurally: each project gets its OWN BullMQ
 *   cron schedule (`0 ${publishHourUtc} * * ${allowedPublishDays}`, UTC),
 *   so it fires at exactly the right time regardless of what that time is
 *   — no sweep, no "did the single daily trigger happen to be late enough"
 *   check needed at all.
 *
 * WHEN SCHEDULES ARE CREATED/UPDATED/REMOVED:
 *   - services/cms.service.ts's updateCmsConfig(): autoPublish turned on,
 *     or allowedPublishDays changed while autoPublish is on → upsert.
 *     autoPublish turned off → remove.
 *   - services/cms.service.ts's disconnectCms(): always remove.
 *   - Worker boot (scheduler.worker.ts calls reconcileCmsPublishSchedules
 *     once on startup): idempotent safety net — re-asserts the correct
 *     schedule for every autoPublish:true project. Covers first deploy of
 *     this change (existing projects had no per-project scheduler yet) and
 *     recovery if Redis's scheduler data was ever lost.
 *
 * IDEMPOTENCY: upsertJobScheduler is upsert-by-design — calling it again
 * with the same schedulerId replaces the existing schedule rather than
 * creating a duplicate. Safe to call on every relevant config change and
 * on every worker boot without needing to check "does this already exist"
 * first.
 */

import { Queue } from 'bullmq';
import { logger } from '@/open-tele';
import { CmsConfig } from '@/models/CmsConfig';
import { getConnectionOptions } from '@/loaders/redis';
import { QUEUE_NAMES } from '@/constants/seo-pipeline.constants';

const cmsPublishQueue = new Queue<{ projectId: string }>(QUEUE_NAMES.CMS_PUBLISH_CRON, {
  connection: getConnectionOptions(),
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 200 },
  },
});

function schedulerId(projectId: string): string {
  return `cms-publish:${projectId}`;
}

/** Builds a UTC cron pattern for the given hour + allowed days.
 *  e.g. hour=20, days=[1,2,3,4,5,6] → "0 20 * * 1,2,3,4,5,6" */
function buildCronPattern(publishHourUtc: number, allowedPublishDays: number[]): string {
  const days = allowedPublishDays.length > 0 ? allowedPublishDays.join(',') : '1,2,3,4,5,6';
  return `0 ${publishHourUtc} * * ${days}`;
}

/**
 * Creates or updates the recurring CMS-publish schedule for a project.
 * Call whenever autoPublish is (or becomes) true, or when
 * allowedPublishDays/publishHourUtc change while autoPublish is true.
 */
export async function upsertCmsPublishSchedule(
  projectId:          string,
  publishHourUtc:     number,
  allowedPublishDays: number[],
): Promise<void> {
  const pattern = buildCronPattern(publishHourUtc, allowedPublishDays);

  await cmsPublishQueue.upsertJobScheduler(
    schedulerId(projectId),
    { pattern, tz: 'UTC' },
    {
      name: 'cms-publish',
      data: { projectId },
      opts: {
        attempts: 3,
        backoff:  { type: 'exponential', delay: 30_000 },
      },
    },
  );

  logger.info('CMS publish schedule upserted', { projectId, pattern, publishHourUtc, allowedPublishDays });
}

/**
 * Removes a project's recurring CMS-publish schedule.
 * Call when autoPublish is turned off, or CMS is disconnected.
 */
export async function removeCmsPublishSchedule(projectId: string): Promise<void> {
  const removed = await cmsPublishQueue.removeJobScheduler(schedulerId(projectId));
  logger.info('CMS publish schedule removed', { projectId, existed: removed });
}

/**
 * Reconciliation pass — re-asserts the correct schedule for every project
 * with autoPublish:true. Idempotent (upsert), safe to run on every worker
 * boot. This is what migrates existing projects onto the new per-project
 * scheduler design without needing a one-off manual migration script.
 */
export async function reconcileCmsPublishSchedules(): Promise<void> {
  const configs = await CmsConfig.find({ autoPublish: true })
    .select('projectId publishHourUtc allowedPublishDays')
    .lean();

  logger.info('Reconciling CMS publish schedules', { count: configs.length });

  for (const config of configs) {
    try {
      await upsertCmsPublishSchedule(
        String(config.projectId),
        config.publishHourUtc     ?? 17,
        config.allowedPublishDays ?? [1, 2, 3, 4, 5, 6],
      );
    } catch (err) {
      // Non-fatal per project — one bad config shouldn't block the others
      logger.error(
        err instanceof Error ? err : new Error(String(err)),
        { context: 'reconcileCmsPublishSchedules', projectId: String(config.projectId) },
      );
    }
  }
}
