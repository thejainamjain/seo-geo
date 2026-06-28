import { Blog, Project, OrganizationMember, Keyword, type IBlog } from '../models';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors';
import { publishBlog as cmsPushBlog, type BlogPublishPayload } from '../lib/cms';
import { CmsConfig } from '../models/CmsConfig';
import { logger } from '../open-tele';

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

    logger.info('Blog fetched', { projectId, blogId });
    return blog;
  },

  async updateBlog(userId: string, projectId: string, blogId: string, input: {
    title?:       string;
    content?:     string;
    description?: string;
    status?:      string;
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
    if (input.content) {
      blog.content = input.content;
      await Blog.findByIdAndUpdate(blogId, {
        $push: {
          history: {
            $each: [{
              content:     input.content,
              description: input.description ?? blog.description,
              status:      (input.status ?? blog.status) as IBlog['status'],
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

    const result = await cmsPushBlog(cmsConfig, payload, projectId);

    if (!result.success) {
      throw new ValidationError(result.error ?? 'CMS publish failed');
    }

    const now = new Date();
    blog.status           = 'published';
    blog.cmsReference     = result.cmsReference;
    blog.publishedUrl     = result.publishedUrl;
    blog.publishedDate    = now;
    blog.publishedContent = blog.content;

    await Blog.findByIdAndUpdate(blogId, {
      $push: {
        history: {
          $each:  [{ content: blog.content ?? '', status: 'published', writer: 'system', createdAt: now }],
          $slice: -50,
        },
      },
    });

    await blog.save();

    // Update keyword status if linked
    if (blog.keywordId) {
      await Keyword.findByIdAndUpdate(blog.keywordId, {
        $set: { status: 'published' },
      });
    }

    logger.info('Blog published to CMS', {
      projectId,
      blogId,
      cmsType:      cmsConfig.cmsType,
      publishedUrl: result.publishedUrl,
    });

    return blog;
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
