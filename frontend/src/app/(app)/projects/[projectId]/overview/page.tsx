'use client';

import { use } from 'react';
import { usePipelineStatus, usePipelineResume, useProject, useLatestAudit, useKeywords } from '@/lib/hooks';
import { STEP_META, PIPELINE_SEQUENCE, getStatusColor } from '@/lib/utils/pipeline';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { CheckCircle2, Circle, Loader2, XCircle, RefreshCw } from 'lucide-react';
import type { PipelineStepStatus } from '@/types/api';
import { HomeDashboard } from '@/components/dashboard/home-dashboard';

function StepIcon({ status }: { status: PipelineStepStatus }) {
  switch (status) {
    case 'COMPLETED': return <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />;
    case 'RUNNING':   return <Loader2 className="h-5 w-5 text-blue-500 shrink-0 animate-spin" />;
    case 'ERRORED':   return <XCircle className="h-5 w-5 text-red-500 shrink-0" />;
    default:          return <Circle className="h-5 w-5 text-muted-foreground/40 shrink-0" />;
  }
}

export default function OverviewPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { data: pipeline, isLoading } = usePipelineStatus(projectId);
  const { data: project }             = useProject(projectId);
  const { data: audit }               = useLatestAudit(projectId);
  const { data: keywords }            = useKeywords(projectId);
  const resume                        = usePipelineResume(projectId);

  if (isLoading) {
    return (
      <div className="p-8 max-w-2xl mx-auto space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        <div className="mt-8 space-y-3">
          {PIPELINE_SEQUENCE.map(s => <Skeleton key={s} className="h-16 w-full" />)}
        </div>
      </div>
    );
  }

  const completedCount = pipeline?.steps.filter(s => s.status === 'COMPLETED').length ?? 0;
  const totalCount     = pipeline?.steps.length ?? PIPELINE_SEQUENCE.length;

  // Once the onboarding pipeline is fully done, "Home" becomes the real
  // dashboard (search opportunity, content-calendar growth, activity feed)
  // instead of the step-by-step progress view — that view stays useful
  // only while there's still pipeline progress to show.
  if (pipeline?.status === 'COMPLETED') {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold">{project?.domain}</h1>
        </div>
        <HomeDashboard projectId={projectId} />
      </div>
    );
  }

  // Summary numbers — only show if data exists
  const summaryItems = [
    audit?.summary?.totalPages   ? { label: 'Pages crawled',      value: audit.summary.totalPages }   : null,
    audit?.summary?.totalFixes   ? { label: 'SEO fixes found',    value: audit.summary.totalFixes }   : null,
    audit?.summary?.score        ? { label: 'SEO score',          value: `${audit.summary.score}/100` } : null,
    keywords?.length             ? { label: 'Keywords researched', value: keywords.length }            : null,
  ].filter(Boolean) as { label: string; value: string | number }[];

  return (
    <div className="p-8 max-w-2xl mx-auto">

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-semibold">Pipeline</h1>
          {pipeline && (
            <Badge variant={
              pipeline.status === 'RUNNING'   ? 'secondary' :
              pipeline.status === 'ERRORED'   ? 'destructive' : 'outline'
            }>
              {pipeline.status}
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {project?.domain} · {completedCount}/{totalCount} steps complete
        </p>
      </div>

      {/* Summary numbers — shown once pipeline has produced data */}
      {summaryItems.length > 0 && (
        <div className="grid grid-cols-2 gap-3 mb-8">
          {summaryItems.map(({ label, value }) => (
            <div key={label} className="border border-border rounded-lg p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
              <p className="text-2xl font-semibold mt-1">{value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Resume alert */}
      {pipeline?.canResume && pipeline.status !== 'RUNNING' && (
        <Alert className="mb-6 border-yellow-500/30 bg-yellow-500/5">
          <AlertDescription className="flex items-center justify-between">
            <span className="text-sm">
              Pipeline stopped at <strong>{pipeline.resumeFrom}</strong>.
              {pipeline.status === 'ERRORED' && ' A step failed after max retries.'}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => resume.mutate(undefined)}
              disabled={resume.isPending}
            >
              {resume.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              )}
              Resume
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Steps */}
      <div className="space-y-1">
        {PIPELINE_SEQUENCE.map((stepKey, idx) => {
          const stepState = pipeline?.steps.find(s => s.step === stepKey);
          const status    = stepState?.status ?? 'PENDING';
          const meta      = STEP_META[stepKey];
          const isLast    = idx === PIPELINE_SEQUENCE.length - 1;

          // Show duration if completed
          const duration = stepState?.startedAt && stepState?.completedAt
            ? Math.round((new Date(stepState.completedAt).getTime() - new Date(stepState.startedAt).getTime()) / 1000)
            : null;

          return (
            <div key={stepKey} className="flex gap-4">
              <div className="flex flex-col items-center">
                <StepIcon status={status} />
                {!isLast && (
                  <div className={`w-px flex-1 my-1 ${
                    status === 'COMPLETED' ? 'bg-green-500/30' : 'bg-border'
                  }`} />
                )}
              </div>

              <div className={`pb-6 flex-1 ${isLast ? '' : ''}`}>
                <div className="flex items-center justify-between">
                  <p className={`text-sm font-medium ${getStatusColor(status)}`}>
                    {meta.label}
                  </p>
                  <div className="flex items-center gap-2">
                    {duration !== null && (
                      <span className="text-xs text-muted-foreground">{duration}s</span>
                    )}
                    {status === 'RUNNING' && (
                      <span className="text-xs text-blue-500 animate-pulse">Running…</span>
                    )}
                    {status === 'ERRORED' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-xs text-red-500 hover:text-red-400"
                        onClick={() => resume.mutate(stepKey)}
                        disabled={resume.isPending}
                      >
                        Retry from here
                      </Button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{meta.description}</p>
                {stepState?.error && (
                  <p className="text-xs text-red-400 mt-1 font-mono">{stepState.error}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Integrations */}
      {project && (
        <div className="mt-8 border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-3">Integrations</p>
          <div className="space-y-2">
            {[
              { label: 'Google Search Console', connected: project.isGscConnected },
              { label: 'CMS publishing',        connected: project.isCmsConnected },
              { label: 'Onboarding complete',   connected: project.isOnboardingComplete },
            ].map(({ label, connected }) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{label}</span>
                <span className={`text-xs ${connected ? 'text-green-500' : 'text-muted-foreground'}`}>
                  {connected ? 'Connected' : 'Not connected'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
