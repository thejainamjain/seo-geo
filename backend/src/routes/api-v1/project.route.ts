import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { projectHandler } from '@/handlers/project.handler';
import { requireAuth } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { resumePipeline, getPipelineStatus } from '@/lib/pipeline-resume';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }, // mirrors blog.route.ts / projectService.uploadPoolImage
});

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
    z.literal(6),
  ]),
  data: z.record(z.unknown()),
});

const StartPipelineSchema = z.object({
  keywordPrimaryCountryCode: z.string().optional(),
});

// Partial project settings update — Image configuration's brand color +
// blog theme toggle + hero image fallback mode. All optional so the
// frontend can PATCH just the field that changed.
const UpdateProjectSettingsSchema = z.object({
  brandColor:            z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'brandColor must be a 6-digit hex color, e.g. #2563EB').optional(),
  useDefaultBlogTheme:   z.boolean().optional(),
  heroImageFallbackMode: z.enum(['unsplash', 'text_card']).optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field is required' });

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
// Body: { step: 1-6, data: { ...step fields } }
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

// Project-level hero image pool — the PRIMARY source for blog hero images
// (Unsplash is the fallback, see lib/hero-image-pool.ts). No upload count
// limit by design.
router.get('/:projectId/settings/hero-images', projectHandler.listPoolImages);
router.post('/:projectId/settings/hero-images', upload.single('image'), projectHandler.uploadPoolImage);
router.delete('/:projectId/settings/hero-images/:imageId', projectHandler.deletePoolImage);

// Project settings — brand color, blog theme toggle, hero image fallback mode
router.patch('/:projectId/settings', validate(UpdateProjectSettingsSchema), projectHandler.updateSettings);
router.post('/:projectId/settings/brand-color/detect', projectHandler.detectBrandColor);

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
