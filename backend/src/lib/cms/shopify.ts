/**
 * lib/cms/shopify.ts
 *
 * Shopify Blog API publisher (Admin REST API).
 * API DOCS: https://shopify.dev/docs/api/admin-rest/latest/resources/article
 *
 * AUTH: Private app — Client ID + Client Secret → access token
 *   Access token stored in credentials after first OAuth exchange.
 *   For private apps (which is what we create), the access token
 *   is available immediately from the app credentials — no OAuth dance.
 *
 * ENDPOINT: POST /admin/api/2024-01/blogs/{blogId}/articles.json
 *
 * SHOPIFY BLOG vs ARTICLE:
 *   In Shopify, a "Blog" is a channel (like a category).
 *   An "Article" is an individual post within a Blog.
 *   We create Articles under the first Blog found on the store.
 *
 * FLOW:
 *   0. GET /blogs/{blogId}/articles.json?handle=X → check if an article
 *      with this handle already exists (idempotency)
 *   1a. If found: PUT /blogs/{blogId}/articles/{articleId}.json → update
 *   1b. If not found: POST /blogs/{blogId}/articles.json → create
 *
 * IDEMPOTENCY: step 0 makes this safe to call twice for the same handle —
 * confirmed the Article resource supports "Retrieve an article with a
 * specific handle" directly via the handle query param on the list
 * endpoint (shopify.dev Article resource docs).
 *
 * NOTE: seoSchema is injected directly into body_html (same pattern as
 * the other raw-HTML publishers, see lib/cms/shared.ts) because it's
 * rendered on the storefront unconditionally. The `seo.schema_json`
 * metafield below is kept as well for any theme that's been customized
 * to read it separately, but body_html is what actually guarantees the
 * schema reaches the live page on a default theme.
 */

import { logger } from '@/open-tele';
import type { ShopifyCredentials, BlogPublishPayload, PublishResult } from './types';
import { injectSchema } from './shared';

const SHOPIFY_API_VERSION = '2024-01';
const FETCH_TIMEOUT_MS    = 30_000;

function buildShopifyBase(storeName: string): string {
  return `https://${storeName}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}`;
}

async function shopifyFetch(
  storeName:   string,
  accessToken: string,
  path:        string,
  method:      string,
  body?:       unknown,
  context?:    string,
): Promise<Record<string, unknown>> {
  const url = `${buildShopifyBase(storeName)}${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type':           'application/json',
    },
    body:   body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Shopify API error: HTTP ${response.status} on ${method} ${url}. ` +
      `Context: ${context ?? 'unknown'}. Body: ${text.slice(0, 300)}`
    );
  }

  return response.json() as Promise<Record<string, unknown>>;
}

/**
 * Fetches the first Blog ID from the Shopify store.
 * Shopify requires an existing Blog to post Articles under.
 * Most stores have at least one Blog ("News", "Journal", etc.).
 */
async function getFirstBlogId(
  storeName:   string,
  accessToken: string,
  context:     string,
): Promise<number> {
  const data  = await shopifyFetch(storeName, accessToken, '/blogs.json', 'GET', undefined, context);
  const blogs = data['blogs'] as Array<Record<string, unknown>> | undefined;

  if (!blogs || blogs.length === 0) {
    throw new Error(
      `No Shopify blogs found on store ${storeName}. ` +
      `Create at least one Blog in Shopify admin before publishing. Context: ${context}`
    );
  }

  const blogId = blogs[0]!['id'] as number;
  logger.debug('Shopify blog ID fetched', { context, blogId, blogTitle: String(blogs[0]!['title'] ?? '') });
  return blogId;
}

/** Checks whether an article with this handle already exists in the blog.
 *  Returns its numeric article ID, or null if none found. */
async function findArticleByHandle(
  storeName:   string,
  accessToken: string,
  blogId:      number,
  handle:      string,
  context:     string,
): Promise<number | null> {
  const data = await shopifyFetch(
    storeName, accessToken,
    `/blogs/${blogId}/articles.json?handle=${encodeURIComponent(handle)}`,
    'GET', undefined, context,
  );
  const articles = data['articles'] as Array<Record<string, unknown>> | undefined;
  const existing  = articles?.[0];
  if (!existing) return null;
  return existing['id'] as number;
}

export async function publishToShopify(
  creds:   ShopifyCredentials,
  payload: BlogPublishPayload,
  context: string,
): Promise<PublishResult> {
  logger.info('Publishing to Shopify', {
    context,
    storeName: creds.storeName,
    slug:      payload.slug,
    title:     payload.title,
  });

  // Use access token — for private apps this is the client secret
  const accessToken = creds.accessToken;

  // 1. Get the first blog ID
  const blogId = await getFirstBlogId(creds.storeName, accessToken, context);

  const articleFields = {
    title:            payload.title,
    body_html:        injectSchema(payload.content, payload.seoSchema),
    summary_html:     payload.description,
    handle:           payload.slug,
    published:        true,
    image: payload.heroImageUrl
      ? { src: payload.heroImageUrl, alt: payload.title }
      : undefined,
    metafields: payload.seoSchema
      ? [
          {
            key:       'schema_json',
            value:     JSON.stringify(payload.seoSchema),
            type:      'json',
            namespace: 'seo',
          },
        ]
      : [],
  };

  // 2. Idempotency check — reuse an existing article with this handle
  //    instead of creating a duplicate (see file header comment for why)
  const existingArticleId = await findArticleByHandle(creds.storeName, accessToken, blogId, payload.slug, context);

  let articleId: string;
  if (existingArticleId) {
    logger.info('Existing Shopify article found for handle — updating instead of creating', {
      context, articleId: existingArticleId, handle: payload.slug,
    });
    const data = await shopifyFetch(
      creds.storeName, accessToken,
      `/blogs/${blogId}/articles/${existingArticleId}.json`,
      'PUT',
      { article: articleFields },
      context,
    );
    const article = data['article'] as Record<string, unknown>;
    articleId = String(article['id'] ?? existingArticleId);
  } else {
    const data = await shopifyFetch(
      creds.storeName, accessToken,
      `/blogs/${blogId}/articles.json`,
      'POST',
      { article: articleFields },
      context,
    );
    const article = data['article'] as Record<string, unknown>;
    articleId = String(article['id'] ?? '');
  }

  const publishedUrl = `https://${payload.domain}/${payload.blogPostPath}/${payload.slug}`;

  logger.info('Shopify publish complete', { context, articleId, publishedUrl });

  return {
    success:      true,
    cmsReference: articleId,
    publishedUrl,
  };
}
