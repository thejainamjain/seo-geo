import { Router } from 'express';
import { optimizationHandler } from '@/handlers/optimization.handler';
import { requireAuth } from '@/middleware/auth';

const router = Router({ mergeParams: true });

router.use(requireAuth);

// GET  /projects/:projectId/optimizations              — review queue (defaults to pending_review)
// GET  /projects/:projectId/optimizations/:optimizationId
// PATCH /projects/:projectId/optimizations/:optimizationId/approve
// PATCH /projects/:projectId/optimizations/:optimizationId/reject
//
// ACCESS: any project member (see optimization.service.ts doc comment for
// why this is a deliberate, flagged-for-later choice rather than an
// oversight).
router.get('/',                          optimizationHandler.list);
router.get('/:optimizationId',           optimizationHandler.getOne);
router.patch('/:optimizationId/approve', optimizationHandler.approve);
router.patch('/:optimizationId/reject',  optimizationHandler.reject);

export default router;
