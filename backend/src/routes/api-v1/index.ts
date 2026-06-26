import { Router } from 'express';
import authRoutes    from './auth.route';
import projectRoutes from './project.route';

const router = Router();

router.use('/auth',     authRoutes);
router.use('/projects', projectRoutes);

export default router;
