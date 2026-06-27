/**
 * lib/cms/framer.ts
 *
 * Framer CMS publisher via RankAI Framer plugin.
 * The plugin exposes a webhook endpoint on the Framer project that
 * accepts blog post data and creates a CMS item.
 *
 * FLOW:
 *   POST to Framer plugin webhook → plugin creates CMS item → returns item ID
 *
 * AUTH: projectId is the shared secret — set during plugin configuration.
 *
 * NOTE: Framer does not have a public REST API for CMS items.
 *   We publish via the RankAI Framer plugin (installed by user).
 *   The plugin webhook URL follows a predictable pattern based on projectId.
 */

import { logger } from '../../open-tele';
import type { FramerCredentials, BlogPublishPayload, PublishResult } from './types';

const FETCH_TIMEOUT_MS = 30_000;

// Framer plugin webhook — provisioned when user installs RankAI plugin
function buildWebhookUrl(projectId: string): string {
  return `https://framer-plugin.rankai.ai/api/publish/${projectId}`;
}

export async function publishToFramer(
  creds:   FramerCredentials,
  payload: BlogPublishPayload,
  context: string,
): Promise<PublishResult> {
  logger.info('Publishing to Framer', {
    context,
    projectId: creds.projectId,
    slug:      payload.slug,
    title:     payload.title,
  });

  const webhookUrl = buildWebhookUrl(creds.projectId);

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title:       payload.title,
      slug:        payload.slug,
      description: payload.description,
      content:     payload.content,
      heroImage:   payload.heroImageUrl ?? '',
      schema:      payload.seoSchema ?? {},
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Framer plugin webhook failed: HTTP ${response.status}. ` +
      `Context: ${context}. Body: ${text.slice(0, 300)}`
    );
  }

  const data    = await response.json() as Record<string, unknown>;
  const itemId  = String(data['itemId'] ?? data['id'] ?? 'unknown');
  const publishedUrl = `https://${payload.domain}/${payload.blogPostPath}/${payload.slug}`;

  logger.info('Framer publish complete', { context, itemId, publishedUrl });

  return {
    success:      true,
    cmsReference: itemId,
    publishedUrl,
  };
}
