import type { Request, Response, NextFunction } from 'express';
import { optimizationService } from '../services/optimization.service';

function parsePagination(query: Record<string, unknown>) {
  const page  = Math.max(1, parseInt(String(query['page']  ?? 1), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(query['limit'] ?? 20), 10)));
  return { page, limit };
}

export const optimizationHandler = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page, limit } = parsePagination(req.query as Record<string, unknown>);
      const result = await optimizationService.listOptimizations(
        req.userId,
        req.params['projectId'] as string,
        {
          status: req.query['status'] as 'pending_review' | 'applied' | 'rejected' | undefined,
          blogId: req.query['blogId'] as string | undefined,
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
      const optimization = await optimizationService.getOptimization(
        req.userId,
        req.params['projectId']      as string,
        req.params['optimizationId'] as string,
      );
      res.status(200).json({ optimization });
    } catch (err) {
      next(err);
    }
  },

  async approve(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const optimization = await optimizationService.approveOptimization(
        req.userId,
        req.params['projectId']      as string,
        req.params['optimizationId'] as string,
      );
      res.status(200).json({ optimization, message: 'Optimization applied' });
    } catch (err) {
      next(err);
    }
  },

  async reject(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const optimization = await optimizationService.rejectOptimization(
        req.userId,
        req.params['projectId']      as string,
        req.params['optimizationId'] as string,
      );
      res.status(200).json({ optimization, message: 'Optimization rejected' });
    } catch (err) {
      next(err);
    }
  },
};
