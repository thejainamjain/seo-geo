/**
 * utils/auth-cookie.ts
 *
 * The login JWT lives in an httpOnly cookie so page JavaScript (and any XSS
 * payload) can never read it. The same cookie is read by:
 *   - requireAuth (API requests)
 *   - the GSC OAuth start endpoint (a plain browser navigation)
 *   - the Next.js proxy on the frontend (route protection)
 *
 * A Bearer header is still accepted so scripts/tools that already hold a
 * token keep working.
 */

import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import config from './config';

export const AUTH_COOKIE_NAME = config.authCookie.name;

function baseOptions() {
  return {
    httpOnly: true,
    secure:   config.env === 'production',
    sameSite: 'lax' as const,
    path:     '/',
    ...(config.authCookie.domain ? { domain: config.authCookie.domain } : {}),
  };
}

/** Sets the auth cookie. Its lifetime matches the JWT's own `exp`. */
export function setAuthCookie(res: Response, token: string): void {
  const decoded = jwt.decode(token) as { exp?: number } | null;
  const opts: Record<string, unknown> = { ...baseOptions() };
  if (decoded?.exp) {
    opts.maxAge = Math.max(decoded.exp * 1000 - Date.now(), 0);
  }
  res.cookie(AUTH_COOKIE_NAME, token, opts);
}

/** Clears the auth cookie (must use the same path/domain it was set with). */
export function clearAuthCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, baseOptions());
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;

    const raw = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** Bearer header first (API clients), then the httpOnly cookie (browser). */
export function extractAuthToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return readCookie(req, AUTH_COOKIE_NAME);
}
