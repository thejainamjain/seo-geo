// lib/api/index.ts
import { apiClient } from './client';
import type {
  AuthResponse,
  Project,
  PipelineStatus,
  ResumeResult,
  PipelineStep,
  Blog,
  BlogStatus,
  CodeChange,
  Audit,
  Keyword,
  GeoRun,
  BusinessContext, 
  SaveOnboardingStepResult, 
  StartPipelineResult, 
  CmsConfig, 
  CmsConnectPayload, 
  CmsUpdatePayload } from '@/types/api';

// ── Auth ──────────────────────────────────────────────────────────────────

export const authApi = {
  login: (email: string, password: string) =>
    apiClient.post<AuthResponse>('/auth/login', { email, password }).then(r => r.data),

  register: (name: string, email: string, password: string) =>
    apiClient.post<AuthResponse>('/auth/register', { name, email, password }).then(r => r.data),
};

// ── Projects ──────────────────────────────────────────────────────────────

export const projectsApi = {
  list: () =>
  apiClient.get<{ projects: Project[] }>('/projects').then(r => r.data.projects),

  get: (projectId: string) =>
    apiClient.get<Project>(`/projects/${projectId}`).then(r => r.data),

  create: (domain: string) =>
    apiClient.post<{ project: Project }>('/projects', { domain }).then(r => r.data.project),

  getBusinessContext: (projectId: string) =>
    apiClient.get<{ businessContext: BusinessContext | null }>(`/projects/${projectId}/business`)
      .then(r => r.data.businessContext),

  saveOnboardingStep: (projectId: string, step: 1|2|3|4|5, data: Record<string, unknown>) =>
    apiClient.post<SaveOnboardingStepResult>(`/projects/${projectId}/onboarding/step`, { step, data })
      .then(r => r.data),

  startPipeline: (projectId: string) =>
    apiClient.post<StartPipelineResult>(`/projects/${projectId}/pipeline/start`)
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
  // GET /projects/:projectId/blogs  →  { blogs, total, page, limit }
  // Note: list response omits content, history, publishedContent, sourceAnalysis
  list: (projectId: string, status?: BlogStatus) =>
    apiClient
      .get<{ blogs: Blog[]; total: number; page: number; limit: number }>(
        `/projects/${projectId}/blogs`,
        { params: status ? { status } : undefined },
      )
      .then(r => r.data.blogs),
 
  // GET /projects/:projectId/blogs/:blogId  →  { blog: Blog }
  // Full blog document including content and history
  get: (projectId: string, blogId: string) =>
    apiClient
      .get<{ blog: Blog }>(`/projects/${projectId}/blogs/${blogId}`)
      .then(r => r.data.blog),
 
  // PATCH /projects/:projectId/blogs/:blogId  →  { blog: Blog }
  updateStatus: (projectId: string, blogId: string, status: BlogStatus) =>
    apiClient
      .patch<{ blog: Blog }>(`/projects/${projectId}/blogs/${blogId}`, { status })
      .then(r => r.data.blog),
};

// ── Audit ─────────────────────────────────────────────────────────────────

export const auditApi = {
  latest: (projectId: string) =>
    apiClient.get<Audit>(`/projects/${projectId}/audit/latest`).then(r => r.data),

  codeChanges: (projectId: string, params?: { type?: string; status?: string }) =>
    apiClient.get<CodeChange[]>(`/projects/${projectId}/audit/changes`, { params }).then(r => r.data),
};

// ── Keywords ──────────────────────────────────────────────────────────────

export const keywordsApi = {
  list: (projectId: string) =>
    apiClient.get<{ keywords: Keyword[] }>(`/projects/${projectId}/keywords`).then(r => r.data.keywords),
};

// ── GEO ───────────────────────────────────────────────────────────────────

export const geoApi = {
  runs: (projectId: string) =>
    apiClient.get<GeoRun[]>(`/projects/${projectId}/geo`).then(r => r.data),
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