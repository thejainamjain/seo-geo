'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useBlog, useUpdateBlogStatus } from '@/lib/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { timeAgo } from '@/lib/utils/format';
import { ArrowLeft, CheckCircle2, ExternalLink, Clock } from 'lucide-react';
import Link from 'next/link';

export default function BlogDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; blogId: string }>;
}) {
  const { projectId, blogId } = use(params);
  const router = useRouter();
  const { data: blog, isLoading } = useBlog(projectId, blogId);
  const updateStatus = useUpdateBlogStatus(projectId);

  if (isLoading) {
    return (
      <div className="p-8 max-w-4xl mx-auto space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-96 w-full mt-8" />
      </div>
    );
  }

  if (!blog) {
    return (
      <div className="p-8">
        <p className="text-sm text-muted-foreground">Blog not found.</p>
      </div>
    );
  }

  const wordCount = blog.content
    ? blog.content.replace(/<[^>]*>/g, '').split(/\s+/).filter(Boolean).length
    : 0;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Back */}
      <Link
        href={`/projects/${projectId}/keywords`}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Keywords & Blogs
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold leading-snug">{blog.title}</h1>
          <div className="flex items-center gap-3 mt-2">
            <Badge
              variant={
                blog.status === 'published' ? 'default' :
                blog.status === 'ready'     ? 'secondary' : 'outline'
              }
              className="capitalize"
            >
              {blog.status}
            </Badge>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {timeAgo(blog.createdAt)}
            </span>
            {wordCount > 0 && (
              <span className="text-xs text-muted-foreground">{wordCount.toLocaleString()} words</span>
            )}
          </div>
          {blog.description && (
            <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{blog.description}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {blog.publishedUrl && (
            <Button variant="outline" size="sm" asChild>
              <a href={blog.publishedUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                View live
              </a>
            </Button>
          )}
          {blog.status === 'draft' && (
            <Button
              size="sm"
              onClick={() => updateStatus.mutate({ blogId, status: 'ready' })}
              disabled={updateStatus.isPending}
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
              {updateStatus.isPending ? 'Marking ready…' : 'Mark as ready'}
            </Button>
          )}
          {blog.status === 'ready' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => updateStatus.mutate({ blogId, status: 'draft' })}
              disabled={updateStatus.isPending}
            >
              Revert to draft
            </Button>
          )}
        </div>
      </div>

      <Separator className="mb-6" />

      <Tabs defaultValue="content">
        <TabsList className="mb-6">
          <TabsTrigger value="content">Content</TabsTrigger>
          <TabsTrigger value="history">
            History ({(blog.history ?? []).length})
          </TabsTrigger>
        </TabsList>

        {/* Content tab */}
        <TabsContent value="content">
          {blog.content ? (
            <div
              className="prose prose-sm prose-invert max-w-none
                prose-headings:font-semibold prose-headings:tracking-tight
                prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg
                prose-p:text-muted-foreground prose-p:leading-relaxed
                prose-a:text-foreground prose-a:underline
                prose-li:text-muted-foreground
                prose-strong:text-foreground
                prose-code:text-foreground prose-code:bg-muted prose-code:px-1 prose-code:rounded"
              dangerouslySetInnerHTML={{ __html: blog.content }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No content generated yet.</p>
          )}
        </TabsContent>

        {/* History tab */}
        <TabsContent value="history">
          <div className="space-y-4">
            {(blog.history ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No history entries yet.</p>
            )}
            {[...(blog.history ?? [])].reverse().map((entry, idx) => (
              <div key={entry._id} className="border border-border rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="capitalize text-xs">
                      {entry.writer}
                    </Badge>
                    <Badge variant="outline" className="capitalize text-xs">
                      {entry.status}
                    </Badge>
                    {idx === 0 && (
                      <span className="text-xs text-muted-foreground">Latest</span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">{timeAgo(entry.createdAt)}</span>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-3">
                  {entry.content.replace(/<[^>]*>/g, '').slice(0, 200)}…
                </p>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
