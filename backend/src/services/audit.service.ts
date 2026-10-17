import { Types } from 'mongoose';
import { Audit, CodeChange, FAQ, TLDR } from '../models';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors';
import { OrganizationMember, Project } from '../models';
import { logger } from '../open-tele';

// Types whose newHtml is real, copy-in markup (mirrors the frontend's
// REAL_DIFF_TYPES). Applying one with nothing generated would mark a fix as
// done when there is nothing to apply.
const REAL_DIFF_TYPES = new Set([
  'title', 'description', 'open_graph', 'canonical',
  'alt_text', 'link_title', 'link_target', 'schema',
]);

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

/**
 * Finds the most recent COMPLETED audit for a project — the single
 * source of truth for "is it safe to show generated fix content yet."
 *
 * WHY THIS EXISTS: site-crawl.job.ts creates CodeChange/FAQ/TLDR stub
 * records immediately (with empty newHtml), and the NEXT pipeline step
 * (technical-audit.job.ts) fills in the real LLM-generated content
 * afterward — Audit.status only becomes 'completed' once that whole
 * process, including score calculation, is done (see models/Audit.ts's
 * own FLOW comment). Before this fix, listCodeChanges/listFAQs/listTLDRs
 * queried by projectId alone, with no check against the parent Audit's
 * status at all — so a frontend polling these endpoints while
 * technical-audit.job.ts was still running would get back partially-
 * generated records (empty newHtml, but status: 'pending' same as a
 * finished one), which is exactly the "blank-looking card" bug this
 * was built to fix.
 *
 * Also incidentally protects against a second, latent issue: Audit
 * documents aren't capped at one per project ("Audits grow unboundedly —
 * one per crawl run" per models/Audit.ts) — querying by projectId alone
 * with no audit scoping at all would mix in results from any earlier
 * audit run too, not just the latest one.
 */
async function findLatestCompletedAudit(projectId: string) {
  return Audit.findOne({ projectId, status: 'completed' })
    .sort({ performedAt: -1 })
    .select('_id')
    .lean();
}

interface LatestAuditResult {
  _id:          unknown;
  projectId:    unknown;
  status:       'pending' | 'running' | 'completed' | 'failed';
  crawledUrls?: string[];
  summary?: {
    totalPages?:         number;
    totalFixes?:         number;
    totalSchemas?:       number;
    totalInternalLinks?: number;
    totalFaqs?:          number;
    checkTotals?:        Record<string, number>;
    score?:              number;
    scoreReasoning?:     string;
  };
  performedAt:   Date;
  completedAt?:  Date;
  previousScore: number | null;
}

