/**
 * lib/cms/gohighlevel.ts
 *
 * GoHighLevel Blog API publisher.
 * API DOCS: https://highlevel.stoplight.io/docs/integrations/
 *
 * AUTH: Private Integration Token
 *   Created in GHL Settings → Private Integrations
 *   Requires all blog-related permissions enabled
 *
 * FLOW:
 *   Parse locationId from blogDashboardUrl
 *   POST /blogs/posts → create and publish post
 */

import { logger } from '@/open-tele';
import type { GoHighLevelCredentials, BlogPublishPayload, PublishResult } from './types';
import { injectSchema } from './shared';

const GHL_API_BASE     = 'https://services.leadconnectorhq.com';
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Extracts locationId from GHL blog dashboard URL.
 * URL format: app.gohighlevel.com/v2/location/{locationId}/blogs/site/{siteId}
 */
function extractLocationId(blogDashboardUrl: string): string {
  const match = blogDashboardUrl.match(/\/location\/([^/]+)\//);
  if (!match?.[1]) {
    throw new Error(
      `Could not extract locationId from GHL blogDashboardUrl: ${blogDashboardUrl}. ` +
      `Expected format: app.gohighlevel.com/v2/location/{locationId}/blogs/site/{siteId}`
    );
  }
  return match[1];
}

/**
 * Extracts siteId from GHL blog dashboard URL.
 */
function extractSiteId(blogDashboardUrl: string): string {
  const match = blogDashboardUrl.match(/\/blogs\/site\/([^/]+)/);
  if (!match?.[1]) {
    throw new Error(
      `Could not extract siteId from GHL blogDashboardUrl: ${blogDashboardUrl}`
    );
  }
  return match[1];
}

export async function publishToGoHighLevel(
  creds:   GoHighLevelCredentials,
  payload: BlogPublishPayload,
  context: string,
): Promise<PublishResult> {
  const locationId = extractLocationId(creds.blogDashboardUrl);
  const siteId     = extractSiteId(creds.blogDashboardUrl);

  logger.info('Publishing to GoHighLevel', {
    context,
    locationId,
    siteId,
    slug:  payload.slug,
    title: payload.title,
  });

  const url = `${GHL_API_BASE}/blogs/posts`;
  const fullContent = injectSchema(payload.content, payload.seoSchema);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${creds.privateIntegrationToken}`,
      'Content-Type':  'application/json',
      'Version':       '2021-07-28',
    },
    body: JSON.stringify({
      locationId,
      siteId,
      title:       payload.title,
      slug:        payload.slug,
      description: payload.description,
      rawHtml:     fullContent,
      status:      'PUBLISHED',
      imageUrl:    payload.heroImageUrl ?? '',
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `GoHighLevel API error: HTTP ${response.status}. Context: ${context}. Body: ${text.slice(0, 300)}`
    );
  }

  const data    = await response.json() as Record<string, unknown>;
  const postId  = String(data['id'] ?? data['postId'] ?? 'unknown');
  const publishedUrl = `https://${payload.domain}/${payload.blogPostPath}/${payload.slug}`;

  logger.info('GoHighLevel publish complete', { context, postId, publishedUrl });

  return {
    success:      true,
    cmsReference: postId,
    publishedUrl,
  };
}
