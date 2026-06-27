import { Router } from 'express';
import { z } from 'zod';
import { projectHandler } from '@/handlers/project.handler';
import { requireAuth } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { resumePipeline, getPipelineStatus } from '@/lib/pipeline-resume';

const router = Router();

const CreateProjectSchema = z.object({
  domain:                    z.string().min(1),
  keywordPrimaryCountryCode: z.string().optional(),
});

const UpdateBusinessSchema = z.object({
  domainDescription:    z.string().min(1),
  oldDomainDescription: z.string(),
  isDraft:              z.boolean(),
});

router.use(requireAuth);

router.post('/',validate(CreateProjectSchema),  projectHandler.create);
router.get('/',projectHandler.list);
router.get('/:projectId',projectHandler.getOne);
router.post('/:projectId/business',validate(UpdateBusinessSchema), projectHandler.updateBusiness);
router.get('/:projectId/business', projectHandler.getBusinessContext);

// GET /api/projects/:id/pipeline/status
router.get('/:id/pipeline/status', async (req, res) => {
  const status = await getPipelineStatus(req.params.id);
  res.json(status);
});

// POST /api/projects/:id/pipeline/resume
router.post('/:id/pipeline/resume', async (req, res) => {
  const result = await resumePipeline(req.params.id, {
    fromStep: req.body.fromStep, // optional — auto-detects if not provided
  });
  res.json(result);
});

export default router;
