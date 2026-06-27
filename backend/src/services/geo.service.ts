import { GeoAnalyticsRun, Project, OrganizationMember } from '../models';
import { NotFoundError, ForbiddenError } from '../utils/errors';
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

export const geoService = {
  async listRuns(userId: string, projectId: string) {
    logger.debug('geoService.listRuns', { userId, projectId });

    await assertProjectAccess(userId, projectId);

    const runs = await GeoAnalyticsRun.find({ projectId })
      .sort({ createdAt: -1 })
      .lean();

    logger.info('GEO runs listed', { projectId, count: runs.length });
    return runs;
  },

  async getLatestRun(userId: string, projectId: string) {
    logger.debug('geoService.getLatestRun', { userId, projectId });

    await assertProjectAccess(userId, projectId);

    const run = await GeoAnalyticsRun.findOne({ projectId })
      .sort({ createdAt: -1 })
      .lean();

    logger.info('Latest GEO run fetched', { projectId, found: !!run });
    return run;
  },
};
