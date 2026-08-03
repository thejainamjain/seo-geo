'use client';

import { useState } from 'react';
import type { PerformanceOverviewPoint } from '@/types/api';
import { format } from 'date-fns';

/**
 * components/analytics/performance-chart.tsx
 *
 * Hand-rolled SVG line chart, matching the existing convention in
 * components/dashboard/home-dashboard.tsx (GrowthChart/GeoVisibilityChart)
 * rather than introducing recharts/chart.js as a new dependency for one
 * chart — this codebase deliberately has none installed.
 */
export function PerformanceChart({ series }: { series: PerformanceOverviewPoint[] }) {
  const [metric, setMetric] = useState<'clicks' | 'impressions'>('clicks');

  if (series.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-16 text-center">
        No performance data available
      </p>
    );
  }

  const width  = 640;
  const height = 200;
  const pad    = 24;

  const values = series.map(p => p[metric]);
  const max    = Math.max(...values, 1);

  const stepX = series.length > 1 ? (width - pad * 2) / (series.length - 1) : 0;
  const coords = series.map((p, i) => {
    const x = pad + i * stepX;
    const y = height - pad - (p[metric] / max) * (height - pad * 2);
    return { x, y, p };
  });

  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ');
  const areaPath = `${linePath} L ${coords[coords.length - 1]!.x} ${height - pad} L ${coords[0]!.x} ${height - pad} Z`;

  return (
    <div>
      <div className="flex items-center gap-4 mb-3">
        <button
          onClick={() => setMetric('clicks')}
          className={`flex items-center gap-1.5 text-xs ${metric === 'clicks' ? 'font-medium' : 'text-muted-foreground'}`}
        >
          <span className="h-2 w-2 rounded-full bg-primary" /> Clicks
        </button>
        <button
          onClick={() => setMetric('impressions')}
          className={`flex items-center gap-1.5 text-xs ${metric === 'impressions' ? 'font-medium' : 'text-muted-foreground'}`}
        >
          <span className="h-2 w-2 rounded-full bg-blue-400" /> Impressions
        </button>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-48" preserveAspectRatio="none">
        <path d={areaPath} className={metric === 'clicks' ? 'fill-primary/10' : 'fill-blue-400/10'} />
        <path
          d={linePath}
          className={metric === 'clicks' ? 'stroke-primary fill-none' : 'stroke-blue-400 fill-none'}
          strokeWidth={2}
        />
        {coords.map((c, i) => (
          <circle key={i} cx={c.x} cy={c.y} r={2.5} className={metric === 'clicks' ? 'fill-primary' : 'fill-blue-400'} />
        ))}
      </svg>

      <div className="flex justify-between mt-1">
        <span className="text-[10px] text-muted-foreground">{format(new Date(series[0]!.date), 'MMM d')}</span>
        <span className="text-[10px] text-muted-foreground">
          {format(new Date(series[series.length - 1]!.date), 'MMM d')}
        </span>
      </div>
    </div>
  );
}
