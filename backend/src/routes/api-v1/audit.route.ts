import { Router } from 'express';
import { auditHandler } from '@/handlers/audit.handler';
import { requireAuth } from '@/middleware/auth';

const router = Router({ mergeParams: true });

router.use(requireAuth);

router.get('/',                               auditHandler.getLatest);
router.get('/code-changes',                   auditHandler.listCodeChanges);
router.get('/code-changes/type-counts',       auditHandler.getCodeChangeTypeCounts);
router.post('/code-changes/:changeId/apply',  auditHandler.applyCodeChange);
router.post('/code-changes/:changeId/disable',auditHandler.disableCodeChange);
router.get('/faqs',                           auditHandler.listFAQs);
router.get('/tldrs',                          auditHandler.listTLDRs);

export default router;
