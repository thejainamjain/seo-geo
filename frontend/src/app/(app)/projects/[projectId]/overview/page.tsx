'use client';

import { use } from 'react';
import { usePipelineStatus, usePipelineResume, useProject } from '@/lib/hooks';
import { STEP_META, PIPELINE_SEQUENCE, getStatusColor } from '@/lib/utils/pipeline';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { CheckCircle2, Circle, Loader2, XCircle, RefreshCw } from 'lucide-react';
import type { PipelineStepStatus } from '@/types/api';

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

  return (
    <div className="p-8 max-w-2xl mx-auto">

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-semibold">Pipeline</h1>
          {pipeline && (
            <Badge variant={
              pipeline.status === 'COMPLETED' ? 'default' :
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

          return (
            <div key={stepKey} className="flex gap-4">
              {/* Timeline connector */}
              <div className="flex flex-col items-center">
                <StepIcon status={status} />
                {!isLast && (
                  <div className={`w-px flex-1 my-1 ${
                    status === 'COMPLETED' ? 'bg-green-500/30' : 'bg-border'
                  }`} />
                )}
              </div>

              {/* Content */}
              <div className={`pb-6 flex-1 ${isLast ? '' : ''}`}>
                <div className="flex items-center justify-between">
                  <p className={`text-sm font-medium ${getStatusColor(status)}`}>
                    {meta.label}
                  </p>
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
                <p className="text-xs text-muted-foreground mt-0.5">{meta.description}</p>
                {stepState?.error && (
                  <p className="text-xs text-red-400 mt-1 font-mono">{stepState.error}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Completion message */}
      {pipeline?.status === 'COMPLETED' && (
        <div className="mt-4 p-4 border border-green-500/20 bg-green-500/5 rounded-lg">
          <p className="text-sm font-medium text-green-500">Pipeline complete</p>
          <p className="text-xs text-muted-foreground mt-1">
            Your site has been crawled, audited, and blog posts have been generated.
            Check the Keywords & Blogs and Technical SEO tabs.
          </p>
        </div>
      )}
    </div>
  );
}
