import type { Request, Response, NextFunction } from 'express';
import { analyticsService } from '../services/analytics.service';

export const analyticsHandler = {
  async getSummaryCards(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cards = await analyticsService.getSummaryCards(
        req.userId,
        req.params['projectId'] as string,
      );
      res.status(200).json(cards);
    } catch (err) {
      next(err);
    }
  },

  async getPerformanceOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const days = req.query['days'] ? Number(req.query['days']) : 14;
      const overview = await analyticsService.getPerformanceOverview(
        req.userId,
        req.params['projectId'] as string,
        days,
      );
      res.status(200).json(overview);
    } catch (err) {
      next(err);
    }
  },

  async getTopMovers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const limit = req.query['limit'] ? Number(req.query['limit']) : 5;
      const result = await analyticsService.getTopMovers(
        req.userId,
        req.params['projectId'] as string,
        limit,
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async getKeywordPerformance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page  = req.query['page']  ? Number(req.query['page'])  : 1;
      const limit = req.query['limit'] ? Number(req.query['limit']) : 20;
      const result = await analyticsService.getKeywordPerformance(
        req.userId,
        req.params['projectId'] as string,
        { page, limit },
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
};
