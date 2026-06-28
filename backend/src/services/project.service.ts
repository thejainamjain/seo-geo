import { Queue } from 'bullmq';
import { Project, OrganizationMember, BusinessContext } from '../models';
import { QUEUE_NAMES } from '../constants/seo-pipeline.constants';
import { getConnectionOptions } from '../loaders/redis';
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from '../utils/errors';
import { logger } from '../open-tele';

const seoPipelineQueue = new Queue(QUEUE_NAMES.SEO_PIPELINE, {
  connection: getConnectionOptions(),
});

// ── Step data shapes (mirror BusinessContext model exactly) ────────────────

interface StepData {
  1: {
    name?: string;
    website?: string;
    description?: string;
    targetRegions?: string[];
    primaryLanguage?: string;
    howDidYouHearAboutUs?: string;
  };
  2: {
    whatItSells?: string;
    keyFeatures?: string;
    pricingTiers?: string;
    freeTrialAvailable?: boolean;
    lifetimeValuePerClient?: string;
  };
  3: {
    segments?: string[];
    painPoints?: string;
    keywordsTheyUse?: string;
    topUseCases?: string;
  };
  4: {
    mainCompetitors?: string[];
    differentiation?: string;
    uniqueStrengths?: string;
    tradeOffs?: string;
    proof?: string;
  };
  5: {
    caseStudies?: string;
    organicDiscussions?: string;
    socialMediaPresence?: string;
  };
}

// Map step number → BusinessContext field name
const STEP_FIELD_MAP: Record<number, string> = {
  1: 'company',
  2: 'product',
  3: 'customers',
  4: 'competition',
  5: 'socialProof',
};

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

    // Create project — pipeline does NOT start here.
    // Pipeline starts only after onboarding wizard is complete.
    const project = await Project.create({
      domain,
      organizationId: membership.organizationId,
      ownerId:        userId,
    });

    logger.info('Project created (pipeline not started yet)', {
      projectId: project._id.toString(),
      domain,
    });

    return { project };
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

  /**
   * Save a single onboarding wizard step.
   * Step 1 → company, Step 2 → product, etc.
   * Marks step complete in completedSteps[].
   * On step 5: also sets project.isOnboardingComplete = true.
   */
  async saveOnboardingStep(
    userId:    string,
    projectId: string,
    step:      1 | 2 | 3 | 4 | 5,
    data:      StepData[typeof step],
  ) {
    logger.debug('projectService.saveOnboardingStep', { userId, projectId, step });

    const project = await projectService.getProject(userId, projectId);

    const field = STEP_FIELD_MAP[step];
    if (!field) throw new ValidationError(`Invalid step: ${step}`);

    await BusinessContext.findOneAndUpdate(
      { projectId: project._id },
      {
        [field]:       data,
        $addToSet:     { completedSteps: step },
      },
      { upsert: true, new: true },
    );

    // On step 5 completion, mark onboarding done on the project
    if (step === 5) {
      await Project.findByIdAndUpdate(project._id, {
        isOnboardingComplete: true,
      });
    }

    logger.info('Onboarding step saved', { projectId, step });

    const updatedProject = await Project.findById(project._id).lean();
    const businessContext = await BusinessContext.findOne({ projectId: project._id }).lean();

    return { project: updatedProject, businessContext };
  },

  /**
   * Start the pipeline after onboarding is complete.
   * Called by the "Start pipeline" button at end of wizard.
   * Guards: onboarding must be complete, pipeline must not already be running.
   */
  async startPipeline(
    userId:    string,
    projectId: string,
    input: { keywordPrimaryCountryCode?: string } = {},
  ) {
    logger.debug('projectService.startPipeline', { userId, projectId });

    const project = await projectService.getProject(userId, projectId);

    if (!project.isOnboardingComplete) {
      throw new ValidationError('Complete the onboarding wizard before starting the pipeline.');
    }

    if (project.pipeline.status === 'RUNNING') {
      throw new ValidationError('Pipeline is already running.');
    }

    const job = await seoPipelineQueue.add(
      'SITE_CRAWL',
      {
        projectId:                 project._id.toString(),
        domain:                    project.domain,
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

    logger.info('Pipeline started', {
      projectId: project._id.toString(),
      domain:    project.domain,
      jobId:     String(job.id),
    });

    return {
      projectId: project._id.toString(),
      jobId:     job.id,
    };
  },

  async getBusinessContext(userId: string, projectId: string) {
    logger.debug('projectService.getBusinessContext', { userId, projectId });

    const project = await projectService.getProject(userId, projectId);

    const businessContext = await BusinessContext.findOne({ projectId: project._id }).lean();

    // Return null instead of throwing — wizard needs to handle "not started yet"
    return businessContext ?? null;
  },

  // Legacy — kept so existing code doesn't break. New wizard uses saveOnboardingStep.
  async updateBusiness(userId: string, projectId: string, input: {
    domainDescription:    string;
    oldDomainDescription: string;
    isDraft:              boolean;
  }) {
    logger.debug('projectService.updateBusiness (legacy)', { userId, projectId });

    const project = await projectService.getProject(userId, projectId);

    await BusinessContext.findOneAndUpdate(
      { projectId: project._id },
      {
        'company.description': input.domainDescription,
        $addToSet: { completedSteps: 1 },
      },
      { upsert: true, new: true },
    );

    logger.info('Business context updated (legacy)', { projectId });

    return project;
  },
};
