/**
 * lib/cms/webflow.ts
 *
 * Webflow CMS API publisher.
 * API DOCS: https://developers.webflow.com/data/reference/cms/collection-items/create-item
 *
 * FLOW:
 *   1. POST /collections/{collectionId}/items → create item (staged)
 *   2. POST /collections/{collectionId}/items/{itemId}/publish → go live
 *
 * AUTH: Bearer token (API token from Webflow project settings)
 *
 * FIELD MAPPING:
 *   Webflow CMS fields are custom — we map to standard blog field names.
 *   If the user's collection uses different field slugs, they'll need to
 *   update their collection or we add a field mapping config (future).
 *   Standard Webflow blog template field slugs used here.
 */

import { logger } from '../../open-tele';
import type { WebflowCredentials, BlogPublishPayload, PublishResult } from './types';

const WEBFLOW_API_BASE  = 'https://api.webflow.com/v2';
const FETCH_TIMEOUT_MS  = 30_000;

async function webflowFetch(
  path:    string,
  method:  string,
  token:   string,
  body?:   unknown,
  context?: string,
): Promise<Record<string, unknown>> {
  const url = `${WEBFLOW_API_BASE}${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'accept':        'application/json',
    },
    body:   body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Webflow API error: HTTP ${response.status} on ${method} ${url}. ` +
      `Context: ${context ?? 'unknown'}. Body: ${text.slice(0, 300)}`
    );
  }

  return response.json() as Promise<Record<string, unknown>>;
}

export async function publishToWebflow(
  creds:   WebflowCredentials,
  payload: BlogPublishPayload,
  context: string,
): Promise<PublishResult> {
  logger.info('Publishing to Webflow', {
    context,
    collectionId: creds.collectionId,
    slug:         payload.slug,
    title:        payload.title,
  });

  // 1. Create CMS item (staged — not live yet)
  const item = await webflowFetch(
    `/collections/${creds.collectionId}/items`,
    'POST',
    creds.apiToken,
    {
      isArchived: false,
      isDraft:    false,
      fieldData: {
        name:              payload.title,
        slug:              payload.slug,
        'post-body':       payload.content,
        'post-summary':    payload.description,
        'main-image':      payload.heroImageUrl ?? '',
        'thumbnail-image': payload.heroImageUrl ?? '',
      },
    },
    context,
  );

  const itemId = item['id'] as string;

  logger.debug('Webflow CMS item created', { context, itemId, slug: payload.slug });

  // 2. Publish the item
  await webflowFetch(
    `/collections/${creds.collectionId}/items/${itemId}/publish`,
    'POST',
    creds.apiToken,
    { itemIds: [itemId] },
    context,
  );

  const publishedUrl = `https://${payload.domain}/${payload.blogPostPath}/${payload.slug}`;

  logger.info('Webflow publish complete', { context, itemId, publishedUrl });

  return {
    success:      true,
    cmsReference: itemId,
    publishedUrl,
  };
}
