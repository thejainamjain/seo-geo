/**
 * WHAT: Generates content for ONE keyword on-demand.
 *       Runs SERP research → Blog generation → optionally CMS publish
 *       for a single keyword when the user clicks "Generate".
 *
 * TRIGGERED BY: POST /api/v1/projects/:projectId/keywords/:keywordId/generate
 * QUEUE:        seo-content-generation
 *
 * READS:
 *   Keyword         → keyword string, status, brief
 *   Project         → domain, for contactUrl
 *   BusinessContext → full profile for blog prompt
 *   CmsConfig       → autoPublish, allowedPublishDays, credentials
 *   ProjectKnowledgeFile → brand docs via knowledge-loader
 *
 * WRITES:
 *   Keyword → status: upcoming → generating → draft → ready → published
 *   Keyword → brief (SERP analysis JSON)
 *   Blog    → created with full content
 *
 * LLM CALLS (2 total):
 *   1. analyzeSerpResults  — SERP analysis for this keyword
 *   2. generateBlogPost    — full blog post
 *
 * ERROR HANDLING:
 *   - Keyword not found or wrong status → throw (BullMQ retries)
 *   - SERP fetch fails → log warn, continue without brief (blog still generates)
 *   - LLM calls fail → throw (BullMQ retries with backoff)
 *   - CMS publish fails → log error, keyword stays 'ready' (user can retry manually)
 *   - Blog already exists for keyword → skip generation, go straight to publish check
 *
 * IDEMPOTENCY:
 *   Status check at start prevents duplicate runs.
 *   Blog.findOne({ keywordId }) guard prevents duplicate blog creation.
 *   Safe to retry — each step checks current state before proceeding.
 */

import { logger }            from '@/open-tele';
import { Project }           from '@/models/Project';
import { BusinessContext }   from '@/models/BusinessContext';
import { Keyword }           from '@/models/Keyword';
import { Blog }              from '@/models/Blog';
import { CmsConfig }         from '@/models/CmsConfig';
import { searchOrganic, deriveCountryCodeFromRegions } from '@/lib/serp';
import { analyzeSerpResults, generateBlogPost }        from '@/lib/llm';
import { publishBlog }       from '@/lib/cms';
import { loadKnowledgeChunks } from '@/lib/knowledge-loader';
import { LLM_RATE_LIMIT }    from '@/constants/seo-pipeline.constants';
import type { BlogPublishPayload } from '@/lib/cms';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ContentGenerationJobData {
  projectId: string;
  keywordId: string;
}

