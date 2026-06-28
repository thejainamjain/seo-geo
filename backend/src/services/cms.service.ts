import { CmsConfig, Project, OrganizationMember } from '../models';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors';
import { encrypt } from '../lib/crypto';
import { logger } from '../open-tele';

const VALID_CMS_TYPES = [
  'wordpress', 'webflow', 'framer', 'wix', 'shopify',
  'sanity', 'squarespace', 'gohighlevel', 'custom_api', 'other',
];

const REQUIRED_CREDENTIAL_FIELDS: Record<string, string[]> = {
  wordpress:    ['siteUrl', 'username', 'applicationPassword'],
  webflow:      ['apiToken', 'collectionId'],
  framer:       ['projectId'],
  wix: ['apiKey', 'siteId'],
  shopify:      ['storeName', 'clientId', 'clientSecret'],
  sanity:       ['projectId', 'datasetName', 'apiToken'],
  squarespace:  ['dashboardUrl'],
  gohighlevel:  ['privateIntegrationToken', 'blogDashboardUrl'],
  custom_api:   ['endpointUrl', 'authHeader'],
  other:        [],
};

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

function validateCredentials(cmsType: string, credentials: Record<string, unknown>) {
  const required = REQUIRED_CREDENTIAL_FIELDS[cmsType] ?? [];
  const missing  = required.filter((field) => !credentials[field]);
  if (missing.length > 0) {
    throw new ValidationError(`Missing credentials for ${cmsType}: ${missing.join(', ')}`);
  }
}

export const cmsService = {
  async getCmsConfig(userId: string, projectId: string) {
    logger.debug('cmsService.getCmsConfig', { userId, projectId });

    await assertProjectAccess(userId, projectId);

    const config = await CmsConfig.findOne({ projectId }).lean();
    if (!config) throw new NotFoundError('CmsConfig');

    logger.info('CmsConfig fetched', { projectId });
    return config;
  },

  async connectCms(userId: string, projectId: string, input: {
    cmsType:     string;
    credentials: Record<string, unknown>;
    blogPostPath?: string;
  }) {
    logger.debug('cmsService.connectCms', { userId, projectId, cmsType: input.cmsType });

    const project = await assertProjectAccess(userId, projectId);

    if (!VALID_CMS_TYPES.includes(input.cmsType)) {
      throw new ValidationError(`Invalid cmsType: ${input.cmsType}`);
    }

    validateCredentials(input.cmsType, input.credentials);

    const encryptedCredentials = encrypt(JSON.stringify(input.credentials));

    const config = await CmsConfig.findOneAndUpdate(
      { projectId },
      {
        cmsType: input.cmsType,
        encryptedCredentials,
        ...(input.blogPostPath ? { blogPostPath: input.blogPostPath } : {}),
      },
      { upsert: true, new: true },
    );

    await Project.findByIdAndUpdate(project._id, { isCmsConnected: true });

    logger.info('CMS connected', { projectId, cmsType: input.cmsType });
    return config;
  },

  async updateCmsConfig(userId: string, projectId: string, input: {
    autoPublish?:        boolean;
    allowedPublishDays?: number[];
    blogPostPath?:       string;
  }) {
    logger.debug('cmsService.updateCmsConfig', { userId, projectId });

    await assertProjectAccess(userId, projectId);

    if (input.allowedPublishDays) {
      if (input.allowedPublishDays.includes(0)) {
        throw new ValidationError('Sunday (0) publishing is not allowed');
      }
      const valid = input.allowedPublishDays.every((d) => d >= 1 && d <= 6);
      if (!valid) {
        throw new ValidationError('allowedPublishDays must be values 1–6 (Mon–Sat)');
      }
    }

    const config = await CmsConfig.findOneAndUpdate(
      { projectId },
      { ...input },
      { new: true },
    );
    if (!config) throw new NotFoundError('CmsConfig');

    logger.info('CmsConfig updated', { projectId });
    return config;
  },

  async disconnectCms(userId: string, projectId: string) {
    logger.debug('cmsService.disconnectCms', { userId, projectId });

    const project = await assertProjectAccess(userId, projectId);

    await CmsConfig.findOneAndUpdate(
      { projectId },
      {
        $unset: { cmsType: '', encryptedCredentials: '' },
        autoPublish: false,
      },
    );

    await Project.findByIdAndUpdate(project._id, { isCmsConnected: false });

    logger.info('CMS disconnected', { projectId });
  },
};
