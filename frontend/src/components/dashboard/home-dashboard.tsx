'use client';

import { useDashboardHome } from '@/lib/hooks';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDistanceToNow } from 'date-fns';
import type { DashboardGrowthPoint, GeoVisibilityPoint } from '@/types/api';

function formatCompact(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function GrowthChart({ points }: { points: DashboardGrowthPoint[] }) {
  if (points.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No content weeks scheduled yet — this fills in once keyword research schedules your content calendar.
      </p>
    );
  }

  const width  = 640;
  const height = 160;
  const pad    = 24;
  const max    = Math.max(...points.map(p => p.cumulativeSearchVolume), 1);

  const stepX = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = height - pad - (p.cumulativeSearchVolume / max) * (height - pad * 2);
    return { x, y, p };
  });

  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ');
  const areaPath = `${linePath} L ${coords[coords.length - 1]!.x} ${height - pad} L ${coords[0]!.x} ${height - pad} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-40" preserveAspectRatio="none">
      <path d={areaPath} className="fill-primary/10" />
      <path d={linePath} className="stroke-primary fill-none" strokeWidth={2} />
      {coords.map((c, i) => (
        <circle key={i} cx={c.x} cy={c.y} r={3} className="fill-primary" />
      ))}
      {coords.map((c, i) => (
        <text key={i} x={c.x} y={height - 6} textAnchor="middle" className="fill-muted-foreground text-[9px]">
          Wk {c.p.week}
        </text>
      ))}
    </svg>
  );
}

function GeoVisibilityChart({ points }: { points: GeoVisibilityPoint[] }) {
  if (points.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No GEO analytics runs yet — this fills in once you have published content for the weekly AI-visibility check to evaluate.
      </p>
    );
  }

  const width  = 640;
  const height = 120;
  const pad    = 20;

  const stepX = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = height - pad - (p.objectivePercentage / 100) * (height - pad * 2);
    return { x, y, p };
  });

  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-28" preserveAspectRatio="none">
      <path d={linePath} className="stroke-primary fill-none" strokeWidth={2} />
      {coords.map((c, i) => (
        <circle key={i} cx={c.x} cy={c.y} r={3} className="fill-primary" />
      ))}
      {coords.map((c, i) => (
        <text key={i} x={c.x} y={height - 4} textAnchor="middle" className="fill-muted-foreground text-[9px]">
          {c.p.objectivePercentage}%
        </text>
      ))}
    </svg>
  );
}

export function HomeDashboard({ projectId }: { projectId: string }) {
  const { data, isLoading } = useDashboardHome(projectId);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data) return null;

  const { searchOpportunity, growthTimeline, geoVisibilityHistory, activity } = data;

  return (
    <div className="space-y-6">
      {/* Search opportunity */}
      <Card>
        <CardHeader>
          <CardTitle>Your search traffic opportunity</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-semibold">
            {formatCompact(searchOpportunity.monthlySearchVolume)}
            <span className="text-sm font-normal text-muted-foreground ml-2">searches/mo</span>
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Across {searchOpportunity.trackedKeywordCount} keywords we&apos;ve identified for you so far.
            This grows as more keyword research runs — it&apos;s not an estimate of total market size.
          </p>
        </CardContent>
      </Card>

      {/* Growth timeline */}
      <Card>
        <CardHeader>
          <CardTitle>Content calendar growth</CardTitle>
        </CardHeader>
        <CardContent>
          <GrowthChart points={growthTimeline} />
          <p className="text-xs text-muted-foreground mt-3">
            Cumulative search volume of keywords scheduled into your content calendar, by week.
          </p>
        </CardContent>
      </Card>

      {/* GEO visibility — real history, not a projection */}
      <Card>
        <CardHeader>
          <CardTitle>AI search visibility</CardTitle>
        </CardHeader>
        <CardContent>
          <GeoVisibilityChart points={geoVisibilityHistory} />
          <p className="text-xs text-muted-foreground mt-3">
            % of AI search responses that cited your domain, per weekly check. Actual measured history — not a forecast.
          </p>
        </CardContent>
      </Card>

      {/* Activity */}
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Queued</CardTitle>
          </CardHeader>
          <CardContent>
            {activity.queued.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing queued right now.</p>
            ) : (
              <ul className="space-y-3">
                {activity.queued.map((item, i) => (
                  <li key={i} className="flex items-center justify-between text-sm">
                    <span>{item.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {item.dueAt
                        ? formatDistanceToNow(new Date(item.dueAt), { addSuffix: true })
                        : item.note}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Completed</CardTitle>
          </CardHeader>
          <CardContent>
            {activity.completed.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing completed yet.</p>
            ) : (
              <ul className="space-y-3">
                {activity.completed.map((item, i) => (
                  <li key={i} className="text-sm">
                    <p>{item.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(item.lastUpdated), { addSuffix: true })}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
