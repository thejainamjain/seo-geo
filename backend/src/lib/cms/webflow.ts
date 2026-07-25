/**
 * lib/cms/webflow.ts
 *
 * Webflow CMS API publisher.
 * API DOCS: https://developers.webflow.com/data/reference/cms/collection-items/create-item
 *
 * FLOW:
 *   0. GET /collections/{collectionId}/items?slug=X → check if an item
 *      with this slug already exists (idempotency)
 *   1a. If found: PATCH that item directly
 *   1b. If not found: POST /collections/{collectionId}/items → create item (staged)
 *   2. POST /collections/{collectionId}/items/{itemId}/publish → go live
 *
 * AUTH: Bearer token (API token from Webflow project settings)
 *
 * IDEMPOTENCY: step 0 makes this safe to call twice for the same slug —
 * a retry updates the existing item instead of creating a duplicate.
 * Confirmed the `slug` query param is supported directly by Webflow's
 * List Collection Items endpoint (exact-match filter, not a v1-style
 * fields[slug][eq] filter, which doesn't work in v2).
 *
 * FIELD MAPPING:
 *   Webflow CMS fields are custom — we map to standard blog field names.
 *   If the user's collection uses different field slugs, they'll need to
 *   update their collection or we add a field mapping config (future).
 *   Standard Webflow blog template field slugs used here.
 *
 *   NOTE: payload.seoSchema (JSON-LD structured data) is injected into the
 *   'post-body' content field via lib/cms/shared.ts's injectSchema() —
 *   safe because it appends to a field already being sent, not a new
 *   guessed field slug, so it doesn't carry the 400-on-unmapped-field risk
 *   a brand-new custom field would.
 */

import { logger } from '@/open-tele';
import type { WebflowCredentials, BlogPublishPayload, PublishResult } from './types';
import { injectSchema } from './shared';

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

async function webflowFetchList(
  path:    string,
  token:   string,
  context: string,
): Promise<Array<Record<string, unknown>>> {
  const url = `${WEBFLOW_API_BASE}${path}`;

  const response = await fetch(url, {
    method:  'GET',
    headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' },
    signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Webflow API error: HTTP ${response.status} on GET ${url}. ` +
      `Context: ${context}. Body: ${text.slice(0, 300)}`
    );
  }

  const data = await response.json() as { items?: Array<Record<string, unknown>> };
  return data.items ?? [];
}

/** Checks whether a collection item with this slug already exists.
 *  Returns its item ID, or null if none found. */
async function findItemBySlug(
  collectionId: string,
  slug:         string,
  token:        string,
  context:      string,
): Promise<string | null> {
  const items = await webflowFetchList(
    `/collections/${collectionId}/items?slug=${encodeURIComponent(slug)}`,
    token,
    context,
  );
  const existing = items[0];
  if (!existing) return null;
  return existing['id'] as string;
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

  const fullContent = injectSchema(payload.content, payload.seoSchema);

  const fieldData = {
    name:              payload.title,
    slug:              payload.slug,
    'post-body':       fullContent,
    'post-summary':    payload.description,
    'main-image':      payload.heroImageUrl ?? '',
    'thumbnail-image': payload.heroImageUrl ?? '',
  };

  // 0. Idempotency check — reuse an existing item with this slug instead
  //    of creating a duplicate (see file header comment for why)
  const existingItemId = await findItemBySlug(creds.collectionId, payload.slug, creds.apiToken, context);

  let itemId: string;
  if (existingItemId) {
    logger.info('Existing Webflow item found for slug — updating instead of creating', {
      context, itemId: existingItemId, slug: payload.slug,
    });
    await webflowFetch(
      `/collections/${creds.collectionId}/items/${existingItemId}`,
      'PATCH',
      creds.apiToken,
      { isArchived: false, isDraft: false, fieldData },
      context,
    );
    itemId = existingItemId;
  } else {
    const item = await webflowFetch(
      `/collections/${creds.collectionId}/items`,
      'POST',
      creds.apiToken,
      { isArchived: false, isDraft: false, fieldData },
      context,
    );
    itemId = item['id'] as string;
    logger.debug('Webflow CMS item created', { context, itemId, slug: payload.slug });
  }

  // Publish the item (required for both create and update paths — an
  // update to a staged/unpublished item doesn't automatically go live)
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
