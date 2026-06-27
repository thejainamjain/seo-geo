import type { Request, Response, NextFunction } from 'express';
import { toolsService } from '../services/tools.service';

export const toolsHandler = {
  async runAudit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
        ?? req.ip
        ?? 'unknown';

      await toolsService.runFreeAudit(ip, req.body);

      res.status(200).json({ message: 'Audit running, check your email' });
    } catch (err) {
      next(err);
    }
  },
};
