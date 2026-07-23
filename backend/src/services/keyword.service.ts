import { Keyword, Blog, Project, OrganizationMember } from '../models';
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from '../utils/errors';
import { logger } from '../open-tele';
import { Queue } from 'bullmq';
import { getConnectionOptions } from '../loaders/redis';
import { QUEUE_NAMES, JOB_RETRY_CONFIG } from '../constants/seo-pipeline.constants';

const contentGenerationQueue = new Queue(
  QUEUE_NAMES.CONTENT_GENERATION,
  { connection: getConnectionOptions() },
);

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

export const keywordService = {
  async listKeywords(userId: string, projectId: string, query: {
    status?:     string;
    weekNumber?: number;
    page:        number;
    limit:       number;
  }) {
    logger.debug('keywordService.listKeywords', { userId, projectId, query });

    await assertProjectAccess(userId, projectId);

    const filter: Record<string, unknown> = { projectId };
    if (query.status)     filter['status']     = query.status;
    if (query.weekNumber) filter['weekNumber']  = query.weekNumber;

    const skip = (query.page - 1) * query.limit;
    const [keywords, total] = await Promise.all([
      Keyword.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
      Keyword.countDocuments(filter),
    ]);

    logger.info('Keywords listed', { projectId, total });
    return { keywords, total, page: query.page, limit: query.limit };
  },

  async addKeyword(userId: string, projectId: string, input: { keyword: string }) {
    logger.debug('keywordService.addKeyword', { userId, projectId, keyword: input.keyword });

    await assertProjectAccess(userId, projectId);

    const normalized = input.keyword.trim().toLowerCase();

    const existing = await Keyword.findOne({
      projectId,
      keyword: { $regex: new RegExp(`^${normalized}$`, 'i') },
    });
    if (existing) throw new ConflictError('Keyword');

    const keyword = await Keyword.create({
      projectId,
      keyword:        normalized,
      source:         'user_added',
      status:         'upcoming',
      alignmentScore: 100,
    });

    logger.info('Keyword added', { projectId, keywordId: String(keyword._id) });
    return keyword;
  },

   async generateContent(userId: string, projectId: string, keywordId: string) {
    logger.debug('keywordService.generateContent', { userId, projectId, keywordId });

    await assertProjectAccess(userId, projectId);

    const keyword = await Keyword.findOne({ _id: keywordId, projectId });
    if (!keyword) throw new NotFoundError('Keyword');

    if (keyword.status !== 'upcoming') {
      throw new ValidationError(
        `Keyword is already ${keyword.status} — cannot generate content again`,
      );
    }

    const retryConfig = JOB_RETRY_CONFIG['CONTENT_GENERATION']!;

    await contentGenerationQueue.add(
      'content-generation',
      { projectId, keywordId },
      {
        // Same jobId scheme as lib/keyword-generation-scheduler.ts's
        // automatic weekly trigger — if both happen to fire for the same
        // keyword near-simultaneously (manual click racing the automatic
        // trigger), BullMQ's jobId dedup means only one actually runs.
        jobId:    `content-generation:${keywordId}`,
        attempts: retryConfig.attempts,
        backoff:  { type: 'exponential', delay: retryConfig.backoffDelay },
      },
    );

    logger.info('Content generation job queued', { projectId, keywordId });

    return { status: 'generating', keywordId };
  },

  async deleteKeyword(userId: string, projectId: string, keywordId: string) {
    logger.debug('keywordService.deleteKeyword', { userId, projectId, keywordId });

    await assertProjectAccess(userId, projectId);

    const keyword = await Keyword.findOne({ _id: keywordId, projectId });
    if (!keyword) throw new NotFoundError('Keyword');

    if (keyword.status !== 'upcoming') {
      throw new ValidationError('Only upcoming keywords can be deleted');
    }

    const blogExists = await Blog.exists({ keywordId });
    if (blogExists) {
      throw new ValidationError('Cannot delete a keyword that has an associated blog');
    }

    await keyword.deleteOne();

    logger.info('Keyword deleted', { projectId, keywordId });
    return keyword;
  },
};
