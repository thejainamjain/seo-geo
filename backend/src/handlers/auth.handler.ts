import type { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';
import { logger } from '../open-tele';

export const authHandler = {
  async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.register(req.body);
      logger.info('User registered', { userId: result.user.id });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },

  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.login(req.body);
      logger.info('User logged in', { userId: result.user.id });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
};
