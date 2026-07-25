/**
 * WHAT: Rewrites ONE underperforming blog post, applying retrieved learnings
 *       and brand-knowledge context. This is the piece that was completely
 *       missing before — gsc-monitor.job.ts creates BlogLearning insights,
 *       but nothing ever acted on them. This job is that action.
 *
 * TRIGGERED BY: gsc-monitor.job.ts, once per blog that had fresh (non-deduped)
 *               insights created this run — see that file for the trigger logic.
 * QUEUE:        seo-blog-optimization
 *
 * READS:
 *   Blog             → current content/title/description/schema
 *   Project           → domain, for contactUrl
 *   BusinessContext   → brand profile for the rewrite prompt
 *   ProjectLearningChunk (via lib/vector-search.ts) → relevant past learnings
 *                        + relevant brand-knowledge chunks
 *
 * WRITES:
 *   BlogOptimization → one record per run, the audit trail + review queue
 *   Blog             → seoTagOptimization fields auto-applied immediately
 *                       (title, description, seoSchema, history snapshot);
 *                       content itself is NOT touched — it stays a proposal
 *                       inside BlogOptimization.contentOptimization until a
 *                       human approves it via the review endpoint.
 *
 * TIER DECISION (confirmed with the team — see docs/13-knowledge-learning-system.md):
 *   - contentOptimization (full body rewrite)  → pending_review, human must approve
 *   - seoTagOptimization  (title/description/schema) → auto-applied immediately,
 *     with a rollback check added to gsc-monitor.job.ts's next cycle using the
 *     Blog.history[] snapshot taken here.
 *   Rationale: a bad title is cheap to notice and cheap to revert; a wrong
 *   fact or broken claim baked into full body content is not.
 *
 * KNOWN LIMITATION — CMS re-sync not wired: if this blog is already
 * published (blog.cmsReference set), the updated title/description/schema
 * are saved to the Blog document but NOT pushed to the live CMS post. Doing
 * that safely requires per-platform "update existing post" support, which
 * doesn't exist yet for 7 of 8 CMS publishers (see
 * docs/11-cms-integrations-audit.md, 🟠 cross-cutting bucket — calling the
 * existing publishBlog() here would CREATE A DUPLICATE live post instead of
 * updating the existing one, which is worse than doing nothing). Flagged
 * clearly on the BlogOptimization record (cmsResyncPending) rather than
 * silently either duplicating content live or silently doing nothing.
 *
 * ERROR HANDLING:
 *   - Blog not found → throw (BullMQ retries — likely a real problem, not a race)
 *   - No content to rewrite (blog.content empty) → log warn, return (nothing to optimize)
 *   - Retrieval (vector search) fails → hybridSearch already degrades to []
 *     internally (see vector-search.ts) — rewrite proceeds with whatever
 *     context it got, even if that's none
 *   - Rewrite LLM call fails → throw (BullMQ retries with backoff)
 *
 * IDEMPOTENCY: each run creates a new BlogOptimization record — this is
 * intentional, matching BlogLearning's "time-series, not upsert" philosophy
 * elsewhere in this codebase. Re-running for the same blog on the same day
 * would auto-apply tag changes again and create another pending_review
 * content proposal; the trigger in gsc-monitor.job.ts only fires this once
 * per blog per its own 30-day insight dedup window, which is the real
 * guard against repeat runs, not this job itself.
 */

import { logger }               from '@/open-tele';
import { Project }              from '@/models/Project';
import { BusinessContext }      from '@/models/BusinessContext';
import { Blog }                 from '@/models/Blog';
import { BlogLearning, BlogOptimization } from '@/models';
import { findRelevantLearnings, findRelevantKnowledge, formatChunksForPrompt } from '@/lib/vector-search';
import { rewriteBlogPost }      from '@/lib/llm';
import { formatBusinessContext } from '@/lib/business-context-formatter';

export interface BlogOptimizationJobData {
  projectId: string;
  blogId:    string;
  keyword:   string;
  /** BlogLearning _ids created this run — recorded on contentOptimization.learningIds for traceability. */
  learningIds: string[];
}

