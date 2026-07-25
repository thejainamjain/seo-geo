/**
 * lib/cms/wix.ts
 *
 * Wix Blog API publisher.
 * API DOCS: https://dev.wix.com/docs/rest/business-solutions/blog/blog-posts/create-post
 *
 * AUTH: API Key from Wix API Key Manager (author-scoped, Wix Blog permission)
 *
 * FLOW:
 *   0. GET /v3/posts/slugs/{slug} → check if a post with this slug
 *      already exists (idempotency)
 *   1a. If found: PATCH /v3/posts/{postId} → update directly
 *   1b. If not found: POST /v3/posts → create draft
 *   2. POST /v3/posts/{postId}/publish → publish
 *
 * IDEMPOTENCY: step 0 makes this safe to call twice for the same slug —
 * confirmed against Wix's documented "Get Post By Slug" endpoint
 * (GET /blog/v3/posts/slugs/{slug}). Update verb (PATCH) follows Wix's
 * general v3 REST convention — worth a live test to confirm before
 * relying on it in production, since the exact update endpoint wasn't
 * directly documented in what I could verify.
 *
 * NOTE: seoSchema is appended into `contentText` the same way as the
 * other raw-HTML publishers (see lib/cms/shared.ts). Whether Wix's
 * `contentText` field actually renders HTML (including this script tag)
 * or shows it as literal text is unconfirmed — see
 * docs/11-cms-integrations-audit.md.
 */

import { logger } from '@/open-tele';
import type { WixCredentials, BlogPublishPayload, PublishResult } from './types';
import { injectSchema } from './shared';

const WIX_API_BASE     = 'https://www.wixapis.com/blog/v3';
const FETCH_TIMEOUT_MS = 30_000;

async function wixFetch(
  path:    string,
  method:  string,
  apiKey:  string,
  siteId:  string,
  body?:   unknown,
  context?: string,
): Promise<Record<string, unknown>> {
  const url = `${WIX_API_BASE}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': apiKey,
      'Content-Type':  'application/json',
      'wix-site-id':   siteId,
    },
    body:   body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Wix API error: HTTP ${response.status} on ${method} ${url}. ` +
      `Context: ${context ?? 'unknown'}. Body: ${text.slice(0, 300)}`
    );
  }

  return response.json() as Promise<Record<string, unknown>>;
}

/** Checks whether a post with this slug already exists.
 *  Returns its post ID, or null if none found (including a 404, which
 *  Wix's Get Post By Slug returns for "not found" — treated as absent,
 *  not an error). */
async function findPostBySlug(
  slug:    string,
  apiKey:  string,
  siteId:  string,
  context: string,
): Promise<string | null> {
  const url = `${WIX_API_BASE}/posts/slugs/${encodeURIComponent(slug)}`;
  const response = await fetch(url, {
    method:  'GET',
    headers: { 'Authorization': apiKey, 'wix-site-id': siteId },
    signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Wix API error: HTTP ${response.status} on GET ${url}. ` +
      `Context: ${context}. Body: ${text.slice(0, 300)}`
    );
  }

  const data = await response.json() as { post?: Record<string, unknown> };
  const postId = data.post?.['id'];
  return postId ? String(postId) : null;
}

export async function publishToWix(
  creds:   WixCredentials,
  payload: BlogPublishPayload,
  context: string,
): Promise<PublishResult> {
  logger.info('Publishing to Wix', {
    context,
    slug:  payload.slug,
    title: payload.title,
  });

  const postFields = {
    title:               payload.title,
    contentText:         injectSchema(payload.content, payload.seoSchema),
    excerpt:             payload.description,
    slug:                payload.slug,
    coverMedia: payload.heroImageUrl
      ? { image: { url: payload.heroImageUrl } }
      : undefined,
  };

  // 0. Idempotency check — reuse an existing post with this slug instead
  //    of creating a duplicate (see file header comment for why)
  const existingPostId = await findPostBySlug(payload.slug, creds.apiKey, creds.siteId, context);

  let postId: string;
  if (existingPostId) {
    logger.info('Existing Wix post found for slug — updating instead of creating', {
      context, postId: existingPostId, slug: payload.slug,
    });
    await wixFetch(`/posts/${existingPostId}`, 'PATCH', creds.apiKey, creds.siteId, { post: postFields }, context);
    postId = existingPostId;
  } else {
    const draft = await wixFetch('/posts', 'POST', creds.apiKey, creds.siteId, { post: postFields }, context);
    const post  = draft['post'] as Record<string, unknown>;
    postId = String(post['id'] ?? '');

    if (!postId) {
      throw new Error(`Wix API returned no post ID. Context: ${context}`);
    }
    logger.debug('Wix draft created', { context, postId });
  }

  // Publish (required for both create and update paths)
  await wixFetch(`/posts/${postId}/publish`, 'POST', creds.apiKey, creds.siteId, {}, context);

  const publishedUrl = `https://${payload.domain}/${payload.blogPostPath}/${payload.slug}`;

  logger.info('Wix publish complete', { context, postId, publishedUrl });

  return {
    success:      true,
    cmsReference: postId,
    publishedUrl,
  };
}
