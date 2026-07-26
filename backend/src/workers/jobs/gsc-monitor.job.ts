/**
 * workers/jobs/gsc-monitor.job.ts
 *
 * WHAT: Fetches Google Search Console performance data for published blogs,
 *       creates BlogLearning documents for underperforming posts, embeds
 *       them for retrieval, and triggers the actual rewrite (previously
 *       this job created insights and nothing ever acted on them — see
 *       LEARNING_SYSTEM_ARCHITECTURE.md / docs/13-knowledge-learning-system.md).
 *
 * HOW IT WORKS:
 *   1. Load GoogleToken for project — refresh accessToken if expired
 *   2. Load all published blogs for project
 *   3. Call GSC Search Analytics API (REST) for each blog's URL
 *      — last 28 days of clicks, impressions, CTR, average position
 *   3.5. Check any previously auto-applied tag optimization for this blog
 *        for rollback — see checkAndRollbackTagOptimization() below
 *   4. Identify underperforming blogs (high impressions, low CTR OR
 *      ranking drops, OR new query opportunities)
 *   5. Create BlogLearning documents for each fresh (non-deduped) insight
 *   6. Embed each new BlogLearning into ProjectLearningChunk so it becomes
 *      retrievable by lib/vector-search.ts
 *   7. Enqueue workers/jobs/blog-optimization.job.ts for the blog — the
 *      actual rewrite engine, which auto-applies tag changes and proposes
 *      a content rewrite for human review
 *
 * GSC API: REST (no SDK needed — just fetch with Bearer token)
 *   POST https://searchconsole.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
 *
 * TOKEN REFRESH:
 *   GSC access tokens expire every 1 hour. We check expiryDate before calling.
 *   If expired, call Google OAuth token endpoint with refreshToken.
 *   Update GoogleToken in DB with new accessToken + expiryDate.
 *
 * PERFORMANCE THRESHOLDS (industry standard):
 *   HIGH_IMPRESSION_LOW_CTR: impressions > 100, ctr < 0.02 (2%)
 *     → Title/meta description issue — users see but don't click
 *   LOW_POSITION_DROP: avgPosition > 20 AND previous position was better
 *     → Content may be stale or outranked
 *   QUERY_EXPANSION: new queries appearing not in blog's primary keyword
 *     → Opportunity to add a section targeting these queries
 *
 * IDEMPOTENCY:
 *   BlogLearning docs are created fresh each run — time-series data.
 *   We don't upsert — multiple learnings per blog over time is correct
 *   and expected (e.g. a ranking drop this month is a different, real
 *   data point from one two months ago).
 *
 *   DEDUP: we DO skip creating a new doc for a given blog+type if one
 *   already exists within INSIGHT_DEDUP_WINDOW_DAYS (30 days). Without
 *   this, a chronically underperforming post re-triggers the *same*
 *   insight every single week forever, which (a) is noise, and (b) bloats
 *   the context fed to the BlogOptimization LLM pipeline with near-
 *   duplicate insights instead of new signal.
 *
 * ERROR HANDLING:
 *   - Token missing → logs warning, skips (project may have disconnected GSC)
 *   - Token refresh fails → throws → BullMQ retries
 *   - GSC API fails for one blog → logs warn, continues to next
 *   - Zero published blogs → logs, exits cleanly (valid state)
 */

import type { Job } from 'bullmq';
import { Queue }        from 'bullmq';
import { logger }       from '@/open-tele';
import { Project, BlogLearning, BlogOptimization, ProjectLearningChunk, Blog, GoogleToken, Keyword } from '@/models';
import { embedText }    from '@/lib/embeddings';
import { getConnectionOptions } from '@/loaders/redis';
import { QUEUE_NAMES, JOB_RETRY_CONFIG } from '@/constants/seo-pipeline.constants';
import type { BlogOptimizationJobData } from './blog-optimization.job';

