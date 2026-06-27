import { Router } from 'express';
import authRoutes      from './auth.route';
import projectRoutes   from './project.route';
import auditRoutes     from './audit.route';
import blogRoutes      from './blog.route';
import keywordRoutes   from './keyword.route';
import cmsRoutes       from './cms.route';
import geoRoutes       from './geo.route';
import gscRoutes       from './gsc.route';
import knowledgeRoutes from './knowledge.route';
import toolsRoutes     from './tools.route';

const router = Router();

router.use('/auth',                          authRoutes);
router.use('/projects',                      projectRoutes);
router.use('/projects/:projectId/audit',     auditRoutes);
router.use('/projects/:projectId/blogs',     blogRoutes);
router.use('/projects/:projectId/keywords',  keywordRoutes);
router.use('/projects/:projectId/cms',       cmsRoutes);
router.use('/projects/:projectId/geo',       geoRoutes);
router.use('/projects/:projectId/gsc',       gscRoutes);
router.use('/projects/:projectId/knowledge', knowledgeRoutes);
router.use('/tools',                         toolsRoutes);

export default router;
