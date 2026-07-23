export const PIPELINE_STEP = {
  SITE_CRAWL:           'SITE_CRAWL',
  BUSINESS_PROFILE:     'BUSINESS_PROFILE',
  TECHNICAL_AUDIT:      'TECHNICAL_AUDIT',
  COMPETITOR_DISCOVERY: 'COMPETITOR_DISCOVERY',
  KEYWORD_RESEARCH:     'KEYWORD_RESEARCH',
  SERP_RESEARCH:        'SERP_RESEARCH',
  BLOG_GENERATION:      'BLOG_GENERATION',
  CMS_PUBLISH:          'CMS_PUBLISH',
  GEO_ANALYTICS:        'GEO_ANALYTICS',
  GSC_MONITOR:          'GSC_MONITOR',
} as const

export type PipelineStep = typeof PIPELINE_STEP[keyof typeof PIPELINE_STEP]

/**
 * PIPELINE_SEQUENCE defines the linear auto-chained steps.
 *
 * SERP_RESEARCH, BLOG_GENERATION, CMS_PUBLISH are intentionally removed.
 * They now run on-demand per keyword via the content-generation worker.
 * See: src/workers/jobs/content-generation.job.ts
 * Triggered by: POST /api/v1/projects/:projectId/keywords/:keywordId/generate
 */
export const PIPELINE_SEQUENCE: PipelineStep[] = [
  'SITE_CRAWL',
  'BUSINESS_PROFILE',
  'TECHNICAL_AUDIT',
  'COMPETITOR_DISCOVERY',
  'KEYWORD_RESEARCH',
  // Pipeline ends here. User triggers content generation per keyword.
]

export const PIPELINE_STEP_STATUS = {
  PENDING:   'PENDING',
  RUNNING:   'RUNNING',
  COMPLETED: 'COMPLETED',
  ERRORED:   'ERRORED',
} as const

export const AUDIT_STATUS = {
  IN_PROGRESS: 'IN_PROGRESS',
  CRAWLED:     'CRAWLED',
  FINISHED:    'FINISHED',
  ERRORED:     'ERRORED',
} as const

export const CMS_PLATFORMS = {
  WORDPRESS:   'wordpress',
  SHOPIFY:     'shopify',
  WEBFLOW:     'webflow',
  WIX:         'wix',
  SQUARESPACE: 'squarespace',
  FRAMER:      'framer',
  SANITY:      'sanity',
} as const

export const QUEUE_NAMES = {
  SEO_PIPELINE:        'seo-pipeline',
  BLOG_GENERATION:     'seo-blog-generation',
  GEO_ANALYTICS:       'seo-geo-analytics',
  GSC_MONITOR:         'seo-gsc-monitor',
  CMS_PUBLISH_CRON: 'seo-cms-publish',
  CONTENT_GENERATION:  'seo-content-generation',  // on-demand per-keyword SERP+Blog+Publish
  WEEKLY_GENERATION_TRIGGER: 'seo-weekly-generation-trigger', // per-project, per-week — fans out to CONTENT_GENERATION
} as const

export const CODE_CHANGE_TYPE = {
  H1_PROMOTION:         'H1_PROMOTION',
  H1_DEMOTION:          'H1_DEMOTION',
  ADD_LINK_TARGET:      'ADD_LINK_TARGET',
  ADD_LINK_TITLE:       'ADD_LINK_TITLE',
  OPTIMIZE_DESCRIPTION: 'OPTIMIZE_DESCRIPTION',
  OPTIMIZE_TITLE:       'OPTIMIZE_TITLE',
  ADD_OG_SITE_TAG:      'ADD_OG_SITE_TAG',
  META_VIEWPORT:        'META_VIEWPORT',
  LINK_CANONICAL:       'LINK_CANONICAL',
  ADD_ALT_TAG:          'ADD_ALT_TAG',
  BROKEN_LINKS:         'BROKEN_LINKS',
  INTERNAL_LINKS:       'INTERNAL_LINKS',
  SCHEMA:               'SCHEMA',
} as const

