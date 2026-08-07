'use client';

import { use } from 'react';
import Link from 'next/link';
import { useKeywords, useBlogs } from '@/lib/hooks';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatNumber } from '@/lib/utils/format';
import { ExternalLink } from 'lucide-react';
import type { Blog, Keyword } from '@/types/api';

/**
 * app/(app)/projects/[projectId]/blogs/page.tsx — "all posts" browse page.
 *
 * Not in the sidebar nav (matches the reference product's IA — individual
 * posts are reached via "View" links from the Keywords & Content page).
 * Kept as a lightweight linked-to utility for browsing every post at once.
 *
 * Previously had a Draft tab + "Mark as ready" manual-review button.
 * Removed: content-generation.job.ts (the live, actually-wired job —
 * confirmed by checking what's actually imported by any worker) creates
 * blogs directly with status: 'ready', skipping 'draft' entirely. That
 * state is not reachable through the current pipeline, so a review step
 * for it was dead UI. See keywords/page.tsx's header comment for the
 * fuller explanation, including the confirmation that workers/jobs/
 * blog-generation.job.ts (which DOES create 'draft' blogs) is dead code.
 */

function BlogStatusBadge({ status }: { status: string }) {
  const map: Record<string, 'default' | 'secondary' | 'outline'> = {
    published:  'default',
    ready:      'secondary',
    draft:      'outline',
    archived:   'outline',
  };
  return (
    <Badge variant={map[status] ?? 'outline'} className="capitalize text-xs">
      {status === 'ready' ? 'scheduled' : status}
    </Badge>
  );
}

function BlogsTable({
  blogs, kwMap, projectId,
}: {
  blogs: Blog[]; kwMap: Map<string, Keyword>; projectId: string;
}) {
  if (blogs.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[25%]">Keyword</TableHead>
          <TableHead>Volume</TableHead>
          <TableHead className="w-[30%]">Title</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Live</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {blogs.map(blog => {
          const kw = blog.keywordId ? kwMap.get(blog.keywordId) : undefined;

          return (
            <TableRow key={blog._id}>
              <TableCell className="text-sm">
                {kw?.keyword ?? <span className="text-muted-foreground italic">—</span>}
              </TableCell>

              <TableCell className="text-sm text-muted-foreground">
                {kw ? `${formatNumber(kw.searchVolume)}/mo` : '—'}
              </TableCell>

              <TableCell>
                <Link
                  href={`/projects/${projectId}/blogs/${blog._id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium hover:underline line-clamp-1"
                >
                  {blog.title}
                </Link>
              </TableCell>

              <TableCell>
                <BlogStatusBadge status={blog.status} />
              </TableCell>

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
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export default function BlogsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);

  const { data: keywords, isLoading: kwLoading } = useKeywords(projectId);
  const { data: blogs,    isLoading: blLoading  } = useBlogs(projectId);

  const isLoading = kwLoading || blLoading;

  const kwMap = new Map<string, Keyword>(
    (keywords ?? []).map(k => [k._id, k])
  );

  const scheduledBlogs = blogs?.filter(b => b.status === 'ready')     ?? [];
  const publishedBlogs = blogs?.filter(b => b.status === 'published') ?? [];

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">All Posts</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every post RankAI has generated, scheduled, or published for this project
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-4 mb-8">
          {[0, 1].map(i => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 mb-8">
          <div className="border border-border rounded-lg p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Scheduled</p>
            <p className="text-3xl font-semibold mt-1">{scheduledBlogs.length}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Generated, waiting for the next publish window</p>
          </div>
          <div className="border border-border rounded-lg p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Published</p>
            <p className="text-3xl font-semibold mt-1">{publishedBlogs.length}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Live on your site</p>
          </div>
        </div>
      )}

      <Tabs defaultValue="scheduled">
        <TabsList className="mb-4">
          <TabsTrigger value="scheduled">
            Scheduled {!isLoading && scheduledBlogs.length > 0 ? `(${scheduledBlogs.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="published">
            Published {!isLoading && publishedBlogs.length > 0 ? `(${publishedBlogs.length})` : ''}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scheduled">
          {isLoading && <Skeleton className="h-64 w-full" />}
          {!isLoading && scheduledBlogs.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Nothing scheduled right now.
            </p>
          )}
          {!isLoading && scheduledBlogs.length > 0 && (
            <BlogsTable blogs={scheduledBlogs} kwMap={kwMap} projectId={projectId} />
          )}
        </TabsContent>

        <TabsContent value="published">
          {isLoading && <Skeleton className="h-64 w-full" />}
          {!isLoading && publishedBlogs.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No published blogs yet. Connect a CMS in Settings to enable auto-publish.
            </p>
          )}
          {!isLoading && publishedBlogs.length > 0 && (
            <BlogsTable blogs={publishedBlogs} kwMap={kwMap} projectId={projectId} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
