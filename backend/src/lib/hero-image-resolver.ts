/**
 * lib/hero-image-resolver.ts
 *
 * WHAT: Single source of truth for hero image resolution, used by every
 * place a blog gets published — workers/jobs/cms-publish.job.ts,
 * workers/jobs/content-generation.job.ts's handlePublish, and
 * services/blog.service.ts's publishBlog. Introduced when a third tier
 * (text-card generation) was added, specifically to avoid the drift that
 * happened before: the pool→Unsplash order used to be hand-copied into
 * each of those three files (see blog-cms-publisher.ts's header for the
 * identical drift that happened with the CMS-push logic itself) — adding
 * a third tier to three separate copies is exactly how that drift
 * happens again, so it's consolidated here once instead.
 *
 * RESOLUTION ORDER:
 *   1. The blog's existing heroImageUrl, if already set (user upload via
 *      the editor, or a prior resolution — never overwritten).
 *   2. Claim one image from the project's uploaded pool (primary
 *      automatic source — see lib/hero-image-pool.ts).
 *   3. Project.heroImageFallbackMode:
 *        'text_card' → generate an on-brand image from the title
 *                       (lib/text-card-image.ts)
 *        'unsplash' (default) → fetch a relevant stock photo
 *                       (lib/unsplash.ts)
 *   4. If step 3's chosen method fails, try the OTHER fallback method as
 *      a last resort — a transient Unsplash outage or a text-card render
 *      bug shouldn't leave a blog with no image when a working
 *      alternative exists.
 *   5. null — publish continues without a hero image (existing, accepted
 *      behavior; every consumer already treats this as non-fatal).
 */

import { claimPoolImage } from './hero-image-pool';
import { fetchHeroImageUrl } from './unsplash';
import { generateTextCardImage } from './text-card-image';
import { logger } from '@/open-tele';

export interface ResolveHeroImageInput {
  projectId:             string;
  blogId:                string;
  blogTitle:             string;
  existingHeroImageUrl?: string | null;
  brandColor?:           string;
  fallbackMode?:         'unsplash' | 'text_card'; // Project.heroImageFallbackMode; defaults to 'unsplash'
  context:               string; // logging context, e.g. "cms-publish:projectId:blogId"
}

export async function resolveHeroImage(input: ResolveHeroImageInput): Promise<string | null> {
  const { projectId, blogId, existingHeroImageUrl, brandColor, context } = input;
  const fallbackMode = input.fallbackMode ?? 'unsplash';
  const title = input.blogTitle || 'business technology';

  // 1. Already set — never touch it.
  if (existingHeroImageUrl) return existingHeroImageUrl;

  // 2. Project's uploaded pool — the primary automatic source.
  const pooled = await claimPoolImage(projectId, blogId);
  if (pooled) return pooled;

  // 3 + 4. Chosen fallback, with the other fallback as a last resort.
  if (fallbackMode === 'text_card') {
    const card = await generateTextCardImage(title, brandColor, projectId);
    if (card) return card;

    logger.warn('Text-card generation failed — trying Unsplash as last resort', { context, projectId, blogId });
    return fetchHeroImageUrl(title, context);
  }

  const unsplash = await fetchHeroImageUrl(title, context);
  if (unsplash) return unsplash;

  logger.warn('Unsplash had no results — trying text-card as last resort', { context, projectId, blogId });
  return generateTextCardImage(title, brandColor, projectId);
}
