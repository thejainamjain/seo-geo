import type { Request, Response, NextFunction } from 'express';
import { dashboardService } from '../services/dashboard.service';

export const dashboardHandler = {
  async getHome(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const home = await dashboardService.getHome(req.userId, req.params['projectId'] as string);
      res.status(200).json(home);
    } catch (err) {
      next(err);
    }
  },
};
