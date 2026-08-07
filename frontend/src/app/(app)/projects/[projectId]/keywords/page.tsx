'use client';

import { use, useState } from 'react';
import { useKeywords, useBlogs, useAddKeyword, useCmsConfig } from '@/lib/hooks';
import { extractApiErrorMessage } from '@/lib/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatNumber } from '@/lib/utils/format';
import { Calendar, AlertTriangle, Search, FileText, Clock, Eye } from 'lucide-react';
import Link from 'next/link';
import type { Keyword, Blog } from '@/types/api';

/**
 * app/(app)/projects/[projectId]/keywords/page.tsx — "Keywords & Content
 * Strategy"
 *
 * Replaces the previous design (Upcoming/In Progress/Published/All tabs
 * + a per-keyword "Generate" button). That button is gone deliberately —
 * content generation is fully automatic (weekly-trigger scheduler, see
 * lib/keyword-generation-scheduler.ts) and blogs skip manual draft review
 * entirely (content-generation.job.ts creates them directly as 'ready' —
 * confirmed this is the live, actually-wired job; workers/jobs/
 * blog-generation.job.ts, which DOES create 'draft' blogs, is dead code
 * never registered on any worker). So there is nothing for a human to
 * manually trigger or approve here — only keywords to view and, once
 * their post exists, a "View" link to open the editor.
 *
 * READY vs UPCOMING: not a generation-status distinction (most "Ready"
 * rows still show "Upcoming" per-row status until their turn comes up) —
 * it's date-based. "Ready" = keyword.startDate has already arrived
 * (its content-calendar week has begun); "Upcoming" = startDate is still
 * in the future. This isn't a stored field — startDate/weekNumber already
 * exist on Keyword (assigned in keyword-research.job.ts, 5/week from
 * project creation), so this is a plain comparison against "now", not new
 * business logic. Flagging this as my interpretation of the reference
 * screenshots, not a confirmed spec.
 */