export async function runBlogOptimizationJob(
  data: BlogOptimizationJobData,
): Promise<void> {
  const { projectId, blogId, keyword, learningIds } = data;

  logger.info('Blog optimization job started', { projectId, blogId, keyword });

  // ── 1. Load blog + context ───────────────────────────────────────────────

  const blog = await Blog.findOne({ _id: blogId, projectId });
  if (!blog) {
    throw new Error(`Blog not found: ${blogId} (projectId: ${projectId})`);
  }

  if (!blog.content || !blog.content.trim()) {
    logger.warn('Blog optimization skipped — blog has no content to rewrite', {
      projectId, blogId,
    });
    return;
  }

  const project = await Project.findById(projectId).lean();
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const bc = await BusinessContext.findOne({ projectId }).lean();
  const customerProfile = bc ? formatBusinessContext(bc) : '';
  const contactUrl       = `https://${project.domain}/contact`;

  // ── 2. Retrieve relevant learnings + knowledge ───────────────────────────

  const [learnings, knowledge] = await Promise.all([
    findRelevantLearnings(projectId, keyword, 8),
    findRelevantKnowledge(projectId, keyword, 5),
  ]);

  const learningsBlock = formatChunksForPrompt(learnings, 'PAST LEARNINGS FOR THIS KEYWORD CATEGORY');
  const knowledgeBlock = formatChunksForPrompt(knowledge, 'BRAND CONTEXT');

  logger.info('Blog optimization context retrieved', {
    projectId, blogId,
    learningsFound: learnings.length,
    knowledgeFound: knowledge.length,
  });

  // ── 3. Rewrite ────────────────────────────────────────────────────────────

  const rewrite = await rewriteBlogPost(
    blog.content,
    customerProfile,
    keyword,
    knowledgeBlock,
    learningsBlock,
    contactUrl,
    projectId,
    blogId,
  );

  // ── 4. Auto-apply the tag optimization (title/description/schema) ───────

  const now = new Date();
  const cmsResyncPending = Boolean(blog.status === 'published' && blog.cmsReference);

  // Baseline CTR for the rollback check — averaged across the BlogLearning
  // docs that triggered this run, from the GSC snapshot each one already
  // carries. See gsc-monitor.job.ts's checkAndRollbackTagOptimization().
  const triggeringLearnings = await BlogLearning.find({ _id: { $in: learningIds } })
    .select('gscSnapshot.ctr')
    .lean();
  const ctrValues = triggeringLearnings
    .map(l => l.gscSnapshot?.ctr)
    .filter((ctr): ctr is number => typeof ctr === 'number');
  const baselineCtr = ctrValues.length > 0
    ? ctrValues.reduce((sum, c) => sum + c, 0) / ctrValues.length
    : undefined;

  // Capture BEFORE mutating — used both for the history snapshot and the
  // BlogOptimization audit trail below.
  const originalTitle       = blog.title;
  const originalDescription = blog.description;
  const originalSchema      = blog.seoSchema;
  const originalContent     = blog.content;
  const originalStatus      = blog.status;

  // Snapshot BEFORE mutating — same pattern blog.service.ts uses for every
  // other content-changing action on a Blog.
  await Blog.findByIdAndUpdate(blogId, {
    $push: {
      history: {
        $each: [{
          content:     originalContent,
          description: originalDescription,
          status:      originalStatus,
          writer:      'system',
          createdAt:   now,
        }],
        $slice: -50,
      },
    },
  });

  blog.title           = rewrite.title;
  blog.description     = rewrite.description;
  blog.seoSchema        = rewrite.schema;
  blog.lastOptimizedAt = now;
  await blog.save();

  if (cmsResyncPending) {
    logger.warn(
      'Blog tag optimization applied to DB but NOT pushed to live CMS — update-existing-post not yet supported for any CMS publisher',
      { projectId, blogId, cmsReference: blog.cmsReference },
    );
  }

  // ── 5. Record the optimization (audit trail + content review queue) ─────

  const optimization = await BlogOptimization.create({
    blogId,
    projectId,
    contentOptimization: {
      originalContent,
      optimizedContent: rewrite.content,
      changesSummary:   rewrite.contentOptimizationSummary,
      learningIds,
    },
    seoTagOptimization: {
      originalTitle,
      optimizedTitle:        rewrite.title,
      originalDescription,
      optimizedDescription:  rewrite.description,
      originalSchema,
      optimizedSchema:       rewrite.schema,
      baselineCtr,
      appliedAt:             now,
    },
    cmsResyncPending,
    status: 'pending_review',
  });

  logger.info('Blog optimization job completed', {
    projectId, blogId,
    optimizationId:   String(optimization._id),
    contentStatus:    'pending_review',
    tagsAutoApplied:  true,
    cmsResyncPending,
  });
}
