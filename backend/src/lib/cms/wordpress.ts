/**
 * lib/cms/wordpress.ts
 *
 * WordPress REST API publisher.
 * Used for: wordpress, squarespace (bridge WP install on our infrastructure)
 *
 * API DOCS: https://developer.wordpress.org/rest-api/reference/posts/
 *
 * AUTH: Application Passwords (WP 5.6+)
 *   Authorization: Basic base64(username:applicationPassword)
 *
 * FLOW:
 *   1. POST /wp-json/wp/v2/posts → create draft
 *   2. If heroImageUrl → upload to WP media library → set featured_media
 *   3. PATCH post → status: publish
 *
 * WHY TWO STEPS (draft then publish):
 *   Creating as draft first lets us attach the featured image before publishing.
 *   Publishing in one step without featured image = post goes live without hero.
 *
 * SQUARESPACE NOTE:
 *   When cmsType is 'squarespace', siteUrl points to our bridge WP install,
 *   not the user's site. Everything else is identical.
 *   publishedUrl is built from the user's domain (not the bridge URL)
 *   because that's where the XML import will land.
 */

import { logger } from '@/open-tele';
import type { WordPressCredentials, BlogPublishPayload, PublishResult } from './types';

const FETCH_TIMEOUT_MS = 30_000;

// ── Auth header ────────────────────────────────────────────────────────────

function buildAuthHeader(creds: WordPressCredentials): string {
  return 'Basic ' + Buffer.from(`${creds.username}:${creds.applicationPassword}`).toString('base64');
}

// ── WP API fetch ───────────────────────────────────────────────────────────

async function wpFetch(
  siteUrl:  string,
  path:     string,
  method:   string,
  auth:     string,
  body?:    unknown,
  context?: string,
): Promise<Record<string, unknown>> {
  const url = `${siteUrl.replace(/\/$/, '')}/wp-json/wp/v2${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': auth,
      'Content-Type':  'application/json',
    },
    body:   body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `WordPress API error: HTTP ${response.status} on ${method} ${url}. ` +
      `Context: ${context ?? 'unknown'}. Body: ${text.slice(0, 300)}`
    );
  }

  return response.json() as Promise<Record<string, unknown>>;
}

// ── Featured image upload ──────────────────────────────────────────────────

/**
 * Uploads a hero image to the WordPress media library.
 * Returns the WP media ID, or null if upload fails (non-fatal).
 *
 * WHY NON-FATAL: A blog post without a featured image is better than
 * a failed publish. Hero image is nice-to-have, not required for SEO.
 */
async function uploadFeaturedImage(
  siteUrl:      string,
  auth:         string,
  heroImageUrl: string,
  title:        string,
  context:      string,
): Promise<number | null> {
  try {
    // Fetch the image from Cloudinary/Unsplash
    const imgResponse = await fetch(heroImageUrl, {
      signal: AbortSignal.timeout(15_000),
    });

    if (!imgResponse.ok) {
      logger.warn('Hero image fetch failed — publishing without featured image', {
        context,
        heroImageUrl,
        status: imgResponse.status,
      });
      return null;
    }

    const imgBuffer  = await imgResponse.arrayBuffer();
    const imgBytes   = new Uint8Array(imgBuffer);
    const contentType = imgResponse.headers.get('content-type') ?? 'image/jpeg';
    const filename   = `${title.toLowerCase().replace(/\s+/g, '-').slice(0, 50)}.avif`;

    // Upload to WP media library
    const uploadUrl = `${siteUrl.replace(/\/$/, '')}/wp-json/wp/v2/media`;
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization':       auth,
        'Content-Type':        contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
      body:   imgBytes,
      signal: AbortSignal.timeout(30_000),
    });

    if (!uploadResponse.ok) {
      logger.warn('Hero image upload to WordPress failed — publishing without featured image', {
        context,
        status: uploadResponse.status,
      });
      return null;
    }

    const media = await uploadResponse.json() as Record<string, unknown>;
    const mediaId = media['id'] as number | undefined;

    logger.debug('Hero image uploaded to WordPress media library', {
      context,
      mediaId,
      filename,
    });

    return mediaId ?? null;

  } catch (err) {
    // Non-fatal — log and continue without featured image
    logger.warn('Hero image upload threw — publishing without featured image', {
      context,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Schema injection ───────────────────────────────────────────────────────

/**
 * Injects Schema.org JSON-LD into the blog HTML content.
 * Appended at the end — doesn't affect visual rendering.
 */
function injectSchema(content: string, schema: Record<string, unknown> | undefined): string {
  if (!schema) return content;
  const scriptTag = `\n<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`;
  return content + scriptTag;
}

// ── Main publisher ─────────────────────────────────────────────────────────

export async function publishToWordPress(
  creds:   WordPressCredentials,
  payload: BlogPublishPayload,
  context: string,
): Promise<PublishResult> {
  const auth = buildAuthHeader(creds);

  logger.info('Publishing to WordPress', {
    context,
    siteUrl: creds.siteUrl,
    slug:    payload.slug,
    title:   payload.title,
  });

  // 1. Inject schema into content
  const fullContent = injectSchema(payload.content, payload.seoSchema);

  // 2. Create post as draft first
  const draftPost = await wpFetch(
    creds.siteUrl,
    '/posts',
    'POST',
    auth,
    {
      title:   payload.title,
      slug:    payload.slug,
      content: fullContent,
      excerpt: payload.description,
      status:  'draft',
      meta: {
        description: payload.description,
      },
    },
    context,
  );

  const postId = draftPost['id'] as number;

  logger.debug('WordPress draft created', { context, postId, slug: payload.slug });

  // 3. Upload featured image (non-fatal if fails)
  let featuredMediaId: number | null = null;
  if (payload.heroImageUrl) {
    featuredMediaId = await uploadFeaturedImage(
      creds.siteUrl,
      auth,
      payload.heroImageUrl,
      payload.title,
      context,
    );
  }

  // 4. Publish the post (update status to publish + attach featured image)
  const updateBody: Record<string, unknown> = { status: 'publish' };
  if (featuredMediaId) {
    updateBody['featured_media'] = featuredMediaId;
  }

  await wpFetch(
    creds.siteUrl,
    `/posts/${postId}`,
    'POST', // WordPress uses POST for updates too
    auth,
    updateBody,
    context,
  );

  // 5. Build published URL
  // For squarespace: domain is the user's domain (not our bridge URL)
  const publishedUrl = `https://${payload.domain}/${payload.blogPostPath}/${payload.slug}`;

  logger.info('WordPress publish complete', {
    context,
    postId,
    publishedUrl,
    hasFeaturedImage: !!featuredMediaId,
  });

  return {
    success:      true,
    cmsReference: String(postId),
    publishedUrl,
  };
}