// ── Slug utilities (same as blog-generation.job.ts) ────────────────────────

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function keywordToSlug(keyword: string): string {
  return keyword
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

// ── Business context formatter (same as blog-generation.job.ts) ────────────

function formatBusinessContext(bc: {
  company?:     { name?: string; description?: string; targetRegions?: string[] };
  product?:     { whatItSells?: string; keyFeatures?: string; pricingTiers?: string };
  customers?:   { segments?: string[]; painPoints?: string; topUseCases?: string };
  competition?: { differentiation?: string; uniqueStrengths?: string };
  socialProof?: { caseStudies?: string };
}): string {
  const lines: string[] = [];
  if (bc.company?.name)                lines.push(`Company: ${bc.company.name}`);
  if (bc.company?.description)         lines.push(`About: ${bc.company.description}`);
  if (bc.company?.targetRegions)       lines.push(`Markets: ${bc.company.targetRegions.join(', ')}`);
  if (bc.product?.whatItSells)         lines.push(`Product: ${bc.product.whatItSells}`);
  if (bc.product?.keyFeatures)         lines.push(`Features: ${bc.product.keyFeatures}`);
  if (bc.product?.pricingTiers)        lines.push(`Pricing: ${bc.product.pricingTiers}`);
  if (bc.customers?.segments)          lines.push(`Customer segments: ${bc.customers.segments.join(', ')}`);
  if (bc.customers?.painPoints)        lines.push(`Pain points: ${bc.customers.painPoints}`);
  if (bc.customers?.topUseCases)       lines.push(`Top use cases: ${bc.customers.topUseCases}`);
  if (bc.competition?.differentiation) lines.push(`Differentiation: ${bc.competition.differentiation}`);
  if (bc.competition?.uniqueStrengths) lines.push(`Strengths: ${bc.competition.uniqueStrengths}`);
  if (bc.socialProof?.caseStudies)     lines.push(`Case studies: ${bc.socialProof.caseStudies}`);
  return lines.join('\n').slice(0, 2_000);
}

// ── SERP brief formatter (same as blog-generation.job.ts) ─────────────────

function formatSerpBrief(briefJson: string | undefined): string {
  if (!briefJson) return '';
  try {
    const serpRelevance = JSON.parse(briefJson) as Array<{
      title: string; link: string; topic: string;
      pageType: string; titleIntent: string; isRelevantToICP: boolean;
    }>;
    if (!Array.isArray(serpRelevance) || serpRelevance.length === 0) return '';
    const lines = ['Top SERP results for this keyword:'];
    for (const result of serpRelevance.slice(0, 5)) {
      if (!result.isRelevantToICP) continue;
      lines.push(`- "${result.title}" (${result.pageType}, intent: ${result.titleIntent})\n  ${result.link}`);
    }
    return lines.length > 1 ? lines.join('\n').slice(0, 1_500) : '';
  } catch {
    return '';
  }
}

// ── Day check (same as cms-publish.job.ts) ────────────────────────────────

function isTodayAllowedPublishDay(allowedDays: number[]): boolean {
  return allowedDays.includes(new Date().getUTCDay());
}

// ── Main job handler ───────────────────────────────────────────────────────

export async function runContentGenerationJob(
  data: ContentGenerationJobData,
): Promise<void> {
  const { projectId, keywordId } = data;

  logger.info('Content generation job started', { projectId, keywordId });

  // ── 1. Load and validate keyword ─────────────────────────────────────────

  const keyword = await Keyword.findOne({ _id: keywordId, projectId });
  if (!keyword) {
    throw new Error(`Keyword not found: ${keywordId} (projectId: ${projectId})`);
  }

  // Guard — only generate for upcoming keywords
  // If already generating/draft/ready/published, this is a duplicate trigger
  if (keyword.status !== 'upcoming') {
    logger.warn('Content generation skipped — keyword not in upcoming status', {
      projectId,
      keywordId,
      keyword: keyword.keyword,
      status:  keyword.status,
    });
    return;
  }

  // ── 2. Load project and business context ─────────────────────────────────

  const project = await Project.findById(projectId).lean();
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const bc = await BusinessContext.findOne({ projectId }).lean();
  if (!bc) {
    throw new Error(
      `BusinessContext not found for project ${projectId}. ` +
      `Ensure BUSINESS_PROFILE step completed successfully.`,
    );
  }

  // ── 3. Set keyword → generating ──────────────────────────────────────────

  await Keyword.findByIdAndUpdate(keywordId, { $set: { status: 'generating' } });

  logger.info('Keyword status set to generating', {
    projectId,
    keywordId,
    keyword: keyword.keyword,
  });

  try {
    // ── 4. SERP research for this keyword ──────────────────────────────────

    let brief = '';

    try {
      const domainDescription = [
        bc.product?.whatItSells,
        bc.customers?.topUseCases,
        bc.competition?.differentiation,
      ].filter(Boolean).join('\n');

      const countryCode = deriveCountryCodeFromRegions(
        bc.company?.targetRegions as string[] | undefined,
        projectId,
      );

      const serpResults = await searchOrganic(
        keyword.keyword,
        countryCode,
        projectId,
        10,
      );

      const serpResultsText = serpResults.organicResults
        .map((r, idx) =>
          `${idx + 1}. Title: ${r.title}\n   URL: ${r.link}\n   Snippet: ${r.snippet}`
        )
        .join('\n\n');

      if (serpResultsText.trim()) {
        const analysis = await analyzeSerpResults(
          keyword.keyword,
          serpResultsText,
          domainDescription,
          projectId,
        );

        brief = JSON.stringify(analysis.serpRelevance);

        const relevantCount = analysis.serpRelevance.filter(r => r.isRelevantToICP).length;

        await Keyword.findByIdAndUpdate(keywordId, {
          $set: {
            brief,
            relevanceReason: `${relevantCount}/${analysis.serpRelevance.length} top SERP results relevant to ICP.`,
          },
        }, { runValidators: false });

        logger.info('SERP analysis completed', {
          projectId,
          keywordId,
          keyword:       keyword.keyword,
          relevantCount,
          totalResults:  analysis.serpRelevance.length,
        });
      }
    } catch (serpErr) {
      // SERP failure is non-fatal — blog generates without brief (weaker but valid)
      logger.warn('SERP research failed — continuing without brief', {
        projectId,
        keywordId,
        keyword: keyword.keyword,
        error:   serpErr instanceof Error ? serpErr.message : String(serpErr),
      });
    }

    // Rate limit delay between the two LLM calls
    await new Promise(resolve => setTimeout(resolve, LLM_RATE_LIMIT.DELAY_MS));

    // ── 5. Blog generation ────────────────────────────────────────────────

    // Guard — blog already exists (retry scenario)
    const existingBlog = await Blog.findOne({ keywordId }).lean();
    if (existingBlog) {
      logger.warn('Blog already exists for keyword — skipping generation', {
        projectId,
        keywordId,
        blogId: String(existingBlog._id),
      });
      // Jump straight to publish check below
      await handlePublish(projectId, keywordId, String(existingBlog._id), project.domain, existingBlog.status);
      return;
    }

    const customerProfile  = formatBusinessContext(bc);
    const sourceAnalysis   = formatSerpBrief(brief || keyword.brief);
    const contactUrl       = `https://${project.domain}/contact`;

    let knowledgeChunks = '';
    try {
      knowledgeChunks = await loadKnowledgeChunks(projectId);
    } catch {
      // Non-fatal — blog generates without brand context
    }

    logger.info('Calling LLM for blog generation', {
      projectId,
      keywordId,
      keyword:         keyword.keyword,
      hasBrief:        sourceAnalysis.length > 0,
      hasKnowledge:    knowledgeChunks.length > 0,
    });

    const llmResult = await generateBlogPost(
      keyword.keyword,
      customerProfile,
      sourceAnalysis,
      knowledgeChunks,
      contactUrl,
      projectId,
      keywordId,
    );

    // Validate LLM response
    const MIN_CONTENT_LENGTH = 500;
    if (!llmResult.content || llmResult.content.length < MIN_CONTENT_LENGTH) {
      throw new Error(
        `Blog generation returned empty content for keyword "${keyword.keyword}". ` +
        `Got ${llmResult.content?.length ?? 0} chars. BullMQ will retry.`,
      );
    }
    if (!llmResult.title) {
      throw new Error(`Blog generation returned no title for "${keyword.keyword}". BullMQ will retry.`);
    }

    // Build slug
    let slug = llmResult.slug ? sanitizeSlug(llmResult.slug) : keywordToSlug(keyword.keyword);
    const collision = await Blog.findOne({ projectId, slug }).lean();
    if (collision) slug = `${slug}-${Date.now()}`;

    // Create blog
    const blog = await Blog.create({
      projectId,
      keywordId,
      title:       llmResult.title,
      slug,
      description: llmResult.description ?? '',
      content:     llmResult.content,
      status:      'ready',  // Skip 'draft' — user triggered this intentionally
      seoSchema:   llmResult.schema ?? null,
      heroImageUrl: null,
      sourceAnalysis: sourceAnalysis
        ? { serpBrief: sourceAnalysis, keyword: keyword.keyword }
        : null,
      history: [{
        content:     llmResult.content,
        description: llmResult.description ?? '',
        status:      'ready',
        writer:      'ai',
        createdAt:   new Date(),
      }],
    });

    logger.info('Blog created', {
      projectId,
      keywordId,
      blogId:        String(blog._id),
      slug,
      keyword:       keyword.keyword,
      contentLength: llmResult.content.length,
    });

    // Update keyword → ready
    await Keyword.findByIdAndUpdate(keywordId, { $set: { status: 'ready' } });

    // ── 6. CMS publish (if autoPublish enabled) ───────────────────────────

    await handlePublish(projectId, keywordId, String(blog._id), project.domain, 'ready');

  } catch (err) {
    // If anything threw after we set status to 'generating',
    // reset back to 'upcoming' so user can retry
    await Keyword.findByIdAndUpdate(keywordId, { $set: { status: 'upcoming' } });

    logger.error(
      err instanceof Error ? err : new Error(String(err)),
      { projectId, keywordId, context: 'content-generation.job' },
    );

    throw err; // Re-throw so BullMQ handles retry
  }
}

// ── CMS publish helper ─────────────────────────────────────────────────────

async function handlePublish(
  projectId: string,
  keywordId: string,
  blogId:    string,
  domain:    string,
  blogStatus: string,
): Promise<void> {
  // Only publish 'ready' blogs
  if (blogStatus !== 'ready') return;

  const cmsConfig = await CmsConfig.findOne({ projectId })
    .select('+encryptedCredentials')
    .lean();

  if (!cmsConfig || !cmsConfig.cmsType || !cmsConfig.encryptedCredentials) {
    logger.info('No CMS connected — blog stays ready for manual publish', { projectId, blogId });
    return;
  }

  if (!cmsConfig.autoPublish) {
    logger.info('Auto-publish disabled — blog stays ready', { projectId, blogId });
    return;
  }

  const allowedDays = cmsConfig.allowedPublishDays ?? [1, 2, 3, 4, 5, 6];
  if (!isTodayAllowedPublishDay(allowedDays)) {
    logger.info('Today not an allowed publish day — blog stays ready', {
      projectId,
      blogId,
      todayUtc:    new Date().getUTCDay(),
      allowedDays,
    });
    return;
  }

  const blog = await Blog.findById(blogId).lean();
  if (!blog) return;

  const payload: BlogPublishPayload = {
    blogId,
    title:        blog.title,
    slug:         blog.slug,
    description:  blog.description ?? '',
    content:      blog.content ?? '',
    heroImageUrl: blog.heroImageUrl,
    seoSchema:    blog.seoSchema as Record<string, unknown> | undefined,
    blogPostPath: cmsConfig.blogPostPath,
    domain,
  };

  try {
    const result = await publishBlog(cmsConfig, payload, projectId);

    if (!result.success) {
      throw new Error(result.error ?? 'CMS publish returned success:false');
    }

    const now = new Date();
    await Blog.findByIdAndUpdate(blogId, {
      $set: {
        status:           'published',
        cmsReference:     result.cmsReference,
        publishedUrl:     result.publishedUrl,
        publishedDate:    now,
        publishedContent: blog.content ?? '',
      },
      $push: {
        history: {
          $each:  [{ content: blog.content ?? '', status: 'published', writer: 'system', createdAt: now }],
          $slice: -50,
        },
      },
    });

    await Keyword.findByIdAndUpdate(keywordId, { $set: { status: 'published' } });

    logger.info('Blog published to CMS', {
      projectId,
      blogId,
      keywordId,
      cmsType:      cmsConfig.cmsType,
      publishedUrl: result.publishedUrl,
    });

  } catch (publishErr) {
    // Publish failure is non-fatal — blog stays 'ready', user can retry
    logger.error(
      publishErr instanceof Error ? publishErr : new Error(String(publishErr)),
      { projectId, blogId, keywordId, context: 'content-generation.publish' },
    );
  }
}
