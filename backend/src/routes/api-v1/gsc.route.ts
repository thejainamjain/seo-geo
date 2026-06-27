import { Router } from 'express';
import { z } from 'zod';
import { gscHandler } from '../../handlers/gsc.handler';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';

const router = Router({ mergeParams: true });

router.use(requireAuth);

const ConnectGscSchema = z.object({
  accessToken:  z.string().min(1),
  refreshToken: z.string().min(1),
  expiryDate:   z.coerce.date(),
});

router.get('/',          gscHandler.getStatus);
router.post('/connect',  validate(ConnectGscSchema), gscHandler.connect);
router.delete('/disconnect', gscHandler.disconnect);

export default router;
