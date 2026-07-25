/**
 * workers/jobs/cms-publish.job.ts
 *
 * WHAT: Cron job that publishes all ready blog posts to the connected CMS.
 *       Runs on a repeatable schedule (Mon–Sat at publishHourUtc).
 *       NOT a pipeline step — registered as a BullMQ repeatable job per project
 *       when KEYWORD_RESEARCH completes, and whenever CMS is connected.
 *
 * TRIGGERED BY:
 *   - Automatically after KEYWORD_RESEARCH pipeline step completes
 *   - BullMQ repeat schedule: daily at publishHourUtc UTC
 *
 * READS:  Blog (status: 'ready', for this project)
 *         CmsConfig (cmsType + encryptedCredentials + schedule)
 *         Project (domain)
 * WRITES: Blog (status → 'published', cmsReference, publishedUrl,
 *               publishedDate, publishedContent, heroImageUrl)
 *         Keyword (status → 'published')
 *
 * HERO IMAGE FLOW:
 *   1. fetchHeroImageUrl(keyword) → Unsplash CDN URL (or null if fetch fails)
 *   2. URL is passed as heroImageUrl in BlogPublishPayload
 *   3. Each CMS publisher handles upload/attachment in its own way:
 *      - WordPress: uploads to media library → sets featured_media
 *      - Others: embeds URL directly in content or CMS fields
 *   Hero image failure is non-fatal — publish continues without it.
 *
 * DAY + HOUR CHECK:
 *   Publishing only runs on allowedPublishDays at or after publishHourUtc.
 *   If conditions not met → logs and exits cleanly (job still marked complete).
 *
 * PARTIAL FAILURE:
 *   Per-blog failures are logged and skipped — partial publish is better than none.
 *   If ALL blogs fail → throws → BullMQ retries.
 *
 * IDEMPOTENCY:
 *   Only processes status: 'ready' blogs. Already published blogs are skipped.
 *   Safe to retry.
 */

import { logger }             from '@/open-tele';
import { Project }            from '@/models/Project';
import { Blog }               from '@/models/Blog';
import { CmsConfig }          from '@/models/CmsConfig';
import { publishBlogToCms, isNowAllowedPublishTime } from '@/lib/blog-cms-publisher';
import { fetchHeroImageUrl }  from '@/lib/unsplash';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CmsPublishJobData {
  projectId: string;
}

// ── Main job handler ───────────────────────────────────────────────────────

export async function runCmsPublishJob(data: CmsPublishJobData): Promise<void> {
  const { projectId } = data;

  logger.info('CMS publish cron job started', { projectId });

  // 1. Load project
  const project = await Project.findById(projectId).lean();
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  // 2. Load CmsConfig with credentials
  const cmsConfig = await CmsConfig.findOne({ projectId })
    .select('+encryptedCredentials')
    .lean();

  // 3. No CMS connected — exit cleanly
  if (!cmsConfig || !cmsConfig.cmsType || !cmsConfig.encryptedCredentials) {
    logger.info('No CMS connected — skipping publish cron', { projectId });
    return;
  }

  // 4. Check autoPublish flag
  if (!cmsConfig.autoPublish) {
    logger.info('Auto-publish disabled — skipping publish cron', {
      projectId,
      cmsType: cmsConfig.cmsType,
    });
    return;
  }

  // 5. Check day + hour
  const allowedDays    = cmsConfig.allowedPublishDays ?? [1, 2, 3, 4, 5, 6];
  const publishHourUtc = cmsConfig.publishHourUtc     ?? 17;

  if (!isNowAllowedPublishTime(allowedDays, publishHourUtc)) {
    logger.info('Not an allowed publish time — skipping', {
      projectId,
      todayUtc:       new Date().getUTCDay(),
      hourUtc:        new Date().getUTCHours(),
      allowedDays,
      publishHourUtc,
    });
    return;
  }

  // 6. Load all ready blogs (with their keyword for image search)
  const blogs = await Blog.find({ projectId, status: 'ready' })
    .sort({ createdAt: 1 }) // oldest first — publish in creation order
    .lean();

  if (blogs.length === 0) {
    logger.info('No ready blogs to publish', { projectId });
    return;
  }

  logger.info('Ready blogs found for publishing', {
    projectId,
    cmsType:   cmsConfig.cmsType,
    blogCount: blogs.length,
  });

  // 7. Publish each blog
  let successCount = 0;
  let failCount    = 0;

  for (const blog of blogs) {
    const blogId  = String(blog._id);
    const context = `cms-publish-cron:${projectId}:${blogId}`;

    // ── 7a. Resolve hero image ─────────────────────────────────────────────
    // Use existing heroImageUrl if already set (e.g. manually assigned),
    // otherwise fetch from Unsplash using the blog title as the search query.
    // Falls back to null — publish continues without hero image.

    let heroImageUrl: string | null = blog.heroImageUrl ?? null;

    if (!heroImageUrl) {
      // Prefer the blog title for image search — more specific than keyword string
      const imageQuery = blog.title ?? 'business technology';
      heroImageUrl = await fetchHeroImageUrl(imageQuery, context);
    }

    // ── 7b. Publish via the shared helper ────────────────────────────────
    //     (heroImageUrl resolved above stays caller-side — it's specific
    //      to this cron path's "fetch from Unsplash if unset" behavior)

    try {
      const result = await publishBlogToCms({
        blogId,
        projectId,
        domain:    project.domain,
        cmsConfig,
        resolvedHeroImageUrl: heroImageUrl,
      });

      if (!result.success) {
        throw new Error(result.error ?? 'Publisher returned success:false');
      }

      if (result.skipped) {
        logger.info('Publish skipped — blog already had a cmsReference (idempotency guard)', {
          context, blogId, cmsReference: result.cmsReference,
        });
        continue;
      }

      successCount++;

      logger.info('Blog published via cron', {
        context,
        blogId,
        title:           blog.title,
        publishedUrl:    result.publishedUrl,
        cmsType:         cmsConfig.cmsType,
        hasHeroImage:    !!heroImageUrl,
      });

    } catch (err) {
      failCount++;
      logger.error(
        err instanceof Error ? err : new Error(String(err)),
        { context, blogId, title: blog.title, cmsType: cmsConfig.cmsType },
      );
    }
  }

  logger.info('CMS publish cron job completed', {
    projectId,
    cmsType:      cmsConfig.cmsType,
    total:        blogs.length,
    successCount,
    failCount,
  });

  // If ALL failed — throw so BullMQ retries
  if (failCount === blogs.length && blogs.length > 0) {
    throw new Error(
      `All ${blogs.length} blog publish attempts failed for project ${projectId}. BullMQ will retry.`
    );
  }
}
