/**
 * services/dashboard.service.ts
 *
 * WHAT: Backs the Home dashboard (frontend overview page). Composes
 * several things, all derived from data that genuinely exists — nothing
 * here is fabricated or smoothed to look nicer:
 *
 *   1. searchOpportunity — sum of DataForSEO monthly search volume across
 *      this project's tracked keywords. NOTE: this is deliberately NOT
 *      the same claim as a "total addressable market" number — it's the
 *      volume of the keywords we've actually identified, which grows as
 *      keyword-research.job.ts finds more. Labelled accordingly in the
 *      response so the frontend doesn't overstate it.
 *
 *   2. growthTimeline — cumulative scheduled search volume + keyword
 *      count, grouped by the real content-calendar `weekNumber` already
 *      stored on Keyword. Deliberately does NOT include a "visitors"
 *      curve — no backend source exists for actual or forecasted
 *      traffic. (BlogLearning.gscSnapshot was considered and rejected:
 *      it's only written when a specific insight fires — ranking_drop,
 *      high_impression, etc — not on a regular cadence for every blog,
 *      so it's a biased sample skewed toward underperforming posts, not
 *      a real time series. Using it here would be misleading in the
 *      other direction from fabricating a number outright.)
 *
 *   3. geoVisibilityHistory — REAL history (not a projection) of AI
 *      search visibility, straight from GeoAnalyticsRun. Unlike
 *      BlogLearning, this collection gets one row per project per week
 *      unconditionally (see workers/jobs/geo-analytics.job.ts and its
 *      scheduler in workers/jobs/global-scheduler.job.ts) — a genuine,
 *      unbiased periodic series. This is what actually substitutes for
 *      the reference design's "AI Mention %" curve.
 *
 *   4. activity — queued + completed, see getQueuedActivity /
 *      getCompletedActivity below.
 */

import { Keyword, Project, OrganizationMember, ActivityLog, BlogOptimization, GoogleToken, Blog, GeoAnalyticsRun } from '../models';
import { NotFoundError, ForbiddenError } from '../utils/errors';

async function assertProjectAccess(userId: string, projectId: string) {
  const project = await Project.findById(projectId);
  if (!project) throw new NotFoundError('Project');

  const membership = await OrganizationMember.findOne({
    userId,
    organizationId: project.organizationId,
  });
  if (!membership) throw new ForbiddenError();

  return project;
}

// ── 1. Search opportunity ───────────────────────────────────────────────────

async function getSearchOpportunity(projectId: string) {
  const keywords = await Keyword.find({ projectId })
    .select('searchVolume')
    .lean();

  const trackedKeywordCount = keywords.length;
  const monthlySearchVolume = keywords.reduce(
    (sum, k) => sum + (k.searchVolume ?? 0),
    0,
  );

  return { monthlySearchVolume, trackedKeywordCount };
}

// ── 2. Growth timeline (derived from the real content calendar) ────────────

async function getGrowthTimeline(projectId: string) {
  const keywords = await Keyword.find({ projectId })
    .select('weekNumber searchVolume')
    .lean();

  const byWeek = new Map<number, { searchVolume: number; keywordCount: number }>();
  for (const k of keywords) {
    if (k.weekNumber == null) continue; // not yet scheduled into a week
    const bucket = byWeek.get(k.weekNumber) ?? { searchVolume: 0, keywordCount: 0 };
    bucket.searchVolume += k.searchVolume ?? 0;
    bucket.keywordCount += 1;
    byWeek.set(k.weekNumber, bucket);
  }

  const weeks = [...byWeek.keys()].sort((a, b) => a - b);

  let cumulativeSearchVolume = 0;
  let cumulativeKeywordCount = 0;

  return weeks.map(week => {
    const bucket = byWeek.get(week)!;
    cumulativeSearchVolume += bucket.searchVolume;
    cumulativeKeywordCount += bucket.keywordCount;
    return {
      week,
      cumulativeSearchVolume,
      cumulativeKeywordCount,
    };
  });
}

// ── 3. GEO visibility history (real, not projected) ─────────────────────────

async function getGeoVisibilityHistory(projectId: string) {
  const runs = await GeoAnalyticsRun.find({ projectId, status: 'completed' })
    .select('periodIndex objectivePercentage runAt')
    .sort({ periodIndex: 1 })
    .lean();

  return runs.map(r => ({
    periodIndex: r.periodIndex,
    objectivePercentage: r.objectivePercentage,
    runAt: r.runAt,
  }));
}

// ── 4. Activity feed ─────────────────────────────────────────────────────────

const NEXT_UP_LIMIT = 20;

/** Real next occurrence of a weekly UTC cron slot — used for the GEO
 *  analytics recheck (`0 10 * * 1`) and GSC monitor recheck (`0 11 * * 1`),
 *  see workers/scheduler.worker.ts for the source-of-truth patterns.
 *  Kept in sync manually since BullMQ doesn't expose a "next run" query
 *  without connecting to the queue; if either cron pattern changes,
 *  update the call site below to match. `weekdayUtc` uses JS's
 *  Date#getUTCDay() convention (Sunday = 0, Monday = 1, ...). */
function nextWeeklyUtcSlot(from: Date, weekdayUtc: number, hourUtc: number): Date {
  const next = new Date(from);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getUTCDay() === weekdayUtc && next.getTime() > from.getTime()) {
    return next; // already the right day, still before the target hour today
  }
  const daysUntil = (weekdayUtc + 7 - next.getUTCDay()) % 7 || 7;
  next.setUTCDate(next.getUTCDate() + daysUntil);
  return next;
}

