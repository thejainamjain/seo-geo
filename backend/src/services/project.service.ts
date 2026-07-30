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
//
// The onboarding wizard has 6 UI steps (matching the product's real flow),
// but BusinessContext still stores data by MEANING (company/product/
// customers/competition/socialProof), not by step number — that's also
// what workers/jobs/business-profile.job.ts's AI pre-fill writes into
// directly, independently of this wizard, using its own hardcoded
// `aiDraftedSteps: [1,2,3,4,5]` referring to those same 5 fields. To avoid
// touching that job, this file keeps the old field-based numbering
// internally (1=company, 2=product, 3=customers, 4=competition,
// 5=socialProof) and maps the wizard's 6 UI steps onto it:
//   UI step 1 "Business"              → company + product together
//   UI step 2 "Audience & Competitors" → customers + competition together
//   UI step 3 "Setup Analytics"        → no BusinessContext field (GSC OAuth
//                                         flow handles itself — see gscApi)
//   UI step 4 "Site Integration"       → no BusinessContext field (CMS setup
//                                         handled by cmsApi)
//   UI step 5 "Blog Post Settings"     → Project.blogWriterInstruction +
//                                         Project.heroImageMode (knowledge
//                                         files are their own collection,
//                                         handled by knowledgeApi)
//   UI step 6 "Auto Publish"           → marks isOnboardingComplete
// socialProof isn't part of the wizard at all anymore (not in the current
// product flow) — the AI still drafts it, it's just not reviewed here.

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
   * Save a single onboarding wizard step. See the module-level comment
   * above for how the 6 UI steps map onto BusinessContext/Project fields.
   * On step 6: sets project.isOnboardingComplete = true.
   */
  async saveOnboardingStep(
    userId:    string,
    projectId: string,
    step:      1 | 2 | 3 | 4 | 5 | 6,
    data:      Record<string, unknown>,
  ) {
    logger.debug('projectService.saveOnboardingStep', { userId, projectId, step });

    const project = await projectService.getProject(userId, projectId);

    switch (step) {
      case 1: {
        // "Business" — company + product together
        const company = (data.company as Record<string, unknown>) ?? {};
        const product = (data.product as Record<string, unknown>) ?? {};
        await BusinessContext.findOneAndUpdate(
          { projectId: project._id },
          { company, product, $addToSet: { completedSteps: step } },
          { upsert: true, new: true },
        );
        break;
      }

      case 2: {
        // "Audience & Competitors" — customers + competition together.
        // mainCompetitors arrives as plain domain strings from the wizard;
        // wrap each as a structured CompetitorEntry so it carries
        // provenance (source: 'user') and starts unverified — the same
        // shape business-profile.job.ts's AI draft and
        // competitor-discovery.job.ts's SERP results use, so a human's
        // manually-entered list MERGES with later SERP findings instead of
        // being silently replaced. See docs/05-phase4-competitor-discovery-audit.md.
        const customers = (data.customers as Record<string, unknown>) ?? {};
        let competition = (data.competition as Record<string, unknown>) ?? {};
        if (Array.isArray(competition.mainCompetitors)) {
          const now = new Date();
          competition = {
            ...competition,
            mainCompetitors: (competition.mainCompetitors as unknown[])
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
          { customers, competition, $addToSet: { completedSteps: step } },
          { upsert: true, new: true },
        );
        break;
      }

      case 3:
      case 4: {
        // "Setup Analytics" (GSC connect) / "Site Integration" (CMS) —
        // both are handled by their own dedicated endpoints (gscApi's
        // OAuth flow, cmsApi's connect). This call only records wizard
        // progress so the step shows as complete on reload.
        await BusinessContext.findOneAndUpdate(
          { projectId: project._id },
          { $addToSet: { completedSteps: step } },
          { upsert: true, new: true },
        );
        break;
      }

      case 5: {
        // "Blog Post Settings" — writer notes + hero image mode live on
        // Project (not BusinessContext); knowledge files are their own
        // collection, already handled by knowledgeApi.
        const projectUpdate: Record<string, unknown> = {};
        if (typeof data.blogWriterInstruction === 'string') {
          projectUpdate.blogWriterInstruction = data.blogWriterInstruction;
        }
        if (typeof data.heroImageMode === 'string') {
          projectUpdate.heroImageMode = data.heroImageMode;
        }
        if (Object.keys(projectUpdate).length > 0) {
          await Project.findByIdAndUpdate(project._id, projectUpdate);
        }
        await BusinessContext.findOneAndUpdate(
          { projectId: project._id },
          { $addToSet: { completedSteps: step } },
          { upsert: true, new: true },
        );
        break;
      }

      case 6: {
        // "Auto Publish" — last step. autoPublish itself is saved via
        // cmsApi.update (PATCH /cms) right before this call; this just
        // records progress and completes onboarding.
        await BusinessContext.findOneAndUpdate(
          { projectId: project._id },
          { $addToSet: { completedSteps: step } },
          { upsert: true, new: true },
        );
        await Project.findByIdAndUpdate(project._id, { isOnboardingComplete: true });
        break;
      }

      default:
        throw new ValidationError(`Invalid step: ${step as number}`);
    }

    logger.info('Onboarding step saved', { projectId, step });

    const updatedProject  = await Project.findById(project._id).lean();
    const businessContext = await BusinessContext.findOne({ projectId: project._id }).lean();

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
