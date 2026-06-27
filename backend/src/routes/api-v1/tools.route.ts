import { Router } from 'express';
import { z } from 'zod';
import { toolsHandler } from '../../handlers/tools.handler';
import { validate } from '../../middleware/validate';

const router = Router();

const FreeAuditSchema = z.object({
  domain:       z.string().min(1),
  email:        z.string().email(),
  firstName:    z.string().min(1),
  businessType: z.enum(['over_150k', 'under_150k', 'agency']),
});

// No requireAuth — this is a public route
router.post('/audit', validate(FreeAuditSchema), toolsHandler.runAudit);

export default router;