export const auditService = {
  async getLatestAudit(userId: string, projectId: string): Promise<LatestAuditResult> {
    logger.debug('auditService.getLatestAudit', { userId, projectId });

    await assertProjectAccess(userId, projectId);

    const [audit, previousAudit] = await Promise.all([
      Audit.findOne({ projectId, status: 'completed' }).sort({ performedAt: -1 }).lean(),
      // Second-most-recent completed audit — used for a genuine before/
      // after score comparison (Website Audit page's "A- → A+" card).
      // Not fabricated: if this project has only ever had one completed
      // audit, this is null, and the frontend shows a single grade
      // rather than inventing a "before" that never happened.
      Audit.find({ projectId, status: 'completed' }).sort({ performedAt: -1 }).skip(1).limit(1).lean(),
    ]);

    if (!audit) throw new NotFoundError('Audit');

    logger.info('Latest audit fetched', { projectId, auditId: String(audit._id) });
    return { ...audit, previousScore: previousAudit[0]?.summary?.score ?? null };
  },

  async listCodeChanges(userId: string, projectId: string, query: {
    type?:   string;
    status?: string;
    page:    number;
    limit:   number;
  }) {
    logger.debug('auditService.listCodeChanges', { userId, projectId, query });

    await assertProjectAccess(userId, projectId);

    const latestAudit = await findLatestCompletedAudit(projectId);
    if (!latestAudit) {
      // Nothing generated yet, or still mid-generation — see
      // findLatestCompletedAudit()'s doc comment. auditReady:false lets
      // the frontend show a "still working on this" state instead of a
      // blank/broken-looking list.
      logger.info('Code changes not ready — no completed audit yet', { projectId });
      return { codeChanges: [], total: 0, page: query.page, limit: query.limit, auditReady: false };
    }

    // Scoped to the latest completed audit specifically (CodeChange has
    // a real auditId field) — not just projectId, so results from an
    // earlier audit run never mix in with the current one.
    const filter: Record<string, unknown> = { projectId, auditId: latestAudit._id };
    if (query.type)   filter['type']   = query.type;
    if (query.status) filter['status'] = query.status;

    const skip  = (query.page - 1) * query.limit;
    const [codeChanges, total] = await Promise.all([
      CodeChange.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(query.limit).lean(),
      CodeChange.countDocuments(filter),
    ]);

    logger.info('Code changes listed', { projectId, total });
    return { codeChanges, total, page: query.page, limit: query.limit, auditReady: true };
  },

  /**
   * Per-type, per-status counts across ALL of the latest audit's
   * CodeChanges. Backs the Technical SEO & GEO page's sidebar filter
   * list (image reference: "Add link title 2124", "Active 2165",
   * "Disabled 2", etc.).
   *
   * NOTE ON WHY THIS EXISTS: the frontend's auditApi.codeChanges() already
   * loops through every page internally (100/request) to build a
   * complete list, so client-side counting from that wouldn't actually
   * be wrong. But every CodeChange document carries full oldHtml/newHtml
   * payloads — fetching potentially thousands of them (2165+ in the
   * reference screenshots) just to display a sidebar count is real,
   * unnecessary payload. This aggregation returns just the counts.
   */
  async getCodeChangeTypeCounts(userId: string, projectId: string) {
    logger.debug('auditService.getCodeChangeTypeCounts', { userId, projectId });

    await assertProjectAccess(userId, projectId);

    const latestAudit = await findLatestCompletedAudit(projectId);
    if (!latestAudit) {
      return { auditReady: false, total: 0, activeTotal: 0, disabledTotal: 0, byType: {} };
    }

    // aggregate() does NOT auto-cast string projectId to ObjectId like
    // find() does — explicit cast required or this $match silently
    // matches nothing.
    const rows = await CodeChange.aggregate([
      { $match: { projectId: new Types.ObjectId(projectId), auditId: latestAudit._id } },
      { $group: { _id: { type: '$type', status: '$status' }, count: { $sum: 1 } } },
    ]);

    const byType: Record<string, { pending: number; applied: number; disabled: number; failed: number }> = {};
    let total = 0, activeTotal = 0, disabledTotal = 0;

    for (const row of rows) {
      const { type, status } = row._id as { type: string; status: 'pending' | 'applied' | 'disabled' | 'failed' };
      byType[type] ??= { pending: 0, applied: 0, disabled: 0, failed: 0 };
      byType[type]![status] += row.count;
      total += row.count;
      if (status === 'pending')  activeTotal   += row.count;
      if (status === 'disabled') disabledTotal += row.count;
    }

    return { auditReady: true, total, activeTotal, disabledTotal, byType };
  },

  async applyCodeChange(userId: string, projectId: string, changeId: string) {
    logger.debug('auditService.applyCodeChange', { userId, projectId, changeId });

    await assertProjectAccess(userId, projectId);

    const change = await CodeChange.findOne({ _id: changeId, projectId });
    if (!change) throw new NotFoundError('CodeChange');

    if (REAL_DIFF_TYPES.has(change.type) && !(change.newHtml ?? '').trim()) {
      throw new ValidationError('This fix has no generated content yet, so it cannot be applied.');
    }

    change.status    = 'applied';
    change.appliedAt = new Date();
    await change.save();

    logger.info('CodeChange applied', { projectId, changeId });
    return change;
  },

  async disableCodeChange(userId: string, projectId: string, changeId: string) {
    logger.debug('auditService.disableCodeChange', { userId, projectId, changeId });

    await assertProjectAccess(userId, projectId);

    const change = await CodeChange.findOne({ _id: changeId, projectId });
    if (!change) throw new NotFoundError('CodeChange');

    change.status = 'disabled';
    await change.save();

    logger.info('CodeChange disabled', { projectId, changeId });
    return change;
  },

  async listFAQs(userId: string, projectId: string, query: {
    status?: string;
    page:    number;
    limit:   number;
  }) {
    logger.debug('auditService.listFAQs', { userId, projectId, query });

    await assertProjectAccess(userId, projectId);

    const latestAudit = await findLatestCompletedAudit(projectId);
    if (!latestAudit) {
      logger.info('FAQs not ready — no completed audit yet', { projectId });
      return { faqs: [], total: 0, page: query.page, limit: query.limit, auditReady: false };
    }

    // Scoped to the latest completed audit specifically (FAQ now has a
    // real auditId field, same as CodeChange) — not just projectId, so
    // results from an earlier audit run never mix in with the current one.
    const filter: Record<string, unknown> = { projectId, auditId: latestAudit._id };
    if (query.status) filter['status'] = query.status;

    const skip = (query.page - 1) * query.limit;
    const [faqs, total] = await Promise.all([
      FAQ.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
      FAQ.countDocuments(filter),
    ]);

    logger.info('FAQs listed', { projectId, total });
    return { faqs, total, page: query.page, limit: query.limit, auditReady: true };
  },

  async listTLDRs(userId: string, projectId: string, query: {
    status?: string;
    page:    number;
    limit:   number;
  }) {
    logger.debug('auditService.listTLDRs', { userId, projectId, query });

    await assertProjectAccess(userId, projectId);

    const latestAudit = await findLatestCompletedAudit(projectId);
    if (!latestAudit) {
      logger.info('TLDRs not ready — no completed audit yet', { projectId });
      return { tldrs: [], total: 0, page: query.page, limit: query.limit, auditReady: false };
    }

    // Scoped to the latest completed audit specifically (TLDR now has a
    // real auditId field, same as CodeChange/FAQ).
    const filter: Record<string, unknown> = { projectId, auditId: latestAudit._id };
    if (query.status) filter['status'] = query.status;

    const skip = (query.page - 1) * query.limit;
    const [tldrs, total] = await Promise.all([
      TLDR.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
      TLDR.countDocuments(filter),
    ]);

    logger.info('TLDRs listed', { projectId, total });
    return { tldrs, total, page: query.page, limit: query.limit, auditReady: true };
  },
};