export const CODE_CHANGE_SEVERITY = {
  HIGH:   'HIGH',
  MEDIUM: 'MEDIUM',
  LOW:    'LOW',
} as const

export const CODE_CHANGE_SEVERITY_WEIGHT: Record<string, number> = {
  HIGH:   3,
  MEDIUM: 2,
  LOW:    1,
}

/**
 * BullMQ job priorities — lower number = higher priority.
 * SITE_CRAWL is highest here: unblocks all downstream pipeline steps.
 * BLOG_GENERATION is lowest: heavy background work, not time-sensitive.
 *
 * NOTE: CMS_PUBLISH has no entry here — it's not enqueued via this constant.
 * global-scheduler.job.ts enqueues CMS_PUBLISH_CRON jobs with its own
 * hardcoded { attempts: 3, backoff: { delay: 30_000 } }, since it fans out
 * per-project from a cron trigger rather than following the linear pipeline.
 */
export const JOB_PRIORITY = {
  SITE_CRAWL:           2,
  BUSINESS_PROFILE:     3,
  TECHNICAL_AUDIT:      3,
  COMPETITOR_DISCOVERY: 3,
  KEYWORD_RESEARCH:     3,
  SERP_RESEARCH:        3,
  GEO_ANALYTICS:        4,
  GSC_MONITOR:          4,
  BLOG_GENERATION:      5,
  CONTENT_GENERATION:   3,  // on-demand — treat same priority as pipeline steps
} as const satisfies Record<string, number>

/**
 * Retry configuration per pipeline step.
 * Steps that call external APIs get more retries with longer backoff.
 * SITE_CRAWL gets fewer retries — if the site is down, retrying many times wastes time.
 */
export const JOB_RETRY_CONFIG: Record<string, { attempts: number; backoffDelay: number }> = {
  SITE_CRAWL:           { attempts: 2,  backoffDelay: 5_000  },
  BUSINESS_PROFILE:     { attempts: 3,  backoffDelay: 10_000 },
  TECHNICAL_AUDIT:      { attempts: 3,  backoffDelay: 10_000 },
  COMPETITOR_DISCOVERY: { attempts: 3,  backoffDelay: 15_000 },
  KEYWORD_RESEARCH:     { attempts: 4,  backoffDelay: 15_000 },
  SERP_RESEARCH:        { attempts: 4,  backoffDelay: 15_000 },
  BLOG_GENERATION:      { attempts: 4,  backoffDelay: 30_000 },
  GEO_ANALYTICS:        { attempts: 3,  backoffDelay: 15_000 },
  GSC_MONITOR:          { attempts: 3,  backoffDelay: 15_000 },
  CONTENT_GENERATION:   { attempts: 3,  backoffDelay: 15_000 },
}

/**
 * LLM rate limit configuration.
 *
 * GEMINI FREE TIER: 15 RPM → one call every 4 seconds.
 * When upgrading to paid plan, change REQUESTS_PER_MINUTE and DELAY_MS here.
 * Every job that calls LLM sequentially imports this — one place to change.
 *
 * DELAY_MS = Math.ceil(60_000 / REQUESTS_PER_MINUTE) + 500ms buffer.
 * The buffer prevents hitting the limit exactly on the boundary.
 */
export const LLM_RATE_LIMIT = {
  REQUESTS_PER_MINUTE: 15,
  DELAY_MS:            4_500, // 60000/15 = 4000 + 500ms safety buffer
} as const

/**
 * Technical audit LLM configuration.
 * Controls how many pages are processed per batch before sleeping.
 * On free tier: process 1 page at a time (1 LLM call per page).
 * On paid tier: increase PAGES_PER_BATCH to parallelise.
 */
export const TECHNICAL_AUDIT_CONFIG = {
  PAGES_PER_BATCH:    1,    // Process N pages before sleeping — increase on paid plan
  MAX_ALT_TEXT_IMGS:  10,   // Cap: only generate alt text for first N missing-alt images per page
  MAX_FAQ_QUESTIONS:  5,    // Cap: max FAQ Q&A pairs per page
  MAX_LINK_TITLES:    20,   // Cap: only generate titles for first N missing-title links per page
} as const
