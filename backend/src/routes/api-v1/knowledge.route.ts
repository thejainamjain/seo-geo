import { Router } from 'express';
import multer from 'multer';
import { knowledgeHandler } from '@/handlers/knowledge.handler';
import { requireAuth } from '@/middleware/auth';

const router  = Router({ mergeParams: true });
const upload  = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB — hard limit at multer layer
});

router.use(requireAuth);

router.get('/',           knowledgeHandler.list);
router.post('/',          upload.single('file'), knowledgeHandler.upload);
router.delete('/:fileId', knowledgeHandler.remove);

export default router;
