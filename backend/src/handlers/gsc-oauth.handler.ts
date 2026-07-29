/**
 * handlers/gsc-oauth.handler.ts
 *
 * Two browser-navigation endpoints (not JSON APIs — both respond with
 * redirects), mounted at the top level as /api/v1/gsc/connect and
 * /api/v1/gsc/callback (NOT nested under /projects/:projectId/gsc like
 * the rest of the GSC routes) because the callback URL is fixed and
 * registered with Google ahead of time — it can't contain a dynamic
 * :projectId segment. See routes/api-v1/gsc-oauth.route.ts.
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { gscOAuthService } from '../services/gsc-oauth.service';
import { gscService } from '../services/gsc.service';
import { verifyToken, signOAuthState, verifyOAuthState } from '../utils/jwt';
import { ValidationError } from '../utils/errors';
import config from '../utils/config';
import { logger } from '../open-tele';

const OAUTH_STATE_TTL = '10m';

interface OAuthState {
  userId:    string;
  projectId: string;
}

const StartQuerySchema = z.object({
  projectId: z.string().min(1),
  token:     z.string().min(1),
});

function settingsUrl(projectId: string, query: string): string {
  return `${config.frontend.url}/projects/${projectId}/settings?${query}`;
}

export const gscOAuthHandler = {
  /**
   * GET /gsc/connect?projectId=&token=
   *
   * `token` is the same JWT normally sent as a Bearer header — it has to
   * travel as a query param here because this is a plain browser
   * navigation (an <a href>), not an XHR request the axios interceptor
   * can attach an Authorization header to.
   */
  async start(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = StartQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError('projectId and token query params are required');
      }
      const { projectId, token } = parsed.data;

      const { userId } = verifyToken(token);

      // Reuses gscService's own access check (project exists + userId is a
      // member of its organization) rather than duplicating that logic
      // here — throws NotFoundError/ForbiddenError the same way every
      // other project-scoped endpoint does.
      await gscService.getStatus(userId, projectId);

      const state = signOAuthState<OAuthState>({ userId, projectId }, OAUTH_STATE_TTL);
      const authUrl = gscOAuthService.buildAuthUrl(state);

      logger.info('GSC OAuth flow started', { userId, projectId });
      res.redirect(authUrl);
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /gsc/callback?code=&state=
   *
   * Google redirects here after the user approves/denies consent. There's
   * no Authorization header and no :projectId in the path — `state` is
   * the only thing tying this request back to a user + project, so every
   * failure path below redirects to the frontend with an error flag
   * rather than throwing a raw JSON error the user would never see (this
   * is a browser tab, not an API client).
   */
  async callback(req: Request, res: Response): Promise<void> {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };

    if (error) {
      logger.info('GSC OAuth consent denied or errored at Google', { error });
      res.redirect(`${config.frontend.url}/projects?gsc=error`);
      return;
    }

    if (!code || !state) {
      res.redirect(`${config.frontend.url}/projects?gsc=error`);
      return;
    }

    let parsedState: OAuthState;
    try {
      parsedState = verifyOAuthState<OAuthState>(state);
    } catch (err) {
      logger.warn('GSC OAuth callback got an invalid/expired state param', { err: String(err) });
      res.redirect(`${config.frontend.url}/projects?gsc=error`);
      return;
    }

    const { userId, projectId } = parsedState;

    try {
      const tokens = await gscOAuthService.exchangeCodeForTokens(code);
      await gscService.connect(userId, projectId, tokens);

      logger.info('GSC OAuth flow completed', { userId, projectId });
      res.redirect(settingsUrl(projectId, 'gsc=connected'));
    } catch (err) {
      logger.error(err instanceof Error ? err : new Error(String(err)), { userId, projectId, context: 'gsc-oauth-callback' });
      res.redirect(settingsUrl(projectId, 'gsc=error'));
    }
  },
};
