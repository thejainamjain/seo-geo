/**
 * utils/jwt.ts
 *
 * JWT sign and verify helpers.
 * Tokens reference userId only — everything else fetched from DB.
 */

import jwt from 'jsonwebtoken';
import { UnauthorizedError } from './errors';
import config from './config';

const SECRET     = config.jwt.secret();
const EXPIRES_IN = config.jwt.expiresIn;

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

/**
 * Short-lived signed state for redirect-based OAuth flows (GSC connect).
 * Not a login token — carries whatever context the callback needs to
 * identify who/what the flow was started for, since the callback request
 * comes straight from the OAuth provider with no Authorization header.
 */
export function signOAuthState<T extends object>(payload: T, expiresIn: string): string {
  if (!SECRET) throw new Error('JWT_SECRET is not defined');
  return jwt.sign(payload, SECRET, { expiresIn } as jwt.SignOptions);
}

export function verifyOAuthState<T>(token: string): T {
  if (!SECRET) throw new Error('JWT_SECRET is not defined');
  try {
    return jwt.verify(token, SECRET) as T;
  } catch {
    throw new UnauthorizedError('Invalid or expired OAuth state');
  }
}
