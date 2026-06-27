import type { Request, Response, NextFunction } from 'express';
import { gscService } from '../services/gsc.service';

export const gscHandler = {
  async getStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const status = await gscService.getStatus(
        req.userId,
        req.params['projectId'] as string,
      );
      res.status(200).json({ gsc: status });
    } catch (err) {
      next(err);
    }
  },

  async connect(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await gscService.connect(
        req.userId,
        req.params['projectId'] as string,
        req.body,
      );
      res.status(200).json({ message: 'GSC connected' });
    } catch (err) {
      next(err);
    }
  },

  async disconnect(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await gscService.disconnect(
        req.userId,
        req.params['projectId'] as string,
      );
      res.status(200).json({ message: 'GSC disconnected' });
    } catch (err) {
      next(err);
    }
  },
};
