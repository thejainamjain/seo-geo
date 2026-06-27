/**
 * lib/cms/sanity.ts
 *
 * Sanity CMS publisher via Sanity HTTP API.
 * API DOCS: https://www.sanity.io/docs/http-api-mutations
 *
 * SCHEMA TYPE: RankAIBlogPosts (custom schema type installed by user)
 * Users fetch blog content via:
 *   GET https://rankai.ai/api/v1/{projectId}/articles?page=X&limit=Y
 *   GET https://rankai.ai/api/v1/{projectId}/articles/{slug}?format=html|markdown
 *
 * FLOW:
 *   POST /v{apiVersion}/data/mutate/{dataset} with createOrReplace mutation
 *
 * CORS: User must add https://rankai.ai to Sanity CORS origins.
 */

import { logger } from '@/open-tele';
import type { SanityCredentials, BlogPublishPayload, PublishResult } from './types';

const FETCH_TIMEOUT_MS = 30_000;

function buildSanityUrl(projectId: string, dataset: string): string {
  return `https://${projectId}.api.sanity.io/v2024-01-01/data/mutate/${dataset}`;
}

export async function publishToSanity(
  creds:   SanityCredentials,
  payload: BlogPublishPayload,
  context: string,
): Promise<PublishResult> {
  logger.info('Publishing to Sanity', {
    context,
    sanityProjectId: creds.projectId,
    dataset:         creds.datasetName,
    slug:            payload.slug,
    title:           payload.title,
  });

  // Sanity document ID — stable, derived from slug
  // Using slug as ID means re-publishing the same post updates it (idempotent)
  const documentId = `rankAiBlogPost-${payload.slug}`;

  const mutation = {
    mutations: [
      {
        createOrReplace: {
          _id:   documentId,
          _type: 'RankAIBlogPosts',
          title:       payload.title,
          slug:        { _type: 'slug', current: payload.slug },
          description: payload.description,
          content:     payload.content,
          heroImage:   payload.heroImageUrl ?? '',
          seoSchema:   payload.seoSchema ?? {},
          publishedAt: new Date().toISOString(),
        },
      },
    ],
  };

  const response = await fetch(buildSanityUrl(creds.projectId, creds.datasetName), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${creds.apiToken}`,
      'Content-Type':  'application/json',
    },
    body:   JSON.stringify(mutation),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Sanity API error: HTTP ${response.status}. Context: ${context}. Body: ${text.slice(0, 300)}`
    );
  }

  const publishedUrl = `https://${payload.domain}/${payload.blogPostPath}/${payload.slug}`;

  logger.info('Sanity publish complete', { context, documentId, publishedUrl });

  return {
    success:      true,
    cmsReference: documentId,
    publishedUrl,
  };
}
