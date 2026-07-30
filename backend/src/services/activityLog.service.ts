/**
 * services/activityLog.service.ts
 *
 * Thin write-side wrapper around the ActivityLog model — see
 * models/ActivityLog.ts for what this collection is and isn't for.
 *
 * ACCESS MODEL: unlike every other service in this codebase, `logActivity`
 * takes no userId and does NOT call assertProjectAccess. It's only ever
 * called from trusted internal contexts (BullMQ workers acting on a
 * projectId they already own the job for), never directly from a
 * request handler — there's no user-facing write path for this
 * collection. Reading it back out (dashboard.service.ts) IS
 * user-facing and DOES go through the normal access check.
 *
 * Logging failures are swallowed (logged, not thrown) — an activity-feed
 * write failing should never fail the pipeline step it's describing.
 */

import { ActivityLog, type ActivityType } from '../models';
import { logger } from '../open-tele';

export const activityLogService = {
  async logActivity(
    projectId: string,
    type: ActivityType,
    title: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await ActivityLog.create({ projectId, type, title, meta });
    } catch (err) {
      // Best-effort — see file header.
      logger.error(
        err instanceof Error ? err : new Error(String(err)),
        { context: 'activityLogService.logActivity', projectId, type },
      );
    }
  },
};
