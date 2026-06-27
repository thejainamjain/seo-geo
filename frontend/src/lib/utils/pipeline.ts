// lib/utils/pipeline.ts
import type { PipelineStep, PipelineStepStatus } from '@/types/api';

export const STEP_META: Record<PipelineStep, { label: string; description: string }> = {
  SITE_CRAWL:           { label: 'Site Crawl',           description: 'Crawling all pages and detecting issues' },
  BUSINESS_PROFILE:     { label: 'Business Profile',     description: 'Understanding your business and market' },
  TECHNICAL_AUDIT:      { label: 'Technical Audit',      description: 'Generating SEO fixes for every page' },
  COMPETITOR_DISCOVERY: { label: 'Competitor Discovery', description: 'Finding who ranks for your keywords' },
  KEYWORD_RESEARCH:     { label: 'Keyword Research',     description: 'Researching and scoring 260 keywords' },
  SERP_RESEARCH:        { label: 'SERP Research',        description: 'Analyzing what already ranks' },
  BLOG_GENERATION:      { label: 'Blog Generation',      description: 'Writing 25 SEO-optimized blog posts' },
  CMS_PUBLISH:          { label: 'CMS Publish',          description: 'Publishing content to your CMS' },
};

export const PIPELINE_SEQUENCE: PipelineStep[] = [
  'SITE_CRAWL',
  'BUSINESS_PROFILE',
  'TECHNICAL_AUDIT',
  'COMPETITOR_DISCOVERY',
  'KEYWORD_RESEARCH',
  'SERP_RESEARCH',
  'BLOG_GENERATION',
  'CMS_PUBLISH',
];

export function getStatusColor(status: PipelineStepStatus): string {
  switch (status) {
    case 'COMPLETED': return 'text-green-500';
    case 'RUNNING':   return 'text-blue-500';
    case 'ERRORED':   return 'text-red-500';
    default:          return 'text-muted-foreground';
  }
}

export function getStatusBadgeVariant(status: PipelineStepStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'COMPLETED': return 'default';
    case 'RUNNING':   return 'secondary';
    case 'ERRORED':   return 'destructive';
    default:          return 'outline';
  }
}

export function getPipelineProgress(steps: Array<{ status: PipelineStepStatus }>): number {
  if (!steps.length) return 0;
  const completed = steps.filter(s => s.status === 'COMPLETED').length;
  return Math.round((completed / steps.length) * 100);
}
