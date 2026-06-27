import type { Request, Response, NextFunction } from 'express';
import { knowledgeService } from '../services/knowledge.service';

export const knowledgeHandler = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const files = await knowledgeService.listFiles(
        req.userId,
        req.params['projectId'] as string,
      );
      res.status(200).json({ files });
    } catch (err) {
      next(err);
    }
  },

  async upload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ message: 'No file provided' });
        return;
      }
      const file = await knowledgeService.uploadFile(
        req.userId,
        req.params['projectId'] as string,
        req.file,
      );
      res.status(201).json({ file });
    } catch (err) {
      next(err);
    }
  },

  async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const file = await knowledgeService.deleteFile(
        req.userId,
        req.params['projectId'] as string,
        req.params['fileId']    as string,
      );
      res.status(200).json({ file });
    } catch (err) {
      next(err);
    }
  },
};
