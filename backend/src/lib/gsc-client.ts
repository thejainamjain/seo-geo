/**
 * lib/gsc-client.ts
 *
 * WHAT: Shared "get me a valid GSC access token for this project" helper,
 * plus a thin wrapper around the Search Analytics query endpoint.
 *
 * WHY THIS EXISTS: Originally this refresh-on-expiry logic lived only
 * inside workers/jobs/gsc-monitor.job.ts. workers/jobs/keyword-ranking-sync.job.ts
 * (see that file) needs the exact same token — same GoogleToken doc, same
 * refresh-if-expiring-soon behavior — so it's extracted here rather than
 * copy-pasted a second time. gsc-monitor.job.ts has been updated to call
 * this instead of its own private copy; its behavior is unchanged.
 */

import { GoogleToken } from '@/models';
import { logger } from '@/open-tele';
import config from '@/utils/config';

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh if expiring within 5 minutes

export interface GscAccessToken {
  accessToken: string;
  siteUrl:     string;
}

async function refreshAccessToken(
  refreshToken: string,
  projectId:    string,
): Promise<{ accessToken: string; expiryDate: Date }> {
  logger.debug('Refreshing GSC access token', { projectId });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id: config.google.clientId(),
      client_secret: config.google.clientSecret(),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GSC token refresh failed: ${response.status} ${body}`);
  }

  const data = await response.json() as {
    access_token: string;
    expires_in:   number;
  };

  const expiryDate = new Date(Date.now() + data.expires_in * 1000);

  logger.info('GSC access token refreshed', { projectId, expiresIn: data.expires_in });

  return { accessToken: data.access_token, expiryDate };
}

/**
 * Returns a valid (non-expired) GSC access token for a project, refreshing
 * it first if it's within REFRESH_BUFFER_MS of expiring. Returns null if
 * the project has no GoogleToken doc at all (GSC never connected, or
 * disconnected) — this is a normal, expected state, not an error; callers
 * should log-and-skip, not throw.
 */
export async function getValidAccessToken(projectId: string): Promise<string | null> {
  // select('+accessToken +refreshToken') required — these fields are
  // select: false at the schema level (see models/GoogleToken.ts).
  const tokenDoc = await GoogleToken.findOne({ projectId }).select('+accessToken +refreshToken');
  if (!tokenDoc) return null;

  if (tokenDoc.expiryDate.getTime() - Date.now() < REFRESH_BUFFER_MS) {
    logger.info('GSC token expiring soon — refreshing', {
      projectId,
      expiryDate: tokenDoc.expiryDate.toISOString(),
    });

    const refreshed = await refreshAccessToken(tokenDoc.refreshToken, projectId);

    await GoogleToken.findByIdAndUpdate(tokenDoc._id, {
      accessToken: refreshed.accessToken,
      expiryDate:  refreshed.expiryDate,
    });

    return refreshed.accessToken;
  }

  return tokenDoc.accessToken;
}

export interface GscSearchAnalyticsRow {
  keys:        string[];
  clicks:      number;
  impressions: number;
  ctr:         number;
  position:    number;
}

interface GscSearchAnalyticsResponse {
  rows?: GscSearchAnalyticsRow[];
}

export interface SearchAnalyticsQuery {
  startDate:  string; // YYYY-MM-DD
  endDate:    string; // YYYY-MM-DD
  dimensions: string[];
  dimensionFilterGroups?: Array<{
    filters: Array<{ dimension: string; operator: string; expression: string }>;
  }>;
  rowLimit?: number;
  orderBy?:  Array<{ fieldName: string; sortOrder: 'ASCENDING' | 'DESCENDING' }>;
}

/**
 * Thin wrapper around GSC's Search Analytics query endpoint. Returns an
 * empty rows array (never throws) on a non-2xx response — callers treat
 * "no data" and "request failed" the same way (log + move on), matching
 * the existing behavior in gsc-monitor.job.ts's fetchGscMetricsForPage.
 */
export async function querySearchAnalytics(
  siteUrl:     string,
  accessToken: string,
  query:       SearchAnalyticsQuery,
  projectId:   string,
): Promise<GscSearchAnalyticsRow[]> {
  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(query),
    },
  );

  if (!res.ok) {
    logger.warn('GSC searchAnalytics query failed', {
      projectId,
      status: res.status,
      dimensions: query.dimensions,
    });
    return [];
  }

  const data = await res.json() as GscSearchAnalyticsResponse;
  return data.rows ?? [];
}
