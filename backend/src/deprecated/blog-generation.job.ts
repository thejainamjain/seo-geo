/**
 * DEPRECATED — moved from workers/jobs/ to deprecated/ on this date.
 * Never imported by any live worker; superseded by
 * workers/jobs/content-generation.job.ts. See deprecated/README.md for
 * the full verification (how this was confirmed dead, not just unused-
 * looking) and the key behavioral difference (this created 'draft'
 * blogs requiring manual review; the replacement creates 'ready' blogs
 * directly, which is the current, correct, confirmed-desired behavior).
 * Left in place for historical reference only — do not import from here.
 */

/**
 * workers/jobs/blog-generation.job.ts  (v2 — full implementation)
 *
 * WHAT: Generates ONE complete blog post for ONE keyword using Gemini.
 *       Each job is a BullMQ FlowProducer child — 25 run in parallel.
 *
 * WHAT CHANGED FROM v1 (stub → real):
 *   v1: created Blog with title = keyword, no content, status = 'draft'
 *   v2: calls generateBlogPost() → full HTML content, meta description,
 *       SEO schema, history entry, source analysis saved on the Blog doc.
 *
 * PIPELINE POSITION: Called by BLOG_GENERATION step orchestrator.
 *
 * READS:
 *   Keyword         → keyword string, alignmentScore, searchVolume, brief (SERP analysis)
 *   Project         → domain (for contactUrl in prompt)
 *   BusinessContext → full profile injected into blog generation prompt
 *   ProjectKnowledgeFile → brand docs, pricing sheets (via knowledge-loader.ts)
 *
 * WRITES:
 *   Blog            → creates with full content, description, seoSchema,
 *                     history[0] (first AI version), sourceAnalysis
 *   Keyword         → status: upcoming → draft
 *
 * LLM CALL:
 *   generateBlogPost() in lib/llm.ts — one call per keyword.
 *   System prompt includes: business context, SERP brief, knowledge chunks.
 *   Returns: title, slug, description, full HTML content, schema.
 *
 * SLUG STRATEGY:
 *   LLM generates slug from keyword (better than our regex — handles edge cases).
 *   We sanitize it and check for collisions — append jobIndex if collision.
 *
 * HERO IMAGE:
 *   heroImageUrl starts null. Resolved later — either by the user uploading
 *   one directly in the editor (see blogService.uploadImage), or
 *   automatically at publish time if still unset: first from the project's
 *   uploaded image pool (lib/hero-image-pool.ts, the primary automatic
 *   source), falling back to Unsplash only if the pool has nothing left
 *   (see cms-publish.job.ts). It is always a separate field, never embedded
 *   inline in `content` — the frontend renders it as its own element
 *   (components/editor/hero-image.tsx).
 *   (Earlier versions of this job asked the LLM to embed a
 *   {{HERO_IMAGE_URL}} placeholder directly in `content`, meant to be
 *   substituted later — that substitution step was never actually built,
 *   so every blog generated that way shipped a permanently broken <img>.
 *   Fixed by removing the instruction from the prompt and self-healing
 *   already-generated content — see lib/blog-content.ts.)
 *
 * KNOWLEDGE CONTEXT:
 *   Fetches ready ProjectKnowledgeFile docs, extracts their text from Cloudinary
 *   (PDF/text/markdown), passes as knowledgeChunks to the LLM prompt.
 *   If no knowledge files → empty string → blog generates without brand context.
 *   Never blocks blog generation.
 *
 * SERP BRIEF:
 *   Keyword.brief stores JSON-stringified SerpAnalysisLlmResponse from
 *   serp-research.job.ts. We parse it and format it for the blog prompt.
 *   If brief missing → empty string → blog generates without SERP context
 *   (weaker output but still valid).
 *
 * ERROR HANDLING:
 *   - Keyword/Project/BusinessContext missing → throw (BullMQ retries)
 *   - Blog already exists → skip (idempotent)
 *   - LLM call fails → throw (BullMQ retries with exponential backoff)
 *   - LLM returns empty content → throw (BullMQ retries)
 *   - Slug collision → append jobIndex, proceed
 *
 * CONCURRENCY:
 *   25 children run in parallel (blogWorker concurrency: 10).
 *   Each makes one Gemini call. At 15 RPM Gemini limit, 10 parallel calls
 *   is safe — each call takes ~3-8s so actual RPM is well under limit.
 */

import type { Job } from 'bullmq';
import { logger }          from '@/open-tele';
import { Blog }            from '@/models/Blog';
import { Keyword }         from '@/models/Keyword';
import { Project }         from '@/models/Project';
import { BusinessContext } from '@/models/BusinessContext';
import { generateBlogPost } from '@/lib/llm';
import { loadKnowledgeChunks } from '@/lib/knowledge-loader';
import { findRelevantKnowledge, findRelevantLearnings, formatChunksForPrompt } from '@/lib/vector-search';
import type { BlogJobData } from '../seo-pipeline.worker';
import { formatBusinessContext } from '@/lib/business-context-formatter';

