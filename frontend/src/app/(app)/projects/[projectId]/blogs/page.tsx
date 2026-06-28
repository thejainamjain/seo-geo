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

function BlogStatusBadge({ status }: { status: string }) {
  const map: Record<string, 'default' | 'secondary' | 'outline'> = {
    published:  'default',
    ready:      'secondary',
    draft:      'outline',
    archived:   'outline',
  };
  return (
    <Badge variant={map[status] ?? 'outline'} className="capitalize text-xs">
      {status}
    </Badge>
  );
}

function BlogsTable({
  blogs,
  kwMap,
  projectId,
  showMarkReady,
}: {
  blogs:         Blog[];
  kwMap:         Map<string, Keyword>;
  projectId:     string;
  showMarkReady: boolean;
}) {
  const updateStatus = useUpdateBlogStatus(projectId);

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
          {showMarkReady && <TableHead />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {blogs.map(blog => {
          const kw        = blog.keywordId ? kwMap.get(blog.keywordId) : undefined;
          const isMarking = updateStatus.isPending && updateStatus.variables?.blogId === blog._id;

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

              {showMarkReady && (
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={isMarking}
                    onClick={() => updateStatus.mutate({ blogId: blog._id, status: 'ready' })}
                  >
                    {isMarking
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : 'Mark as ready'
                    }
                  </Button>
                </TableCell>
              )}
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

  const draftBlogs     = blogs?.filter(b => b.status === 'draft')     ?? [];
  const readyBlogs     = blogs?.filter(b => b.status === 'ready')     ?? [];
  const publishedBlogs = blogs?.filter(b => b.status === 'published') ?? [];

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">Blogs</h1>
        <p className="text-sm text-muted-foreground mt-1">
          AI-generated blog posts — review drafts, approve for publishing
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
            { label: 'Draft',      value: draftBlogs.length,     sub: 'Awaiting your review' },
            { label: 'Ready',      value: readyBlogs.length,     sub: 'Approved, waiting to publish' },
            { label: 'Published',  value: publishedBlogs.length, sub: 'Live on your site' },
          ].map(({ label, value, sub }) => (
            <div key={label} className="border border-border rounded-lg p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
              <p className="text-3xl font-semibold mt-1">{value}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
            </div>
          ))}
        </div>
      )}

      <Tabs defaultValue="draft">
        <TabsList className="mb-4">
          <TabsTrigger value="draft">
            Draft {!isLoading && draftBlogs.length > 0 ? `(${draftBlogs.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="ready">
            Ready {!isLoading && readyBlogs.length > 0 ? `(${readyBlogs.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="published">
            Published {!isLoading && publishedBlogs.length > 0 ? `(${publishedBlogs.length})` : ''}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="draft">
          {isLoading && <Skeleton className="h-64 w-full" />}
          {!isLoading && draftBlogs.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No drafts yet. Go to Keywords and click Generate on a keyword to create a blog post.
            </p>
          )}
          {!isLoading && draftBlogs.length > 0 && (
            <BlogsTable
              blogs={draftBlogs}
              kwMap={kwMap}
              projectId={projectId}
              showMarkReady
            />
          )}
        </TabsContent>

        <TabsContent value="ready">
          {isLoading && <Skeleton className="h-64 w-full" />}
          {!isLoading && readyBlogs.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No blogs ready to publish yet. Review drafts and mark them as ready.
            </p>
          )}
          {!isLoading && readyBlogs.length > 0 && (
            <BlogsTable
              blogs={readyBlogs}
              kwMap={kwMap}
              projectId={projectId}
              showMarkReady={false}
            />
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
            <BlogsTable
              blogs={publishedBlogs}
              kwMap={kwMap}
              projectId={projectId}
              showMarkReady={false}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
