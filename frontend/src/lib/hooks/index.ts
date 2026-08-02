// lib/hooks/index.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/lib/stores/auth.store';
import { useRouter } from 'next/navigation';
import type { BlogStatus, PipelineStep, CmsConnectPayload, CmsUpdatePayload, OptimizationStatus, FreeAuditPayload } from '@/types/api';
import { authApi, projectsApi, pipelineApi, blogsApi, auditApi, keywordsApi, geoApi, cmsApi, knowledgeApi, optimizationsApi, gscApi, toolsApi, dashboardApi } from '@/lib/api';

// ── Auth ──────────────────────────────────────────────────────────────────

export function useLogin() {
  const setAuth  = useAuthStore(s => s.setAuth);
  const router   = useRouter();

  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      authApi.login(email, password),
    onSuccess: (data) => {
      setAuth(data.token, data.user);
      router.push('/projects');
    },
  });
}

export function useRegister() {
  const setAuth = useAuthStore(s => s.setAuth);
  const router  = useRouter();

  return useMutation({
    mutationFn: ({ name, email, password }: { name: string; email: string; password: string }) =>
      authApi.register(name, email, password),
    onSuccess: (data) => {
      setAuth(data.token, data.user);
      router.push('/projects');
    },
  });
}

export function useLogout() {
  const clear       = useAuthStore(s => s.clear);
  const router      = useRouter();
  const queryClient = useQueryClient();   // ← add this

  return () => {
    clear();
    queryClient.clear();                  // ← wipes ALL cached query data
    router.push('/login');
  };
}

// ── Projects ──────────────────────────────────────────────────────────────

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn:  projectsApi.list,
  });
}

export function useProject(projectId: string) {
  return useQuery({
    queryKey: ['projects', projectId],
    queryFn:  () => projectsApi.get(projectId),
    enabled:  !!projectId,
  });
}

// Image configuration — brand color, blog theme toggle, hero image
// fallback mode. Invalidates useProject's cache so every consumer
// (Settings page, onboarding wizard) sees the change immediately.
export function useUpdateProjectSettings(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (updates: {
      brandColor?:            string;
      useDefaultBlogTheme?:   boolean;
      heroImageFallbackMode?: 'unsplash' | 'text_card';
    }) => projectsApi.updateSettings(projectId, updates),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
    },
  });
}

// Preview-only mutation (POST because it does network I/O, but doesn't
// persist) — the caller decides whether to confirm the detected color via
// useUpdateProjectSettings.
export function useDetectBrandColor(projectId: string) {
  return useMutation({
    mutationFn: () => projectsApi.detectBrandColor(projectId),
  });
}

// `waitFor` lets a caller delay the initial fetch until some other
// condition is true (e.g. the onboarding wizard waits for the
// BUSINESS_PROFILE pipeline step to finish before fetching — see
// onboarding/page.tsx). Defaults to true so existing callers that just want
// "fetch as soon as we have a projectId" (Business settings page, Settings
// page) are unaffected.
export function useBusinessContext(projectId: string, waitFor = true) {
  return useQuery({
    queryKey: ['businessContext', projectId],
    queryFn:  () => projectsApi.getBusinessContext(projectId),
    enabled:  !!projectId && waitFor,
  });
}

export function usePoolImages(projectId: string) {
  return useQuery({
    queryKey: ['poolImages', projectId],
    queryFn:  () => projectsApi.listPoolImages(projectId),
    enabled:  !!projectId,
  });
}

export function useUploadPoolImage(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (file: File) => projectsApi.uploadPoolImage(projectId, file),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['poolImages', projectId] });
    },
  });
}

export function useDeletePoolImage(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (imageId: string) => projectsApi.deletePoolImage(projectId, imageId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['poolImages', projectId] });
    },
  });
}

export function useSaveOnboardingStep(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ step, data }: { step: 1|2|3|4|5|6; data: Record<string, unknown> }) =>
      projectsApi.saveOnboardingStep(projectId, step, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['businessContext', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
    },
  });
}

export function useStartPipeline(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => projectsApi.startPipeline(projectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['pipeline', projectId] });
    },
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  const router      = useRouter();

  return useMutation({
    mutationFn: (domain: string) => projectsApi.create(domain),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      // Redirect to onboarding wizard instead of overview
      router.push(`/projects/${project._id}/onboarding`);
    },
  });
}

