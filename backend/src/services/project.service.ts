import { Queue } from 'bullmq';
import { Project, OrganizationMember, BusinessContext } from '../models';
import { QUEUE_NAMES, JOB_RETRY_CONFIG, JOB_PRIORITY, PIPELINE_STEP } from '../constants/seo-pipeline.constants';
import { getConnectionOptions } from '../loaders/redis';
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from '../utils/errors';
import { logger } from '../open-tele';

const seoPipelineQueue = new Queue(QUEUE_NAMES.SEO_PIPELINE, {
  connection: getConnectionOptions(),
});

// ── Step data shapes ───────────────────────────────────────────────────────

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

    const project = await Project.create({
      domain,
      organizationId: membership.organizationId,
      ownerId:        userId,
    });

    // Start pipeline immediately — SITE_CRAWL + BUSINESS_PROFILE will run.
    // Pipeline pauses automatically after BUSINESS_PROFILE (see seo-pipeline.worker.ts).
    // User fills onboarding wizard, then calls resumeAfterOnboarding to continue.
    const job = await seoPipelineQueue.add(
      PIPELINE_STEP.SITE_CRAWL,
      {
        projectId:                 project._id.toString(),
        step:                      PIPELINE_STEP.SITE_CRAWL,
        domain,
        keywordPrimaryCountryCode: input.keywordPrimaryCountryCode ?? 'usa',
      },
      {
        attempts: JOB_RETRY_CONFIG.SITE_CRAWL.attempts,
        backoff:  { type: 'exponential', delay: JOB_RETRY_CONFIG.SITE_CRAWL.backoffDelay },
        jobId:    `site-crawl-${project._id.toString()}`,
        priority: JOB_PRIORITY.SITE_CRAWL,
      },
    );

    await Project.findByIdAndUpdate(project._id, {
      'pipeline.jobId':                      job.id,
      'pipeline.status':                     'RUNNING',
      'pipeline.startedAt':                  new Date(),
      'pipeline.currentStep':                PIPELINE_STEP.SITE_CRAWL,
      'pipeline.steps.SITE_CRAWL.status':    'RUNNING',
      'pipeline.steps.SITE_CRAWL.startedAt': new Date(),
    });

    logger.info('Project created + SITE_CRAWL enqueued', {
      projectId: project._id.toString(),
      domain,
      jobId:     String(job.id),
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
   * On step 5: sets project.isOnboardingComplete = true.
   */
  async saveOnboardingStep(
    userId:    string,
    projectId: string,
    step:      1 | 2 | 3 | 4 | 5,
    data:      Record<string, unknown>,
  ) {
    logger.debug('projectService.saveOnboardingStep', { userId, projectId, step });

    const project = await projectService.getProject(userId, projectId);

    const field = STEP_FIELD_MAP[step];
    if (!field) throw new ValidationError(`Invalid step: ${step}`);

    // Step 4 (Competition): the wizard submits mainCompetitors as plain
    // domain strings. Wrap each as a structured CompetitorEntry so it
    // carries provenance (source: 'user') and starts unverified — the
    // same shape business-profile.job.ts's AI draft and
    // competitor-discovery.job.ts's SERP results use. This lets a human's
    // manually-entered list MERGE with later SERP findings instead of
    // being silently replaced — see docs/05-phase4-competitor-discovery-audit.md.
    let stepData = data;
    if (step === 4 && Array.isArray(data.mainCompetitors)) {
      const now = new Date();
      stepData = {
        ...data,
        mainCompetitors: (data.mainCompetitors as unknown[])
          .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
          .map(raw => ({
            domain:   raw.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').trim().toLowerCase(),
            source:   'user' as const,
            verified: false,
            addedAt:  now,
          })),
      };
    }

    await BusinessContext.findOneAndUpdate(
      { projectId: project._id },
      {
        [field]:   stepData,
        $addToSet: { completedSteps: step },
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

    const updatedProject     = await Project.findById(project._id).lean();
    const businessContext    = await BusinessContext.findOne({ projectId: project._id }).lean();

    return { project: updatedProject, businessContext };
  },

  /**
   * Resume pipeline from TECHNICAL_AUDIT after user completes onboarding wizard.
   * Guards: onboarding must be complete, BUSINESS_PROFILE must be done.
   */
  async resumeAfterOnboarding(userId: string, projectId: string) {
    logger.debug('projectService.resumeAfterOnboarding', { userId, projectId });

    const project = await projectService.getProject(userId, projectId);

    if (!project.isOnboardingComplete) {
      throw new ValidationError('Complete the onboarding wizard before continuing.');
    }

    const bpStatus = project.pipeline.steps[PIPELINE_STEP.BUSINESS_PROFILE]?.status;
    if (bpStatus !== 'COMPLETED') {
      throw new ValidationError('Business profile is still being generated. Please wait.');
    }

    const taStatus = project.pipeline.steps[PIPELINE_STEP.TECHNICAL_AUDIT]?.status;
    if (taStatus === 'RUNNING' || taStatus === 'COMPLETED') {
      throw new ValidationError('Pipeline is already running or completed past this point.');
    }

    const retryConfig = JOB_RETRY_CONFIG[PIPELINE_STEP.TECHNICAL_AUDIT];
    const priority    = JOB_PRIORITY[PIPELINE_STEP.TECHNICAL_AUDIT as keyof typeof JOB_PRIORITY] ?? 3;

    const job = await seoPipelineQueue.add(
      PIPELINE_STEP.TECHNICAL_AUDIT,
      { projectId: project._id.toString(), step: PIPELINE_STEP.TECHNICAL_AUDIT },
      {
        priority,
        attempts: retryConfig.attempts,
        backoff:  { type: 'exponential', delay: retryConfig.backoffDelay },
      },
    );

    await Project.findByIdAndUpdate(project._id, {
      'pipeline.status':                            'RUNNING',
      'pipeline.currentStep':                       PIPELINE_STEP.TECHNICAL_AUDIT,
      'pipeline.steps.TECHNICAL_AUDIT.status':      'RUNNING',
      'pipeline.steps.TECHNICAL_AUDIT.startedAt':   new Date(),
    });

    logger.info('Pipeline resumed from TECHNICAL_AUDIT after onboarding', {
      projectId: project._id.toString(),
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

  // Legacy — kept for backward compat
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

    return project;
  },

  // Legacy — kept so route doesn't break
  async startPipeline(userId: string, projectId: string) {
    return projectService.resumeAfterOnboarding(userId, projectId);
  },
};
