/**
 * services/gsc-oauth.service.ts
 *
 * WHAT: The actual Google OAuth "authorization code" exchange for GSC.
 * Separate from gsc.service.ts on purpose — that file owns storing/
 * reading/deleting the GoogleToken record (the generic "connect with
 * tokens you already have" contract used by handlers/gsc.handler.ts).
 * This file owns talking to Google itself: building the consent-screen
 * URL and exchanging a `code` for tokens. gsc-oauth.handler.ts calls both:
 * this service to get real tokens, then gscService.connect() to store them.
 *
 * WHY A SERVER-SIDE CODE EXCHANGE (not a frontend-only OAuth library):
 * a browser-only ("implicit"/PKCE without a backend) OAuth flow can get an
 * access token, but Google only issues a REFRESH token during a
 * server-side "authorization_code" exchange with the client secret
 * present — and GSC access tokens expire hourly (see
 * workers/jobs/gsc-monitor.job.ts), so a refresh token is required for
 * the weekly monitor job to keep working without the user re-connecting
 * constantly. That's why this exists instead of a client-only Google
 * Identity Services integration.
 */

import config from '../utils/config';
import { AppError } from '../utils/errors';
import { logger } from '../open-tele';

const GOOGLE_AUTH_ENDPOINT  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// Read-only — matches what the settings page already tells users
// ("It only requests read access to your GSC property — nothing else").
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

interface GoogleTokenResponse {
  access_token:  string;
  refresh_token?: string;
  expires_in:    number;
  scope?:        string;
  token_type?:   string;
}

export const gscOAuthService = {
  /**
   * Builds the URL to send the browser to for the Google consent screen.
   * `access_type=offline` + `prompt=consent` together force Google to
   * issue a refresh token on *every* connect, not just the first —
   * without `prompt=consent`, a user who disconnects and reconnects
   * (already having a prior grant on file with Google) would silently get
   * no refresh_token back, breaking the weekly monitor job.
   */
  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id:     config.google.clientId(),
      redirect_uri:  config.google.redirectUri(),
      response_type: 'code',
      scope:         GSC_SCOPE,
      access_type:   'offline',
      prompt:        'consent',
      state,
    });

    return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
  },

  async exchangeCodeForTokens(code: string): Promise<{
    accessToken:  string;
    refreshToken: string;
    expiryDate:   Date;
  }> {
    logger.debug('gscOAuthService.exchangeCodeForTokens');

    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        client_id:     config.google.clientId(),
        client_secret: config.google.clientSecret(),
        redirect_uri:  config.google.redirectUri(),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error(new Error('GSC OAuth code exchange failed'), { status: response.status, body });
      throw new AppError('Failed to exchange authorization code with Google', 502, 'GSC_OAUTH_EXCHANGE_FAILED');
    }

    const data = await response.json() as GoogleTokenResponse;

    if (!data.refresh_token) {
      // Should not happen with access_type=offline + prompt=consent, but
      // storing a token we can never refresh would silently break the
      // weekly monitor job an hour later — fail loudly instead.
      logger.error(new Error('GSC OAuth exchange returned no refresh_token'), {});
      throw new AppError(
        'Google did not return a refresh token — please try connecting again',
        502,
        'GSC_OAUTH_NO_REFRESH_TOKEN',
      );
    }

    logger.info('GSC OAuth code exchanged for tokens', { expiresIn: data.expires_in });

    return {
      accessToken:  data.access_token,
      refreshToken: data.refresh_token,
      expiryDate:   new Date(Date.now() + data.expires_in * 1000),
    };
  },
};
