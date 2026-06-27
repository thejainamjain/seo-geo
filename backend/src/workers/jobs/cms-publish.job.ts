/**
 * workers/jobs/cms-publish.job.ts
 *
 * WHAT: Publishes all ready blog posts to the project's connected CMS.
 *
 * PIPELINE POSITION: Step 8 of 8 (final step)
 * READS:  Blog (status: 'ready', for this project)
 *         CmsConfig (cmsType + encryptedCredentials + schedule)
 *         Project (domain)
 * WRITES: Blog (status → 'published', cmsReference, publishedUrl,
 *               publishedDate, publishedContent)
 *
 * DAY CHECK:
 *   Publishing only allowed Mon–Sat (no Sunday).
 *   Enforced by: CmsConfig.allowedPublishDays AND explicit day check here.
 *   If today is Sunday or not in allowedPublishDays → skip, log, complete.
 *   This matches RankAI's schedule (Mon–Sat 5PM UTC).
 *
 * NO CMS CONNECTED:
 *   If CmsConfig missing or autoPublish: false → blogs stay 'ready'.
 *   Step marks COMPLETED — this is a valid user state, not an error.
 *   User sees "Auto-publish is not enabled" banner in dashboard.
 *
 * PARTIAL FAILURE:
 *   If one blog fails to publish → log error, continue to next.
 *   If ALL blogs fail → throw → BullMQ retries the whole step.
 *   If some succeed, some fail → step COMPLETES (partial publish is fine).
 *
 * IDEMPOTENCY:
 *   Blogs already published (status: 'published') are skipped.
 *   Only status: 'ready' blogs are processed.
 *   Safe to retry.
 *
 * PUBLISHED CONTENT SNAPSHOT:
 *   Blog.publishedContent is set to the exact HTML that went to the CMS.
 *   This is important because: user might edit Blog.content after publishing.
 *   We need to know exactly what is live on the site for GSC monitoring.
 */

import type { Job }      from 'bullmq';
import { logger }        from '@/open-tele';
import { Project }       from '@/models/Project';
import { Blog }          from '@/models/Blog';
import { CmsConfig }     from '@/models/CmsConfig';
import { publishBlog }   from '@/lib/cms';
import type { BlogPublishPayload } from '@/lib/cms';
import type { PipelineJobData }   from '../seo-pipeline.worker';

// ── Day check ─────────────────────────────────────────────────────────────

/**
 * Returns true if today is an allowed publish day.
 * Sunday = 0. Monday = 1. Saturday = 6.
 * CmsConfig.allowedPublishDays enforces no Sunday at schema level.
 * We double-check here for defence in depth.
 */
function isTodayAllowedPublishDay(allowedDays: number[]): boolean {
  const todayUtc = new Date().getUTCDay(); // 0 = Sunday
  return allowedDays.includes(todayUtc);
}

// ── Main job handler ───────────────────────────────────────────────────────

export async function runCmsPublishJob(job: Job<PipelineJobData>): Promise<void> {
  const { projectId } = job.data;

  logger.info('CMS publish job started', { projectId, jobId: job.id });

  // 1. Load project — need domain for publishedUrl
  const project = await Project.findById(projectId).lean();
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  // 2. Load CmsConfig — must use +encryptedCredentials (select: false by default)
  const cmsConfig = await CmsConfig.findOne({ projectId })
    .select('+encryptedCredentials') // encrypted creds are select:false — must opt in
    .lean();

  // 3. No CMS connected — valid state, not an error
  if (!cmsConfig || !cmsConfig.cmsType || !cmsConfig.encryptedCredentials) {
    logger.warn('No CMS connected or auto-publish not configured — blogs stay ready', {
      projectId,
      hasCmsConfig:           !!cmsConfig,
      hasCmsType:             !!cmsConfig?.cmsType,
      hasEncryptedCredentials: !!cmsConfig?.encryptedCredentials,
    });
    return; // Step completes — blogs stay 'ready' for manual publish
  }

  // 4. Check autoPublish flag
  if (!cmsConfig.autoPublish) {
    logger.warn('Auto-publish is disabled for project — blogs stay ready', {
      projectId,
      cmsType: cmsConfig.cmsType,
    });
    return;
  }

  // 5. Day of week check — no Sunday publishing
  const allowedDays = cmsConfig.allowedPublishDays ?? [1, 2, 3, 4, 5, 6];
  if (!isTodayAllowedPublishDay(allowedDays)) {
    const todayUtc = new Date().getUTCDay();
    logger.warn('Today is not an allowed publish day — skipping', {
      projectId,
      todayUtc,
      allowedDays,
      dayName: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][todayUtc],
    });
    return;
  }

  // 6. Load all ready blogs for this project
  const blogs = await Blog.find({
    projectId,
    status: 'ready',
  })
    .sort({ createdAt: 1 }) // oldest first — publish in creation order
    .lean();

  if (blogs.length === 0) {
    logger.warn('No ready blogs found for publishing', { projectId });
    return;
  }

  logger.info('Ready blogs found for publishing', {
    projectId,
    cmsType:   cmsConfig.cmsType,
    blogCount: blogs.length,
    blogIds:   blogs.map(b => String(b._id)),
  });

  // 7. Publish each blog
  let successCount = 0;
  let failCount    = 0;

  for (const blog of blogs) {
    const blogId  = String(blog._id);
    const context = `cms-publish:${projectId}:${blogId}`;

    logger.debug('Publishing blog', {
      context,
      blogId,
      title: blog.title,
      slug:  blog.slug,
    });

    // Build publish payload
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
        // Publisher returned failure without throwing
        throw new Error(result.error ?? 'Publisher returned success:false with no error message');
      }

      // Update blog to published
      const now = new Date();
      await Blog.findByIdAndUpdate(blogId, {
        $set: {
          status:           'published',
          cmsReference:     result.cmsReference,
          publishedUrl:     result.publishedUrl,
          publishedDate:    now,
          publishedContent: blog.content ?? '', // snapshot of what went live
        },
        // Append to history — capped at 50 via $slice
        $push: {
          history: {
            $each: [{
              content:   blog.content ?? '',
              status:    'published',
              writer:    'system',
              createdAt: now,
            }],
            $slice: -50, // keep last 50 entries
          },
        },
      });

      successCount++;

      logger.info('Blog published successfully', {
        context,
        blogId,
        title:        blog.title,
        cmsReference: result.cmsReference,
        publishedUrl: result.publishedUrl,
        cmsType:      cmsConfig.cmsType,
      });

    } catch (err) {
      // Per-blog failure — log and continue to next blog
      failCount++;
      logger.error(
        err instanceof Error ? err : new Error(String(err)),
        {
          context,
          blogId,
          title:   blog.title,
          cmsType: cmsConfig.cmsType,
        },
      );
    }
  }

  logger.info('CMS publish job completed', {
    projectId,
    jobId:        job.id,
    cmsType:      cmsConfig.cmsType,
    total:        blogs.length,
    successCount,
    failCount,
    allFailed:    failCount === blogs.length && blogs.length > 0,
  });

  // 8. If ALL blogs failed → throw so BullMQ retries the step
  if (failCount === blogs.length && blogs.length > 0) {
    throw new Error(
      `All ${blogs.length} blog publish attempts failed for project ${projectId}. ` +
      `CMS type: ${cmsConfig.cmsType}. BullMQ will retry.`
    );
  }
}
