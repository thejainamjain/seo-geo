/**
 * middleware/validate.ts
 *
 * Zod validation wrapper.
 * Usage: router.post('/path', validate(MySchema), handler)
 */

import type { Request, Response, NextFunction } from 'express';
import { type ZodSchema, ZodError } from 'zod';
import { ValidationError } from '../utils/errors';

export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const message = err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
        next(new ValidationError(message));
      } else {
        next(err);
      }
    }
  };
}