// ── Pipeline ──────────────────────────────────────────────────────────────

export function usePipelineStatus(projectId: string) {
  return useQuery({
    queryKey:        ['pipeline', projectId],
    queryFn:         () => pipelineApi.status(projectId),
    enabled:         !!projectId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'RUNNING' ? 5_000 : false;
    },
  });
}

export function usePipelineResume(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (fromStep?: PipelineStep) => pipelineApi.resume(projectId, fromStep),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pipeline', projectId] });
    },
  });
}

// ── Blogs ─────────────────────────────────────────────────────────────────

export function useBlogs(projectId: string, status?: BlogStatus) {
  return useQuery({
    queryKey: ['blogs', projectId, status],
    queryFn:  () => blogsApi.list(projectId, status),
    enabled:  !!projectId,
  });
}

export function useBlog(projectId: string, blogId: string) {
  return useQuery({
    queryKey: ['blogs', projectId, blogId],
    queryFn:  () => blogsApi.get(projectId, blogId),
    enabled:  !!projectId && !!blogId,
  });
}

export function useUpdateBlogStatus(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ blogId, status }: { blogId: string; status: BlogStatus }) =>
      blogsApi.updateStatus(projectId, blogId, status),
    onSuccess: (_, { blogId }) => {
      void queryClient.invalidateQueries({ queryKey: ['blogs', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['blogs', projectId, blogId] });
    },
  });
}

export function useUploadBlogImage(projectId: string) {
  return useMutation({
    mutationFn: ({ blogId, file }: { blogId: string; file: File }) =>
      blogsApi.uploadImage(projectId, blogId, file),
    // No cache invalidation — this doesn't change the blog document itself.
    // The editor inserts the returned URL into content; that only becomes
    // a real change (and gets invalidated) when the user saves via
    // useUpdateBlogContent, same as any other in-progress edit.
  });
}

export function useUpdateBlogContent(projectId: string) {
  const queryClient = useQueryClient();
 
  return useMutation({
    mutationFn: ({
      blogId,
      payload,
    }: {
      blogId:  string;
      payload: { title?: string; description?: string; content?: string; heroImageUrl?: string | null };
    }) => blogsApi.updateContent(projectId, blogId, payload),
    onSuccess: (_, { blogId }) => {
      void queryClient.invalidateQueries({ queryKey: ['blogs', projectId, blogId] });
      void queryClient.invalidateQueries({ queryKey: ['blogs', projectId] });
    },
  });
}

// ── Dashboard ─────────────────────────────────────────────────────────────

export function useDashboardHome(projectId: string) {
  return useQuery({
    queryKey: ['dashboard', projectId],
    queryFn:  () => dashboardApi.getHome(projectId),
    enabled:  !!projectId,
  });
}

// ── Audit ─────────────────────────────────────────────────────────────────

export function useLatestAudit(projectId: string) {
  return useQuery({
    queryKey: ['audit', projectId],
    queryFn:  () => auditApi.latest(projectId),
    enabled:  !!projectId,
  });
}

export function useCodeChanges(projectId: string, params?: { type?: string; status?: string }) {
  return useQuery({
    queryKey: ['codeChanges', projectId, params],
    queryFn:  () => auditApi.codeChanges(projectId, params),
    enabled:  !!projectId,
  });
}

export function useFAQs(projectId: string) {
  return useQuery({
    queryKey: ['faqs', projectId],
    queryFn:  () => auditApi.faqs(projectId),
    enabled:  !!projectId,
  });
}
 
export function useTLDRs(projectId: string) {
  return useQuery({
    queryKey: ['tldrs', projectId],
    queryFn:  () => auditApi.tldrs(projectId),
    enabled:  !!projectId,
  });
}

// ── Keywords ──────────────────────────────────────────────────────────────

export function useKeywords(projectId: string) {
  return useQuery({
    queryKey: ['keywords', projectId],
    queryFn:  () => keywordsApi.list(projectId),
    enabled:  !!projectId,
  });
}

export function useGenerateContent(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (keywordId: string) => keywordsApi.generate(projectId, keywordId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['keywords', projectId] });
    },
  });
}

