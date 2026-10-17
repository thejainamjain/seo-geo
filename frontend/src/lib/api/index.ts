// lib/api/index.ts
import { apiClient } from './client';
import type {
  AuthResponse,
  User,
  Project,
  ProjectImage,
  PipelineStatus,
  ResumeResult,
  PipelineStep,
  Blog,
  BlogStatus,
  CodeChange,
  Audit,
  Keyword,
  GeoRun,
  AnalyticsSummary,
  PerformanceOverview,
  TopMovers,
  KeywordPerformance,
  BusinessContext, 
  SaveOnboardingStepResult, 
  StartPipelineResult, 
  CmsConfig, 
  CmsConnectPayload, 
  CmsUpdatePayload, TLDR, FAQ, CodeChangeTypeCounts,
  KnowledgeFile,
  Optimization,
  OptimizationStatus,
  GscStatus,
  FreeAuditPayload,
  FreeAuditResult,
  DashboardHome,
 } from '@/types/api';

// ── Auth ──────────────────────────────────────────────────────────────────

export const authApi = {
  login: (email: string, password: string) =>
    apiClient.post<AuthResponse>('/auth/login', { email, password }).then(r => r.data),

  register: (name: string, email: string, password: string) =>
    apiClient.post<AuthResponse>('/auth/register', { name, email, password }).then(r => r.data),

  me: () =>
    apiClient.get<{ user: User }>('/auth/me').then(r => r.data.user),

  logout: () =>
    apiClient.post('/auth/logout').then(() => undefined),
};

// ── Projects ──────────────────────────────────────────────────────────────

export const projectsApi = {
  list: () =>
  apiClient.get<{ projects: Project[] }>('/projects').then(r => r.data.projects),

  get: (projectId: string) =>
    apiClient.get<{ project: Project }>(`/projects/${projectId}`).then(r => r.data.project),

  create: (domain: string) =>
    apiClient.post<{ project: Project }>('/projects', { domain }).then(r => r.data.project),

  getBusinessContext: (projectId: string) =>
    apiClient.get<{ businessContext: BusinessContext | null }>(`/projects/${projectId}/business`)
      .then(r => r.data.businessContext),

  saveOnboardingStep: (projectId: string, step: 1|2|3|4|5|6, data: Record<string, unknown>) =>
    apiClient.post<SaveOnboardingStepResult>(`/projects/${projectId}/onboarding/step`, { step, data })
      .then(r => r.data),

  // Business page: partial save of ONE section. Unlike saveOnboardingStep (which
  // replaces whole sub-objects and is meant for the wizard only), this writes
  // just the fields sent.
  saveBusinessSection: (
    projectId: string,
    section:   'company' | 'product' | 'customers' | 'competition' | 'socialProof',
    data:      Record<string, unknown>,
  ) =>
    apiClient.patch<{ saved: true; section: string }>(`/projects/${projectId}/business/${section}`, { data })
      .then(r => r.data),

  startPipeline: (projectId: string) =>
    apiClient.post<StartPipelineResult>(`/projects/${projectId}/pipeline/start`)
      .then(r => r.data),

  // Image configuration — brand color, blog theme toggle, hero image
  // fallback mode. Partial update; only send the field(s) that changed.
  updateSettings: (projectId: string, updates: {
    brandColor?:            string;
    useDefaultBlogTheme?:   boolean;
    heroImageFallbackMode?: 'unsplash' | 'text_card';
  }) =>
    apiClient
      .patch<{ project: Project }>(`/projects/${projectId}/settings`, updates)
      .then(r => r.data.project),

  // Preview-only — does not save. UI should call updateSettings with the
  // returned color if the user confirms it.
  detectBrandColor: (projectId: string) =>
    apiClient
      .post<{ color: string | null }>(`/projects/${projectId}/settings/brand-color/detect`)
      .then(r => r.data.color),

  // Hero image pool ("Image configuration" in Settings) — primary source
  // for blog hero images, no count limit. See routes/api-v1/project.route.ts.
  listPoolImages: (projectId: string) =>
    apiClient
      .get<{ images: ProjectImage[] }>(`/projects/${projectId}/settings/hero-images`)
      .then(r => r.data.images),

  // multipart/form-data — field name must be exactly 'image' (multer config
  // on the backend). Mirrors blogsApi.uploadImage's pattern.
  uploadPoolImage: (projectId: string, file: File) => {
    const formData = new FormData();
    formData.append('image', file);
    return apiClient
      .post<{ image: ProjectImage }>(`/projects/${projectId}/settings/hero-images`, formData)
      .then(r => r.data.image);
  },

  deletePoolImage: (projectId: string, imageId: string) =>
    apiClient
      .delete<{ deleted: boolean }>(`/projects/${projectId}/settings/hero-images/${imageId}`)
      .then(r => r.data),
};

