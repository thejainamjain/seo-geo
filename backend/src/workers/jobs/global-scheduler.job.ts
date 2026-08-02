/**
 * workers/jobs/global-scheduler.job.ts
 *
 * WHAT: Two global cron jobs that fan out work to per-project queues.
 *
 * PATTERN (industry standard):
 *   One repeatable job fires on schedule → loads all active projects →
 *   enqueues individual jobs per project → workers process with concurrency.
 *
 * WHY ONE GLOBAL JOB (not per-project crons):
 *   - 100 projects × per-project crons = 100 simultaneous bursts at schedule time
 *   - Global fan-out = controlled, rate-limited, observable
 *   - One place to change the schedule for all projects
 *   - BullMQ repeatable jobs are simpler to manage as singletons
 *
 *   NOTE: CMS publishing does NOT use this pattern anymore — it moved to
 *   per-project BullMQ Job Schedulers (see lib/cms-publish-scheduler.ts)
 *   because, unlike GEO analytics and GSC monitoring (which run at the
 *   same global time for every project), CMS publish time is meant to be
 *   per-project configurable. A single global trigger structurally can't
 *   serve that correctly — see
 *   docs/07-phases6-8-content-generation-publish-audit.md for the history.
 *
 * THREE SCHEDULERS:
 *
 *   1. GEO_ANALYTICS_SCHEDULER — every Monday at 10:00 UTC
 *      Finds all projects with at least one published keyword
 *      Enqueues one geo-analytics job per project
 *
 *   2. GSC_MONITOR_SCHEDULER — every Monday at 11:00 UTC
 *      Finds all projects with GSC connected + published blogs
 *      Enqueues one gsc-monitor job per project
 *
 *   3. CMS_RESYNC_RETRY_SCHEDULER — every 4 hours
 *      Retries BlogOptimization records whose earlier CMS re-sync attempt
 *      failed (see lib/blog-cms-publisher.ts's updateBlogOnCms(), called
 *      from workers/jobs/blog-optimization.job.ts and
 *      services/optimization.service.ts). Unlike the other two, this one
 *      processes records directly in the scheduler job itself rather than
 *      fanning out to a per-project queue — the expected volume is small
 *      (only genuine failures: network blips, a platform being down),
 *      and each retry is a single lightweight CMS API call, not
 *      LLM/DataForSEO work — a whole extra queue+worker for that would be
 *      more machinery than the problem needs. Capped per run
 *      (CMS_RESYNC_RETRY_BATCH_SIZE) so a large backlog can't turn one
 *      run into an hours-long job; the next scheduled run picks up
 *      whatever's left.
 *
 * IDEMPOTENCY:
 *   Per-project jobs use jobId: `{type}:{projectId}:{date}` so the same
 *   project is never double-enqueued on the same day even if scheduler retries.
 *   CMS_RESYNC_RETRY_SCHEDULER doesn't need this — it queries
 *   `cmsResyncPending: true` fresh each run and only clears the flag on
 *   confirmed success, so re-running it (including a genuine BullMQ retry
 *   of the scheduler job itself) just retries whatever's still actually
 *   pending — naturally idempotent, no jobId scheme needed.
 */

import { Queue }         from 'bullmq';
import { logger }        from '@/open-tele';
import { GoogleToken }   from '@/models/GoogleToken';
import { Keyword }       from '@/models/Keyword';
import { Blog }          from '@/models/Blog';
import { BlogOptimization } from '@/models/BlogLearning';
import { Project }       from '@/models/Project';
import { CmsConfig }     from '@/models/CmsConfig';
import { updateBlogOnCms } from '@/lib/blog-cms-publisher';
import { getConnectionOptions } from '@/loaders/redis';
import { QUEUE_NAMES }   from '@/constants/seo-pipeline.constants';

// ── Queue instances for fan-out ────────────────────────────────────────────

const geoAnalyticsQueue = new Queue<{ projectId: string }>(QUEUE_NAMES.GEO_ANALYTICS, {
  connection: getConnectionOptions(),
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 200 },
  },
});

