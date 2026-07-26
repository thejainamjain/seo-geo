import { Keyword, Blog, Project, OrganizationMember, BusinessContext } from '../models';
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from '../utils/errors';
import { logger } from '../open-tele';
import { Queue } from 'bullmq';
import { getConnectionOptions } from '../loaders/redis';
import { QUEUE_NAMES, JOB_RETRY_CONFIG } from '../constants/seo-pipeline.constants';
import { getSearchVolume } from '../lib/dataforseo';
import { scoreKeywordAlignment } from '../lib/llm';
import { deriveCountryCodeFromRegions } from '../lib/serp';
import { formatBusinessContext } from '../lib/business-context-formatter';

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

  /**
   * Adds a keyword the user typed in themselves, outside the automated
   * keyword-research pipeline.
   *
   * VERIFICATION: real search volume (DataForSEO) + real relevance
   * judgment (LLM, against this project's actual business context) —
   * synchronous, so the user gets real data back immediately rather than
   * finding out later a keyword was a dead end. Hard-blocks ONLY when
   * BOTH signals clearly fail (confirmed zero search volume AND judged
   * irrelevant to the business) — one bad signal alone isn't enough
   * (e.g. a real product/brand name can show near-zero "search volume"
   * in keyword tools while still being exactly the right keyword; a
   * broad but relevant term might have volume data unavailable).
   *
   * FAIL-OPEN, NOT FAIL-CLOSED: if either check itself fails (API down,
   * rate limited, etc.), that signal is treated as "unknown" — never as
   * "confirmed bad." A verification-infrastructure problem on our side
   * should never be the reason a user's keyword gets rejected.
   */
  async addKeyword(userId: string, projectId: string, input: { keyword: string }) {
    logger.debug('keywordService.addKeyword', { userId, projectId, keyword: input.keyword });

    await assertProjectAccess(userId, projectId);

    const normalized = input.keyword.trim().toLowerCase();

    const existing = await Keyword.findOne({
      projectId,
      keyword: { $regex: new RegExp(`^${normalized}$`, 'i') },
    });
    if (existing) throw new ConflictError('Keyword');

    const [project, bc] = await Promise.all([
      Project.findById(projectId).select('domain').lean(),
      BusinessContext.findOne({ projectId }).lean(),
    ]);
    if (!project) throw new NotFoundError('Project');

    const countryCode       = deriveCountryCodeFromRegions(bc?.company?.targetRegions, projectId);
    const domainDescription = formatBusinessContext(bc ?? {});

    // Both checks run in parallel, both fail-open (see doc comment above)
    const [volumeOutcome, alignmentOutcome] = await Promise.allSettled([
      getSearchVolume(normalized, countryCode, projectId),
      scoreKeywordAlignment(normalized, domainDescription, projectId),
    ]);

    const volumeResult = volumeOutcome.status === 'fulfilled' ? volumeOutcome.value : null;
    const alignment     = alignmentOutcome.status === 'fulfilled'
      ? alignmentOutcome.value.keywords[0]
      : undefined;

    if (alignmentOutcome.status === 'rejected') {
      logger.warn('Keyword alignment check failed — treating as unknown, not blocking', {
        projectId, keyword: normalized, error: String(alignmentOutcome.reason),
      });
    }

    // "Confirmed zero" means the lookup succeeded AND returned exactly 0 —
    // a failed/unavailable lookup (searchVolume === null) is NOT the same
    // thing and must never trigger the block on its own.
    const isConfirmedZeroVolume = volumeResult?.searchVolume === 0;
    const isConfirmedIrrelevant = alignment ? alignment.relevant === false : false;

    if (isConfirmedZeroVolume && isConfirmedIrrelevant) {
      logger.info('Keyword rejected — zero search volume and judged irrelevant', {
        projectId, keyword: normalized, reasoning: alignment?.reasoning,
      });
      throw new ValidationError(
        `"${normalized}" doesn't appear to get any search volume and doesn't look related to your business` +
        (alignment?.reasoning ? ` (${alignment.reasoning})` : '') +
        `. Double-check the spelling, or try a more specific/different keyword.`,
      );
    }

    const keyword = await Keyword.create({
      projectId,
      keyword:         normalized,
      source:          'user_added',
      status:          'upcoming',
      searchVolume:    volumeResult?.searchVolume ?? undefined,
      cpc:             volumeResult?.cpc || undefined,
      // Falls back to 89(trust the user) if the alignment check itself
      // was unavailable — never punish the user for our infra being down.
      alignmentScore:  alignment?.alignmentScore ?? 89,
      relevanceReason: alignment?.reasoning,
    });

    logger.info('Keyword added', {
      projectId,
      keywordId:      String(keyword._id),
      searchVolume:   volumeResult?.searchVolume ?? 'unavailable',
      alignmentScore: alignment?.alignmentScore ?? 'unavailable (defaulted to trust)',
    });
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
