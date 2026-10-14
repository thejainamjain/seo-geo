/**
 * middleware/auth.ts
 *
 * JWT guard. Attaches req.userId to every protected request.
 * Reads the token from the httpOnly auth cookie (browser) or a Bearer header.
 * Use on any route that requires a logged-in user.
 */

import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';
import { extractAuthToken } from '../utils/auth-cookie';
import { UnauthorizedError } from '../utils/errors';
import { logger } from '../open-tele';

declare global {
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  try {
    const token = extractAuthToken(req);
    if (!token) {
      throw new UnauthorizedError('Not authenticated');
    }

    const payload = verifyToken(token);
    req.userId    = payload.userId;

    logger.debug('Auth passed', { userId: payload.userId, path: req.path });
    next();
  } catch (err) {
    next(err);
  }
}
