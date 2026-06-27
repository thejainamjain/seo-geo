import type { Request, Response, NextFunction } from 'express';
import { blogService } from '../services/blog.service';

function parsePagination(query: Record<string, unknown>) {
  const page  = Math.max(1, parseInt(String(query['page']  ?? 1), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(query['limit'] ?? 20), 10)));
  return { page, limit };
}

export const blogHandler = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page, limit } = parsePagination(req.query as Record<string, unknown>);
      const result = await blogService.listBlogs(
        req.userId,
        req.params['projectId'] as string,
        {
          status: req.query['status'] as string | undefined,
          page,
          limit,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async getOne(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const blog = await blogService.getBlog(
        req.userId,
        req.params['projectId'] as string,
        req.params['blogId']    as string,
      );
      res.status(200).json({ blog });
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const blog = await blogService.updateBlog(
        req.userId,
        req.params['projectId'] as string,
        req.params['blogId']    as string,
        req.body,
      );
      res.status(200).json({ blog });
    } catch (err) {
      next(err);
    }
  },

  async publish(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const blog = await blogService.publishBlog(
        req.userId,
        req.params['projectId'] as string,
        req.params['blogId']    as string,
      );
      res.status(200).json({ blog, message: 'Publish job enqueued' });
    } catch (err) {
      next(err);
    }
  },

  async unpublish(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const blog = await blogService.unpublishBlog(
        req.userId,
        req.params['projectId'] as string,
        req.params['blogId']    as string,
      );
      res.status(200).json({ blog });
    } catch (err) {
      next(err);
    }
  },

  async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const blog = await blogService.deleteBlog(
        req.userId,
        req.params['projectId'] as string,
        req.params['blogId']    as string,
      );
      res.status(200).json({ blog });
    } catch (err) {
      next(err);
    }
  },
};
