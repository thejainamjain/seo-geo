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
  | 'KEYWORD_RESEARCH';

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
  blogWriterInstruction?: string;
  // Note: no heroImageMode / defaultHeroImageUrl fields — hero image
  // resolution is always: the project's uploaded image pool first (see
  // ProjectImage / the hero-images endpoints below), then the fallback
  // mode below.
  brandColor?:            string;
  useDefaultBlogTheme?:   boolean;
  heroImageFallbackMode?: 'unsplash' | 'text_card';
  createdAt:           string;
  updatedAt:           string;
}

// ── Project image pool ───────────────────────────────────────────────────
// Uploaded once in Settings ("Image configuration"); primary source for
// blog hero images, claimed one-per-blog. Unsplash is the fallback once
// this pool has nothing 'available' left. See backend lib/hero-image-pool.ts.

export interface ProjectImage {
  _id:           string;
  projectId:     string;
  url:           string;
  status:        'available' | 'used';
  usedByBlogId?: string;
  usedAt?:       string;
  createdAt:     string;
  updatedAt:     string;
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
  _id:           string;
  projectId:     string;
  keywordId?:    string;
  title:         string;
  slug:          string;
  description?:  string;
  content?:      string;   // excluded from list, present on getOne
  status:        BlogStatus;
  heroImageUrl?: string;
  publishedUrl?: string;
  publishedDate?: string;
  seoSchema?:    Record<string, unknown>;
  history?:      BlogHistoryEntry[];  // excluded from list, present on getOne
  createdAt:     string;
  updatedAt:     string;
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
    checkTotals?:       Record<string, number>;
    score?:             number;
    scoreReasoning?:    string;
  };
  /** Score of the previous completed audit, if one exists — null if this
   *  is the project's first-ever completed audit (see
   *  audit.service.ts's getLatestAudit for why this isn't fabricated). */
  previousScore: number | null;
  performedAt:  string;
  completedAt?: string;
}

// ── Keyword ───────────────────────────────────────────────────────────────

export type KeywordStatus = 'upcoming' | 'generating' | 'draft' | 'ready' | 'published';

