// lib/hooks/index.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/lib/stores/auth.store';
import { useRouter } from 'next/navigation';
import type { BlogStatus, PipelineStep, CmsConnectPayload, CmsUpdatePayload } from '@/types/api';
import { authApi, projectsApi, pipelineApi, blogsApi, auditApi, keywordsApi, geoApi, cmsApi } from '@/lib/api';

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
  const clear  = useAuthStore(s => s.clear);
  const router = useRouter();

  return () => {
    clear();
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

export function useBusinessContext(projectId: string) {
  return useQuery({
    queryKey: ['businessContext', projectId],
    queryFn:  () => projectsApi.getBusinessContext(projectId),
    enabled:  !!projectId,
  });
}

export function useSaveOnboardingStep(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ step, data }: { step: 1|2|3|4|5; data: Record<string, unknown> }) =>
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