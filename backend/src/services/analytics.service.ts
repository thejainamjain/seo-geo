/**
 * services/analytics.service.ts
 *
 * WHAT: Backs the combined Analytics page (frontend "Analytics" nav item).
 * That page is one scrollable composite of several sections; this service
 * only backs the sections that didn't already have a working endpoint:
 *
 *   - Summary cards (Pages / SEO Fixes / Schemas / Ranked)
 *   - Performance Overview (aggregated clicks & impressions over time)
 *   - Top Movers (keywords whose Google position improved recently)
 *   - Keyword Performance (per-keyword position/clicks/impressions table)
 *
 * DELIBERATELY NOT HERE — the page's other two sections already have
 * real, working endpoints and are called directly by the frontend rather
 * than proxied/duplicated through this service:
 *   - AI Search Metrics (GEO)  → GET /projects/:id/geo  (geo.route.ts)
 *   - Rewrite Queue            → GET /projects/:id/optimizations (optimization.route.ts)
 *
 * DATA HONESTY: every section here returns a genuine empty/zero state
 * (not fabricated placeholder numbers) when the underlying data doesn't
 * exist yet — e.g. no completed Audit yet, or KeywordRanking has fewer
 * than 2 distinct dates so there's nothing to diff for a trend. This
 * matches the reference product's own behavior (it shows "No performance
 * data available" / "No keywords data available" when GSC isn't
 * connected yet — see the screenshots this was built against).
 */

import { Types } from 'mongoose';
import { Audit, CodeChange, Keyword, KeywordRanking } from '../models';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { OrganizationMember, Project } from '../models';
import { logger } from '../open-tele';

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

/** Same "latest completed audit" scoping used by audit.service.ts — see
 * that file's doc comment for why this can't just be projectId alone. */
async function findLatestCompletedAudit(projectId: string) {
  return Audit.findOne({ projectId, status: 'completed' })
    .sort({ performedAt: -1 })
    .select('_id summary')
    .lean();
}

