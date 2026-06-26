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
  'GEO_ANALYTICS',
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