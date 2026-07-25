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
 *   0. GET /blogs/posts/url-slug-exists → check if this slug is taken
 *      (idempotency signal)
 *   1a. If taken: GET /blogs/posts (list, filtered by blogId) to find the
 *       matching post's ID, then POST /blogs/posts/{postId} to update it
 *   1b. If not taken: POST /blogs/posts → create and publish post
 *
 * IDEMPOTENCY: confirmed GHL's public Blogs API includes a documented
 * "Check url slug" endpoint (blogs/check-slug.readonly →
 * GET /blogs/posts/url-slug-exists) and an "Update Blog Post" endpoint
 * (POST /blogs/posts/:postId), per GHL's own API changelog. The exact
 * response shape of url-slug-exists (does it return the existing post's
 * ID directly, or just a boolean?) wasn't fully confirmed from
 * documentation alone — implemented defensively assuming it's boolean-only
 * and a separate list-and-match step is needed to get the ID. Worth a
 * live test against a real GHL account before trusting this in production.
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

/**
 * Checks whether a post with this slug already exists, and if so, finds
 * its post ID by listing posts for the blog and matching on slug.
 * Returns the post ID, or null if the slug isn't taken.
 *
 * Two-step because the "check slug" endpoint's exact response shape
 * (whether it includes the post ID directly) wasn't confirmed from
 * documentation alone — see file header comment.
 */
async function findExistingPostBySlug(
  locationId: string,
  siteId:     string,
  slug:       string,
  token:      string,
  context:    string,
): Promise<string | null> {
  const checkUrl = `${GHL_API_BASE}/blogs/posts/url-slug-exists?locationId=${encodeURIComponent(locationId)}&urlSlug=${encodeURIComponent(slug)}`;
  const checkResponse = await fetch(checkUrl, {
    method:  'GET',
    headers: { 'Authorization': `Bearer ${token}`, 'Version': '2021-07-28' },
    signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!checkResponse.ok) {
    // Non-fatal — if the existence check itself fails, fall through to
    // "not found" and let the create path run. Worst case on a genuine
    // slug collision: GHL's create call itself errors, which surfaces
    // clearly rather than silently duplicating.
    logger.warn('GoHighLevel slug-exists check failed — proceeding as if not found', {
      context, status: checkResponse.status,
    });
    return null;
  }

  const checkData = await checkResponse.json() as { exists?: boolean; slugExists?: boolean };
  const exists = checkData.exists ?? checkData.slugExists ?? false;
  if (!exists) return null;

  // Slug is taken — find the matching post's ID by listing posts for this blog.
  const listUrl = `${GHL_API_BASE}/blogs/posts?locationId=${encodeURIComponent(locationId)}&blogId=${encodeURIComponent(siteId)}&limit=100`;
  const listResponse = await fetch(listUrl, {
    method:  'GET',
    headers: { 'Authorization': `Bearer ${token}`, 'Version': '2021-07-28' },
    signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!listResponse.ok) {
    logger.warn('GoHighLevel post list failed while resolving existing slug — proceeding as if not found', {
      context, status: listResponse.status,
    });
    return null;
  }

  const listData = await listResponse.json() as { blogs?: Array<Record<string, unknown>>; posts?: Array<Record<string, unknown>> };
  const posts = listData.posts ?? listData.blogs ?? [];
  const match = posts.find(p => p['urlSlug'] === slug || p['slug'] === slug);
  return match ? String(match['id'] ?? match['_id'] ?? '') || null : null;
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

  const postBody = {
    locationId,
    siteId,
    title:       payload.title,
    slug:        payload.slug,
    description: payload.description,
    rawHtml:     injectSchema(payload.content, payload.seoSchema),
    status:      'PUBLISHED',
    imageUrl:    payload.heroImageUrl ?? '',
  };

  // 0. Idempotency check — reuse an existing post with this slug instead
  //    of creating a duplicate (see file header comment for why)
  const existingPostId = await findExistingPostBySlug(
    locationId, siteId, payload.slug, creds.privateIntegrationToken, context,
  );

  const url = existingPostId
    ? `${GHL_API_BASE}/blogs/posts/${existingPostId}`
    : `${GHL_API_BASE}/blogs/posts`;

  if (existingPostId) {
    logger.info('Existing GoHighLevel post found for slug — updating instead of creating', {
      context, postId: existingPostId, slug: payload.slug,
    });
  }

  const response = await fetch(url, {
    method: 'POST', // GHL uses POST for both create and update (per its documented Update Blog Post endpoint)
    headers: {
      'Authorization': `Bearer ${creds.privateIntegrationToken}`,
      'Content-Type':  'application/json',
      'Version':       '2021-07-28',
    },
    body: JSON.stringify(postBody),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `GoHighLevel API error: HTTP ${response.status}. Context: ${context}. Body: ${text.slice(0, 300)}`
    );
  }

  const data    = await response.json() as Record<string, unknown>;
  const postId  = existingPostId ?? String(data['id'] ?? data['postId'] ?? 'unknown');
  const publishedUrl = `https://${payload.domain}/${payload.blogPostPath}/${payload.slug}`;

  logger.info('GoHighLevel publish complete', { context, postId, publishedUrl });

  return {
    success:      true,
    cmsReference: postId,
    publishedUrl,
  };
}
