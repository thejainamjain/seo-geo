'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useKeywords, useBlogs } from '@/lib/hooks';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatNumber } from '@/lib/utils/format';
import { ArrowUpDown, ExternalLink } from 'lucide-react';
import type { Keyword, Blog } from '@/types/api';

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
    label,
    k,
    sortKey,
    onSort,
    }: {
    label: string;
    k: SortKey;
    sortKey: SortKey;
    onSort: (k: SortKey) => void;
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
          <TableHead><SortHeader label="Volume"    k="searchVolume"   sortKey={sortKey} onSort={toggleSort} /></TableHead>
          <TableHead><SortHeader label="Difficulty" k="difficulty"    sortKey={sortKey} onSort={toggleSort} /></TableHead>
          <TableHead><SortHeader label="Alignment"  k="alignmentScore" sortKey={sortKey} onSort={toggleSort} /></TableHead>
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

function BlogsTable({ blogs, projectId }: { blogs: Blog[]; projectId: string }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[50%]">Title</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Published URL</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {blogs.map(blog => (
          <TableRow key={blog._id}>
            <TableCell>
              <Link
                href={`/projects/${projectId}/blogs/${blog._id}`}
                className="text-sm font-medium hover:underline"
              >
                {blog.title}
              </Link>
              <p className="text-xs text-muted-foreground mt-0.5">{blog.slug}</p>
            </TableCell>
            <TableCell>
              <Badge
                variant={
                  blog.status === 'published' ? 'default' :
                  blog.status === 'ready'     ? 'secondary' : 'outline'
                }
                className="capitalize text-xs"
              >
                {blog.status}
              </Badge>
            </TableCell>
            <TableCell>
              {blog.publishedUrl ? (
                <a
                  href={blog.publishedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  View live <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function KeywordsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { data: keywords, isLoading: kwLoading } = useKeywords(projectId);
  const { data: blogs,    isLoading: blLoading } = useBlogs(projectId);

  const upcoming  = keywords?.filter(k => k.status === 'upcoming')  ?? [];
  const drafted   = keywords?.filter(k => k.status === 'draft')     ?? [];
  const published = keywords?.filter(k => k.status === 'published') ?? [];

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">Keywords & Content</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Keywords researched and scored for your business, and blog posts generated for each
        </p>
      </div>

      {/* Summary cards */}
      {!kwLoading && keywords && (
        <div className="grid grid-cols-3 gap-4 mb-8">
          {[
            { label: 'Keywords', value: keywords.length, sub: 'Total researched' },
            { label: 'Blogs created', value: blogs?.length ?? 0, sub: 'AI-generated posts' },
            { label: 'Published', value: published.length, sub: 'Live on your site' },
          ].map(({ label, value, sub }) => (
            <div key={label} className="border border-border rounded-lg p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
              <p className="text-3xl font-semibold mt-1">{value}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
            </div>
          ))}
        </div>
      )}

      <Tabs defaultValue="blogs">
        <TabsList className="mb-4">
          <TabsTrigger value="blogs">
            Blogs {blogs ? `(${blogs.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="upcoming">
            Upcoming {upcoming.length > 0 ? `(${upcoming.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="all">
            All keywords {keywords ? `(${keywords.length})` : ''}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="blogs">
          {blLoading && <Skeleton className="h-64 w-full" />}
          {!blLoading && (!blogs || blogs.length === 0) && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No blogs generated yet. Pipeline must complete blog generation phase first.
            </p>
          )}
          {blogs && blogs.length > 0 && (
            <BlogsTable blogs={blogs} projectId={projectId} />
          )}
        </TabsContent>

        <TabsContent value="upcoming">
          {kwLoading && <Skeleton className="h-64 w-full" />}
          {!kwLoading && upcoming.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No upcoming keywords. Run the pipeline to research keywords for your domain.
            </p>
          )}
          {upcoming.length > 0 && <KeywordsTable keywords={upcoming} />}
        </TabsContent>

        <TabsContent value="all">
          {kwLoading && <Skeleton className="h-64 w-full" />}
          {!kwLoading && (!keywords || keywords.length === 0) && (
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
