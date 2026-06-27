import { Router } from 'express';
import { z } from 'zod';
import { keywordHandler } from '@/handlers/keyword.handler';
import { requireAuth } from '@/middleware/auth';
import { validate } from '@/middleware/validate';

const router = Router({ mergeParams: true });

router.use(requireAuth);

const AddKeywordSchema = z.object({
  keyword: z.string().min(1),
});

router.get('/',                validate(AddKeywordSchema.pick({}).partial()), keywordHandler.list);
router.post('/',               validate(AddKeywordSchema),                    keywordHandler.add);
router.delete('/:keywordId',                                                  keywordHandler.remove);

export default router;
