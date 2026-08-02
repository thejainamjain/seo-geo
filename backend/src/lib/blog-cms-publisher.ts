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
import { stripLegacyHeroImagePlaceholder } from '@/lib/blog-content';
import { applyDefaultBlogTheme } from '@/lib/blog-theme';

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
  /** Project.brandColor — passed through to applyDefaultBlogTheme when
   *  useDefaultBlogTheme is true. Ignored otherwise. */
  brandColor?: string;
  /** Project.useDefaultBlogTheme — when true, lib/blog-theme.ts's scoped
   *  typography <style> block is injected into content before it's sent
   *  to the CMS. See "CONTENT THEMING" note below for why this changes
   *  what publishedContent stores but not what `history` stores. */
  useDefaultBlogTheme?: boolean;
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

  // Same self-heal as blogService.getBlog — see lib/blog-content.ts. Applied
  // here too (not just on read) so a blog that gets auto-published without
  // ever being opened in the editor doesn't ship a broken placeholder to
  // the CMS. Not persisted here — getBlog already persists the cleanup on
  // first read, this is just a defensive belt-and-suspenders pass on the
  // exact string being sent out.
  const { content: cleanContent, changed: hadLegacyPlaceholder } =
    stripLegacyHeroImagePlaceholder(blog.content ?? '');
  if (hadLegacyPlaceholder) {
    logger.info('Stripped legacy hero-image placeholder before CMS publish', { context, blogId });
  }

  // CONTENT THEMING: `cmsContent` (what actually gets sent to the CMS, and
  // what publishedContent below records) gets the theme wrapper.
  // `cleanContent` — un-themed — is what goes into `history`, so a later
  // "revert to this version" in the editor never restores theme-wrapper
  // HTML into an editable draft. The theme is a publish-time presentation
  // layer, not part of the content itself.
  const cmsContent = opts.useDefaultBlogTheme
    ? applyDefaultBlogTheme(cleanContent, opts.brandColor)
    : cleanContent;

  const payload: BlogPublishPayload = {
    blogId,
    title:        blog.title,
    slug:         blog.slug,
    description:  blog.description ?? '',
    content:      cmsContent,
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
      publishedContent: cmsContent,
      ...(opts.resolvedHeroImageUrl !== undefined ? { heroImageUrl: opts.resolvedHeroImageUrl } : {}),
    },
    $push: {
      history: {
        $each:  [{ content: cleanContent, status: 'published', writer: 'system', createdAt: now }],
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

export interface UpdateBlogOnCmsResult {
  success:        boolean;
  skippedReason?: string; // set when re-sync wasn't even attempted (see below)
  publishedUrl?:  string;
  error?:         string;
}

/**
 * Platforms with a confirmed safe update-by-slug path (see
 * docs/11-cms-integrations-audit.md) — everything except Framer, whose
 * webhook has no dedup at all, so calling it again for the same blog would
 * create a genuine duplicate live item rather than updating one. Custom
 * API is attempted rather than skipped — its schema isn't ours to
 * guarantee, but the outbound payload already includes a stable `blogId`
 * a well-built receiving endpoint can use to dedupe/update on its own
 * side (see lib/cms/custom-api.ts) — attempting it is no worse than a
 * normal publish call, unlike Framer where it's actively harmful.
 */
const CMS_TYPES_WITHOUT_SAFE_UPDATE = new Set(['framer']);

/**
 * Pushes a blog's CURRENT content to the CMS for a blog that's ALREADY
 * published (has a `cmsReference`) and whose content has legitimately
 * changed since — e.g. an auto-applied tag optimization
 * (workers/jobs/blog-optimization.job.ts) or an approved content rewrite
 * (services/optimization.service.ts). Both call this to actually clear
 * the `cmsResyncPending` flag they set, instead of only logging that a
 * resync is needed.
 *
 * DELIBERATELY A SEPARATE FUNCTION FROM publishBlogToCms(), not a
 * `forceUpdate` flag on it: publishBlogToCms()'s guard exists specifically
 * to stop re-publishing UNCHANGED content on a retry (see that function's
 * doc comment). This function exists for the opposite situation — content
 * HAS changed and a push is exactly what's wanted. Keeping them separate
 * keeps each function's contract unambiguous at the call site rather than
 * relying on every caller remembering to pass the right flag.
 */
export async function updateBlogOnCms(
  blogId:    string,
  projectId: string,
  domain:    string,
  cmsConfig: CmsConfigForPublish,
  brandColor?: string,
  useDefaultBlogTheme?: boolean,
): Promise<UpdateBlogOnCmsResult> {
  const context = `blog-cms-updater:${projectId}:${blogId}`;

  if (cmsConfig.cmsType && CMS_TYPES_WITHOUT_SAFE_UPDATE.has(cmsConfig.cmsType)) {
    logger.warn('CMS re-sync skipped — no safe update path for this platform yet', {
      context, cmsType: cmsConfig.cmsType,
    });
    return {
      success:       false,
      skippedReason: `No safe update-by-slug path for '${cmsConfig.cmsType}' yet — see docs/11-cms-integrations-audit.md`,
    };
  }

  const blog = await Blog.findById(blogId);
  if (!blog) {
    return { success: false, error: 'Blog not found' };
  }

  if (!blog.cmsReference) {
    // Not actually published yet — nothing to re-sync. The caller should
    // be using publishBlogToCms() for a first-time publish instead.
    return { success: false, error: 'Blog has no cmsReference — nothing to update, use publishBlogToCms() instead' };
  }

  // Same theming as publishBlogToCms — see that function's CONTENT
  // THEMING note. A resync needs to reapply the theme too, or an
  // approved-rewrite resync would silently strip it from an
  // already-themed live post.
  const cmsContent = useDefaultBlogTheme
    ? applyDefaultBlogTheme(blog.content ?? '', brandColor)
    : (blog.content ?? '');

  const payload: BlogPublishPayload = {
    blogId,
    title:        blog.title,
    slug:         blog.slug,
    description:  blog.description ?? '',
    content:      cmsContent,
    heroImageUrl: blog.heroImageUrl ?? undefined,
    seoSchema:    blog.seoSchema as Record<string, unknown> | undefined,
    blogPostPath: cmsConfig.blogPostPath,
    domain,
  };

  const result = await cmsPushBlog(cmsConfig, payload, projectId);

  if (!result.success) {
    logger.warn('CMS re-sync failed', { context, cmsType: cmsConfig.cmsType, error: result.error });
    return { success: false, error: result.error ?? 'CMS update returned success:false' };
  }

  // Slug is unchanged by a resync, so cmsReference/publishedUrl should
  // already match what's stored — but persist whatever the platform
  // actually returned in case it legitimately differs (e.g. a platform
  // reassigns an internal ID on update).
  await Blog.findByIdAndUpdate(blogId, {
    $set: {
      cmsReference:      result.cmsReference ?? blog.cmsReference,
      publishedUrl:      result.publishedUrl ?? blog.publishedUrl,
      publishedContent:  cmsContent,
    },
  });

  logger.info('CMS re-sync completed', {
    context, cmsType: cmsConfig.cmsType, publishedUrl: result.publishedUrl ?? blog.publishedUrl,
  });

  return { success: true, publishedUrl: result.publishedUrl ?? blog.publishedUrl ?? undefined };
}
