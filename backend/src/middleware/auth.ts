/**
 * middleware/auth.ts
 *
 * JWT guard. Attaches req.userId to every protected request.
 * Use on any route that requires a logged-in user.
 */

import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';
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
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing Bearer token');
    }

    const token   = header.slice(7);
    const payload = verifyToken(token);
    req.userId    = payload.userId;

    logger.debug('Auth passed', { userId: payload.userId, path: req.path });
    next();
  } catch (err) {
    next(err);
  }
}