const blogOptimizationQueue = new Queue<BlogOptimizationJobData>(
  QUEUE_NAMES.BLOG_OPTIMIZATION,
  { connection: getConnectionOptions() },
);

// Auto-applied tag optimizations are checked for rollback starting this many
// days after they went live (needs at least a week of fresh GSC data to be
// a meaningful comparison, not noise) and stop being checked after this
// many days (an old change that hasn't clearly hurt by now probably isn't
// going to — no point checking forever).
const ROLLBACK_CHECK_MIN_DAYS_AFTER_APPLY = 7;
const ROLLBACK_CHECK_MAX_DAYS_AFTER_APPLY = 35;
// A tag change is considered to have HURT performance if CTR drops by more
// than this fraction relative to the pre-change baseline — small week-to-
// week noise shouldn't trigger a revert, only a real regression.
const ROLLBACK_CTR_DEGRADATION_THRESHOLD = 0.10; // 10% relative drop

// Skip re-creating a BlogLearning for a blog+type pair if one was already
// created within this window. Prevents an unresolved insight (e.g. a
// chronically low-CTR post) from accumulating a near-identical duplicate
// record every single week, forever — these feed the re-optimization LLM
// pipeline (BlogOptimization), so duplicates also mean wasted context, not
// just UI noise. 30 days because these are content-strategy insights meant
// to inform a rewrite, not time-critical alerts — a monthly refresh is
// enough to notice if a chronic issue is still unresolved.
const INSIGHT_DEDUP_WINDOW_DAYS = 30;
import config from '@/utils/config';

// ── Thresholds ─────────────────────────────────────────────────────────────

const HIGH_IMPRESSION_THRESHOLD = 100;   // impressions/28d to be "visible"
const LOW_CTR_THRESHOLD         = 0.02;  // 2% CTR — below this = title problem
const LOW_POSITION_THRESHOLD    = 20;    // avgPosition > 20 = page 2+
const GSC_LOOKBACK_DAYS         = 28;    // 28-day window — standard GSC reporting

// ── Types ──────────────────────────────────────────────────────────────────

interface GscSearchAnalyticsRow {
  keys:        string[];   // [page] or [page, query]
  clicks:      number;
  impressions: number;
  ctr:         number;
  position:    number;
}

interface GscSearchAnalyticsResponse {
  rows?: GscSearchAnalyticsRow[];
}

interface BlogGscMetrics {
  clicks:      number;
  impressions: number;
  ctr:         number;
  avgPosition: number;
  topQueries:  string[];
}

// ── Token refresh ──────────────────────────────────────────────────────────

