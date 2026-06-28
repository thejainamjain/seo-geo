'use client';

import { use } from 'react';
import { useGeoRuns } from '@/lib/hooks';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/utils/format';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export default function GeoPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { data: runs, isLoading } = useGeoRuns(projectId);

  const latest  = runs?.[0];
  const trend   = latest
    ? latest.objectivePercentage - latest.prevObjectivePercentage
    : 0;

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">GEO Analytics</h1>
        <p className="text-sm text-muted-foreground mt-1">
          How often AI engines like Gemini cite your domain when users ask about your keywords
        </p>
      </div>

      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {!isLoading && (!runs || runs.length === 0) && (
        <div className="text-center py-16 border border-dashed border-border rounded-lg">
          <p className="text-sm font-medium">No GEO data yet</p>
          <p className="text-sm text-muted-foreground mt-1">
            GEO tracking runs daily (Mon–Sat) after your pipeline completes and blogs are published.
          </p>
        </div>
      )}

      {runs && runs.length > 0 && (
        <>
          {/* Latest score */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className="border border-border rounded-lg p-6 col-span-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-3">
                Current citation rate
              </p>
              <div className="flex items-end gap-2">
                <p className="text-5xl font-semibold">
                  {latest?.objectivePercentage ?? 0}
                  <span className="text-2xl text-muted-foreground">%</span>
                </p>
                {trend !== 0 && (
                  <div className={`flex items-center gap-0.5 mb-1 text-sm ${
                    trend > 0 ? 'text-green-500' : 'text-red-500'
                  }`}>
                    {trend > 0
                      ? <TrendingUp className="h-4 w-4" />
                      : <TrendingDown className="h-4 w-4" />
                    }
                    {Math.abs(trend)}%
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                vs {latest?.prevObjectivePercentage ?? 0}% last run
              </p>
            </div>

            <div className="border border-border rounded-lg p-6">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-3">
                Keywords evaluated
              </p>
              <p className="text-3xl font-semibold">{latest?.evaluationPoolSize ?? 0}</p>
              <p className="text-xs text-muted-foreground mt-2">
                {latest?.successfulPrompts ?? 0} successful ·{' '}
                {latest?.failedPrompts ?? 0} failed
              </p>
            </div>

            <div className="border border-border rounded-lg p-6">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-3">
                Total runs
              </p>
              <p className="text-3xl font-semibold">{runs.length}</p>
              <p className="text-xs text-muted-foreground mt-2">
                Runs daily Mon–Sat
              </p>
            </div>
          </div>

          {/* Run history */}
          <div>
            <h2 className="text-sm font-medium mb-3">Run history</h2>
            <div className="space-y-2">
              {runs.map((run, idx) => {
                const runTrend = run.objectivePercentage - run.prevObjectivePercentage;
                return (
                  <div
                    key={run._id}
                    className="flex items-center justify-between p-3 border border-border rounded-lg"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium w-8 text-muted-foreground">
                        #{runs.length - idx}
                      </span>
                      <span className="text-sm">{formatDate(run.runAt)}</span>
                      <Badge variant={run.status === 'completed' ? 'outline' : 'secondary'} className="text-xs capitalize">
                        {run.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-xs text-muted-foreground">
                        {run.successfulPrompts}/{run.evaluationPoolSize} prompts
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-semibold">
                          {run.objectivePercentage}%
                        </span>
                        {runTrend > 0 && <TrendingUp className="h-3.5 w-3.5 text-green-500" />}
                        {runTrend < 0 && <TrendingDown className="h-3.5 w-3.5 text-red-500" />}
                        {runTrend === 0 && <Minus className="h-3.5 w-3.5 text-muted-foreground" />}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
