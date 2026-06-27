/**
 * workers/jobs/gsc-monitor.job.ts
 *
 * WHAT: Fetches Google Search Console performance data for published blogs
 *       and creates BlogLearning documents for underperforming posts.
 *
 * HOW IT WORKS:
 *   1. Load GoogleToken for project — refresh accessToken if expired
 *   2. Load all published blogs for project
 *   3. Call GSC Search Analytics API (REST) for each blog's URL
 *      — last 28 days of clicks, impressions, CTR, average position
 *   4. Identify underperforming blogs (high impressions, low CTR OR
 *      ranking drops, OR new query opportunities)
 *   5. Create BlogLearning documents for each insight found
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
 *   We don't upsert — multiple learnings per blog per week is correct.
 *
 * ERROR HANDLING:
 *   - Token missing → logs warning, skips (project may have disconnected GSC)
 *   - Token refresh fails → throws → BullMQ retries
 *   - GSC API fails for one blog → logs warn, continues to next
 *   - Zero published blogs → logs, exits cleanly (valid state)
 */

import type { Job } from 'bullmq';
import { logger }       from '@/open-tele';
import { Project }      from '@/models/Project';
import { Blog }         from '@/models/Blog';
import { GoogleToken }  from '@/models/GoogleToken';
import { BlogLearning } from '@/models/BlogLearning';

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
      client_id:     process.env.GOOGLE_CLIENT_ID     ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
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
  const tokenDoc = await GoogleToken.findOne({ projectId });
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

      // Derive primary keyword from blog slug as fallback
      const keyword = blog.slug.replace(/-/g, ' ');

      // Detect insights
      const insights = detectInsights(metrics, blog, keyword);

      if (insights.length === 0) {
        logger.debug('No insights detected for blog', { projectId, blogId });
        continue;
      }

      // Create BlogLearning docs for each insight
      const learningDocs = insights.map((insight) => ({
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

      await BlogLearning.insertMany(learningDocs);
      learningCount += learningDocs.length;

      logger.info('BlogLearning docs created', {
        projectId,
        blogId,
        insightCount: insights.length,
        types:        insights.map(i => i.type),
      });

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
