import { Queue } from 'bullmq';
import { Project, OrganizationMember, BusinessContext } from '../models';
import { QUEUE_NAMES } from '../constants/seo-pipeline.constants';
import { getConnectionOptions } from '../loaders/redis';
import { NotFoundError, ForbiddenError, ConflictError } from '../utils/errors';
import { logger } from '../open-tele';

const seoPipelineQueue = new Queue(QUEUE_NAMES.SEO_PIPELINE, {
  connection: getConnectionOptions(),
});

export const projectService = {
  async createProject(userId: string, input: {
    domain:                     string;
    keywordPrimaryCountryCode?: string;
  }) {
    logger.debug('projectService.createProject', { userId, domain: input.domain });

    const membership = await OrganizationMember.findOne({ userId });
    if (!membership) throw new NotFoundError('Organization');

    const domain = input.domain
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
      .toLowerCase();

    const existing = await Project.findOne({
      domain,
      organizationId: membership.organizationId,
    });
    if (existing) throw new ConflictError('Domain');

    const project = await Project.create({
      domain,
      organizationId: membership.organizationId,
      ownerId:        userId,
    });

    const job = await seoPipelineQueue.add(
      'SITE_CRAWL',
      {
        projectId:                 project._id.toString(),
        domain,
        keywordPrimaryCountryCode: input.keywordPrimaryCountryCode ?? 'usa',
      },
      {
        attempts: 3,
        backoff:  { type: 'exponential', delay: 5000 },
        jobId:    `site-crawl-${project._id.toString()}`,
      },
    );

    await Project.findByIdAndUpdate(project._id, {
      'pipeline.jobId':                      job.id,
      'pipeline.status':                     'RUNNING',
      'pipeline.startedAt':                  new Date(),
      'pipeline.currentStep':                'SITE_CRAWL',
      'pipeline.steps.SITE_CRAWL.status':    'RUNNING',
      'pipeline.steps.SITE_CRAWL.startedAt': new Date(),
    });

    logger.info('Project created + SITE_CRAWL enqueued', {
      projectId: project._id.toString(),
      domain,
      jobId:     String(job.id),
    });

    return {
      project,
      pipelineJobId: job.id,
    };
  },

  async listProjects(userId: string) {
    logger.debug('projectService.listProjects', { userId });

    const membership = await OrganizationMember.findOne({ userId });
    if (!membership) throw new NotFoundError('Organization');

    return Project.find({ organizationId: membership.organizationId })
      .sort({ createdAt: -1 })
      .lean();
  },

  async getProject(userId: string, projectId: string) {
    logger.debug('projectService.getProject', { userId, projectId });

    const project = await Project.findById(projectId);
    if (!project) throw new NotFoundError('Project');

    const membership = await OrganizationMember.findOne({
      userId,
      organizationId: project.organizationId,
    });
    if (!membership) throw new ForbiddenError();

    return project;
  },

  async updateBusiness(userId: string, projectId: string, input: {
    domainDescription:    string;
    oldDomainDescription: string;
    isDraft:              boolean;
  }) {
    logger.debug('projectService.updateBusiness', { userId, projectId });

    const project = await projectService.getProject(userId, projectId);

    await BusinessContext.findOneAndUpdate(
      { projectId: project._id },
      {
        'company.description': input.domainDescription,
        $addToSet: { completedSteps: 1 },
      },
      { upsert: true, new: true },
    );

    logger.info('Business context updated', { projectId });

    return project;
  },

  async getBusinessContext(userId: string, projectId: string) {
    logger.debug('projectService.getBusinessContext', { userId, projectId });

    const project = await projectService.getProject(userId, projectId);

    const businessContext = await BusinessContext.findOne({ projectId: project._id }).lean();
    if (!businessContext) throw new NotFoundError('Business profile is being generated');

    logger.info('Business context fetched', { projectId });
    return businessContext;
  },

};