// ── Pipeline ──────────────────────────────────────────────────────────────

export const pipelineApi = {
  status: (projectId: string) =>
    apiClient.get<PipelineStatus>(`/projects/${projectId}/pipeline/status`).then(r => r.data),

  resume: (projectId: string, fromStep?: PipelineStep) =>
    apiClient.post<ResumeResult>(`/projects/${projectId}/pipeline/resume`, { fromStep }).then(r => r.data),
};

// ── Blogs ─────────────────────────────────────────────────────────────────────
 
export const blogsApi = {
  list: async (projectId: string, status?: BlogStatus) => {
    const allBlogs: Blog[] = [];
    let page = 1;
    let total = Infinity;

    while (allBlogs.length < total) {
      const res = await apiClient.get<{ blogs: Blog[]; total: number; page: number; limit: number }>(
        `/projects/${projectId}/blogs`,
        { params: { ...(status ? { status } : {}), page, limit: 100 } },
      );

      allBlogs.push(...res.data.blogs);
      total = res.data.total;
      page++;

      if (res.data.blogs.length === 0) break; // safety exit
    }

    return allBlogs;
  },
 
  get: (projectId: string, blogId: string) =>
    apiClient
      .get<{ blog: Blog }>(`/projects/${projectId}/blogs/${blogId}`)
      .then(r => r.data.blog),
 
  updateStatus: (projectId: string, blogId: string, status: BlogStatus) =>
    apiClient
      .patch<{ blog: Blog }>(`/projects/${projectId}/blogs/${blogId}`, { status })
      .then(r => r.data.blog),
 
  updateContent: (
    projectId: string,
    blogId: string,
    payload: {
      title?: string; description?: string; content?: string;
      heroImageUrl?: string | null; slug?: string; snapshot?: boolean;
    },
  ) =>
    apiClient
      .patch<{ blog: Blog }>(`/projects/${projectId}/blogs/${blogId}`, payload)
      .then(r => r.data.blog),

  // multipart/form-data — field name must be exactly 'image' (multer config
  // on the backend, see routes/api-v1/blog.route.ts). See
  // knowledgeApi.upload's comment above / client.ts's interceptor for why
  // no manual Content-Type handling is needed (or safe to add) here.
  uploadImage: (projectId: string, blogId: string, file: File) => {
    const formData = new FormData();
    formData.append('image', file);
    return apiClient
      .post<{ url: string }>(`/projects/${projectId}/blogs/${blogId}/images`, formData)
      .then(r => r.data.url);
  },
};

// ── Audit ─────────────────────────────────────────────────────────────────
// ── Dashboard ─────────────────────────────────────────────────────────────

export const dashboardApi = {
  getHome: (projectId: string) =>
    apiClient.get<DashboardHome>(`/projects/${projectId}/dashboard`).then(r => r.data),
};

export const auditApi = {
  latest: (projectId: string) =>
    apiClient.get<{ audit: Audit }>(`/projects/${projectId}/audit`).then(r => r.data.audit),
 
  codeChanges: async (projectId: string, params?: { type?: string; status?: string }) => {
    const allChanges: CodeChange[] = [];
    let page = 1;
    let total = Infinity;
 
    while (allChanges.length < total) {
      const res = await apiClient.get<{
        codeChanges: CodeChange[];
        total: number;
        page: number;
        limit: number;
      }>(`/projects/${projectId}/audit/code-changes`, {
        params: { ...params, page, limit: 100 },
      });
 
      allChanges.push(...res.data.codeChanges);
      total = res.data.total;
      page++;
 
      if (res.data.codeChanges.length === 0) break; // safety exit
    }
 
    return allChanges;
  },
 
  faqs: (projectId: string) =>
    apiClient
      .get<{ faqs: FAQ[]; total: number }>(`/projects/${projectId}/audit/faqs`)
      .then(r => r.data.faqs),
 
  tldrs: (projectId: string) =>
    apiClient
      .get<{ tldrs: TLDR[]; total: number }>(`/projects/${projectId}/audit/tldrs`)
      .then(r => r.data.tldrs),

  codeChangeTypeCounts: (projectId: string) =>
    apiClient
      .get<CodeChangeTypeCounts>(`/projects/${projectId}/audit/code-changes/type-counts`)
      .then(r => r.data),

  applyCodeChange: (projectId: string, changeId: string) =>
    apiClient
      .post<{ codeChange: CodeChange }>(`/projects/${projectId}/audit/code-changes/${changeId}/apply`)
      .then(r => r.data.codeChange),

  disableCodeChange: (projectId: string, changeId: string) =>
    apiClient
      .post<{ codeChange: CodeChange }>(`/projects/${projectId}/audit/code-changes/${changeId}/disable`)
      .then(r => r.data.codeChange),
};
// ── Keywords ──────────────────────────────────────────────────────────────

