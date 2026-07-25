/**
 * lib/cms/sanity.ts
 *
 * Sanity CMS publisher via Sanity HTTP API.
 * API DOCS: https://www.sanity.io/docs/http-api-mutations
 *
 * SCHEMA TYPE: `post` — matches Sanity's own official blog starter
 * template convention (sanity.io/create, "Blog (Personal)" template, and
 * the community-standard `sanity-plugin-blog` package all use `post` as
 * the document type name). Chosen instead of a product-specific name so
 * this integration works against any Sanity project that has a standard
 * blog schema already, rather than requiring a schema package specific to
 * this product. Previously this was hardcoded to `RankAIBlogPosts` — a
 * leftover from referencing RankAI's actual implementation while building
 * this clone (see docs/11-cms-integrations-audit.md) — which only worked
 * if the user's Sanity project happened to have a RankAI-specific schema
 * installed, which no other user's project would.
 *
 * FLOW:
 *   POST /v{apiVersion}/data/mutate/{dataset} with createOrReplace mutation
 *
 * NOTE: the schema type name (and field names below — title, slug,
 * description, content, heroImage, seoSchema, publishedAt) still need to
 * match whatever schema actually exists in the connecting user's Sanity
 * project. `post` + these field names match the most common blog schema
 * convention, but if this product ever ships its own installable Sanity
 * schema package, the type name here should match that package's schema
 * exactly, not just a generic guess.
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
  const documentId = `post-${payload.slug}`;

  const mutation = {
    mutations: [
      {
        createOrReplace: {
          _id:   documentId,
          _type: 'post',
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
