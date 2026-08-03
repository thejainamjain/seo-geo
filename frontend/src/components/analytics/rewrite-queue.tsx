'use client';

import { useEffect, useState } from 'react';
import { useOptimizations, useApproveOptimization, useRejectOptimization } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronLeft, ChevronRight, Target } from 'lucide-react';

/**
 * components/analytics/rewrite-queue.tsx
 *
 * Backed by the EXISTING BlogOptimization list/approve/reject endpoints
 * (optimization.route.ts / useOptimizations et al. in lib/hooks) — this
 * component is new, the data layer underneath it is not. See
 * services/analytics.service.ts's header comment for why Rewrite Queue
 * isn't part of the analytics.* endpoints.
 */
export function RewriteQueue({ projectId }: { projectId: string }) {
  const [index, setIndex] = useState(0);
  const { data, isLoading } = useOptimizations(projectId, { status: 'pending_review' });
  const approve = useApproveOptimization(projectId);
  const reject  = useRejectOptimization(projectId);

  const items   = data?.optimizations ?? [];
  const current = items[index];

  // Clamp index if the list shrinks (e.g. after approving/rejecting the
  // last item) rather than showing a blank card. Effect, not a render-time
  // setState call — avoids the "update state while rendering" footgun.
  useEffect(() => {
    if (index > 0 && index >= items.length) {
      setIndex(Math.max(items.length - 1, 0));
    }
  }, [items.length, index]);

  return (
    <div className="border border-border rounded-lg p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">Rewrite Queue</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Content pages RankAI will rewrite to further optimize
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs px-2 py-1 rounded-full border border-border">
            {items.length} pending
          </span>
          {items.length > 1 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setIndex(i => Math.max(0, i - 1))}
                disabled={index === 0}
                className="p-1 rounded hover:bg-accent disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs text-muted-foreground w-10 text-center">
                {index + 1}/{items.length}
              </span>
              <button
                onClick={() => setIndex(i => Math.min(items.length - 1, i + 1))}
                disabled={index === items.length - 1}
                className="p-1 rounded hover:bg-accent disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {isLoading && <Skeleton className="h-40 w-full" />}

      {!isLoading && items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Target className="h-10 w-10 text-muted-foreground/40 mb-3" />
          <p className="text-sm font-medium">No items in rewrite queue</p>
          <p className="text-xs text-muted-foreground mt-1">All pages are optimized</p>
        </div>
      )}

      {!isLoading && current && (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium">{current.blogId.title}</p>
            <p className="text-xs text-muted-foreground">/{current.blogId.slug}</p>
          </div>

          {current.contentOptimization && (
            <p className="text-sm text-muted-foreground leading-relaxed">
              {current.contentOptimization.changesSummary}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => approve.mutate(current._id)}
              disabled={approve.isPending || reject.isPending}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => reject.mutate(current._id)}
              disabled={approve.isPending || reject.isPending}
            >
              Reject
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
