import { Router } from 'express';
import { geoHandler } from '@/handlers/geo.handler';
import { requireAuth } from '@/middleware/auth';

const router = Router({ mergeParams: true });

router.use(requireAuth);

router.get('/',        geoHandler.list);
router.get('/latest',  geoHandler.getLatest);

export default router;
