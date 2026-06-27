import { Router } from 'express';
import { z } from 'zod';
import { cmsHandler } from '@/handlers/cms.handler';
import { requireAuth } from '@/middleware/auth';
import { validate } from '@/middleware/validate';

const router = Router({ mergeParams: true });

router.use(requireAuth);

const ConnectCmsSchema = z.object({
  cmsType:      z.string().min(1),
  credentials:  z.record(z.unknown()),
  blogPostPath: z.string().optional(),
});

const UpdateCmsSchema = z.object({
  autoPublish:        z.boolean().optional(),
  allowedPublishDays: z.array(z.number().int().min(1).max(6)).optional(),
  blogPostPath:       z.string().optional(),
});

router.get('/',            cmsHandler.getConfig);
router.post('/connect',    validate(ConnectCmsSchema), cmsHandler.connect);
router.patch('/',          validate(UpdateCmsSchema),  cmsHandler.update);
router.delete('/disconnect', cmsHandler.disconnect);

export default router;