async function refreshAccessToken(
  refreshToken: string,
  projectId:    string,
): Promise<{ accessToken: string; expiryDate: Date }> {
  logger.debug('Refreshing GSC access token', { projectId });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id: config.google.clientId(),
      client_secret: config.google.clientSecret(),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GSC token refresh failed: ${response.status} ${body}`);
  }

  const data = await response.json() as {
    access_token:  string;
    expires_in:    number;
  };

  const expiryDate = new Date(Date.now() + data.expires_in * 1000);

  logger.info('GSC access token refreshed', { projectId, expiresIn: data.expires_in });

  return { accessToken: data.access_token, expiryDate };
}

// ── GSC API call ───────────────────────────────────────────────────────────

async function fetchGscMetricsForPage(
  siteUrl:     string,
  pageUrl:     string,
  accessToken: string,
  projectId:   string,
): Promise<BlogGscMetrics | null> {
  const endDate   = new Date();
  const startDate = new Date(Date.now() - GSC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const formatDate = (d: Date) => d.toISOString().split('T')[0]!;

  // First call: page-level metrics (clicks, impressions, ctr, position)
  const pageMetricsRes = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        startDate:   formatDate(startDate),
        endDate:     formatDate(endDate),
        dimensions:  ['page'],
        dimensionFilterGroups: [{
          filters: [{
            dimension:  'page',
            operator:   'equals',
            expression: pageUrl,
          }],
        }],
        rowLimit: 1,
      }),
    },
  );

  if (!pageMetricsRes.ok) {
    logger.warn('GSC page metrics fetch failed', {
      projectId,
      pageUrl,
      status: pageMetricsRes.status,
    });
    return null;
  }

  const pageData = await pageMetricsRes.json() as GscSearchAnalyticsResponse;
  const pageRow  = pageData.rows?.[0];

  if (!pageRow) {
    // Page has no GSC data yet — too new or not indexed
    logger.debug('No GSC data for page yet', { projectId, pageUrl });
    return null;
  }

  // Second call: top queries for this page (for query expansion detection)
  const queryMetricsRes = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        startDate:   formatDate(startDate),
        endDate:     formatDate(endDate),
        dimensions:  ['query'],
        dimensionFilterGroups: [{
          filters: [{
            dimension:  'page',
            operator:   'equals',
            expression: pageUrl,
          }],
        }],
        rowLimit:    10,
        orderBy:     [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
      }),
    },
  );

  const topQueries: string[] = [];
  if (queryMetricsRes.ok) {
    const queryData = await queryMetricsRes.json() as GscSearchAnalyticsResponse;
    for (const row of queryData.rows ?? []) {
      if (row.keys[0]) topQueries.push(row.keys[0]);
    }
  }

  return {
    clicks:      pageRow.clicks,
    impressions: pageRow.impressions,
    ctr:         pageRow.ctr,
    avgPosition: pageRow.position,
    topQueries,
  };
}

// ── Rollback check for auto-applied tag optimizations ──────────────────────

/**
 * Reverts a blog's title/description/schema back to their pre-optimization
 * values if an auto-applied tag change appears to have made CTR worse.
 * See blog-optimization.job.ts for why tag changes auto-apply without
 * human review in the first place — this is the safety net that decision
 * depends on.
 *
 * Deliberately conservative: only acts on optimizations that are
 * ROLLBACK_CHECK_MIN_DAYS_AFTER_APPLY to ROLLBACK_CHECK_MAX_DAYS_AFTER_APPLY
 * days old (enough fresh GSC data to mean something, not checked forever),
 * requires a recorded baselineCtr to compare against (no baseline = no
 * check, not treated as a regression), and only reverts on a
 * ROLLBACK_CTR_DEGRADATION_THRESHOLD+ relative drop (week-to-week noise
 * shouldn't trigger a revert).
 */
async function checkAndRollbackTagOptimization(
  projectId: string,
  blogId:    string,
  currentCtr: number,
): Promise<void> {
  const now = new Date();
  const minAppliedBefore = new Date(now.getTime() - ROLLBACK_CHECK_MIN_DAYS_AFTER_APPLY * 24 * 60 * 60 * 1000);
  const maxAppliedAfter  = new Date(now.getTime() - ROLLBACK_CHECK_MAX_DAYS_AFTER_APPLY * 24 * 60 * 60 * 1000);

  const candidate = await BlogOptimization.findOne({
    blogId,
    projectId,
    'seoTagOptimization.appliedAt':   { $lte: minAppliedBefore, $gte: maxAppliedAfter },
    'seoTagOptimization.rolledBackAt': { $exists: false },
  }).sort({ 'seoTagOptimization.appliedAt': -1 });

  if (!candidate?.seoTagOptimization) return;

  const { baselineCtr, originalTitle, originalDescription, originalSchema } = candidate.seoTagOptimization;

  if (typeof baselineCtr !== 'number' || baselineCtr <= 0) {
    logger.debug('Rollback check skipped — no baseline CTR recorded', { projectId, blogId });
    return;
  }

  const relativeDrop = (baselineCtr - currentCtr) / baselineCtr;

  if (relativeDrop < ROLLBACK_CTR_DEGRADATION_THRESHOLD) {
    logger.debug('Rollback check passed — CTR did not regress meaningfully', {
      projectId, blogId, baselineCtr, currentCtr, relativeDrop,
    });
    return;
  }

  logger.warn('Auto-applied tag optimization appears to have hurt CTR — rolling back', {
    projectId, blogId,
    optimizationId: String(candidate._id),
    baselineCtr, currentCtr, relativeDrop,
  });

  const blog = await Blog.findOne({ _id: blogId, projectId });
  if (!blog) {
    logger.warn('Rollback skipped — blog no longer exists', { projectId, blogId });
    return;
  }

  await Blog.findByIdAndUpdate(blogId, {
    $push: {
      history: {
        $each: [{
          content:     blog.content ?? '',
          description: blog.description,
          status:      blog.status,
          writer:      'system',
          createdAt:   now,
        }],
        $slice: -50,
      },
    },
  });

  if (originalTitle !== undefined)       blog.title       = originalTitle;
  if (originalDescription !== undefined) blog.description = originalDescription;
  if (originalSchema !== undefined)      blog.seoSchema    = originalSchema;
  await blog.save();

  candidate.seoTagOptimization.rolledBackAt = now;
  await candidate.save();

  logger.info('Tag optimization rolled back', { projectId, blogId, optimizationId: String(candidate._id) });
}

// ── Learning generation ────────────────────────────────────────────────────

function detectInsights(
  metrics: BlogGscMetrics,
  blog:    { title: string; slug: string; _id: unknown },
  keyword: string,
): Array<{
  type:       string;
  insight:    string;
  evidence:   string;
  category:   string;
  confidence: number;
}> {
  const insights = [];

  // HIGH_IMPRESSION — users see it but don't click
  if (metrics.impressions >= HIGH_IMPRESSION_THRESHOLD && metrics.ctr < LOW_CTR_THRESHOLD) {
    insights.push({
      type:       'high_impression',
      insight:    `This post gets ${metrics.impressions} impressions but only ${(metrics.ctr * 100).toFixed(1)}% CTR — the title or meta description is not compelling enough to drive clicks.`,
      evidence:   `Impressions: ${metrics.impressions}, CTR: ${(metrics.ctr * 100).toFixed(2)}%, Avg Position: ${metrics.avgPosition.toFixed(1)}`,
      category:   'seo',
      confidence: 0.9,
    });
  }

  // LOW_POSITION — ranking on page 2 or worse
  if (metrics.avgPosition > LOW_POSITION_THRESHOLD && metrics.impressions > 20) {
    insights.push({
      type:       'ranking_drop',
      insight:    `This post ranks at position ${metrics.avgPosition.toFixed(1)} on average — it's on page 2 or beyond. Content may be thin, outdated, or outranked by competitors.`,
      evidence:   `Avg Position: ${metrics.avgPosition.toFixed(1)}, Impressions: ${metrics.impressions}, Clicks: ${metrics.clicks}`,
      category:   'content',
      confidence: 0.85,
    });
  }

  // QUERY_EXPANSION — ranking for queries beyond the primary keyword
  const unexpectedQueries = metrics.topQueries.filter(
    q => !q.toLowerCase().includes(keyword.toLowerCase()),
  );
  if (unexpectedQueries.length >= 3) {
    insights.push({
      type:       'query_expansion',
      insight:    `This post is ranking for ${unexpectedQueries.length} queries beyond the primary keyword. Adding dedicated sections for these queries could significantly increase traffic.`,
      evidence:   `Unexpected top queries: ${unexpectedQueries.slice(0, 5).join(', ')}`,
      category:   'content',
      confidence: 0.8,
    });
  }

  return insights;
}