const gscMonitorQueue = new Queue<{ projectId: string }>(QUEUE_NAMES.GSC_MONITOR, {
  connection: getConnectionOptions(),
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 200 },
  },
});

// ── Date key for idempotent job IDs ───────────────────────────────────────

function todayKey(): string {
  return new Date().toISOString().split('T')[0]!; // "2026-06-29"
}

// ── Orphaned repeatable job cleanup ────────────────────────────────────────

/**
 * geoAnalyticsQueue / gscMonitorQueue exist ONLY to receive per-project,
 * one-off fan-out jobs (added with a plain `{ projectId }` payload — see
 * runGeoAnalyticsScheduler/runGscMonitorScheduler below). An earlier
 * version of this system mistakenly registered the weekly cron as a
 * BullMQ repeatable job directly on these two queues instead of on the
 * dedicated scheduler queue (see scheduler.worker.ts's registerSchedulers,
 * which now does this correctly). BullMQ repeatable job definitions are
 * stored in Redis independently of the code that created them, so fixing
 * the registration code did NOT remove the already-scheduled cron — it
 * kept firing every week with an empty `{}` payload, and every fire
 * failed 3 times with "Project not found: undefined" (job.data.projectId
 * was never set, since a repeat job carries no per-project data). See
 * runGeoAnalyticsJob/runGscMonitorJob's projectId guard for the
 * complementary fix that makes any future misuse fail fast instead of
 * retrying uselessly.
 *
 * Idempotent and safe to run on every boot: once the stale entries are
 * gone this is a no-op, and it can never remove a legitimate job since
 * these queues are never supposed to hold a repeatable one.
 */
export async function removeOrphanedRepeatableJobs(): Promise<void> {
  for (const queue of [geoAnalyticsQueue, gscMonitorQueue]) {
    const repeatables = await queue.getRepeatableJobs();
    for (const repeatable of repeatables) {
      await queue.removeRepeatableByKey(repeatable.key);
      logger.warn('Removed orphaned repeatable job from per-project queue', {
        queue:   queue.name,
        jobName: repeatable.name,
        pattern: repeatable.pattern,
        key:     repeatable.key,
      });
    }
  }
}

// ── Scheduler 1: GEO analytics fan-out ────────────────────────────────────

export async function runGeoAnalyticsScheduler(): Promise<void> {
  logger.info('GEO analytics scheduler started');

  // Find all projects with at least one published or ready keyword
  const projectIds = await Keyword.distinct('projectId', {
    status: { $in: ['published', 'ready'] },
  }) as unknown as string[];

  if (projectIds.length === 0) {
    logger.info('GEO analytics scheduler: no projects with published keywords');
    return;
  }

  const dateKey = todayKey();
  let enqueued  = 0;

  for (const projectId of projectIds) {
    await geoAnalyticsQueue.add(
      `geo-analytics:${projectId}`,
      { projectId: String(projectId) },
      {
        jobId:    `geo-analytics:${projectId}:${dateKey}`,
        attempts: 3,
        backoff:  { type: 'exponential', delay: 15_000 },
      },
    );
    enqueued++;
  }

  logger.info('GEO analytics scheduler completed', { enqueued });
}

// ── Scheduler 2: GSC monitor fan-out ──────────────────────────────────────

export async function runGscMonitorScheduler(): Promise<void> {
  logger.info('GSC monitor scheduler started');

  // Find all projects with GSC connected (have a GoogleToken)
  const tokens = await GoogleToken.find({}).select('projectId').lean();

  if (tokens.length === 0) {
    logger.info('GSC monitor scheduler: no projects with GSC connected');
    return;
  }

  // Filter: only projects with published blogs (no point monitoring if nothing published)
  const projectIds = tokens.map(t => String(t.projectId));

  const publishedProjectIds = await Blog.distinct('projectId', {
    projectId: { $in: projectIds },
    status:    'published',
  }) as unknown as string[];

  if (publishedProjectIds.length === 0) {
    logger.info('GSC monitor scheduler: no projects with published blogs');
    return;
  }

  const dateKey = todayKey();
  let enqueued  = 0;

  for (const projectId of publishedProjectIds) {
    await gscMonitorQueue.add(
      `gsc-monitor:${projectId}`,
      { projectId: String(projectId) },
      {
        jobId:    `gsc-monitor:${projectId}:${dateKey}`,
        attempts: 3,
        backoff:  { type: 'exponential', delay: 15_000 },
      },
    );
    enqueued++;
  }

  logger.info('GSC monitor scheduler completed', { enqueued });
}

