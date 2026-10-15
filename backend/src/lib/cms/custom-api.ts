/**
 * lib/cms/custom-api.ts
 *
 * Custom API publisher — for user's own custom-built sites.
 * User provides an endpoint URL + auth header.
 * We POST the blog data as JSON to that endpoint.
 *
 * This is the "other" CMS option — user exports from SearchPilot and
 * has their own endpoint that accepts the payload.
 *
 * PAYLOAD SHAPE: Standard — same as what our public articles API returns.
 */

import { logger } from '@/open-tele';
import type { CustomApiCredentials, BlogPublishPayload, PublishResult } from './types';

const FETCH_TIMEOUT_MS = 30_000;

export async function publishToCustomApi(
  creds:   CustomApiCredentials,
  payload: BlogPublishPayload,
  context: string,
): Promise<PublishResult> {
  logger.info('Publishing to custom API', {
    context,
    endpointUrl: creds.endpointUrl,
    slug:        payload.slug,
    title:       payload.title,
  });

  const response = await fetch(creds.endpointUrl, {
    method: 'POST',
    headers: {
      'Authorization': creds.authHeader,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      title:        payload.title,
      slug:         payload.slug,
      description:  payload.description,
      content:      payload.content,
      heroImageUrl: payload.heroImageUrl ?? '',
      seoSchema:    payload.seoSchema ?? {},
      publishedAt:  new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Custom API error: HTTP ${response.status} on ${creds.endpointUrl}. ` +
      `Context: ${context}. Body: ${text.slice(0, 300)}`
    );
  }

  const data   = await response.json() as Record<string, unknown>;
  const ref    = String(data['id'] ?? data['postId'] ?? data['slug'] ?? payload.slug);
  const publishedUrl = `https://${payload.domain}/${payload.blogPostPath}/${payload.slug}`;

  logger.info('Custom API publish complete', { context, ref, publishedUrl });

  return {
    success:      true,
    cmsReference: ref,
    publishedUrl,
  };
}
