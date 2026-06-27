import { GoogleToken, Project, OrganizationMember } from '../models';
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

export const gscService = {
  async getStatus(userId: string, projectId: string) {
    logger.debug('gscService.getStatus', { userId, projectId });

    const project = await assertProjectAccess(userId, projectId);

    const token = await GoogleToken.findOne({ projectId }).lean();

    logger.info('GSC status fetched', { projectId });
    return {
      connected:  !!token,
      expiryDate: token?.expiryDate ?? null,
    };
  },

  async connect(userId: string, projectId: string, input: {
    accessToken:  string;
    refreshToken: string;
    expiryDate:   Date;
  }) {
    logger.debug('gscService.connect', { userId, projectId });

    const project = await assertProjectAccess(userId, projectId);

    await GoogleToken.findOneAndUpdate(
      { projectId },
      {
        accessToken:  input.accessToken,
        refreshToken: input.refreshToken,
        expiryDate:   input.expiryDate,
      },
      { upsert: true, new: true },
    );

    await Project.findByIdAndUpdate(project._id, { isGscConnected: true });

    logger.info('GSC connected', { projectId });
  },

  async disconnect(userId: string, projectId: string) {
    logger.debug('gscService.disconnect', { userId, projectId });

    const project = await assertProjectAccess(userId, projectId);

    await GoogleToken.findOneAndDelete({ projectId });

    await Project.findByIdAndUpdate(project._id, { isGscConnected: false });

    logger.info('GSC disconnected', { projectId });
  },
};
