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
 *   0.5 POST /ricos/v1/ricos-document/convert/to-ricos → convert the HTML
 *       content (with JSON-LD schema already appended) into a real Ricos
 *       document, since Wix's post content field expects Ricos JSON, not
 *       raw HTML — see CONTENT FORMAT note below.
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
 * CONTENT FORMAT — the real fix, not just a caveat anymore:
 *   Confirmed via Wix's own docs and multiple developer forum threads:
 *   Wix's blog post content field expects a "Ricos Document" — a
 *   structured JSON node tree (paragraphs/headings/text nodes with
 *   decorations), NOT an HTML string. Sending raw HTML in `contentText`
 *   was very likely wrong (this is exactly the problem multiple other
 *   developers hit trying to integrate with this API — several forum
 *   threads exist about it).
 *
 *   Fix: call Wix's own "Convert To Ricos Document" endpoint
 *   (POST /ricos/v1/ricos-document/convert/to-ricos, confirmed to exist
 *   and documented as accepting HTML/Markdown/plain text input) to do the
 *   HTML→Ricos conversion server-side, rather than hand-writing an
 *   HTML→Ricos parser — Ricos' node structure is non-trivial (nested
 *   paragraph/text/decoration nodes with strict validation) and getting it
 *   wrong produces confusing parse errors, per the same forum threads.
 *
 *   HONEST CONFIDENCE LEVEL: the endpoint's existence and purpose are
 *   confirmed from Wix's official docs. The exact request/response body
 *   field names were NOT confirmable — Wix's interactive API reference
 *   renders the schema client-side in a way that wasn't extractable.
 *   convertToRicosDocument() below uses a best-effort body shape based on
 *   Wix's general REST conventions elsewhere in this same API family, with
 *   a safe fallback (a minimal, manually-built single-paragraph Ricos
 *   document, using the node structure that IS confirmed from Wix's docs)
 *   if the conversion call fails for any reason — so a wrong guess here
 *   degrades to "plain text paragraph" rather than breaking the publish
 *   entirely. This whole path needs a real live test before being trusted
 *   in production — see docs/11-cms-integrations-audit.md.
 *
 *   Also requires the "Manage Ricos Document" permission to be enabled on
 *   the Wix API key/app used — worth checking that's granted.
 */

import { logger } from '@/open-tele';
import type { WixCredentials, BlogPublishPayload, PublishResult } from './types';
import { injectSchema } from './shared';

const WIX_RICOS_API_BASE = 'https://www.wixapis.com/ricos/v1';

/**
 * Converts HTML content to a Ricos document via Wix's own conversion API.
 * Falls back to a minimal manually-built Ricos document (a single
 * paragraph containing the HTML stripped to plain text) if the API call
 * fails — see file header for why this fallback exists and how confident
 * this implementation actually is.
 */
async function convertToRicosDocument(
  html:    string,
  apiKey:  string,
  siteId:  string,
  context: string,
): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`${WIX_RICOS_API_BASE}/ricos-document/convert/to-ricos`, {
      method:  'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type':  'application/json',
        'wix-site-id':   siteId,
      },
      // Best-effort body shape — see file header "HONEST CONFIDENCE LEVEL"
      body: JSON.stringify({
        content:    html,
        fromFormat: 'HTML',
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json() as { ricosDocument?: Record<string, unknown> };
    if (!data.ricosDocument) {
      throw new Error('No ricosDocument in response');
    }

    return data.ricosDocument;

  } catch (err) {
    logger.warn('Wix Ricos conversion failed — falling back to plain-text paragraph', {
      context, error: err instanceof Error ? err.message : String(err),
    });

    // Fallback: minimal valid Ricos document, one paragraph, plain text
    // (HTML tags stripped) — confirmed node structure from Wix's own docs.
    const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      nodes: [
        {
          type: 'PARAGRAPH',
          nodes: [
            { type: 'TEXT', textData: { text: plainText, decorations: [] } },
          ],
          paragraphData: {},
        },
      ],
    };
  }
}

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

  const fullHtml = injectSchema(payload.content, payload.seoSchema);
  const ricosDocument = await convertToRicosDocument(fullHtml, creds.apiKey, creds.siteId, context);

  const postFields = {
    title:               payload.title,
    richContent:         ricosDocument,
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
