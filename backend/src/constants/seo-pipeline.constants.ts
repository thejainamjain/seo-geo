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

export const PIPELINE_SEQUENCE: PipelineStep[] = [
  'SITE_CRAWL',
  'BUSINESS_PROFILE',
  'TECHNICAL_AUDIT',
  'COMPETITOR_DISCOVERY',
  'KEYWORD_RESEARCH',
  'SERP_RESEARCH',
  'BLOG_GENERATION',
  'CMS_PUBLISH',
  // GEO_ANALYTICS and GSC_MONITOR are NOT linear pipeline steps.
  // They are recurring cron jobs registered after CMS_PUBLISH completes.
  // See: handleCmsPublish in seo-pipeline.worker.ts
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
  SEO_PIPELINE:    'seo-pipeline',
  BLOG_GENERATION: 'seo-blog-generation',
  GEO_ANALYTICS:   'seo-geo-analytics',
  GSC_MONITOR:     'seo-gsc-monitor',
  PUBLISH:         'seo-publish',         // Separate cron-triggered publish queue (Mon–Sat 5PM UTC)
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
 * CMS_PUBLISH is highest: runs in a time-sensitive window (Mon–Sat 5PM UTC).
 * SITE_CRAWL is next: unblocks all downstream steps.
 * BLOG_GENERATION is lowest: heavy background work, not time-sensitive.
 */
export const JOB_PRIORITY = {
  CMS_PUBLISH:          1,
  SITE_CRAWL:           2,
  BUSINESS_PROFILE:     3,
  TECHNICAL_AUDIT:      3,
  COMPETITOR_DISCOVERY: 3,
  KEYWORD_RESEARCH:     3,
  SERP_RESEARCH:        3,
  GEO_ANALYTICS:        4,
  GSC_MONITOR:          4,
  BLOG_GENERATION:      5,
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
  CMS_PUBLISH:          { attempts: 3,  backoffDelay: 20_000 },
  GEO_ANALYTICS:        { attempts: 3,  backoffDelay: 15_000 },
  GSC_MONITOR:          { attempts: 3,  backoffDelay: 15_000 },
}
