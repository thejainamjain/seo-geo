/**
 * middleware/error.ts
 *
 * Global error handler — must be registered LAST in app.ts.
 * Catches AppError subclasses and returns correct HTTP status.
 * All other errors become 500.
 */

import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../open-tele';

export function errorHandler(
  err:  Error,
  req:  Request,
  res:  Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    logger.warn(`AppError: ${err.message}`, {
      code:       err.code,
      statusCode: err.statusCode,
      path:       req.path,
      method:     req.method,
    });

    res.status(err.statusCode).json({
      error: {
        code:    err.code,
        message: err.message,
      },
    });
    return;
  }

  // Unexpected error — log full details, return generic message
  logger.error(err, {
    context: 'errorHandler',
    path:    req.path,
    method:  req.method,
  });

  res.status(500).json({
    error: {
      code:    'INTERNAL_ERROR',
      message: 'Something went wrong',
    },
  });
}
