'use client';

import { use } from 'react';
import Link from 'next/link';
import { useKeywords, useBlogs, useUpdateBlogStatus } from '@/lib/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatNumber } from '@/lib/utils/format';
import { ExternalLink, Loader2 } from 'lucide-react';
import type { Blog, Keyword } from '@/types/api';

// ── Helpers ───────────────────────────────────────────────────────────────────

function BlogStatusBadge({ status }: { status: string }) {
  const map: Record<string, 'default' | 'secondary' | 'outline'> = {
    published: 'default',
    ready:     'secondary',
    draft:     'outline',
    archived:  'outline',
  };
  return (
    <Badge variant={map[status] ?? 'outline'} className="capitalize text-xs">
      {status}
    </Badge>
  );
}

// ── Ready tab — blogs with status "ready" or "published" ─────────────────────
// Shows: keyword, search volume, blog title, status, view + mark-as-ready action

function ReadyTable({
  blogs,
  keywords,
  projectId,
}: {
  blogs: Blog[];
  keywords: Keyword[];
  projectId: string;
}) {
  // Build keyword lookup map: keywordId → Keyword
  const kwMap = new Map<string, Keyword>(keywords.map(k => [k._id, k]));
  const updateStatus = useUpdateBlogStatus(projectId);

  // Ready tab shows blogs that have been drafted or are ready/published
  const readyBlogs = blogs.filter(b => ['draft', 'ready', 'published'].includes(b.status));

  if (readyBlogs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No blogs ready yet. Pipeline must complete blog generation first.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[28%]">Keyword</TableHead>
          <TableHead>Volume</TableHead>
          <TableHead className="w-[28%]">Title</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>View</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {readyBlogs.map(blog => {
          const kw = blog.keywordId ? kwMap.get(blog.keywordId) : undefined;
          const isMarking =
            updateStatus.isPending && updateStatus.variables?.blogId === blog._id;

          return (
            <TableRow key={blog._id}>
              {/* Keyword */}
              <TableCell className="text-sm">
                {kw?.keyword ?? <span className="text-muted-foreground italic">—</span>}
              </TableCell>

              {/* Search volume */}
              <TableCell className="text-sm text-muted-foreground">
                {kw ? `${formatNumber(kw.searchVolume)}/mo` : '—'}
              </TableCell>

              {/* Blog title */}
              <TableCell>
                <Link
                  href={`/projects/${projectId}/blogs/${blog._id}`}
                  className="text-sm font-medium hover:underline line-clamp-1"
                >
                  {blog.title}
                </Link>
              </TableCell>

              {/* Status badge */}
              <TableCell>
                <BlogStatusBadge status={blog.status} />
              </TableCell>

              {/* View live link */}
              <TableCell>
                {blog.publishedUrl ? (
                  <a
                    href={blog.publishedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Live <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>

              {/* Mark as ready action — only shown for drafts */}
              <TableCell className="text-right">
                {blog.status === 'draft' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={isMarking}
                    onClick={() =>
                      updateStatus.mutate({ blogId: blog._id, status: 'ready' })
                    }
                  >
                    {isMarking
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : 'Mark as ready'
                    }
                  </Button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ── Upcoming tab — keywords with no blog yet ──────────────────────────────────

function UpcomingTable({ keywords }: { keywords: Keyword[] }) {
  // Upcoming = keywords with status "upcoming" (no blog generated yet)
  const upcomingKws = keywords.filter(k => k.status === 'upcoming');

  if (upcomingKws.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No upcoming keywords queued for content creation.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[40%]">Keyword</TableHead>
          <TableHead>Volume</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {upcomingKws.map(kw => (
          <TableRow key={kw._id}>
            <TableCell className="text-sm font-medium">{kw.keyword}</TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {formatNumber(kw.searchVolume)}/mo
            </TableCell>
            <TableCell className="text-sm text-muted-foreground italic">TBD</TableCell>
            <TableCell>
              <Badge variant="outline" className="text-xs capitalize">
                {kw.status}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BlogsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);

  const { data: keywords, isLoading: kwLoading } = useKeywords(projectId);
  const { data: blogs,    isLoading: blLoading  } = useBlogs(projectId);

  const isLoading = kwLoading || blLoading;

  const totalKeywords      = keywords?.length ?? 0;
  const totalBlogs         = blogs?.length ?? 0;
  const readyToPublish     = blogs?.filter(b => b.status === 'ready').length ?? 0;
  const upcomingCount      = keywords?.filter(k => k.status === 'upcoming').length ?? 0;
  const readyBlogsCount    = blogs?.filter(b => ['draft', 'ready', 'published'].includes(b.status)).length ?? 0;

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">Blogs</h1>
        <p className="text-sm text-muted-foreground mt-1">
          AI-generated blog posts for your keywords, ready to review and publish
        </p>
      </div>

      {/* Summary cards */}
      {isLoading ? (
        <div className="grid grid-cols-3 gap-4 mb-8">
          {[0, 1, 2].map(i => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4 mb-8">
          {[
            { label: 'Total keywords',      value: totalKeywords,  sub: 'Researched for your domain' },
            { label: 'Pages created',       value: totalBlogs,     sub: 'AI-generated posts' },
            { label: 'Ready to publish',    value: readyToPublish, sub: 'Approved and waiting' },
          ].map(({ label, value, sub }) => (
            <div key={label} className="border border-border rounded-lg p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
              <p className="text-3xl font-semibold mt-1">{value}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
            </div>
          ))}
        </div>
      )}

      <Tabs defaultValue="ready">
        <TabsList className="mb-4">
          <TabsTrigger value="ready">
            Ready {!isLoading && readyBlogsCount > 0 ? `(${readyBlogsCount})` : ''}
          </TabsTrigger>
          <TabsTrigger value="upcoming">
            Upcoming {!isLoading && upcomingCount > 0 ? `(${upcomingCount})` : ''}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="ready">
          {isLoading && <Skeleton className="h-64 w-full" />}
          {!isLoading && blogs && keywords && (
            <ReadyTable blogs={blogs} keywords={keywords} projectId={projectId} />
          )}
        </TabsContent>

        <TabsContent value="upcoming">
          {isLoading && <Skeleton className="h-64 w-full" />}
          {!isLoading && keywords && (
            <UpcomingTable keywords={keywords} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
