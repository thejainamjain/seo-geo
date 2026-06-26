/**
 * workers/jobs/blog-generation.job.ts
 *
 * WHAT: Child job handler for blog content generation.
 *       Each job generates ONE blog post for ONE keyword.
 *       25 of these run in parallel via BullMQ FlowProducer.
 *
 * PIPELINE POSITION: Called by BLOG_GENERATION step orchestrator.
 *                    Not a direct pipeline step — runs as FlowProducer child.
 *
 * READS:  Keyword (by keywordId)
 *         Project (by projectId — for domain/context)
 * WRITES: Blog (creates draft)
 *         Keyword (status: upcoming → draft)
 *
 * LLM CALL: Stubbed for now — content left empty, status set to draft.
 *           Real LLM call wired in lib/llm.ts session.
 *
 * SLUG GENERATION:
 *   Derived from keyword string — lowercased, spaces → hyphens,
 *   non-alphanumeric stripped. Collisions handled by appending jobIndex.
 *
 * ERROR HANDLING:
 *   - Keyword not found → throw (BullMQ retries)
 *   - Project not found → throw (BullMQ retries)
 *   - Blog already exists for keyword → skip gracefully, log warning
 *   - Slug collision → append jobIndex to guarantee uniqueness
 */

import type { Job } from 'bullmq';
import { logger } from '../../open-tele';
import { Blog } from '../../models/Blog';
import { Keyword } from '../../models/Keyword';
import { Project } from '../../models/Project';
import type { BlogJobData } from '../seo-pipeline.worker';

// ── Slug generation ────────────────────────────────────────────────────────

/**
 * Converts a keyword string to a URL-safe slug.
 * Example: "Best Floor Cleaner in Udaipur" → "best-floor-cleaner-in-udaipur"
 *
 * jobIndex is appended only if a blog already exists with the same slug
 * for this project (collision guard).
 */
function generateSlug(keyword: string, suffix?: number): string {
  const base = keyword
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')   // strip non-alphanumeric except spaces and hyphens
    .replace(/\s+/g, '-')            // spaces → hyphens
    .replace(/-+/g, '-')             // collapse multiple hyphens
    .slice(0, 80);                   // cap length — long slugs hurt SEO

  return suffix !== undefined ? `${base}-${suffix}` : base;
}

// ── Main job handler ───────────────────────────────────────────────────────

export async function runBlogGenerationJob(job: Job<BlogJobData>): Promise<void> {
  const { projectId, keywordId, jobIndex, total } = job.data;

  logger.info('Blog generation job started', {
    projectId,
    keywordId,
    jobIndex,
    total,
    jobId: job.id,
  });

  // 1. Load keyword — must exist
  const keyword = await Keyword.findById(keywordId).lean();
  if (!keyword) {
    throw new Error(`Keyword not found: ${keywordId} (projectId: ${projectId})`);
  }

  logger.debug('Keyword loaded', {
    projectId,
    keywordId,
    keyword:       keyword.keyword,
    alignmentScore: keyword.alignmentScore,
    searchVolume:   keyword.searchVolume,
    difficulty:     keyword.difficulty,
  });

  // 2. Load project — needed for domain context
  const project = await Project.findById(projectId).lean();
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  // 3. Guard — if blog already exists for this keyword, skip gracefully
  const existing = await Blog.findOne({ keywordId }).lean();
  if (existing) {
    logger.warn('Blog already exists for keyword — skipping', {
      projectId,
      keywordId,
      blogId:  String(existing._id),
      keyword: keyword.keyword,
      jobIndex,
    });
    return; // Not an error — idempotent behaviour
  }

  // 4. Generate slug — append jobIndex if collision detected
  let slug        = generateSlug(keyword.keyword);
  const collision = await Blog.findOne({ projectId, slug }).lean();
  if (collision) {
    slug = generateSlug(keyword.keyword, jobIndex);
    logger.warn('Slug collision detected — appended jobIndex', {
      projectId,
      keywordId,
      slug,
      jobIndex,
    });
  }

  // 5. Create Blog document — stub (LLM content wired in lib/llm.ts session)
  //
  // Title uses keyword string directly for now.
  // LLM will rewrite to: "[Number] Best [Keyword] in [Location] ([Year])"
  // format when blog generation is fully wired.
  const blog = await Blog.create({
    projectId,
    keywordId,
    title:   keyword.keyword,
    slug,
    status:  'draft',
    history: [], // LLM will push first history entry when content is generated
  });

  logger.info('Blog draft created', {
    projectId,
    keywordId,
    blogId:  String(blog._id),
    slug,
    keyword: keyword.keyword,
    jobIndex,
    total,
  });

  // 6. Update keyword status: upcoming → draft
  await Keyword.findByIdAndUpdate(keywordId, {
    $set: { status: 'draft' },
  });

  logger.info('Keyword status updated to draft', {
    projectId,
    keywordId,
    keyword: keyword.keyword,
    jobIndex,
    total,
  });

  // 7. Update job progress — visible in BullMQ dashboard
  await job.updateProgress(Math.round((jobIndex / total) * 100));

  logger.info('Blog generation job completed', {
    projectId,
    keywordId,
    blogId:  String(blog._id),
    slug,
    keyword: keyword.keyword,
    jobIndex,
    total,
    progress: `${jobIndex}/${total}`,
  });
}