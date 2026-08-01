/**
 * lib/hero-image-pool.ts
 *
 * WHAT: Claims one image from a project's uploaded hero-image pool
 * (models/ProjectImage.ts) for a specific blog.
 *
 * WHY THIS EXISTS: hero image resolution now has a fixed two-step order —
 * the project's own uploaded images first, Unsplash only as a fallback
 * once the pool is empty. That order needs to be identical across all
 * three places a blog gets published (workers/jobs/cms-publish.job.ts,
 * workers/jobs/content-generation.job.ts, services/blog.service.ts), so
 * the claim step lives here once instead of being reimplemented per call
 * site — the same drift that happened with the old inline CMS-push logic
 * (see blog-cms-publisher.ts's header) is exactly what this avoids.
 *
 * ATOMICITY: claiming is a single findOneAndUpdate (available → used, in
 * upload order), which Mongo does atomically per document. Two blogs
 * generating/publishing at the same moment can't claim the same image.
 */

import { ProjectImage } from '@/models/ProjectImage';
import { logger } from '@/open-tele';

/**
 * Claims the oldest 'available' image in the project's pool for this blog,
 * marking it 'used' and returning its URL. Returns null if the pool has no
 * unclaimed image left — callers should fall back to Unsplash in that case.
 */
export async function claimPoolImage(projectId: string, blogId: string): Promise<string | null> {
  try {
    const claimed = await ProjectImage.findOneAndUpdate(
      { projectId, status: 'available' },
      { $set: { status: 'used', usedByBlogId: blogId, usedAt: new Date() } },
      { sort: { createdAt: 1 }, new: true },
    );

    if (!claimed) return null;

    logger.info('Claimed pool image for blog hero', { projectId, blogId, imageId: String(claimed._id) });
    return claimed.url;
  } catch (err) {
    // Non-fatal — same posture as fetchHeroImageUrl: a pool problem
    // shouldn't block publishing, just fall through to Unsplash.
    logger.error(err instanceof Error ? err : new Error(String(err)), {
      context: 'claimPoolImage', projectId, blogId,
    });
    return null;
  }
}