// ── Scheduler 3: CMS resync retry sweep ────────────────────────────────────

const CMS_RESYNC_RETRY_BATCH_SIZE = 50; // cap per run — see file header

export async function runCmsResyncRetryScheduler(): Promise<void> {
  logger.info('CMS resync retry scheduler started');

  const pending = await BlogOptimization.find({ cmsResyncPending: true })
    .select('_id blogId projectId')
    .limit(CMS_RESYNC_RETRY_BATCH_SIZE)
    .lean();

  if (pending.length === 0) {
    logger.info('CMS resync retry scheduler: nothing pending');
    return;
  }

  logger.info('CMS resync retry scheduler processing batch', { count: pending.length });

  let succeeded = 0;
  let failed    = 0;
  let skipped   = 0; // no CMS config found, or blog/project missing — not a retryable failure

  for (const record of pending) {
    const projectId = String(record.projectId);
    const blogId     = String(record.blogId);

    try {
      const [project, cmsConfig] = await Promise.all([
        Project.findById(projectId).select('domain').lean(),
        CmsConfig.findOne({ projectId }).select('+encryptedCredentials').lean(),
      ]);

      if (!project || !cmsConfig?.cmsType || !cmsConfig.encryptedCredentials) {
        // Project deleted, or CMS disconnected since the optimization was
        // applied — nothing to retry against. Clear the flag rather than
        // retrying forever against a config that no longer exists; if the
        // user reconnects a CMS later, cms-publish.job.ts's normal sweep
        // will pick up the blog's current (already-updated) content on
        // its next scheduled run same as any other blog.
        await BlogOptimization.updateOne({ _id: record._id }, { $set: { cmsResyncPending: false } });
        skipped++;
        continue;
      }

      const result = await updateBlogOnCms(blogId, projectId, project.domain, {
        cmsType:              cmsConfig.cmsType,
        encryptedCredentials: cmsConfig.encryptedCredentials,
        blogPostPath:         cmsConfig.blogPostPath,
        autoPublish:          cmsConfig.autoPublish,
        allowedPublishDays:   cmsConfig.allowedPublishDays,
        publishHourUtc:       cmsConfig.publishHourUtc,
      }, project.brandColor, project.useDefaultBlogTheme);

      if (result.success) {
        await BlogOptimization.updateOne({ _id: record._id }, { $set: { cmsResyncPending: false } });
        succeeded++;
      } else {
        // Still pending — leave the flag set, next run tries again.
        // (Framer's skippedReason will keep landing here every run since
        // it's never going to succeed until that platform has a real
        // update path — a genuine, currently-unavoidable exception to
        // "this sweep clears its own backlog." Acceptable: it's already
        // visible via the skippedReason in the logs each time.)
        logger.warn('CMS resync retry did not succeed — will retry next run', {
          projectId, blogId, optimizationId: String(record._id),
          reason: result.skippedReason ?? result.error,
        });
        failed++;
      }

    } catch (err) {
      // Per-record failure isolation — one bad record shouldn't block the rest of the batch
      logger.error(
        err instanceof Error ? err : new Error(String(err)),
        { context: 'cms-resync-retry-scheduler', projectId, blogId, optimizationId: String(record._id) },
      );
      failed++;
    }
  }

  logger.info('CMS resync retry scheduler completed', {
    total: pending.length, succeeded, failed, skipped,
  });
}
