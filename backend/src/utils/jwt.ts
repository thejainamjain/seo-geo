/**
 * utils/jwt.ts
 *
 * JWT sign and verify helpers.
 * Tokens reference userId only — everything else fetched from DB.
 */

import jwt from 'jsonwebtoken';
import { UnauthorizedError } from './errors';

const SECRET     = process.env.JWT_SECRET!;
const EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '7d';

export interface JwtPayload {
  userId: string;
}

export function signToken(payload: JwtPayload): string {
  if (!SECRET) throw new Error('JWT_SECRET is not defined');
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  if (!SECRET) throw new Error('JWT_SECRET is not defined');
  try {
    return jwt.verify(token, SECRET) as JwtPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }
}
