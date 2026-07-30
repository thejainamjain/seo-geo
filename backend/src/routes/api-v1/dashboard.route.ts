import { Router } from 'express';
import { dashboardHandler } from '@/handlers/dashboard.handler';
import { requireAuth } from '@/middleware/auth';

const router = Router({ mergeParams: true });

router.use(requireAuth);

router.get('/', dashboardHandler.getHome);

export default router;