export const keywordsApi = {
  list: async (projectId: string) => {
    const allKeywords: Keyword[] = [];
    let page = 1;
    let total = Infinity;

    while (allKeywords.length < total) {
      const res = await apiClient.get<{
        keywords: Keyword[];
        total:    number;
        page:     number;
        limit:    number;
      }>(`/projects/${projectId}/keywords`, { params: { page, limit: 100 } });

      allKeywords.push(...res.data.keywords);
      total = res.data.total;
      page++;

      if (res.data.keywords.length === 0) break; // safety exit
    }

    return allKeywords;
  },

  generate: (projectId: string, keywordId: string) =>
  apiClient.post<{ status: string; keywordId: string }>(
    `/projects/${projectId}/keywords/${keywordId}/generate`
  ).then(r => r.data),

  add: (projectId: string, keyword: string) =>
    apiClient
      .post<{ keyword: Keyword }>(`/projects/${projectId}/keywords`, { keyword })
      .then(r => r.data.keyword),
};

// ── GEO ───────────────────────────────────────────────────────────────────
export const geoApi = {
  runs: (projectId: string) =>
    apiClient
      .get<{ runs: GeoRun[] }>(`/projects/${projectId}/geo`)
      .then(r => r.data.runs),
};

// ── Analytics ────────────────────────────────────────────────────────────
// NOTE: GEO metrics and Rewrite Queue are NOT here — the Analytics page
// calls geoApi.runs() and optimizationsApi.list() directly, since those
// already exist. See backend/src/services/analytics.service.ts's header
// comment for why this deliberately isn't one monolithic endpoint.
export const analyticsApi = {
  summary: (projectId: string) =>
    apiClient
      .get<AnalyticsSummary>(`/projects/${projectId}/analytics/summary`)
      .then(r => r.data),

  performanceOverview: (projectId: string, days = 14) =>
    apiClient
      .get<PerformanceOverview>(`/projects/${projectId}/analytics/performance-overview`, { params: { days } })
      .then(r => r.data),

  topMovers: (projectId: string, limit = 5) =>
    apiClient
      .get<TopMovers>(`/projects/${projectId}/analytics/top-movers`, { params: { limit } })
      .then(r => r.data),

  keywordPerformance: (projectId: string, params?: { page?: number; limit?: number }) =>
    apiClient
      .get<KeywordPerformance>(`/projects/${projectId}/analytics/keyword-performance`, { params })
      .then(r => r.data),
};


// ── CMS ───────────────────────────────────────────────────────────────────────
 
export const cmsApi = {
  // GET /projects/:projectId/cms  →  { cmsConfig: CmsConfig }
  get: (projectId: string) =>
    apiClient
      .get<{ cmsConfig: CmsConfig }>(`/projects/${projectId}/cms`)
      .then(r => r.data.cmsConfig),
 
  // POST /projects/:projectId/cms/connect  →  { cmsConfig: CmsConfig }
  connect: (projectId: string, payload: CmsConnectPayload) =>
    apiClient
      .post<{ cmsConfig: CmsConfig }>(`/projects/${projectId}/cms/connect`, payload)
      .then(r => r.data.cmsConfig),
 
  // PATCH /projects/:projectId/cms  →  { cmsConfig: CmsConfig }
  update: (projectId: string, payload: CmsUpdatePayload) =>
    apiClient
      .patch<{ cmsConfig: CmsConfig }>(`/projects/${projectId}/cms`, payload)
      .then(r => r.data.cmsConfig),
 
  // DELETE /projects/:projectId/cms/disconnect  →  { message: string }
  disconnect: (projectId: string) =>
    apiClient
      .delete<{ message: string }>(`/projects/${projectId}/cms/disconnect`)
      .then(r => r.data),
};