export interface Keyword {
  _id:            string;
  projectId:      string;
  keyword:        string;
  searchVolume:   number;
  difficulty:     number;
  cpc?:           number;        // cost per click from DataForSEO
  alignmentScore: number;
  status:         KeywordStatus;
  relevanceReason?: string;
  weekNumber?:    number;        // content calendar week
  startDate?:     string;        // ISO date string
  pillar?:        string;
  pageType?:      'blog' | 'landing_page' | 'product' | 'comparison';
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

export interface CodeChangeTypeCounts {
  auditReady:    boolean;
  total:         number;
  activeTotal:   number;
  disabledTotal: number;
  byType: Record<string, { pending: number; applied: number; disabled: number; failed: number }>;
}

// ── Analytics ────────────────────────────────────────────────────────────

export interface AnalyticsSummary {
  pages:    number;
  seoFixes: number;
  schemas:  number;
  ranked:   number;
}

export interface PerformanceOverviewPoint {
  date:        string;
  clicks:      number;
  impressions: number;
}

export interface PerformanceOverview {
  hasData: boolean;
  series:  PerformanceOverviewPoint[];
}

export interface TopMover {
  keyword:      string;
  position:     number;
  prevPosition: number;
  delta:        number;
}

export interface TopMovers {
  hasData: boolean;
  movers:  TopMover[];
}

export interface KeywordPerformanceRow {
  keyword:      string;
  searchVolume: number | null;
  position:     number;
  clicks:       number;
  impressions:  number;
  ctr:          number;
  date:         string;
}

export interface KeywordPerformance {
  hasData: boolean;
  rows:    KeywordPerformanceRow[];
  total:   number;
  page:    number;
  limit:   number;
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

export interface CompetitorEntry {
  domain:   string;
  source:   'user' | 'ai' | 'serp';
  verified: boolean;
  addedAt:  string;
}

export interface BusinessContext {
  _id:        string;
  projectId:  string;
  // Steps the AI has auto-drafted (not yet human-reviewed) vs steps the
  // user has actually confirmed via the onboarding wizard. Previously a
  // single completedSteps field conflated the two — see
  // backend/docs/02-phase2-business-profile-audit.md.
  aiDraftedSteps: number[];
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
    // Backend wraps plain domain strings submitted by the wizard into
    // this structured shape (see project.service.ts's saveOnboardingStep)
    // so manually-entered competitors carry provenance and can merge with
    // later SERP-discovered ones instead of being overwritten.
    mainCompetitors?: CompetitorEntry[];
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

export interface FAQ {
  _id:       string;
  projectId: string;
  sourceUrl: string;
  status:    'pending' | 'applied' | 'disabled' | 'failed';
  questions?: Array<{ question: string; answer: string }>;
  oldHtml?:  string;
  newHtml?:  string;
  createdAt: string;
  appliedAt?: string;
}
 
export interface TLDR {
  _id:       string;
  projectId: string;
  sourceUrl: string;
  status:    'pending' | 'applied' | 'disabled' | 'failed';
  tldrText?: string;
  oldHtml?:  string;
  newHtml?:  string;
  createdAt: string;
  appliedAt?: string;
}

// ── Knowledge files ───────────────────────────────────────────────────────

export type KnowledgeFileStatus = 'pending' | 'processing' | 'ready' | 'error';

export interface KnowledgeFile {
  _id:          string;
  projectId:    string;
  originalName: string;
  mimeType:     string;
  sizeBytes:    number;
  storageUrl:   string;
  status:       KnowledgeFileStatus;
  errorMessage?: string;
  // AI classification results — set once status reaches 'ready'
  classifiedDocumentKind?:  string;
  classifiedUsageTags?:     string[];
  classifiedAudience?:      string;
  classifiedTrustLevel?:    string;
  classificationReasoning?: string;
  classifiedAt?:            string;
  createdAt: string;
  updatedAt: string;
}

// ── Content optimization review queue ───────────────────────────────────

export type OptimizationStatus = 'pending_review' | 'applied' | 'rejected';

// The populated blogId — only title/slug/status on the list endpoint;
// content/description are also populated on the single-optimization getOne.
export interface OptimizationBlogRef {
  _id:         string;
  title:       string;
  slug:        string;
  status:      BlogStatus;
  content?:    string;
  description?: string;
}

export interface ContentOptimizationProposal {
  originalContent:  string;
  optimizedContent: string;
  changesSummary:   string;   // plain-language summary of what changed and why
  learningIds:      string[];
}

export interface SeoTagOptimizationProposal {
  originalTitle?:        string;
  optimizedTitle?:       string;
  originalDescription?:  string;
  optimizedDescription?: string;
  originalSchema?:       Record<string, unknown>;
  optimizedSchema?:      Record<string, unknown>;
  baselineCtr?:          number;
  appliedAt?:            string;   // set once this tier auto-applied
  rolledBackAt?:         string;   // set if GSC performance got worse after
}

export interface Optimization {
  _id:        string;
  blogId:     OptimizationBlogRef;
  projectId:  string;
  // Present only if this run proposed a content rewrite (needs review).
  contentOptimization?: ContentOptimizationProposal;
  // Present only if this run proposed a tag/meta change (auto-applied already).
  seoTagOptimization?:  SeoTagOptimizationProposal;
  // True if a content approval hasn't been pushed to the live CMS post yet.
  cmsResyncPending?: boolean;
  status:     OptimizationStatus;
  createdAt:  string;
}

// ── Google Search Console ─────────────────────────────────────────────────

export interface GscStatus {
  connected:  boolean;
  expiryDate: string | null;
}

// ── Free audit tool (public, no auth) ─────────────────────────────────────

export type AuditLeadBusinessType = 'over_150k' | 'under_150k' | 'agency';

export interface FreeAuditPayload {
  domain:       string;
  email:        string;
  firstName:    string;
  businessType: AuditLeadBusinessType;
}

export interface FreeAuditResult {
  message: string;
}

// ── Home dashboard ───────────────────────────────────────────────────────
// Mirrors backend/src/services/dashboard.service.ts's getHome() response.
// See that file for what's real vs. deliberately omitted (no fabricated
// "visitors" or "AI mention %" projections — no backend source exists).

export interface DashboardGrowthPoint {
  week:                    number;
  cumulativeSearchVolume:  number;
  cumulativeKeywordCount:  number;
}

export type ActivityType =
  | 'SITE_CRAWL'
  | 'BUSINESS_PROFILE'
  | 'TECHNICAL_AUDIT'
  | 'COMPETITOR_DISCOVERY'
  | 'KEYWORD_RESEARCH'
  | 'GEO_ANALYTICS'
  | 'CONTENT_GENERATED';

export interface CompletedActivityItem {
  type:        ActivityType;
  title:       string;
  lastUpdated: string;
}

export interface QueuedActivityItem {
  title: string;
  dueAt: string | null;
  /** Server-owned explanation for why dueAt is null (e.g. "Awaiting your
   *  review" vs "Not yet scheduled") — don't infer meaning from null on
   *  the frontend, the two cases mean different things. */
  note: string | null;
}

export interface GeoVisibilityPoint {
  periodIndex:         number;
  objectivePercentage: number;
  runAt:               string;
}

export interface DashboardHome {
  searchOpportunity: {
    monthlySearchVolume:  number;
    trackedKeywordCount:  number;
  };
  growthTimeline:       DashboardGrowthPoint[];
  /** Real measured history, not a projection — see
   *  backend/src/services/dashboard.service.ts. */
  geoVisibilityHistory: GeoVisibilityPoint[];
  activity: {
    queued:    QueuedActivityItem[];
    completed: CompletedActivityItem[];
  };
}