import type { Request, Response, NextFunction } from 'express';
import { cmsService } from '../services/cms.service';

export const cmsHandler = {
  async getConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cmsConfig = await cmsService.getCmsConfig(
        req.userId,
        req.params['projectId'] as string,
      );
      res.status(200).json({ cmsConfig });
    } catch (err) {
      next(err);
    }
  },

  async connect(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cmsConfig = await cmsService.connectCms(
        req.userId,
        req.params['projectId'] as string,
        req.body,
      );
      res.status(200).json({ cmsConfig });
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cmsConfig = await cmsService.updateCmsConfig(
        req.userId,
        req.params['projectId'] as string,
        req.body,
      );
      res.status(200).json({ cmsConfig });
    } catch (err) {
      next(err);
    }
  },

  async disconnect(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await cmsService.disconnectCms(
        req.userId,
        req.params['projectId'] as string,
      );
      res.status(200).json({ message: 'CMS disconnected' });
    } catch (err) {
      next(err);
    }
  },
};
