import { Blog, Project, OrganizationMember, type IBlog } from '../models';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors';
import { seoPipelineQueue } from '../workers/seo-pipeline.worker';
import { QUEUE_NAMES, JOB_RETRY_CONFIG, JOB_PRIORITY } from '../constants/seo-pipeline.constants';
import { Queue } from 'bullmq';
import { getConnectionOptions } from '../loaders/redis';
import { logger } from '../open-tele';

const cmsPublishQueue = new Queue(QUEUE_NAMES.PUBLISH, {
  connection: getConnectionOptions(),
});

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

    if (input.content) {
      logger.debug('Blog content update', { projectId, blogId, contentLength: input.content.length });
    }

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
              content:   input.content,
              description: input.description ?? blog.description,
              status:    (input.status ?? blog.status) as IBlog['status'],
              writer:    'user',
              createdAt: new Date(),
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

    await assertProjectAccess(userId, projectId);

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

    await cmsPublishQueue.add(
      'CMS_PUBLISH',
      { projectId, blogId },
      {
        attempts: JOB_RETRY_CONFIG.CMS_PUBLISH.attempts,
        backoff:  { type: 'exponential', delay: JOB_RETRY_CONFIG.CMS_PUBLISH.backoffDelay },
        priority: JOB_PRIORITY.CMS_PUBLISH,
        jobId:    `cms-publish-manual-${blogId}`,
      },
    );

    logger.info('Blog publish job enqueued', { projectId, blogId });
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

