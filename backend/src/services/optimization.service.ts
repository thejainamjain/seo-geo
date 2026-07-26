/**
 * services/optimization.service.ts
 *
 * WHAT: The human-review side of the learning loop. blog-optimization.job.ts
 * creates BlogOptimization records with a pending_review content rewrite —
 * this service is how a person actually approves or rejects that proposal.
 *
 * ACCESS MODEL: same as every other project-scoped service in this
 * codebase — any member of the organization that owns the project can
 * approve/reject (see assertProjectAccess below, identical to
 * blog.service.ts / knowledge.service.ts).
 *
 * KNOWN GAP, DELIBERATE (flagged during design, not an oversight): a full
 * content-body rewrite going live under a client's brand is a bigger deal
 * than editing an onboarding field, and this access model doesn't
 * distinguish "any team member" from "the person who should sign off."
 * Restricting approve/reject to role: "owner" | "admin" (OrganizationMember
 * already has this field) is a two-line follow-up once there's a real
 * need for it — not built now because there's no broader reviewer-role
 * concept in the product yet, and building one just for this endpoint
 * would be scope creep.
 */

import { Blog, BlogOptimization, Project, OrganizationMember } from '../models';
import { CmsConfig } from '../models/CmsConfig';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors';
import { logger } from '../open-tele';
import { updateBlogOnCms } from '../lib/blog-cms-publisher';

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

export const optimizationService = {
  /**
   * Lists optimization records for a project — the review queue.
   * Defaults to pending_review only (what a reviewer actually needs to
   * act on); pass status to see applied/rejected history instead.
   */
  async listOptimizations(
    userId:    string,
    projectId: string,
    query:     { status?: 'pending_review' | 'applied' | 'rejected'; blogId?: string; page: number; limit: number },
  ) {
    logger.debug('optimizationService.listOptimizations', { userId, projectId, query });

    await assertProjectAccess(userId, projectId);

    const filter: Record<string, unknown> = {
      projectId,
      status: query.status ?? 'pending_review',
    };
    if (query.blogId) filter['blogId'] = query.blogId;

    const skip = (query.page - 1) * query.limit;

    const [optimizations, total] = await Promise.all([
      BlogOptimization.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(query.limit)
        .populate('blogId', 'title slug status')
        .lean(),
      BlogOptimization.countDocuments(filter),
    ]);

    return { optimizations, total, page: query.page, limit: query.limit };
  },

  async getOptimization(userId: string, projectId: string, optimizationId: string) {
    logger.debug('optimizationService.getOptimization', { userId, projectId, optimizationId });

    await assertProjectAccess(userId, projectId);

    const optimization = await BlogOptimization.findOne({ _id: optimizationId, projectId })
      .populate('blogId', 'title slug status content description')
      .lean();
    if (!optimization) throw new NotFoundError('BlogOptimization');

    return optimization;
  },

  /**
   * Applies the proposed content rewrite: snapshots the blog's current
   * content to history, then overwrites content/description with the
   * optimized version. Title/description/schema were already auto-applied
   * by blog-optimization.job.ts (the seoTagOptimization tier) — this only
   * ever touches contentOptimization, the body rewrite that required review.
   */
  async approveOptimization(userId: string, projectId: string, optimizationId: string) {
    logger.debug('optimizationService.approveOptimization', { userId, projectId, optimizationId });

    const project = await assertProjectAccess(userId, projectId);

    const optimization = await BlogOptimization.findOne({ _id: optimizationId, projectId });
    if (!optimization) throw new NotFoundError('BlogOptimization');

    if (optimization.status !== 'pending_review') {
      throw new ValidationError(`Optimization already ${optimization.status} — cannot approve again`);
    }

    if (!optimization.contentOptimization) {
      throw new ValidationError('This optimization has no content proposal to apply (tag-only optimization)');
    }

    const blog = await Blog.findOne({ _id: optimization.blogId, projectId });
    if (!blog) throw new NotFoundError('Blog');

    const now = new Date();
    const cmsResyncPending = Boolean(blog.status === 'published' && blog.cmsReference);

    // Snapshot current (pre-approval) content before overwriting — same
    // pattern used everywhere else content changes on a Blog.
    await Blog.findByIdAndUpdate(blog._id, {
      $push: {
        history: {
          $each: [{
            content:     blog.content ?? '',
            description: blog.description,
            status:      blog.status,
            writer:      'user', // a human approved this, distinct from the 'system' writer used for auto-applied tag changes
            createdAt:   now,
          }],
          $slice: -50,
        },
      },
    });

    blog.content         = optimization.contentOptimization.optimizedContent;
    blog.lastOptimizedAt = now;
    await blog.save();

    // Actually push the approved rewrite to the live CMS post, instead of
    // only flagging that a resync is needed. See
    // lib/blog-cms-publisher.ts's updateBlogOnCms() for why this is a
    // separate function from the regular publish path, and why it's
    // skipped outright for platforms (Framer) without a safe update path.
    let resyncSucceeded = false;
    if (cmsResyncPending) {
      const cmsConfig = await CmsConfig.findOne({ projectId }).lean();
      if (cmsConfig?.cmsType && cmsConfig.encryptedCredentials) {
        const resyncResult = await updateBlogOnCms(String(blog._id), projectId, project.domain, {
          cmsType:              cmsConfig.cmsType,
          encryptedCredentials: cmsConfig.encryptedCredentials,
          blogPostPath:         cmsConfig.blogPostPath,
          autoPublish:          cmsConfig.autoPublish,
          allowedPublishDays:   cmsConfig.allowedPublishDays,
          publishHourUtc:       cmsConfig.publishHourUtc,
        });
        resyncSucceeded = resyncResult.success;

        if (resyncSucceeded) {
          logger.info('Blog content optimization pushed to live CMS', {
            projectId, blogId: String(blog._id), cmsReference: blog.cmsReference,
          });
        } else {
          logger.warn('Blog content optimization approved but CMS re-sync did not succeed', {
            projectId, blogId: String(blog._id), cmsReference: blog.cmsReference,
            reason: resyncResult.skippedReason ?? resyncResult.error,
          });
        }
      } else {
        logger.warn('Blog content optimization approved but CMS re-sync skipped — no CMS config found', {
          projectId, blogId: String(blog._id),
        });
      }
    }

    optimization.status = 'applied';
    // Reflects whether a resync is STILL needed — false if it wasn't
    // needed, or if it was needed and just succeeded above.
    optimization.cmsResyncPending = (optimization.cmsResyncPending || cmsResyncPending) && !resyncSucceeded;
    await optimization.save();

    logger.info('Blog optimization approved and applied', {
      projectId, optimizationId, blogId: String(blog._id),
      cmsResyncPending: optimization.cmsResyncPending,
    });

    return optimization;
  },

  /**
   * Rejects the proposal — no content change, just marks the record so it
   * drops out of the pending_review queue. The BlogOptimization itself is
   * kept (not deleted) as an audit trail of what was proposed and declined.
   */
  async rejectOptimization(userId: string, projectId: string, optimizationId: string) {
    logger.debug('optimizationService.rejectOptimization', { userId, projectId, optimizationId });

    await assertProjectAccess(userId, projectId);

    const optimization = await BlogOptimization.findOne({ _id: optimizationId, projectId });
    if (!optimization) throw new NotFoundError('BlogOptimization');

    if (optimization.status !== 'pending_review') {
      throw new ValidationError(`Optimization already ${optimization.status} — cannot reject`);
    }

    optimization.status = 'rejected';
    await optimization.save();

    logger.info('Blog optimization rejected', { projectId, optimizationId });

    return optimization;
  },
};