// ── Constants ──────────────────────────────────────────────────────────────

const MIN_CONTENT_LENGTH = 500; // Chars — below this = LLM returned garbage

// ── Slug utilities ─────────────────────────────────────────────────────────

/**
 * Sanitizes an LLM-generated slug.
 * LLM usually returns a good slug but may include uppercase or double hyphens.
 */
function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '-')  // replace non-slug chars with hyphens
    .replace(/-+/g, '-')           // collapse multiple hyphens
    .replace(/^-|-$/g, '')         // strip leading/trailing hyphens
    .slice(0, 80);                 // cap length — long slugs hurt SEO
}

/**
 * Fallback slug from keyword string if LLM doesn't return one.
 */
function keywordToSlug(keyword: string, suffix?: number): string {
  const base = keyword
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
  return suffix !== undefined ? `${base}-${suffix}` : base;
}

// ── SERP brief formatter ───────────────────────────────────────────────────

/**
 * Formats Keyword.brief (JSON string from serp-research.job.ts) into
 * a readable string for the blog generation prompt.
 *
 * Only includes relevant results — filters out irrelevant SERP entries.
 * Caps at 1500 chars — SERP context shouldn't dominate the prompt.
 */
function formatSerpBrief(briefJson: string | undefined): string {
  if (!briefJson) return '';

  try {
    const serpRelevance = JSON.parse(briefJson) as Array<{
      title:            string;
      link:             string;
      topic:            string;
      pageType:         string;
      titleIntent:      string;
      isRelevantToICP:  boolean;
    }>;

    if (!Array.isArray(serpRelevance) || serpRelevance.length === 0) return '';

    const lines: string[] = ['Top SERP results for this keyword:'];

    for (const result of serpRelevance.slice(0, 5)) {
      // Only show results relevant to ICP — rest is noise
      if (!result.isRelevantToICP) continue;
      lines.push(
        `- "${result.title}" (${result.pageType}, intent: ${result.titleIntent})\n  ${result.link}`
      );
    }

    return lines.length > 1
      ? lines.join('\n').slice(0, 1_500)
      : '';

  } catch {
    return '';
  }
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

  // ── 1. Load keyword ──────────────────────────────────────────────────────

  const keyword = await Keyword.findById(keywordId).lean();
  if (!keyword) {
    throw new Error(`Keyword not found: ${keywordId} (projectId: ${projectId})`);
  }

  logger.debug('Keyword loaded', {
    projectId,
    keywordId,
    keyword:        keyword.keyword,
    alignmentScore: keyword.alignmentScore,
    searchVolume:   keyword.searchVolume,
    hasBrief:       !!keyword.brief,
  });

  // ── 2. Load project ──────────────────────────────────────────────────────

  const project = await Project.findById(projectId).lean();
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const contactUrl = `https://${project.domain}/contact`;

  // ── 3. Guard — blog already exists for this keyword ──────────────────────

  const existing = await Blog.findOne({ keywordId }).lean();
  if (existing) {
    logger.warn('Blog already exists for keyword — skipping (idempotent)', {
      projectId,
      keywordId,
      blogId:  String(existing._id),
      keyword: keyword.keyword,
      jobIndex,
    });
    return;
  }

  // ── 4. Load business context ─────────────────────────────────────────────

  const bc = await BusinessContext.findOne({ projectId }).lean();
  if (!bc) {
    throw new Error(
      `BusinessContext not found for project ${projectId}. ` +
      `Ensure BUSINESS_PROFILE step completed successfully.`
    );
  }

  const customerProfile = formatBusinessContext(bc);

  logger.debug('Business context formatted', {
    projectId,
    keywordId,
    profileLength: customerProfile.length,
  });

  // ── 5. Load knowledge chunks (non-blocking) ──────────────────────────────

  let knowledgeChunks = '';
  try {
    // Real retrieval first — relevant to THIS keyword specifically, plus
    // past learnings so a new blog doesn't repeat a mistake a previous
    // similar post already needed a rewrite to fix. Previously this always
    // dumped the first few uploaded files' full text, truncated, regardless
    // of relevance to the keyword being generated.
    const [retrievedKnowledge, retrievedLearnings] = await Promise.all([
      findRelevantKnowledge(projectId, keyword.keyword, 5),
      findRelevantLearnings(projectId, keyword.keyword, 5),
    ]);
    const knowledgeBlock = formatChunksForPrompt(retrievedKnowledge, 'BRAND CONTEXT');
    const learningsBlock = formatChunksForPrompt(retrievedLearnings, 'PAST LEARNINGS FOR THIS KEYWORD CATEGORY');
    knowledgeChunks = [knowledgeBlock, learningsBlock].filter(Boolean).join('\n\n');

    // Fallback for projects with no embedded chunks yet — degrade to the
    // old whole-file approach rather than generating with zero brand context.
    if (!knowledgeChunks) {
      knowledgeChunks = await loadKnowledgeChunks(projectId);
    }

    logger.debug('Knowledge chunks loaded', {
      projectId,
      keywordId,
      chunkLength: knowledgeChunks.length,
    });
  } catch (err) {
    // Knowledge loading failure is non-fatal — blog generates without brand context
    logger.warn('Knowledge chunk loading failed — continuing without knowledge context', {
      projectId,
      keywordId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── 6. Format SERP brief ─────────────────────────────────────────────────

  const sourceAnalysisText = formatSerpBrief(keyword.brief);

  logger.debug('SERP brief formatted', {
    projectId,
    keywordId,
    serpBriefLength: sourceAnalysisText.length,
    hasBrief:        sourceAnalysisText.length > 0,
  });

  // ── 7. Call LLM — generate full blog post ───────────────────────────────

  logger.info('Calling Gemini for blog generation', {
    projectId,
    keywordId,
    keyword:         keyword.keyword,
    profileLength:   customerProfile.length,
    knowledgeLength: knowledgeChunks.length,
    serpLength:      sourceAnalysisText.length,
    jobIndex,
    total,
  });

  const llmResult = await generateBlogPost(
    keyword.keyword,
    customerProfile,
    sourceAnalysisText,
    knowledgeChunks,
    contactUrl,
    projectId,
    keywordId,
  );

  // ── 8. Validate LLM response ─────────────────────────────────────────────

  if (!llmResult.content || llmResult.content.length < MIN_CONTENT_LENGTH) {
    throw new Error(
      `Blog generation returned empty or too-short content for keyword "${keyword.keyword}". ` +
      `Got ${llmResult.content?.length ?? 0} chars, minimum is ${MIN_CONTENT_LENGTH}. ` +
      `BullMQ will retry.`
    );
  }

  if (!llmResult.title) {
    throw new Error(
      `Blog generation returned no title for keyword "${keyword.keyword}". BullMQ will retry.`
    );
  }

  logger.info('Blog content generated by LLM', {
    projectId,
    keywordId,
    keyword:         keyword.keyword,
    titleLength:     llmResult.title.length,
    contentLength:   llmResult.content.length,
    descLength:      llmResult.description?.length ?? 0,
    hasSchema:       !!llmResult.schema,
    jobIndex,
    total,
  });

  // ── 9. Build slug ────────────────────────────────────────────────────────

  // Prefer LLM-generated slug (better quality), fall back to keyword-derived
  let slug = llmResult.slug
    ? sanitizeSlug(llmResult.slug)
    : keywordToSlug(keyword.keyword);

  // Collision guard — append jobIndex if slug already taken in this project
  const collision = await Blog.findOne({ projectId, slug }).lean();
  if (collision) {
    slug = `${slug}-${jobIndex}`;
    logger.warn('Slug collision — appended jobIndex', {
      projectId,
      keywordId,
      slug,
      jobIndex,
    });
  }

  // ── 10. Create Blog document ──────────────────────────────────────────────

  const blog = await Blog.create({
    projectId,
    keywordId,
    title:       llmResult.title,
    slug,
    description: llmResult.description ?? '',
    content:     llmResult.content,
    status:      'draft',

    // SEO schema from LLM (Article + FAQ combined schema)
    // Named seoSchema (NOT schema) to avoid Mongoose reserved name collision
    seoSchema: llmResult.schema ?? null,

    // Hero image is a placeholder — replaced at CMS publish time
    // by Unsplash API → Cloudinary .avif pipeline in cms-publish.job.ts
    heroImageUrl: null, // resolved later — user upload, pool image, or Unsplash at publish time (see job header comment)

    // Source analysis — what SERP results informed this blog
    // Stored for the rewrite engine to understand content provenance
    sourceAnalysis: sourceAnalysisText
      ? { serpBrief: sourceAnalysisText, keyword: keyword.keyword }
      : null,

    // First history entry — the initial AI-generated version
    history: [
      {
        content:   llmResult.content,
        description: llmResult.description ?? '',
        status:    'draft',
        writer:    'ai',
        createdAt: new Date(),
      },
    ],
  });

  logger.info('Blog document created', {
    projectId,
    keywordId,
    blogId:        String(blog._id),
    slug,
    keyword:       keyword.keyword,
    contentLength: llmResult.content.length,
    jobIndex,
    total,
  });

  // ── 11. Update keyword status ─────────────────────────────────────────────

  await Keyword.findByIdAndUpdate(keywordId, {
    $set: { status: 'draft' },
  });

  // ── 12. Update job progress ───────────────────────────────────────────────

  await job.updateProgress(Math.round((jobIndex / total) * 100));

  logger.info('Blog generation job completed', {
    projectId,
    keywordId,
    blogId:   String(blog._id),
    slug,
    keyword:  keyword.keyword,
    jobIndex,
    total,
    progress: `${jobIndex}/${total}`,
  });
}
