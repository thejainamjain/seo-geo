'use client';

import { use, useState } from 'react';
import { useKeywords } from '@/lib/hooks';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatNumber } from '@/lib/utils/format';
import { ArrowUpDown } from 'lucide-react';
import type { Keyword } from '@/types/api';

function KeywordStatusBadge({ status }: { status: string }) {
  const map: Record<string, 'default' | 'secondary' | 'outline'> = {
    published: 'default',
    draft:     'secondary',
    upcoming:  'outline',
  };
  return (
    <Badge variant={map[status] ?? 'outline'} className="capitalize text-xs">
      {status}
    </Badge>
  );
}

function DifficultyBar({ value }: { value: number }) {
  const color = value < 30 ? 'bg-green-500' : value < 60 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{value}</span>
    </div>
  );
}

type SortKey = 'alignmentScore' | 'searchVolume' | 'difficulty';

function SortHeader({
  label, k, sortKey, onSort,
}: {
  label: string; k: SortKey; sortKey: SortKey; onSort: (k: SortKey) => void;
}) {
  return (
    <button
      onClick={() => onSort(k)}
      className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
    >
      {label}
      <ArrowUpDown className="h-3 w-3" />
    </button>
  );
}

function KeywordsTable({ keywords }: { keywords: Keyword[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('alignmentScore');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const sorted = [...keywords].sort((a, b) => {
    const diff = a[sortKey] - b[sortKey];
    return sortDir === 'asc' ? diff : -diff;
  });

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[40%]">Keyword</TableHead>
          <TableHead>
            <SortHeader label="Volume"     k="searchVolume"   sortKey={sortKey} onSort={toggleSort} />
          </TableHead>
          <TableHead>
            <SortHeader label="Difficulty" k="difficulty"     sortKey={sortKey} onSort={toggleSort} />
          </TableHead>
          <TableHead>
            <SortHeader label="Alignment"  k="alignmentScore" sortKey={sortKey} onSort={toggleSort} />
          </TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map(kw => (
          <TableRow key={kw._id}>
            <TableCell className="font-medium text-sm">{kw.keyword}</TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {formatNumber(kw.searchVolume)}/mo
            </TableCell>
            <TableCell><DifficultyBar value={kw.difficulty} /></TableCell>
            <TableCell>
              <span className="text-sm font-medium">{kw.alignmentScore}</span>
              <span className="text-xs text-muted-foreground">/100</span>
            </TableCell>
            <TableCell><KeywordStatusBadge status={kw.status} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function KeywordsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { data: keywords, isLoading } = useKeywords(projectId);

  const upcoming  = keywords?.filter(k => k.status === 'upcoming')  ?? [];
  const published = keywords?.filter(k => k.status === 'published') ?? [];

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">Keywords</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Keywords researched and scored for your business
        </p>
      </div>

      {/* Summary cards */}
      {!isLoading && keywords && (
        <div className="grid grid-cols-3 gap-4 mb-8">
          {[
            { label: 'Total keywords', value: keywords.length,  sub: 'Researched for your domain' },
            { label: 'Upcoming',       value: upcoming.length,  sub: 'Queued for content creation' },
            { label: 'Published',      value: published.length, sub: 'Live on your site' },
          ].map(({ label, value, sub }) => (
            <div key={label} className="border border-border rounded-lg p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
              <p className="text-3xl font-semibold mt-1">{value}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
            </div>
          ))}
        </div>
      )}

      <Tabs defaultValue="upcoming">
        <TabsList className="mb-4">
          <TabsTrigger value="upcoming">
            Upcoming {upcoming.length > 0 ? `(${upcoming.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="all">
            All {keywords ? `(${keywords.length})` : ''}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="upcoming">
          {isLoading && <Skeleton className="h-64 w-full" />}
          {!isLoading && upcoming.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No upcoming keywords. Run the pipeline to research keywords for your domain.
            </p>
          )}
          {upcoming.length > 0 && <KeywordsTable keywords={upcoming} />}
        </TabsContent>

        <TabsContent value="all">
          {isLoading && <Skeleton className="h-64 w-full" />}
          {!isLoading && (!keywords || keywords.length === 0) && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No keywords yet. Pipeline must complete keyword research phase first.
            </p>
          )}
          {keywords && keywords.length > 0 && <KeywordsTable keywords={keywords} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