async function getCompletedActivity(projectId: string) {
  const entries = await ActivityLog.find({ projectId })
    .sort({ createdAt: -1 })
    .limit(NEXT_UP_LIMIT)
    .lean();

  // Collapse same type + same UTC day into one row (e.g. 5 individual
  // CONTENT_GENERATED writes from one content-calendar week become a
  // single "Created 5 content pages" row) — see models/ActivityLog.ts.
  const grouped = new Map<string, { type: string; title: string; count: number; lastUpdated: Date }>();

  for (const entry of entries) {
    const dayKey = entry.createdAt.toISOString().slice(0, 10);
    const groupKey = `${entry.type}:${dayKey}`;
    const existing = grouped.get(groupKey);

    if (existing) {
      existing.count += 1;
      if (entry.createdAt > existing.lastUpdated) existing.lastUpdated = entry.createdAt;
    } else {
      grouped.set(groupKey, {
        type: entry.type,
        title: entry.title,
        count: 1,
        lastUpdated: entry.createdAt,
      });
    }
  }

  return [...grouped.values()]
    .sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime())
    .map(g => ({
      type: g.type,
      // If this type fired more than once in the day, prefer a count-based
      // title over whichever single entry's title happened to be grouped in.
      title: g.count > 1 ? `${g.title} (×${g.count})` : g.title,
      lastUpdated: g.lastUpdated,
    }));
}

async function getQueuedActivity(projectId: string) {
  const queued: Array<{ title: string; dueAt: Date | null; note: string | null }> = [];

  // 1. Next content-calendar batch not yet generated. Only the NEAREST
  //    upcoming week's batch — this mirrors the actual trigger cadence in
  //    lib/keyword-generation-scheduler.ts (one delayed BullMQ trigger
  //    per week), not the full remaining backlog across all weeks.
  const nextUpcoming = await Keyword.find({ projectId, status: 'upcoming' })
    .select('weekNumber startDate')
    .sort({ weekNumber: 1 })
    .lean();

  if (nextUpcoming.length > 0) {
    const nextWeek = nextUpcoming[0]!.weekNumber;
    const sameWeek = nextUpcoming.filter(k => k.weekNumber === nextWeek);
    const dueAt = sameWeek.reduce<Date | null>((earliest, k) => {
      if (!k.startDate) return earliest;
      return !earliest || k.startDate < earliest ? k.startDate : earliest;
    }, null);

    queued.push({
      title: `Create ${sameWeek.length} more content page${sameWeek.length === 1 ? '' : 's'}`,
      dueAt,
      note: dueAt ? null : 'Not yet scheduled',
    });
  }

  // 2. Pending blog re-optimization proposals awaiting review. Genuinely
  //    a human-review step in this codebase (see optimization.service.ts
  //    header comment), not something the system will do on its own —
  //    so "Review", not "Reoptimize", and no due date, since it's not on
  //    a clock.
  const pendingOptimizations = await BlogOptimization.countDocuments({
    projectId,
    status: 'pending_review',
  });
  if (pendingOptimizations > 0) {
    queued.push({
      title: `Review ${pendingOptimizations} content re-optimization${pendingOptimizations === 1 ? '' : 's'}`,
      dueAt: null,
      note: 'Awaiting your review',
    });
  }

  // 3. Next recurring GEO analytics check — real cron cadence, gated by
  //    the exact same condition runGeoAnalyticsScheduler itself checks
  //    in workers/jobs/global-scheduler.job.ts, so this queued item only
  //    appears when that scheduler would actually pick the project up.
  const hasEvaluableContent = await Keyword.exists({
    projectId,
    status: { $in: ['published', 'ready'] },
  });
  if (hasEvaluableContent) {
    queued.push({
      title: 'Re-run GEO analytics check',
      dueAt: nextWeeklyUtcSlot(new Date(), 1, 10), // Monday 10:00 UTC
      note: null,
    });
  }

  // 4. Next recurring GSC performance check — same idea, mirrors
  //    runGscMonitorScheduler's own gate (GSC connected + a published
  //    blog) exactly.
  const [hasGoogleToken, hasPublishedBlog] = await Promise.all([
    GoogleToken.exists({ projectId }),
    Blog.exists({ projectId, status: 'published' }),
  ]);
  if (hasGoogleToken && hasPublishedBlog) {
    queued.push({
      title: 'Re-run Google Search Console performance check',
      dueAt: nextWeeklyUtcSlot(new Date(), 1, 11), // Monday 11:00 UTC
      note: null,
    });
  }

  return queued;
}

// ── Public entry point ──────────────────────────────────────────────────────

export const dashboardService = {
  async getHome(userId: string, projectId: string) {
    await assertProjectAccess(userId, projectId);

    const [searchOpportunity, growthTimeline, geoVisibilityHistory, completed, queued] = await Promise.all([
      getSearchOpportunity(projectId),
      getGrowthTimeline(projectId),
      getGeoVisibilityHistory(projectId),
      getCompletedActivity(projectId),
      getQueuedActivity(projectId),
    ]);

    return {
      searchOpportunity,
      growthTimeline,
      geoVisibilityHistory,
      activity: { queued, completed },
    };
  },
};
