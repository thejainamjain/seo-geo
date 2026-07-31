import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { blogHandler } from '@/handlers/blog.handler';
import { requireAuth } from '@/middleware/auth';
import { validate } from '@/middleware/validate';

const router = Router({ mergeParams: true });
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }, // 5MB — hard limit at multer layer, mirrors blogService.uploadImage
});

router.use(requireAuth);

const UpdateBlogSchema = z.object({
  title:        z.string().min(1).optional(),
  content:      z.string().optional(),
  description:  z.string().optional(),
  status:       z.enum(['draft', 'ready', 'published', 'archived']).optional(),
  // null clears the hero image (see components/editor/hero-image.tsx's
  // Remove action); omitted entirely means "don't touch it".
  heroImageUrl: z.string().url().nullable().optional(),
});

router.get('/',                      blogHandler.list);
router.get('/:blogId',               blogHandler.getOne);
router.patch('/:blogId',             validate(UpdateBlogSchema), blogHandler.update);
router.post('/:blogId/images',       upload.single('image'), blogHandler.uploadImage);
router.post('/:blogId/publish',      blogHandler.publish);
router.post('/:blogId/unpublish',    blogHandler.unpublish);
router.delete('/:blogId',            blogHandler.remove);

export default router;
