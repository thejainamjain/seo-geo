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
 *               publishedDate, publishedContent)
 *         Keyword (status → 'published')
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

import { logger }      from '@/open-tele';
import { Project }     from '@/models/Project';
import { Blog }        from '@/models/Blog';
import { Keyword }     from '@/models/Keyword';
import { CmsConfig }   from '@/models/CmsConfig';
import { publishBlog } from '@/lib/cms';
import type { BlogPublishPayload } from '@/lib/cms';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CmsPublishJobData {
  projectId: string;
}

// ── Time check ─────────────────────────────────────────────────────────────

function isNowAllowedPublishTime(allowedDays: number[], publishHourUtc: number): boolean {
  const now      = new Date();
  const todayUtc = now.getUTCDay();
  const hourUtc  = now.getUTCHours();
  return allowedDays.includes(todayUtc) && hourUtc >= publishHourUtc;
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

  // 6. Load all ready blogs
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

    const payload: BlogPublishPayload = {
      blogId,
      title:        blog.title,
      slug:         blog.slug,
      description:  blog.description ?? '',
      content:      blog.content     ?? '',
      heroImageUrl: blog.heroImageUrl,
      seoSchema:    blog.seoSchema as Record<string, unknown> | undefined,
      blogPostPath: cmsConfig.blogPostPath,
      domain:       project.domain,
    };

    try {
      const result = await publishBlog(cmsConfig, payload, projectId);

      if (!result.success) {
        throw new Error(result.error ?? 'Publisher returned success:false');
      }

      const now = new Date();

      await Blog.findByIdAndUpdate(blogId, {
        $set: {
          status:           'published',
          cmsReference:     result.cmsReference,
          publishedUrl:     result.publishedUrl,
          publishedDate:    now,
          publishedContent: blog.content ?? '',
        },
        $push: {
          history: {
            $each:  [{ content: blog.content ?? '', status: 'published', writer: 'system', createdAt: now }],
            $slice: -50,
          },
        },
      });

      // Update keyword status if linked
      if (blog.keywordId) {
        await Keyword.findByIdAndUpdate(blog.keywordId, {
          $set: { status: 'published' },
        });
      }

      successCount++;

      logger.info('Blog published via cron', {
        context,
        blogId,
        title:        blog.title,
        publishedUrl: result.publishedUrl,
        cmsType:      cmsConfig.cmsType,
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
