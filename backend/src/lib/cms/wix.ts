/**
 * lib/cms/wix.ts
 *
 * Wix Blog API publisher.
 * API DOCS: https://dev.wix.com/docs/rest/business-solutions/blog/blog-posts/create-post
 *
 * AUTH: API Key from Wix API Key Manager (author-scoped, Wix Blog permission)
 *
 * FLOW:
 *   1. POST /v3/posts → create draft
 *   2. POST /v3/posts/{postId}/publish → publish
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

  // 1. Create draft post
  //    NOTE: seoSchema is appended the same way as the other raw-HTML
  //    publishers (see lib/cms/shared.ts). Whether Wix's `contentText`
  //    field actually renders HTML (including this script tag) or shows it
  //    as literal text is unconfirmed — see docs/11-cms-integrations-audit.md.
  const fullContent = injectSchema(payload.content, payload.seoSchema);

  const draft = await wixFetch(
    '/posts',
    'POST',
    creds.apiKey,
    creds.siteId,
    {
      post: {
        title:               payload.title,
        contentText:         fullContent,
        excerpt:             payload.description,
        slug:                payload.slug,
        coverMedia: payload.heroImageUrl
          ? { image: { url: payload.heroImageUrl } }
          : undefined,
      },
    },
    context,
  );

  const post   = draft['post'] as Record<string, unknown>;
  const postId = String(post['id'] ?? '');

  if (!postId) {
    throw new Error(`Wix API returned no post ID. Context: ${context}`);
  }

  logger.debug('Wix draft created', { context, postId });

  // 2. Publish the draft
  await wixFetch(`/posts/${postId}/publish`, 'POST', creds.apiKey,creds.siteId , {}, context);

  const publishedUrl = `https://${payload.domain}/${payload.blogPostPath}/${payload.slug}`;

  logger.info('Wix publish complete', { context, postId, publishedUrl });

  return {
    success:      true,
    cmsReference: postId,
    publishedUrl,
  };
}
