import type { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';
import { setAuthCookie, clearAuthCookie } from '../utils/auth-cookie';
import { logger } from '../open-tele';

// The JWT is delivered only as an httpOnly cookie — it is deliberately NOT
// included in the JSON body, so page JavaScript can never read it.
export const authHandler = {
  async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token, user } = await authService.register(req.body);
      logger.info('User registered', { userId: user.id });
      setAuthCookie(res, token);
      res.status(201).json({ user });
    } catch (err) {
      next(err);
    }
  },

  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token, user } = await authService.login(req.body);
      logger.info('User logged in', { userId: user.id });
      setAuthCookie(res, token);
      res.status(200).json({ user });
    } catch (err) {
      next(err);
    }
  },

  async logout(_req: Request, res: Response): Promise<void> {
    clearAuthCookie(res);
    res.status(204).end();
  },

  async me(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await authService.getMe(req.userId);
      res.status(200).json({ user });
    } catch (err) {
      next(err);
    }
  },
};