// ── Knowledge files ─────────────────────────────────────────────────────────

export const knowledgeApi = {
  list: (projectId: string) =>
    apiClient
      .get<{ files: KnowledgeFile[] }>(`/projects/${projectId}/knowledge`)
      .then(r => r.data.files),

  // multipart/form-data — field name must be exactly 'file' (multer config
  // on the backend). Don't set a Content-Type header here yourself — the
  // shared apiClient (lib/api/client.ts) has a request interceptor that
  // strips its default 'application/json' Content-Type specifically for
  // FormData bodies, so axios's adapter can set the correct
  // 'multipart/form-data; boundary=...' itself. (This used to be broken:
  // the instance-level default Content-Type was NOT auto-removed by axios
  // just because the body was FormData, so every upload here was sent as
  // JSON with a multipart body and silently failed server-side — see the
  // client.ts interceptor's comment for the full explanation.)
  upload: (projectId: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return apiClient
      .post<{ file: KnowledgeFile }>(`/projects/${projectId}/knowledge`, formData)
      .then(r => r.data.file);
  },

  remove: (projectId: string, fileId: string) =>
    apiClient
      .delete<{ file: KnowledgeFile }>(`/projects/${projectId}/knowledge/${fileId}`)
      .then(r => r.data.file),
};

// ── Content optimization review queue ────────────────────────────────────────

export const optimizationsApi = {
  // status defaults to 'pending_review' server-side if omitted — i.e. the
  // actual review queue, not full history.
  list: (
    projectId: string,
    params?: { status?: OptimizationStatus; blogId?: string; page?: number; limit?: number },
  ) =>
    apiClient
      .get<{ optimizations: Optimization[]; total: number; page: number; limit: number }>(
        `/projects/${projectId}/optimizations`,
        { params },
      )
      .then(r => r.data),

  get: (projectId: string, optimizationId: string) =>
    apiClient
      .get<{ optimization: Optimization }>(`/projects/${projectId}/optimizations/${optimizationId}`)
      .then(r => r.data.optimization),

  approve: (projectId: string, optimizationId: string) =>
    apiClient
      .patch<{ optimization: Optimization; message: string }>(
        `/projects/${projectId}/optimizations/${optimizationId}/approve`,
      )
      .then(r => r.data),

  reject: (projectId: string, optimizationId: string) =>
    apiClient
      .patch<{ optimization: Optimization; message: string }>(
        `/projects/${projectId}/optimizations/${optimizationId}/reject`,
      )
      .then(r => r.data),
};

// ── Google Search Console ────────────────────────────────────────────────────

export const gscApi = {
  getStatus: (projectId: string) =>
    apiClient.get<{ gsc: GscStatus }>(`/projects/${projectId}/gsc`).then(r => r.data.gsc),

  /**
   * NOT an axios call — this builds the URL for a real browser navigation
   * (`window.location.href = gscApi.getConnectUrl(projectId)` or an
   * `<a href>`), which is why the JWT has to be appended as a query param
   * instead of the usual Authorization header: a full-page redirect can't
   * carry a custom header. The backend route (`GET /gsc/connect`) verifies
   * it there, then 302s to Google's consent screen, then (`GET
   * /gsc/callback`) back to this project's settings page once tokens are
   * stored.
   */
  getConnectUrl: (projectId: string): string => {
    // The browser sends the httpOnly auth cookie on this navigation itself,
    // so no token goes in the URL.
    const baseURL = apiClient.defaults.baseURL ?? '';

    const url = new URL(`${baseURL}/gsc/connect`);
    url.searchParams.set('projectId', projectId);
    return url.toString();
  },

  disconnect: (projectId: string) =>
    apiClient
      .delete<{ message: string }>(`/projects/${projectId}/gsc/disconnect`)
      .then(r => r.data),
};

// ── Free audit tool (public marketing lead-gen tool, no auth) ───────────────

export const toolsApi = {
  runFreeAudit: (payload: FreeAuditPayload) =>
    apiClient.post<FreeAuditResult>('/tools/audit', payload).then(r => r.data),
};
