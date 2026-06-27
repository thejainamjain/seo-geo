import { Router } from 'express';
import { z } from 'zod';
import { blogHandler } from '@/handlers/blog.handler';
import { requireAuth } from '@/middleware/auth';
import { validate } from '@/middleware/validate';

const router = Router({ mergeParams: true });

router.use(requireAuth);

const UpdateBlogSchema = z.object({
  title:       z.string().min(1).optional(),
  content:     z.string().optional(),
  description: z.string().optional(),
  status:      z.enum(['draft', 'ready', 'published', 'archived']).optional(),
});

router.get('/',                      blogHandler.list);
router.get('/:blogId',               blogHandler.getOne);
router.patch('/:blogId',             validate(UpdateBlogSchema), blogHandler.update);
router.post('/:blogId/publish',      blogHandler.publish);
router.post('/:blogId/unpublish',    blogHandler.unpublish);
router.delete('/:blogId',            blogHandler.remove);

export default router;
