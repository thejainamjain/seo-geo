import { Audit, CodeChange, FAQ, TLDR } from '../models';
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

export const auditService = {
  async getLatestAudit(userId: string, projectId: string) {
    logger.debug('auditService.getLatestAudit', { userId, projectId });

    await assertProjectAccess(userId, projectId);

    const audit = await Audit.findOne({ projectId, status: 'completed' })
      .sort({ performedAt: -1 })
      .lean();

    if (!audit) throw new NotFoundError('Audit');

    logger.info('Latest audit fetched', { projectId, auditId: String(audit._id) });
    return audit;
  },

  async listCodeChanges(userId: string, projectId: string, query: {
    type?:   string;
    status?: string;
    page:    number;
    limit:   number;
  }) {
    logger.debug('auditService.listCodeChanges', { userId, projectId, query });

    await assertProjectAccess(userId, projectId);

    const filter: Record<string, unknown> = { projectId };
    if (query.type)   filter['type']   = query.type;
    if (query.status) filter['status'] = query.status;

    const skip  = (query.page - 1) * query.limit;
    const [codeChanges, total] = await Promise.all([
      CodeChange.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
      CodeChange.countDocuments(filter),
    ]);

    logger.info('Code changes listed', { projectId, total });
    return { codeChanges, total, page: query.page, limit: query.limit };
  },

  async applyCodeChange(userId: string, projectId: string, changeId: string) {
    logger.debug('auditService.applyCodeChange', { userId, projectId, changeId });

    await assertProjectAccess(userId, projectId);

    const change = await CodeChange.findOne({ _id: changeId, projectId });
    if (!change) throw new NotFoundError('CodeChange');

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

    const filter: Record<string, unknown> = { projectId };
    if (query.status) filter['status'] = query.status;

    const skip = (query.page - 1) * query.limit;
    const [faqs, total] = await Promise.all([
      FAQ.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
      FAQ.countDocuments(filter),
    ]);

    logger.info('FAQs listed', { projectId, total });
    return { faqs, total, page: query.page, limit: query.limit };
  },

  async listTLDRs(userId: string, projectId: string, query: {
    status?: string;
    page:    number;
    limit:   number;
  }) {
    logger.debug('auditService.listTLDRs', { userId, projectId, query });

    await assertProjectAccess(userId, projectId);

    const filter: Record<string, unknown> = { projectId };
    if (query.status) filter['status'] = query.status;

    const skip = (query.page - 1) * query.limit;
    const [tldrs, total] = await Promise.all([
      TLDR.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
      TLDR.countDocuments(filter),
    ]);

    logger.info('TLDRs listed', { projectId, total });
    return { tldrs, total, page: query.page, limit: query.limit };
  },
};