export const analyticsService = {
  /** Pages / SEO Fixes / Schemas / Ranked summary cards */
  async getSummaryCards(userId: string, projectId: string) {
    logger.debug('analyticsService.getSummaryCards', { userId, projectId });

    await assertProjectAccess(userId, projectId);

    const audit = await findLatestCompletedAudit(projectId);

    // No completed audit yet — honest zero state, not an error. Matches
    // how overview/page.tsx already treats "no audit yet" elsewhere.
    if (!audit) {
      return { pages: 0, seoFixes: 0, schemas: 0, ranked: 0 };
    }

    // "Schemas" card = count of type:'schema' CodeChange docs for this
    // audit — these are the fixes RankAI GENERATED to add schema markup
    // to pages that didn't have it (see site-crawl.job.ts's
    // detectCodeChanges: a 'schema' CodeChange is only created when
    // `!page.hasSchema`). This is NOT the same as
    // Audit.summary.totalSchemas, which counts the opposite thing —
    // pages that already HAD schema present at crawl time
    // (`allPages.filter(p => p.hasSchema).length`). The reference
    // product's label is "LLM schemas added," which only totalSchemas's
    // sibling metric here actually represents.
    const [schemas, ranked] = await Promise.all([
      CodeChange.countDocuments({ auditId: audit._id, type: 'schema' }),
      // "Ranked" — count of keywords with at least one KeywordRanking
      // snapshot at all (see models/KeywordRanking.ts — GSC only returns
      // a row when the query actually surfaced the domain in search
      // results).
      KeywordRanking.distinct('keywordId', { projectId }).then(ids => ids.length),
    ]);

    return {
      pages:    audit.summary?.totalPages ?? 0,
      seoFixes: audit.summary?.totalFixes ?? 0,
      schemas,
      ranked,
    };
  },

  /** Aggregated clicks & impressions per day, most recent `days` days */
  async getPerformanceOverview(userId: string, projectId: string, days = 14) {
    logger.debug('analyticsService.getPerformanceOverview', { userId, projectId, days });

    await assertProjectAccess(userId, projectId);

    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));

    // aggregate() does NOT auto-cast string projectId to ObjectId the way
    // find() does — explicit cast required, or this $match silently
    // matches nothing.
    const rows = await KeywordRanking.aggregate([
      { $match: { projectId: new Types.ObjectId(projectId), date: { $gte: since } } },
      {
        $group: {
          _id:         '$date',
          clicks:      { $sum: '$clicks' },
          impressions: { $sum: '$impressions' },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', clicks: 1, impressions: 1 } },
    ]);

    return {
      hasData: rows.length > 0,
      series:  rows as Array<{ date: Date; clicks: number; impressions: number }>,
    };
  },

  /**
   * Keywords whose position improved between the two most recent
   * snapshot dates available for this project. Needs at least 2 distinct
   * dates to exist at all — with only one day of data there's nothing to
   * diff against, so this returns hasData: false rather than a
   * misleading "no movement" result.
   */
  async getTopMovers(userId: string, projectId: string, limit = 5) {
    logger.debug('analyticsService.getTopMovers', { userId, projectId, limit });

    await assertProjectAccess(userId, projectId);

    const distinctDates = await KeywordRanking.distinct('date', { projectId }) as Date[];
    if (distinctDates.length < 2) {
      return { hasData: false, movers: [] };
    }

    const sorted = distinctDates.map(d => new Date(d)).sort((a, b) => b.getTime() - a.getTime());
    const [latestDate, previousDate] = sorted;

    const [latestRows, previousRows] = await Promise.all([
      KeywordRanking.find({ projectId, date: latestDate }).lean(),
      KeywordRanking.find({ projectId, date: previousDate }).lean(),
    ]);

    const previousByKeyword = new Map(previousRows.map(r => [String(r.keywordId), r.position]));

    const movers = latestRows
      .map(r => {
        const prevPosition = previousByKeyword.get(String(r.keywordId));
        if (prevPosition === undefined) return null;
        return {
          keywordId:    r.keywordId,
          position:     r.position,
          prevPosition,
          delta:        prevPosition - r.position, // positive = improved (moved up, lower position number)
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null && m.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, limit);

    if (movers.length === 0) return { hasData: true, movers: [] };

    const keywordDocs = await Keyword.find({
      _id: { $in: movers.map(m => m.keywordId) },
    }).select('keyword').lean();
    const keywordTextById = new Map(keywordDocs.map(k => [String(k._id), k.keyword]));

    return {
      hasData: true,
      movers: movers.map(m => ({
        keyword:      keywordTextById.get(String(m.keywordId)) ?? '(unknown keyword)',
        position:     m.position,
        prevPosition: m.prevPosition,
        delta:        m.delta,
      })),
    };
  },

  /** Latest ranking snapshot per tracked keyword, joined with keyword metadata */
  async getKeywordPerformance(userId: string, projectId: string, query: { page: number; limit: number }) {
    logger.debug('analyticsService.getKeywordPerformance', { userId, projectId, query });

    await assertProjectAccess(userId, projectId);

    const skip = (query.page - 1) * query.limit;

    // Latest snapshot per keyword — group by keywordId, take the max date's row.
    // (aggregate() needs the explicit ObjectId cast — see getPerformanceOverview above.)
    const latestPerKeyword = await KeywordRanking.aggregate([
      { $match: { projectId: new Types.ObjectId(projectId) } },
      { $sort: { keywordId: 1, date: -1 } },
      { $group: { _id: '$keywordId', row: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$row' } },
      { $sort: { position: 1 } }, // best-ranking keywords first
      { $skip: skip },
      { $limit: query.limit },
    ]);

    const total = (await KeywordRanking.distinct('keywordId', { projectId })).length;

    if (latestPerKeyword.length === 0) {
      return { hasData: total > 0, rows: [], total, page: query.page, limit: query.limit };
    }

    const keywordDocs = await Keyword.find({
      _id: { $in: latestPerKeyword.map(r => r.keywordId) },
    }).select('keyword searchVolume').lean();
    const keywordById = new Map(keywordDocs.map(k => [String(k._id), k]));

    return {
      hasData: true,
      rows: latestPerKeyword.map(r => ({
        keyword:      keywordById.get(String(r.keywordId))?.keyword ?? '(unknown keyword)',
        searchVolume: keywordById.get(String(r.keywordId))?.searchVolume ?? null,
        position:     r.position,
        clicks:       r.clicks,
        impressions:  r.impressions,
        ctr:          r.ctr,
        date:         r.date,
      })),
      total,
      page:  query.page,
      limit: query.limit,
    };
  },
};