// ── GEO ───────────────────────────────────────────────────────────────────

export function useGeoRuns(projectId: string) {
  return useQuery({
    queryKey: ['geo', projectId],
    queryFn:  () => geoApi.runs(projectId),
    enabled:  !!projectId,
  });
}

// ── CMS ───────────────────────────────────────────────────────────────────────
 
export function useCmsConfig(projectId: string) {
  return useQuery({
    queryKey: ['cms', projectId],
    queryFn:  async () => {
      try {
        return await cmsApi.get(projectId);
      } catch (err: unknown) {
        // Backend throws 404 when no CmsConfig document exists yet (new project).
        // Treat this as "not connected" rather than an error state.
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 404) return null;
        throw err;
      }
    },
    enabled: !!projectId,
  });
}
 
export function useConnectCms(projectId: string) {
  const queryClient = useQueryClient();
 
  return useMutation({
    mutationFn: (payload: CmsConnectPayload) => cmsApi.connect(projectId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cms', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
    },
  });
}
 
export function useUpdateCms(projectId: string) {
  const queryClient = useQueryClient();
 
  return useMutation({
    mutationFn: (payload: CmsUpdatePayload) => cmsApi.update(projectId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cms', projectId] });
    },
  });
}
 
export function useDisconnectCms(projectId: string) {
  const queryClient = useQueryClient();
 
  return useMutation({
    mutationFn: () => cmsApi.disconnect(projectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cms', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
    },
  });
}

// ── Knowledge files ─────────────────────────────────────────────────────────

export function useKnowledgeFiles(projectId: string) {
  return useQuery({
    queryKey: ['knowledge', projectId],
    queryFn:  () => knowledgeApi.list(projectId),
    enabled:  !!projectId,
  });
}

export function useUploadKnowledgeFile(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (file: File) => knowledgeApi.upload(projectId, file),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['knowledge', projectId] });
    },
  });
}

export function useDeleteKnowledgeFile(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (fileId: string) => knowledgeApi.remove(projectId, fileId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['knowledge', projectId] });
    },
  });
}

// ── Content optimization review queue ────────────────────────────────────────

export function useOptimizations(
  projectId: string,
  params?: { status?: OptimizationStatus; blogId?: string; page?: number; limit?: number },
) {
  return useQuery({
    queryKey: ['optimizations', projectId, params],
    queryFn:  () => optimizationsApi.list(projectId, params),
    enabled:  !!projectId,
  });
}

export function useOptimization(projectId: string, optimizationId: string) {
  return useQuery({
    queryKey: ['optimizations', projectId, optimizationId],
    queryFn:  () => optimizationsApi.get(projectId, optimizationId),
    enabled:  !!projectId && !!optimizationId,
  });
}

export function useApproveOptimization(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (optimizationId: string) => optimizationsApi.approve(projectId, optimizationId),
    onSuccess: (_, optimizationId) => {
      void queryClient.invalidateQueries({ queryKey: ['optimizations', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['optimizations', projectId, optimizationId] });
    },
  });
}

export function useRejectOptimization(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (optimizationId: string) => optimizationsApi.reject(projectId, optimizationId),
    onSuccess: (_, optimizationId) => {
      void queryClient.invalidateQueries({ queryKey: ['optimizations', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['optimizations', projectId, optimizationId] });
    },
  });
}

// ── Google Search Console ────────────────────────────────────────────────────

export function useGscStatus(projectId: string) {
  return useQuery({
    queryKey: ['gsc', projectId],
    queryFn:  () => gscApi.getStatus(projectId),
    enabled:  !!projectId,
  });
}

// No useConnectGsc mutation — connecting is a full-page redirect
// (window.location.href = gscApi.getConnectUrl(projectId)), not something
// React Query manages. See gscApi.getConnectUrl's doc comment.

export function useDisconnectGsc(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => gscApi.disconnect(projectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['gsc', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
    },
  });
}

// ── Free audit tool (public marketing lead-gen tool) ─────────────────────────

export function useRunFreeAudit() {
  return useMutation({
    mutationFn: (payload: FreeAuditPayload) => toolsApi.runFreeAudit(payload),
  });
}
