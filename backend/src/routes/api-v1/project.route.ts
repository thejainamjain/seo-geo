import { Router } from 'express';
import { z } from 'zod';
import { projectHandler } from '@/handlers/project.handler';
import { requireAuth } from '@/middleware/auth';
import { validate } from '@/middleware/validate';

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

export default router;
