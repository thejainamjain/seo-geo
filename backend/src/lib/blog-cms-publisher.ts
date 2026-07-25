/**
 * lib/blog-cms-publisher.ts
 *
 * WHAT: The single shared "push a blog to its connected CMS, then persist
 *       the result" sequence. Consolidates what used to be three
 *       independent, near-identical implementations:
 *         - services/blog.service.ts's publishBlog() (manual Publish button)
 *         - workers/jobs/content-generation.job.ts's handlePublish()
 *           (auto-publish right after generation)
 *         - workers/jobs/cms-publish.job.ts (cron bulk-publish sweep)
 *
 * WHY THIS EXISTS: see docs/11-cms-integrations-audit.md — those three
 * call sites had drifted into duplicated logic, and none of them guarded
 * against calling the CMS API twice for the same blog on a retry, which
 * could create duplicate posts on the CMS side (most CMS APIs auto-suffix
 * a colliding slug rather than reject it, so this failed silently).
 *
 * THE GUARD: if a Blog document already has `cmsReference` set, this
 * function skips the CMS API call entirely and returns the existing
 * result. This protects against:
 *   - A manual "Publish" click retried after an apparent failure (e.g. the
 *     HTTP response was lost even though the CMS-side post was created)
 *   - A BullMQ job retry where an earlier attempt's persist step ran but
 *     the job then failed on a later step (e.g. the Keyword status update)
 *   - Any future code path that queries for "unpublished" blogs by a
 *     field other than cmsReference and might disagree with it
 *
 * WHAT THIS DOES NOT FIX (documented limitation, not silently ignored):
 * the genuinely unfixable-without-a-bigger-pattern gap is a crash that
 * happens AFTER the CMS API call succeeds but BEFORE this function's own
 * DB write persists cmsReference — in that exact narrow window, the CMS
 * post exists but our guard has nothing to check against yet, so a retry
 * would still create a duplicate. Closing that fully would need a
 * two-phase/outbox pattern (write "attempting" before the call, confirm
 * after) — a bigger architectural change than what this fix scope covers.
 * Combined with the per-platform upsert-by-slug fixes (see
 * lib/cms/*.ts), that remaining window is now handled a different way for
 * platforms that support it: even a duplicate CMS-side call becomes a safe
 * update-in-place rather than a true duplicate post.
 */

import { Blog }   from '@/models/Blog';
import { Keyword } from '@/models/Keyword';
import { logger } from '@/open-tele';
import { publishBlog as cmsPushBlog, type BlogPublishPayload, type CmsConfigForPublish } from '@/lib/cms';

/**
 * True if right now falls within a project's configured publish window
 * (allowed day-of-week + hour, both UTC).
 *
 * Previously duplicated verbatim in both cms-publish.job.ts and
 * content-generation.job.ts — extracted here since both already import
 * from this module, and a timing check like this drifting out of sync
 * between the two publish paths would be an easy, quiet bug to introduce
 * later. See docs/00-master-summary.md.
 */
export function isNowAllowedPublishTime(allowedDays: number[], publishHourUtc: number): boolean {
  const now      = new Date();
  const todayUtc = now.getUTCDay();
  const hourUtc  = now.getUTCHours();
  return allowedDays.includes(todayUtc) && hourUtc >= publishHourUtc;
}

export interface PublishBlogToCmsOptions {
  blogId:        string;
  projectId:     string;
  domain:        string;
  cmsConfig:     CmsConfigForPublish;
  /** If provided, overrides the blog's stored heroImageUrl (used by
   *  cms-publish.job.ts, which resolves a hero image via Unsplash search
   *  before publishing if none is set yet). Omit to use the blog's
   *  existing heroImageUrl as-is. */
  resolvedHeroImageUrl?: string | null;
}

export interface PublishBlogToCmsResult {
  success:       boolean;
  skipped?:      boolean; // true if the idempotency guard caught an already-published blog
  publishedUrl?: string;
  cmsReference?: string;
  error?:        string;
}

export async function publishBlogToCms(opts: PublishBlogToCmsOptions): Promise<PublishBlogToCmsResult> {
  const { blogId, projectId, domain, cmsConfig } = opts;
  const context = `blog-cms-publisher:${projectId}:${blogId}`;

  const blog = await Blog.findById(blogId);
  if (!blog) {
    return { success: false, error: 'Blog not found' };
  }

  // ── Idempotency guard ─────────────────────────────────────────────────
  if (blog.cmsReference) {
    logger.info('Blog already has a cmsReference — skipping duplicate publish', {
      context, blogId, cmsReference: blog.cmsReference, publishedUrl: blog.publishedUrl,
    });
    return {
      success:      true,
      skipped:      true,
      publishedUrl: blog.publishedUrl,
      cmsReference: blog.cmsReference,
    };
  }

  const heroImageUrl = opts.resolvedHeroImageUrl !== undefined
    ? opts.resolvedHeroImageUrl
    : blog.heroImageUrl;

  const payload: BlogPublishPayload = {
    blogId,
    title:        blog.title,
    slug:         blog.slug,
    description:  blog.description ?? '',
    content:      blog.content     ?? '',
    heroImageUrl: heroImageUrl ?? undefined,
    seoSchema:    blog.seoSchema as Record<string, unknown> | undefined,
    blogPostPath: cmsConfig.blogPostPath,
    domain,
  };

  const result = await cmsPushBlog(cmsConfig, payload, projectId);

  if (!result.success) {
    return { success: false, error: result.error ?? 'CMS publish returned success:false' };
  }

  const now = new Date();

  await Blog.findByIdAndUpdate(blogId, {
    $set: {
      status:           'published',
      cmsReference:     result.cmsReference,
      publishedUrl:     result.publishedUrl,
      publishedDate:    now,
      publishedContent: blog.content ?? '',
      ...(opts.resolvedHeroImageUrl !== undefined ? { heroImageUrl: opts.resolvedHeroImageUrl } : {}),
    },
    $push: {
      history: {
        $each:  [{ content: blog.content ?? '', status: 'published', writer: 'system', createdAt: now }],
        $slice: -50,
      },
    },
  });

  if (blog.keywordId) {
    await Keyword.findByIdAndUpdate(blog.keywordId, { $set: { status: 'published' } });
  }

  logger.info('Blog published to CMS', {
    context, blogId, cmsType: cmsConfig.cmsType, publishedUrl: result.publishedUrl,
  });

  return { success: true, publishedUrl: result.publishedUrl, cmsReference: result.cmsReference };
}
