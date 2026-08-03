/**
 * models/KeywordRanking.ts
 *
 * WHO: A daily snapshot of a tracked Keyword's real Google performance,
 * sourced from Google Search Console's Search Analytics API (query
 * dimension, property-wide — not scoped to a single page).
 *
 * WHY SEPARATE COLLECTION (not fields on Keyword): This is time-series
 * data — one row per keyword per day, growing unboundedly, the same
 * pattern as GeoAnalyticsRun. Putting "current position" fields directly
 * on Keyword would only ever show the latest value and lose the ability
 * to compute a trend (Analytics page's "Top Movers": keywords whose
 * position improved since the previous snapshot) or a performance chart
 * over time.
 *
 * WHY NOT PART OF BlogLearning: BlogLearning is deliberately a biased,
 * insight-triggered sample (only written when a specific problem fires —
 * see workers/jobs/gsc-monitor.job.ts's doc comment). KeywordRanking is
 * the opposite: one row per keyword, every sync run, unconditionally —
 * so it can be used for "did Y move on Google" without that bias, the
 * same reasoning dashboard.service.ts already applies to
 * GeoAnalyticsRun vs BlogLearning for the Home dashboard.
 *
 * WRITTEN BY: workers/jobs/keyword-ranking-sync.job.ts, scheduled
 * alongside gsc-monitor (see workers/jobs/global-scheduler.job.ts) —
 * runs once/day per project with GSC connected.
 *
 * MATCHING KEYWORDS TO GSC QUERIES: GSC returns raw query strings, not
 * our Keyword _ids. The sync job matches a GSC query row to a Keyword
 * doc by exact, case-insensitive string match on Keyword.keyword. A
 * query that doesn't match any tracked keyword is simply not recorded
 * here — this collection is scoped to "how are OUR tracked keywords
 * doing", not a general query-performance dump.
 *
 * "RANKED" DEFINITION: A keyword counts as ranked/tracked once it has at
 * least one KeywordRanking row with position <= 100 (GSC's Search
 * Analytics only returns rows where the URL appeared in results at all,
 * so any row at all already implies this — the cutoff exists mainly for
 * clarity/documentation, not as an active filter condition).
 */

import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IKeywordRanking extends Document {
  projectId: Types.ObjectId;
  keywordId: Types.ObjectId;

  /** Calendar date this snapshot represents (midnight UTC) — one row per keywordId per date, enforced by the unique index below */
  date: Date;

  /** Average Google position for this keyword over GSC's reporting window (lower is better) */
  position: number;

  clicks:      number;
  impressions: number;
  ctr:         number; // 0–1, as returned by GSC

  createdAt: Date;
}

const KeywordRankingSchema = new Schema<IKeywordRanking>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    keywordId: { type: Schema.Types.ObjectId, ref: 'Keyword',  required: true },
    date:      { type: Date, required: true },
    position:  { type: Number, required: true },
    clicks:      { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    ctr:         { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// One snapshot per keyword per day — sync job upserts on this key, so
// re-running the same day's sync (e.g. a BullMQ retry) overwrites that
// day's row instead of creating a duplicate.
KeywordRankingSchema.index({ keywordId: 1, date: 1 }, { unique: true });
// Latest-N-days lookups for a whole project (Analytics page load).
KeywordRankingSchema.index({ projectId: 1, date: -1 });

export const KeywordRanking = mongoose.model<IKeywordRanking>('KeywordRanking', KeywordRankingSchema);
