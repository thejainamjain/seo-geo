/**
 * models/ActivityLog.ts
 *
 * WHO: An append-only, human-readable record of a real thing that happened
 * to a project — a pipeline step finishing, a batch of blog posts being
 * generated, a GEO analytics run completing.
 *
 * WHY THIS EXISTS: The Home dashboard's "Completed" activity feed (see
 * frontend overview page) needs real history with real timestamps. Before
 * this model, nothing in the backend persisted that kind of narrative
 * event log — Project.pipeline.steps only stores the CURRENT status of
 * each step (overwritten on every run), and structured logger.info() calls
 * in workers/jobs/*.ts go to stdout/observability tooling, not the
 * database, so the frontend has no way to query them.
 *
 * WHAT THIS IS NOT: a generic audit/event-sourcing log for every DB write.
 * It's deliberately narrow — only the handful of milestone events a user
 * would actually want to see summarized on their dashboard. Don't reach
 * for this to log routine CRUD; use `logger` for that, same as everywhere
 * else in this codebase.
 *
 * WRITERS (see activityLog.service.ts's `logActivity`):
 *   - workers/seo-pipeline.worker.ts   → one entry per linear pipeline step
 *   - workers/jobs/geo-analytics.job.ts → one entry per completed GEO run
 *   - workers/jobs/content-generation.job.ts → one entry per blog created
 *
 * READERS: services/dashboard.service.ts groups same-day CONTENT_GENERATED
 * entries into a single "Created N content pages" row for display, rather
 * than showing one row per blog — see that file for why.
 */

import mongoose, { Document, Schema, Types } from 'mongoose';

export const ACTIVITY_TYPE = {
  SITE_CRAWL:           'SITE_CRAWL',
  BUSINESS_PROFILE:     'BUSINESS_PROFILE',
  TECHNICAL_AUDIT:      'TECHNICAL_AUDIT',
  COMPETITOR_DISCOVERY: 'COMPETITOR_DISCOVERY',
  KEYWORD_RESEARCH:     'KEYWORD_RESEARCH',
  GEO_ANALYTICS:        'GEO_ANALYTICS',
  CONTENT_GENERATED:    'CONTENT_GENERATED',
} as const;

export type ActivityType = typeof ACTIVITY_TYPE[keyof typeof ACTIVITY_TYPE];

export interface IActivityLog extends Document {
  projectId: Types.ObjectId;

  type: ActivityType;

  /** Pre-rendered, human-readable summary — e.g. "Identified 45 keywords".
   *  Rendered once at write time (not derived at read time) so the feed
   *  reads correctly even if later code changes how counts are computed. */
  title: string;

  /** Optional structured detail for anything that needs it beyond the
   *  title — e.g. { count: 45 } or { blogId, keyword }. Not currently
   *  rendered by the frontend; kept for future drill-in / debugging. */
  meta?: Record<string, unknown>;

  createdAt: Date;
}

const ActivityLogSchema = new Schema<IActivityLog>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    type: {
      type: String,
      enum: Object.values(ACTIVITY_TYPE),
      required: true,
    },
    title: { type: String, required: true },
    meta:  { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Feed is always "latest N for this project" — covers the dashboard query directly.
ActivityLogSchema.index({ projectId: 1, createdAt: -1 });

export const ActivityLog = mongoose.model<IActivityLog>('ActivityLog', ActivityLogSchema);
