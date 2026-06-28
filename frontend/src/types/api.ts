// types/api.ts
// Mirrors backend response shapes exactly — never infer from component props

// ── Auth ──────────────────────────────────────────────────────────────────

export interface User {
  _id:   string;
  email: string;
  name:  string;
}

export interface AuthResponse {
  token: string;
  user:  User;
}

// ── Pipeline ──────────────────────────────────────────────────────────────

export type PipelineStepStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'ERRORED';

export type PipelineStep =
  | 'SITE_CRAWL'
  | 'BUSINESS_PROFILE'
  | 'TECHNICAL_AUDIT'
  | 'COMPETITOR_DISCOVERY'
  | 'KEYWORD_RESEARCH'
  | 'SERP_RESEARCH'
  | 'BLOG_GENERATION'
  | 'CMS_PUBLISH';

export interface PipelineStepState {
  step:        PipelineStep;
  status:      PipelineStepStatus;
  error?:      string;
  startedAt?:  string;
  completedAt?: string;
}

export interface PipelineStatus {
  status:      PipelineStepStatus;
  currentStep: PipelineStep | null;
  steps:       PipelineStepState[];
  canResume:   boolean;
  resumeFrom:  PipelineStep | null;
}

export interface ResumeResult {
  resumed:  boolean;
  fromStep: PipelineStep | null;
  reason:   string;
}

// ── Project ───────────────────────────────────────────────────────────────

export interface Project {
  _id:            string;
  domain:         string;
  organizationId: string;
  pipeline: {
    status:      PipelineStepStatus;
    currentStep: PipelineStep | null;
  };
  isGscConnected:      boolean;
  isCmsConnected:      boolean;
  isOnboardingComplete: boolean;
  createdAt:           string;
  updatedAt:           string;
}

// ── Blog ──────────────────────────────────────────────────────────────────

export type BlogStatus = 'draft' | 'ready' | 'published' | 'archived';

export interface BlogHistoryEntry {
  _id:         string;
  content:     string;
  description?: string;
  status:      BlogStatus;
  writer:      'ai' | 'user' | 'system';
  createdAt:   string;
}

export interface Blog {
  _id:          string;
  projectId:    string;
  keywordId?:   string;
  title:        string;
  slug:         string;
  description?: string;
  content?:     string;
  status:       BlogStatus;
  heroImageUrl?: string;
  publishedUrl?: string;
  publishedDate?: string;
  seoSchema?:   Record<string, unknown>;
  history:      BlogHistoryEntry[];
  createdAt:    string;
  updatedAt:    string;
}

// ── Audit / CodeChange ────────────────────────────────────────────────────

export type CodeChangeStatus = 'pending' | 'applied' | 'disabled' | 'failed';

export interface CodeChange {
  _id:             string;
  projectId:       string;
  auditId:         string;
  url:             string;
  type:            string;
  status:          CodeChangeStatus;
  oldHtml?:        string;
  newHtml?:        string;
  htmlAttributes?: Record<string, string>;
  createdAt:       string;
}

export interface Audit {
  _id:         string;
  projectId:   string;
  status:      'pending' | 'running' | 'completed' | 'failed';
  crawledUrls: string[];
  summary?: {
    totalPages:         number;
    totalFixes:         number;
    totalSchemas:       number;
    totalInternalLinks: number;
    totalFaqs:          number;
    score?:             number;
    scoreReasoning?:    string;
  };
  performedAt:  string;
  completedAt?: string;
}

// ── Keyword ───────────────────────────────────────────────────────────────

export type KeywordStatus = 'upcoming' | 'draft' | 'published';

export interface Keyword {
  _id:            string;
  projectId:      string;
  keyword:        string;
  searchVolume:   number;
  difficulty:     number;
  alignmentScore: number;
  status:         KeywordStatus;
  relevanceReason?: string;
  createdAt:      string;
}

// ── GEO ───────────────────────────────────────────────────────────────────

export interface GeoRun {
  _id:                  string;
  projectId:            string;
  status:               'running' | 'completed' | 'failed';
  objectivePercentage:  number;
  prevObjectivePercentage: number;
  successfulPrompts:    number;
  failedPrompts:        number;
  totalAttempts:        number;
  evaluationPoolSize:   number;
  periodIndex:          number;
  runAt:                string;
  completedAt?:         string;
}

// ── API response wrappers ─────────────────────────────────────────────────

export interface ApiError {
  error: {
    code:    string;
    message: string;
  };
}

export interface PaginatedResponse<T> {
  data:  T[];
  total: number;
  page:  number;
  limit: number;
}

// ── BusinessContext ───────────────────────────────────────────────────────
// Add this to src/types/api.ts

export interface BusinessContext {
  _id:        string;
  projectId:  string;
  completedSteps: number[];
  company?: {
    name?:            string;
    website?:         string;
    description?:     string;
    targetRegions?:   string[];
    primaryLanguage?: string;
    howDidYouHearAboutUs?: string;
  };
  product?: {
    whatItSells?:           string;
    keyFeatures?:           string;
    pricingTiers?:          string;
    freeTrialAvailable?:    boolean | string;
    lifetimeValuePerClient?: string;
  };
  customers?: {
    segments?:       string[];
    painPoints?:     string;
    keywordsTheyUse?: string;
    topUseCases?:    string;
  };
  competition?: {
    mainCompetitors?: string[];
    differentiation?: string;
    uniqueStrengths?: string;
    tradeOffs?:       string;
    proof?:           string;
  };
  socialProof?: {
    caseStudies?:         string;
    organicDiscussions?:  string;
    socialMediaPresence?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface SaveOnboardingStepResult {
  project:         Project;
  businessContext: BusinessContext;
}

export interface StartPipelineResult {
  projectId: string;
  jobId:     string | undefined;
}

// ── CMS ───────────────────────────────────────────────────────────────────────
 
export interface CmsConfig {
  _id:                         string;
  projectId:                   string;
  cmsType?:                    string;   // undefined = not connected
  blogPostPath:                string;   // default "blog"
  autoPublish:                 boolean;
  allowedPublishDays:          number[]; // 1–6, never 0
  publishHourUtc:              number;
  stripTitleAndHeroFromApiBody: boolean;
  createdAt:                   string;
  updatedAt:                   string;
}
 
export interface CmsConnectPayload {
  cmsType:      string;
  credentials:  Record<string, string>;
  blogPostPath?: string;
}
 
export interface CmsUpdatePayload {
  autoPublish?:        boolean;
  allowedPublishDays?: number[];
  blogPostPath?:       string;
}