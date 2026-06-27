import type { Request, Response, NextFunction } from 'express';
import { geoService } from '../services/geo.service';

export const geoHandler = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const runs = await geoService.listRuns(
        req.userId,
        req.params['projectId'] as string,
      );
      res.status(200).json({ runs });
    } catch (err) {
      next(err);
    }
  },

  async getLatest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const run = await geoService.getLatestRun(
        req.userId,
        req.params['projectId'] as string,
      );
      res.status(200).json({ run });
    } catch (err) {
      next(err);
    }
  },
};