function StatusCell({
  keyword, blog, projectId,
}: {
  keyword: Keyword; blog: Blog | undefined; projectId: string;
}) {
  if (!blog) {
    return <Badge variant="outline" className="text-xs">Upcoming</Badge>;
  }
  if (blog.status === 'published') {
    return (
      <div className="flex items-center gap-2">
        <Badge className="text-xs">Published</Badge>
        <Link
          href={`/projects/${projectId}/blogs/${blog._id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-400 hover:underline flex items-center gap-1"
        >
          <Eye className="h-3 w-3" /> View
        </Link>
      </div>
    );
  }
  // 'ready' (or the unreachable-but-still-valid 'draft'/'archived' enum
  // values, shown honestly rather than assumed away)
  return (
    <div className="flex items-center gap-2">
      <Badge variant="secondary" className="text-xs capitalize">
        {blog.status === 'ready' ? 'Scheduled' : blog.status}
      </Badge>
      <Link
        href={`/projects/${projectId}/blogs/${blog._id}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-blue-400 hover:underline flex items-center gap-1"
      >
        <Eye className="h-3 w-3" /> View
      </Link>
    </div>
  );
}

function KeywordsTable({
  keywords, blogByKeywordId, projectId,
}: {
  keywords: Keyword[]; blogByKeywordId: Map<string, Blog>; projectId: string;
}) {
  if (keywords.length === 0) return null;

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-muted-foreground uppercase tracking-wide text-left border-b border-border">
          <th className="py-2 font-medium w-24">Week</th>
          <th className="py-2 font-medium">Keyword</th>
          <th className="py-2 font-medium text-right w-32">Search Volume</th>
          <th className="py-2 font-medium w-56">Title</th>
          <th className="py-2 font-medium w-48">Status</th>
        </tr>
      </thead>
      <tbody>
        {keywords.map(kw => {
          const blog = blogByKeywordId.get(kw._id);
          return (
            <tr key={kw._id} className="border-b border-border last:border-0">
              <td className="py-3">
                <Badge variant="outline" className="text-xs">Week {kw.weekNumber ?? '—'}</Badge>
              </td>
              <td className="py-3">{kw.keyword}</td>
              <td className="py-3 text-right text-muted-foreground">
                {kw.searchVolume === undefined
                  ? '—'
                  : kw.searchVolume < 500 ? '<500/mo' : `${formatNumber(kw.searchVolume)}/mo`}
              </td>
              <td className="py-3 text-muted-foreground">
                {blog?.title ?? <span className="italic">TBD</span>}
              </td>
              <td className="py-3">
                <StatusCell keyword={kw} blog={blog} projectId={projectId} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function AddKeywordDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [value, setValue] = useState('');
  const addKeyword = useAddKeyword(projectId);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    addKeyword.mutate(trimmed, { onSuccess: onClose });
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Keyword</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground mb-3">
          RankAI checks real search volume and relevance to your business before adding it —
          this may take a few seconds.
        </p>
        <Input
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="e.g. best cleaning products in udaipur"
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          disabled={addKeyword.isPending}
        />
        {addKeyword.isError && (
          <p className="text-xs text-destructive mt-2">
            {extractApiErrorMessage(addKeyword.error, 'Could not add this keyword.')}
          </p>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" size="sm" onClick={onClose} disabled={addKeyword.isPending}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={addKeyword.isPending || !value.trim()}>
            {addKeyword.isPending ? 'Checking…' : 'Add Keyword'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function KeywordsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { data: keywords, isLoading: kwLoading } = useKeywords(projectId);
  const { data: blogs,    isLoading: blLoading  } = useBlogs(projectId);
  const { data: cmsConfig, isLoading: cmsLoading } = useCmsConfig(projectId);
  const [addOpen, setAddOpen] = useState(false);

  const isLoading = kwLoading || blLoading;

  const blogByKeywordId = new Map<string, Blog>(
    (blogs ?? []).filter(b => b.keywordId).map(b => [b.keywordId!, b]),
  );

  const now = new Date();
  const ready    = (keywords ?? []).filter(k => !k.startDate || new Date(k.startDate) <= now)
    .sort((a, b) => (b.weekNumber ?? 0) - (a.weekNumber ?? 0));
  const upcoming = (keywords ?? []).filter(k => k.startDate && new Date(k.startDate) > now)
    .sort((a, b) => (a.weekNumber ?? 0) - (b.weekNumber ?? 0));

  const publishedCount = (blogs ?? []).filter(b => b.status === 'published').length;
  const readyBlogCount = (blogs ?? []).filter(b => b.status === 'ready').length;

  const cmsIncomplete = !cmsLoading && (!cmsConfig?.cmsType || !cmsConfig?.autoPublish);

  return (
    <div className="p-8">
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
            <Calendar className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Keywords & Content Strategy</h1>
            <p className="text-sm text-muted-foreground">
              RankAI identifies high-impact keywords to drive your content strategy
            </p>
          </div>
        </div>
        <Button onClick={() => setAddOpen(true)}>+ Add Keyword</Button>
      </div>

      {/* Summary cards */}
      {isLoading ? (
        <div className="grid grid-cols-3 gap-4 mb-6">
          {[0, 1, 2].map(i => <Skeleton key={i} className="h-28 w-full" />)}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Search className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-2xl font-semibold">{(keywords ?? []).length}</p>
            <p className="text-sm">Keywords</p>
            <p className="text-xs text-muted-foreground mt-1">Every month, RankAI researches for more</p>
          </div>
          <div className="border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <FileText className="h-4 w-4 text-green-500" />
            </div>
            <p className="text-2xl font-semibold">{(blogs ?? []).length}</p>
            <p className="text-sm">Pages Created</p>
            <p className="text-xs text-muted-foreground mt-1">RankAI researches and writes 2 pages every week</p>
          </div>
          <div className="border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Clock className="h-4 w-4 text-blue-400" />
            </div>
            <p className="text-2xl font-semibold">{readyBlogCount}</p>
            <p className="text-sm">Pages Scheduled</p>
            <p className="text-xs text-muted-foreground mt-1">RankAI publishes up to one post daily (Mon–Sat)</p>
          </div>
        </div>
      )}

      {cmsIncomplete && (
        <div className="border border-amber-500/30 bg-amber-500/5 rounded-lg p-4 mb-6 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium">Your CMS config is not set up completely</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                RankAI cannot schedule automatic publish to your site. Complete your CMS integration in
                settings to enable auto-publish.
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" asChild className="shrink-0">
            <Link href={`/projects/${projectId}/settings`}>Complete setup</Link>
          </Button>
        </div>
      )}

      <Tabs defaultValue="ready">
        <TabsList className="mb-4">
          <TabsTrigger value="ready">Ready {!isLoading ? `(${ready.length})` : ''}</TabsTrigger>
          <TabsTrigger value="upcoming">Upcoming {!isLoading ? `(${upcoming.length})` : ''}</TabsTrigger>
        </TabsList>

        <TabsContent value="ready">
          {isLoading && <Skeleton className="h-96 w-full" />}
          {!isLoading && ready.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No keywords ready yet. Complete the pipeline to generate your content calendar.
            </p>
          )}
          {!isLoading && ready.length > 0 && (
            <KeywordsTable keywords={ready} blogByKeywordId={blogByKeywordId} projectId={projectId} />
          )}
        </TabsContent>

        <TabsContent value="upcoming">
          {isLoading && <Skeleton className="h-96 w-full" />}
          {!isLoading && upcoming.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Nothing upcoming right now.
            </p>
          )}
          {!isLoading && upcoming.length > 0 && (
            <KeywordsTable keywords={upcoming} blogByKeywordId={blogByKeywordId} projectId={projectId} />
          )}
        </TabsContent>
      </Tabs>

      {publishedCount > 0 && (
        <p className="text-xs text-muted-foreground mt-4">
          {publishedCount} post{publishedCount !== 1 ? 's' : ''} live.{' '}
          <Link href={`/projects/${projectId}/blogs`} className="text-blue-400 hover:underline">
            View all posts
          </Link>
        </p>
      )}

      {addOpen && <AddKeywordDialog projectId={projectId} onClose={() => setAddOpen(false)} />}
    </div>
  );
}
