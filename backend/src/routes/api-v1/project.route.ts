import { Router } from 'express';
import { z } from 'zod';
import { projectHandler } from '@/handlers/project.handler';
import { requireAuth } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { resumePipeline, getPipelineStatus } from '@/lib/pipeline-resume';

const router = Router();

// ── Validation schemas ─────────────────────────────────────────────────────

const CreateProjectSchema = z.object({
  domain:                    z.string().min(1),
  keywordPrimaryCountryCode: z.string().optional(),
});

// Legacy business update (kept for backward compat)
const UpdateBusinessSchema = z.object({
  domainDescription:    z.string().min(1),
  oldDomainDescription: z.string(),
  isDraft:              z.boolean(),
});

// Per-step onboarding save
const SaveOnboardingStepSchema = z.object({
  step: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
  ]),
  data: z.record(z.unknown()),
});

const StartPipelineSchema = z.object({
  keywordPrimaryCountryCode: z.string().optional(),
});

// ── Routes ─────────────────────────────────────────────────────────────────

router.use(requireAuth);

// Project CRUD
router.post('/',    validate(CreateProjectSchema), projectHandler.create);
router.get('/',     projectHandler.list);
router.get('/:projectId', projectHandler.getOne);

// Business context (legacy)
router.post('/:projectId/business', validate(UpdateBusinessSchema), projectHandler.updateBusiness);
router.get('/:projectId/business',  projectHandler.getBusinessContext);

// Onboarding wizard — save one step at a time
// POST /api/v1/projects/:projectId/onboarding/step
// Body: { step: 1-5, data: { ...step fields } }
router.post(
  '/:projectId/onboarding/step',
  validate(SaveOnboardingStepSchema),
  projectHandler.saveOnboardingStep,
);

// Start pipeline after onboarding complete
// POST /api/v1/projects/:projectId/pipeline/start
router.post(
  '/:projectId/pipeline/start',
  validate(StartPipelineSchema),
  projectHandler.startPipeline,
);

// Pipeline status + resume (existing)
router.get('/:id/pipeline/status', async (req, res, next) => {
try {
const status = await getPipelineStatus(req.params.id);
res.json(status);
} catch (err) {
next(err);
}
});

// Resume pipeline from a specific step
router.post('/:id/pipeline/resume', async (req, res, next) => {
try {
const result = await resumePipeline(req.params.id, {
fromStep: req.body.fromStep,
});
res.json(result);
} catch (err) {
next(err);
}
});

export default router;
