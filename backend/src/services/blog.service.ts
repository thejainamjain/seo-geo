import { Blog, Project, OrganizationMember, type IBlog } from '../models';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors';
import { publishBlogToCms } from '../lib/blog-cms-publisher';
import { CmsConfig } from '../models/CmsConfig';
import { uploadToCloudinary } from '../lib/cloudinary';
import { stripLegacyHeroImagePlaceholder } from '../lib/blog-content';
import { resolveHeroImage } from '../lib/hero-image-resolver';
import { sanitizeSlug } from '../lib/slug';
import { logger } from '../open-tele';

const IMAGE_MAX_BYTES  = 5 * 1024 * 1024; // 5MB — generous for web-optimised images
const IMAGE_ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

async function assertProjectAccess(userId: string, projectId: string) {
  const project = await Project.findById(projectId);
  if (!project) throw new NotFoundError('Project');

  const membership = await OrganizationMember.findOne({
    userId,
    organizationId: project.organizationId,
  });
  if (!membership) throw new ForbiddenError();

  return project;
}

export const blogService = {
  async listBlogs(userId: string, projectId: string, query: {
    status?: string;
    page:    number;
    limit:   number;
  }) {
    logger.debug('blogService.listBlogs', { userId, projectId, query });

    await assertProjectAccess(userId, projectId);

    const filter: Record<string, unknown> = { projectId };
    if (query.status) filter['status'] = query.status;

    const skip = (query.page - 1) * query.limit;
    const [blogs, total] = await Promise.all([
      Blog.find(filter)
        .select('-content -publishedContent -history -sourceAnalysis')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(query.limit)
        .lean(),
      Blog.countDocuments(filter),
    ]);

    logger.info('Blogs listed', { projectId, total });
    return { blogs, total, page: query.page, limit: query.limit };
  },

  async getBlog(userId: string, projectId: string, blogId: string) {
    logger.debug('blogService.getBlog', { userId, projectId, blogId });

    await assertProjectAccess(userId, projectId);

    const blog = await Blog.findOne({ _id: blogId, projectId });
    if (!blog) throw new NotFoundError('Blog');

    // Self-heal: blogs generated under the old prompt have a permanently
    // broken {{HERO_IMAGE_URL}} placeholder baked into `content` (see
    // lib/blog-content.ts for the full story). Strip it the first time
    // it's read and persist the cleanup so this only ever runs once per
    // blog, not on every fetch.
    if (blog.content) {
      const { content: cleaned, changed } = stripLegacyHeroImagePlaceholder(blog.content);
      if (changed) {
        blog.content = cleaned;
        await blog.save();
        logger.info('Stripped legacy hero-image placeholder from blog content', {
          projectId, blogId,
        });
      }
    }

    logger.info('Blog fetched', { projectId, blogId });
    return blog;
  },

  /**
   * Uploads an image for insertion into a blog's rich-text content (the
   * editor's image tool). Returns just the hosted URL — the image isn't
   * tracked on the Blog document itself; it becomes part of `content`
   * (an <img> tag) the moment the editor inserts it and the user saves,
   * same as any other content edit. No separate cleanup path needed:
   * an unused upload (inserted then removed before saving) just sits in
   * Cloudinary unreferenced, same tradeoff every editor-with-upload makes.
   */
  async uploadImage(userId: string, projectId: string, blogId: string, file: Express.Multer.File) {
    logger.debug('blogService.uploadImage', {
      userId, projectId, blogId, mimeType: file.mimetype, sizeBytes: file.size,
    });

    await assertProjectAccess(userId, projectId);

    const blog = await Blog.findOne({ _id: blogId, projectId }).select('_id').lean();
    if (!blog) throw new NotFoundError('Blog');

    if (!IMAGE_ALLOWED_MIMES.includes(file.mimetype)) {
      logger.warn('Blog image upload rejected — invalid type', {
        projectId, blogId, mimeType: file.mimetype,
      });
      throw new ValidationError(
        `Invalid image type: ${file.mimetype}. Allowed: PNG, JPEG, WebP, GIF`,
      );
    }
    if (file.size > IMAGE_MAX_BYTES) {
      logger.warn('Blog image upload rejected — too large', {
        projectId, blogId, sizeBytes: file.size,
      });
      throw new ValidationError('Image exceeds 5MB limit');
    }

    const { url } = await uploadToCloudinary(
      file.buffer,
      `${projectId}-${blogId}-${Date.now()}-${file.originalname}`,
      { folder: 'blog-content-images', resourceType: 'image' },
    );

    logger.info('Blog image uploaded', { projectId, blogId, url });
    return { url };
  },

  async updateBlog(userId: string, projectId: string, blogId: string, input: {
    title?:        string;
    content?:      string;
    description?:  string;
    status?:       string;
    heroImageUrl?: string | null;
    slug?:         string;
    /**
     * Whether this update should also push a history snapshot (default
     * true — preserves old behavior for any other existing caller).
     * The blog editor's debounced autosave (frontend) passes false for
     * its frequent (~1.2s) silent content saves, and true only
     * periodically / on meaningful boundaries (navigating away, an
     * explicit status change) — see that page's header comment for why:
     * pushing a full history entry on every autosave tick would still be
     * bounded (capped at 50 via $slice below) but would turn "last 50
     * deliberate saves" into "last 50 autosave ticks", which is a real,
     * worse-for-the-user behavior change, not just a cosmetic one.
     */
    snapshot?: boolean;
  }) {
    logger.debug('blogService.updateBlog', { userId, projectId, blogId });

    await assertProjectAccess(userId, projectId);

    const blog = await Blog.findOne({ _id: blogId, projectId });
    if (!blog) throw new NotFoundError('Blog');

    const allowedStatuses = ['draft', 'ready', 'published', 'archived'];
    if (input.status && !allowedStatuses.includes(input.status)) {
      throw new ValidationError(`Invalid status: ${input.status}`);
    }

    if (input.title)       blog.title       = input.title;
    if (input.description) blog.description = input.description;
    if (input.status)      blog.status      = input.status as IBlog['status'];

    if (input.slug !== undefined && input.slug !== blog.slug) {
      // BLOCKED after publish — not a UI limitation, a real data-safety
      // one. lib/cms/wordpress.ts's publishToWordPress (also used for
      // post-publish re-syncs, see lib/blog-cms-publisher.ts's
      // updateBlogOnCms) finds which live CMS post to update by looking
      // up the CURRENT slug (findPostBySlug) — there is no stored CMS
      // post ID used for that lookup. If the slug changed since the post
      // went live, that lookup would find nothing at the new slug and
      // fall through to CREATING A SECOND, DUPLICATE live post, leaving
      // the original (at the old slug) untouched and orphaned. This is
      // true for every CMS integration that follows this same
      // find-by-slug pattern, not just one platform. Fixing this
      // properly would mean reworking the CMS layer to look posts up by
      // a stored reference ID instead of by slug — a real, separate
      // project, not a quick patch here. Blocking is the safe choice
      // until that exists; it also matches real industry practice
      // (Medium and Ghost lock the slug after publish outright, for
      // similar reasons).
      if (blog.status === 'published') {
        throw new ValidationError(
          'The URL slug cannot be changed after a post is published — this could create a duplicate ' +
          'post on your CMS instead of updating the live one. Unpublish first if you really need to change it.',
        );
      }

      const sanitized = sanitizeSlug(input.slug);
      if (!sanitized) {
        throw new ValidationError('Slug cannot be empty after removing invalid characters');
      }

      const collision = await Blog.findOne({
        projectId, slug: sanitized, _id: { $ne: blogId },
      }).select('_id').lean();
      if (collision) {
        throw new ValidationError('This URL slug is already used by another post in this project');
      }

      logger.info('Blog slug changed', { projectId, blogId, previous: blog.slug, next: sanitized });
      blog.slug = sanitized;
    }

    if (input.heroImageUrl !== undefined) {
      const previous = blog.heroImageUrl;
      // null clears it (Mongoose unsets an optional field on `undefined`,
      // not on `null` — hence the explicit branch here).
      blog.heroImageUrl = input.heroImageUrl ?? undefined;
      logger.info('Blog hero image updated', {
        projectId, blogId, previous: previous ?? null, next: input.heroImageUrl,
      });
    }
    if (input.content) {
      blog.content = input.content; // always persisted immediately, regardless of snapshot
    }

    // Snapshot gating is now purely on input.snapshot, not on
    // input.content being present — a title-only or description-only
    // autosave tick can still produce a real, complete history entry.
    // blog.title/description/status already reflect this call's changes
    // (assigned above), so this always captures the true current state.
    if (input.snapshot ?? true) {
      await Blog.findByIdAndUpdate(blogId, {
        $push: {
          history: {
            $each: [{
              content:     blog.content,
              description: blog.description,
              status:      blog.status,
              writer:      'user',
              createdAt:   new Date(),
            }],
            $slice: -50,
          },
        },
      });
    }

    await blog.save();


    logger.info('Blog updated', { projectId, blogId });
    return blog;
  },

  async publishBlog(userId: string, projectId: string, blogId: string) {
    logger.debug('blogService.publishBlog', { userId, projectId, blogId });

    const project = await assertProjectAccess(userId, projectId);

    const blog = await Blog.findOne({ _id: blogId, projectId });
    if (!blog) throw new NotFoundError('Blog');

    if (blog.status === 'draft') {
      throw new ValidationError('Cannot publish a draft blog — set status to ready first');
    }
    if (blog.status === 'published') {
      throw new ValidationError('Blog is already published');
    }
    if (blog.status === 'archived') {
      throw new ValidationError('Cannot publish an archived blog');
    }

    // Load CMS config — must be connected to publish
    const cmsConfig = await CmsConfig.findOne({ projectId })
      .select('+encryptedCredentials')
      .lean();

    if (!cmsConfig || !cmsConfig.cmsType || !cmsConfig.encryptedCredentials) {
      throw new ValidationError('No CMS connected — connect a CMS in Settings to publish');
    }

    // Resolve hero image via the single shared resolver (lib/hero-image-
    // resolver.ts) — used identically by the two auto-publish paths
    // (cms-publish.job.ts, content-generation.job.ts). This was
    // previously only implemented on the cron path — the manual Publish
    // button shipped blogs with no image at all unless one had already
    // been set. Fixed by resolving it here too before delegating to the
    // shared publish helper below.
    const context = `blog-service-publish:${projectId}:${blogId}`;
    const heroImageUrl = await resolveHeroImage({
      projectId,
      blogId,
      blogTitle: blog.title,
      existingHeroImageUrl: blog.heroImageUrl,
      brandColor: project.brandColor,
      fallbackMode: project.heroImageFallbackMode,
      context,
    });

    // Delegate to the shared publish-and-persist helper (lib/blog-cms-
    // publisher.ts) instead of pushing to the CMS and updating the Blog
    // document by hand here — the inline version had drifted from the
    // shared helper's idempotency guard (which stops a retried Publish
    // click from creating a duplicate CMS post) and its keyword-status
    // update, despite that module's header claiming this call site was
    // already consolidated into it.
    const result = await publishBlogToCms({
      blogId,
      projectId,
      domain: project.domain,
      cmsConfig,
      resolvedHeroImageUrl: heroImageUrl,
      brandColor: project.brandColor,
      useDefaultBlogTheme: project.useDefaultBlogTheme,
    });

    if (!result.success) {
      throw new ValidationError(result.error ?? 'CMS publish failed');
    }

    const updated = await Blog.findOne({ _id: blogId, projectId });
    if (!updated) throw new NotFoundError('Blog');

    logger.info('Blog published to CMS', {
      projectId,
      blogId,
      cmsType:      cmsConfig.cmsType,
      publishedUrl: result.publishedUrl,
      skipped:      result.skipped ?? false,
    });

    return updated;
  },

  async unpublishBlog(userId: string, projectId: string, blogId: string) {
    logger.debug('blogService.unpublishBlog', { userId, projectId, blogId });

    await assertProjectAccess(userId, projectId);

    const blog = await Blog.findOne({ _id: blogId, projectId });
    if (!blog) throw new NotFoundError('Blog');

    if (blog.status !== 'published') {
      throw new ValidationError('Blog is not published');
    }

    blog.status       = 'ready';
    blog.publishedUrl = undefined;
    blog.cmsReference = undefined;
    await blog.save();

    logger.info('Blog unpublished', { projectId, blogId });
    return blog;
  },

  async deleteBlog(userId: string, projectId: string, blogId: string) {
    logger.debug('blogService.deleteBlog', { userId, projectId, blogId });

    await assertProjectAccess(userId, projectId);

    const blog = await Blog.findOne({ _id: blogId, projectId });
    if (!blog) throw new NotFoundError('Blog');

    blog.status = 'archived';
    await blog.save();

    logger.info('Blog soft deleted (archived)', { projectId, blogId });
    return blog;
  },
};