// ── Main job handler ───────────────────────────────────────────────────────

export async function runGscMonitorJob(job: Job<{ projectId: string }>): Promise<void> {
  const { projectId } = job.data;

  logger.info('GSC monitor job started', { projectId, jobId: job.id });

  // 1. Load project
  const project = await Project.findById(projectId).lean();
  if (!project) throw new Error(`Project not found: ${projectId}`);

  // 2. Load GoogleToken
  // select('+accessToken +refreshToken') required now that these are
  // select: false at the schema level (see models/GoogleToken.ts) — this
  // is the one legitimate internal caller that actually needs the real
  // secret values to make GSC API calls and refresh the token.
  const tokenDoc = await GoogleToken.findOne({ projectId }).select('+accessToken +refreshToken');
  if (!tokenDoc) {
    logger.warn('No GSC token found for project — skipping GSC monitor', { projectId });
    return; // Not an error — user may have disconnected GSC
  }

  // 3. Refresh token if expired (with 5 minute buffer)
  let accessToken = tokenDoc.accessToken;
  const bufferMs  = 5 * 60 * 1000;

  if (tokenDoc.expiryDate.getTime() - Date.now() < bufferMs) {
    logger.info('GSC token expiring soon — refreshing', {
      projectId,
      expiryDate: tokenDoc.expiryDate.toISOString(),
    });

    const refreshed = await refreshAccessToken(tokenDoc.refreshToken, projectId);
    accessToken = refreshed.accessToken;

    await GoogleToken.findByIdAndUpdate(tokenDoc._id, {
      accessToken:  refreshed.accessToken,
      expiryDate:   refreshed.expiryDate,
    });
  }

  // 4. Load all published blogs
  const blogs = await Blog.find({ projectId, status: 'published' })
    .select('title slug publishedUrl keywordId')
    .lean();

  if (blogs.length === 0) {
    logger.warn('No published blogs for GSC monitoring', { projectId });
    return;
  }

  logger.info('Published blogs loaded for GSC monitoring', {
    projectId,
    blogCount: blogs.length,
  });

  // 5. Build GSC site URL — GSC uses "sc-domain:example.com" or full URL
  const siteUrl = `sc-domain:${project.domain}`;

  // 6. Fetch GSC metrics for each blog + generate learnings
  let processedCount = 0;
  let learningCount  = 0;
  let skipCount      = 0;

  for (const blog of blogs) {
    const blogId  = String(blog._id);
    const pageUrl = blog.publishedUrl ?? `https://${project.domain}/${blog.slug}`;

    logger.debug('Fetching GSC metrics for blog', {
      projectId,
      blogId,
      pageUrl,
    });

    try {
      const metrics = await fetchGscMetricsForPage(
        siteUrl,
        pageUrl,
        accessToken,
        projectId,
      );

      if (!metrics) {
        skipCount++;
        continue; // No GSC data yet for this page
      }

      // ── Rollback check for previously auto-applied tag optimizations ────
      // blog-optimization.job.ts auto-applies seoTagOptimization changes
      // without human review (see that file for the risk-tiering rationale).
      // This is the safety net that makes that defensible: if CTR got
      // meaningfully WORSE after the change, revert using the exact
      // original values already stored on the BlogOptimization record.
      await checkAndRollbackTagOptimization(projectId, blogId, metrics.ctr);

      processedCount++;

      logger.debug('GSC metrics fetched for blog', {
        projectId,
        blogId,
        slug:        blog.slug,
        clicks:      metrics.clicks,
        impressions: metrics.impressions,
        ctr:         metrics.ctr,
        avgPosition: metrics.avgPosition,
        topQueries:  metrics.topQueries.length,
      });

      // Load actual keyword string — more accurate than slug approximation
      // Falls back to slug-derived string if keywordId missing (older blogs)
      let keyword = blog.slug.replace(/-/g, ' ');
      if (blog.keywordId) {
        try {
          const kw = await Keyword.findById(blog.keywordId).select('keyword').lean();
          if (kw?.keyword) keyword = kw.keyword;
        } catch {
          // Non-fatal — fall back to slug
        }
      }

      // Detect insights
      const insights = detectInsights(metrics, blog, keyword);

      if (insights.length === 0) {
        logger.debug('No insights detected for blog', { projectId, blogId });
        continue;
      }

      // Dedup: skip insight types already recorded recently for this blog,
      // so a chronic issue doesn't accumulate a fresh near-identical doc
      // every week forever. See INSIGHT_DEDUP_WINDOW_DAYS above.
      const dedupSince = new Date(Date.now() - INSIGHT_DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const recentTypes = await BlogLearning.find({
        blogId,
        type: { $in: insights.map((i) => i.type) },
        createdAt: { $gte: dedupSince },
      }).distinct('type');
      const recentTypeSet = new Set(recentTypes as string[]);

      const freshInsights = insights.filter((i) => !recentTypeSet.has(i.type));

      if (freshInsights.length === 0) {
        logger.debug('All detected insights already recorded recently — skipping', {
          projectId,
          blogId,
          skippedTypes: insights.map((i) => i.type),
        });
        continue;
      }

      // Create BlogLearning docs for each fresh insight
      const learningDocs = freshInsights.map((insight) => ({
        blogId:    blog._id,
        projectId,
        type:      insight.type,
        insight:   insight.insight,
        evidence:  insight.evidence,
        category:  insight.category,
        confidence: insight.confidence,
        keyword,
        gscSnapshot: {
          clicks:      metrics.clicks,
          impressions: metrics.impressions,
          ctr:         metrics.ctr,
          avgPosition: metrics.avgPosition,
          periodStart: new Date(Date.now() - GSC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
          periodEnd:   new Date(),
          topQueries:  metrics.topQueries,
        },
      }));

      const createdLearnings = await BlogLearning.insertMany(learningDocs);
      learningCount += createdLearnings.length;

      logger.info('BlogLearning docs created', {
        projectId,
        blogId,
        insightCount: freshInsights.length,
        types:        freshInsights.map(i => i.type),
      });

      // Embed each new learning so it becomes retrievable by
      // lib/vector-search.ts (sourceType: "learning") — without this step
      // the insight sits in BlogLearning forever but blog-optimization.job.ts
      // (and any future blog generation) can never find it via hybrid search.
      // Embedding failure here is non-fatal — the BlogLearning record itself
      // is already saved; a chunk that fails to embed just isn't retrievable
      // yet, same degraded-but-not-lost philosophy as everywhere else this
      // system embeds something.
      for (const learning of createdLearnings) {
        try {
          const embeddingInputText = `${learning.insight}\n\nEvidence: ${learning.evidence}`;
          const embedding = await embedText(embeddingInputText);
          await ProjectLearningChunk.create({
            projectId,
            sourceType:          'learning',
            content:             learning.insight,
            embeddingInputText,
            embedding,
            blogId:              learning.blogId,
            learningId:          learning._id,
            confidence:          learning.confidence,
            keyword:             learning.keyword,
          });
        } catch (err) {
          logger.warn('Failed to embed BlogLearning — insight saved but not yet retrievable by vector search', {
            projectId, blogId,
            learningId: String(learning._id),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Trigger the actual rewrite — this is the step that was completely
      // missing before: BlogLearning insights got created and then nothing
      // ever acted on them. See workers/jobs/blog-optimization.job.ts.
      await blogOptimizationQueue.add(
        'optimize-blog',
        {
          projectId,
          blogId,
          keyword,
          learningIds: createdLearnings.map(l => String(l._id)),
        },
        {
          attempts: JOB_RETRY_CONFIG.BLOG_OPTIMIZATION.attempts,
          backoff:  { type: 'exponential', delay: JOB_RETRY_CONFIG.BLOG_OPTIMIZATION.backoffDelay },
        },
      );

    } catch (err) {
      logger.warn('GSC metrics fetch failed for blog — skipping', {
        projectId,
        blogId,
        pageUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('GSC monitor job completed', {
    projectId,
    jobId:         job.id,
    totalBlogs:    blogs.length,
    processedCount,
    skipCount,
    learningCount,
  });
}
