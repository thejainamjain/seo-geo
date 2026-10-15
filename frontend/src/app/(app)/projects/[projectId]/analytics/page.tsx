'use client';

import { use } from 'react';
import {
  useAnalyticsSummary,
  usePerformanceOverview,
  useTopMovers,
  useKeywordPerformance,
  useGeoRuns,
} from '@/lib/hooks';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { PerformanceChart } from '@/components/analytics/performance-chart';
import { RewriteQueue } from '@/components/analytics/rewrite-queue';
import {
  FileText, Wrench, Database, Target,
  Eye, Link2, MessageSquare,
  TrendingUp,
} from 'lucide-react';

// ── Summary cards ───────────────────────────────────────────────────────────

function SummaryCards({ projectId }: { projectId: string }) {
  const { data, isLoading } = useAnalyticsSummary(projectId);

  if (isLoading) {
    return (
      <div className="grid grid-cols-4 gap-4">
        {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full" />)}
      </div>
    );
  }

  const cards = [
    { label: 'Pages',     value: data?.pages ?? 0,    sub: '0 published',            icon: FileText },
    { label: 'SEO Fixes', value: data?.seoFixes ?? 0, sub: 'Technical improvements', icon: Wrench },
    { label: 'Schemas',   value: data?.schemas ?? 0,  sub: 'LLM schemas added',      icon: Database },
    { label: 'Ranked',    value: data?.ranked ?? 0,   sub: 'Keywords tracked',       icon: Target },
  ];

  return (
    <div className="grid grid-cols-4 gap-4">
      {cards.map(({ label, value, sub, icon: Icon }) => (
        <div key={label} className="border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center">
              <Icon className="h-3.5 w-3.5 text-primary" />
            </div>
            <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
          </div>
          <p className="text-2xl font-semibold">{value}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
        </div>
      ))}
    </div>
  );
}

// ── Performance overview + Top movers ───────────────────────────────────────

function PerformanceOverviewCard({ projectId }: { projectId: string }) {
  const { data, isLoading } = usePerformanceOverview(projectId, 14);

  return (
    <div className="border border-border rounded-lg p-6">
      <h2 className="text-base font-semibold">Performance Overview</h2>
      <p className="text-xs text-muted-foreground mt-0.5 mb-4">Aggregated clicks & impressions overtime</p>
      {isLoading ? <Skeleton className="h-48 w-full" /> : <PerformanceChart series={data?.series ?? []} />}
    </div>
  );
}

function TopMoversCard({ projectId }: { projectId: string }) {
  const { data, isLoading } = useTopMovers(projectId, 5);

  return (
    <div className="border border-border rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold">Top Movers</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Top keywords ranking up in Google</p>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">Last 14 days</span>
      </div>

      {isLoading && <Skeleton className="h-48 w-full" />}

      {!isLoading && (!data?.movers || data.movers.length === 0) && (
        <p className="text-sm text-muted-foreground py-16 text-center">
          No rising keywords at the moment. We&apos;ll show them here when they appear.
        </p>
      )}

      {!isLoading && data && data.movers.length > 0 && (
        <div className="space-y-2">
          {data.movers.map(m => (
            <div key={m.keyword} className="flex items-center justify-between py-1.5">
              <span className="text-sm truncate">{m.keyword}</span>
              <div className="flex items-center gap-1.5 shrink-0 ml-2 text-green-500">
                <TrendingUp className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">
                  {m.prevPosition.toFixed(0)} → {m.position.toFixed(0)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── AI Search Metrics (GEO) ─────────────────────────────────────────────────
// Migrated as-is from the old geo/page.tsx (that page previously WAS the
// "Analytics" nav destination — see sidebar.tsx's history) — same hook,
// same data, just relocated into this section of the combined page.
//
// DATA HONESTY NOTE: GeoAnalyticsRun (models/Analytics.ts) only tracks ONE
// real metric — objectivePercentage: "% of AI responses that cited this
// domain at all." The reference product's three cards (Share of Voice /
// Citation Rate / Mention Rate) are three DIFFERENT measurements:
//   - Citation Rate  → matches objectivePercentage exactly. Shown as real.
//   - Mention Rate   → would need to distinguish "mentioned by name" from
//     "cited with a link" — this schema doesn't record that distinction
//     at all (geo-analytics.job.ts only checks domain presence, not
//     link-vs-plain-text). NOT implemented — shown as "not tracked yet"
//     rather than reusing the Citation Rate number under a different label.
//   - Share of Voice vs competitors → needs a competitor list + per-
//     competitor citation percentage, which isn't captured anywhere in
//     GeoAnalyticsRun. NOT implemented — same reasoning.
// Faking these as three different numbers when only one is real would
// misrepresent what this feature actually measures.

function GeoMetricsSection({ projectId }: { projectId: string }) {
  const { data: runs, isLoading } = useGeoRuns(projectId);
  const latest = runs?.[0];

  return (
    <div className="border border-border rounded-lg p-6">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold">AI Search Metrics (GEO)</h2>
          <p className="text-sm text-muted-foreground mt-0.5">Brand visibility across AI Search (i.e. ChatGPT)</p>
        </div>
      </div>

      {isLoading && <Skeleton className="h-40 w-full" />}

      {!isLoading && (!runs || runs.length === 0) && (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No GEO data yet. GEO tracking runs daily (Mon–Sat) after your pipeline completes and blogs are published.
        </p>
      )}

      {!isLoading && runs && runs.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-muted/40 rounded-lg p-4 opacity-50">
            <div className="flex items-center gap-2 mb-3">
              <Eye className="h-4 w-4" />
              <div>
                <p className="text-sm font-medium">Share of Voice</p>
                <p className="text-xs text-muted-foreground">vs competitors</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Not tracked yet — needs competitor citation data (see code comment)
            </p>
          </div>

          <div className="bg-muted/40 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <Link2 className="h-4 w-4 text-green-500" />
              <div>
                <p className="text-sm font-medium">Citation Rate</p>
                <p className="text-xs text-muted-foreground">AI answer linked to you</p>
              </div>
            </div>
            <p className="text-2xl font-semibold">{latest?.objectivePercentage ?? 0}%</p>
            <p className="text-xs text-muted-foreground mt-1">AI answers linking to your domain</p>
          </div>

          <div className="bg-muted/40 rounded-lg p-4 opacity-50">
            <div className="flex items-center gap-2 mb-3">
              <MessageSquare className="h-4 w-4" />
              <div>
                <p className="text-sm font-medium">Mention Rate</p>
                <p className="text-xs text-muted-foreground">AI answer mentions you</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Not tracked yet — needs mention-vs-citation distinction (see code comment)
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Keyword Performance table ────────────────────────────────────────────────

function KeywordPerformanceTable({ projectId }: { projectId: string }) {
  const { data, isLoading } = useKeywordPerformance(projectId, { page: 1, limit: 20 });

  return (
    <div className="border border-border rounded-lg p-6">
      <h2 className="text-base font-semibold">Keyword Performance</h2>
      <p className="text-xs text-muted-foreground mt-0.5 mb-4">Performance of keywords driven by SearchPilot engine</p>

      {isLoading && <Skeleton className="h-48 w-full" />}

      {!isLoading && (!data || data.rows.length === 0) && (
        <p className="text-sm text-muted-foreground py-16 text-center">
          No keywords data available
        </p>
      )}

      {!isLoading && data && data.rows.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground uppercase tracking-wide text-left border-b border-border">
              <th className="pb-2 font-medium">Keyword</th>
              <th className="pb-2 font-medium text-right">Search Volume</th>
              <th className="pb-2 font-medium text-right">Position</th>
              <th className="pb-2 font-medium text-right">Clicks</th>
              <th className="pb-2 font-medium text-right">Impressions</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map(row => (
              <tr key={row.keyword} className="border-b border-border last:border-0">
                <td className="py-2.5 truncate max-w-64">{row.keyword}</td>
                <td className="py-2.5 text-right text-muted-foreground">
                  {row.searchVolume !== null ? `${row.searchVolume}/mo` : '—'}
                </td>
                <td className="py-2.5 text-right">{row.position.toFixed(1)}</td>
                <td className="py-2.5 text-right">{row.clicks}</td>
                <td className="py-2.5 text-right">{row.impressions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function AnalyticsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <h1 className="text-2xl font-semibold">Analytics</h1>
        <Badge variant="outline" className="text-xs">Live</Badge>
      </div>
      <p className="text-sm text-muted-foreground -mt-4 mb-6">
        Search performance across Google and AI search, driven by SearchPilot&apos;s work. Based on these
        results, SearchPilot continuously takes action to optimize and improve performance.
      </p>

      <SummaryCards projectId={projectId} />

      <div className="grid grid-cols-2 gap-6">
        <PerformanceOverviewCard projectId={projectId} />
        <TopMoversCard projectId={projectId} />
      </div>

      <GeoMetricsSection projectId={projectId} />

      <RewriteQueue projectId={projectId} />

      <KeywordPerformanceTable projectId={projectId} />
    </div>
  );
}
