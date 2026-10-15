'use client';

import { use, useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  useBlog, useProject, useCmsConfig,
  useUpdateBlogContent, useUploadBlogImage,
} from '@/lib/hooks';
import { extractApiErrorMessage } from '@/lib/api/client';
import { RichTextEditor } from '@/components/editor/rich-text-editor';
import { HeroImage } from '@/components/editor/hero-image';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { ArrowLeft, ExternalLink, AlertTriangle, Crown, Lock } from 'lucide-react';

/**
 * app/(app)/projects/[projectId]/blogs/[blogId]/page.tsx — blog editor
 *
 * Two-panel layout matching the reference product (left: search preview /
 * SEO settings / AI-optimization signal / editing guidelines / word
 * count; right: title + hero image + body, live-preview style). Reuses
 * the existing RichTextEditor and HeroImage components as-is.
 *
 * ── SAVE MODEL ───────────────────────────────────────────────────────────
 *
 * Debounced autosave, not a manual Save button — industry standard for
 * this kind of editor (Notion, Google Docs, Webflow) and safer than a
 * button someone can forget to click before navigating away.
 *
 * PENDING CHANGES ARE ACCUMULATED, NOT REPLACED — fixes a real bug an
 * earlier version of this file shipped with: editing the title, then
 * quickly editing the description before the debounce fired, cleared the
 * title's pending save and replaced it with a description-only one — the
 * title edit was silently never sent to the backend, while the UI still
 * showed it as typed and `dirty` flipped back to false as if everything
 * had saved. Fixed via `pendingRef`, which every `scheduleSave()` call
 * merges into (not overwrites), so whatever fires after the debounce
 * settles reflects every field touched since the last successful save.
 *
 * ONLY ONE SAVE IN FLIGHT AT A TIME — `savingRef`/`needsResaveRef` queue
 * further edits that arrive while a save is still in flight rather than
 * firing a second, concurrent mutate call that could race it (an
 * older/smaller payload landing after a newer/larger one). The queued
 * flush runs immediately once the in-flight one settles. A failed save's
 * fields are merged back into `pendingRef` (newer edits to the same
 * field take precedence) so they're retried on the next flush instead of
 * silently discarded.
 *
 * TWO KINDS OF SAVE, not one — pushing a full history entry (services/
 * blog.service.ts's `history` array) on every ~1.2s autosave tick would
 * turn "last 50 deliberate saves" into "last 50 autosave ticks", a real
 * behavior regression even though it's bounded and doesn't lose data.
 *   - FAST autosave (every DEBOUNCE_MS of typing pause): persists
 *     `blog.content` immediately so a refresh/crash can't lose typing.
 *     Passes `snapshot: false` — no history entry pushed.
 *   - PERIODIC snapshot: the same flush additionally passes
 *     `snapshot: true` if at least SNAPSHOT_INTERVAL_MS has passed since
 *     the last one AND there's been real editing activity since then —
 *     ties snapshot cadence to actual edits rather than a wall-clock
 *     timer that would fire even while idle. Also always snapshotted:
 *     the final flush on unmount/navigating away (a natural "done
 *     editing" boundary — same idea as how Google Docs names a version
 *     at natural breaks).
 *
 * AVOIDING THE CLASSIC AUTOSAVE RACE CONDITION: local state is only ever
 * initialized FROM the server once (the `initialized` ref) — never
 * overwritten by a later background refetch while the user might still
 * be typing. RichTextEditor only reads its `content` prop once at mount
 * (verified — no prop-resync effect), so this is safe.
 *
 * ── SLUG EDITING ─────────────────────────────────────────────────────────
 *
 * Editable ONLY before publish. This is a real data-safety constraint,
 * not a UI shortcut: lib/cms/wordpress.ts's publishToWordPress (also used
 * for post-publish re-syncs — see lib/blog-cms-publisher.ts) finds which
 * live CMS post to update by looking up the CURRENT slug — there's no
 * stored CMS post ID used for that lookup. Renaming the slug of an
 * already-published post would make that lookup fail to find the live
 * post and create a SECOND, duplicate one instead of updating it — true
 * for every CMS integration using this same pattern, not just one
 * platform. Properly fixing this means reworking the CMS layer to use a
 * stored reference ID instead of slug lookup — a real, separate project.
 * Locking the slug after publish is the safe choice until that exists,
 * and matches real practice elsewhere (Medium and Ghost both lock slugs
 * after publish for the same class of reason).
 *
 * ── "AI OPTIMIZATION" BADGES ─────────────────────────────────────────────
 *
 * The reference shows three (LLM Processing / Google AI Overview / FAQ
 * Schema). Checked what's actually real: the blog-generation prompt
 * (constants/llm.constants.ts) only ever produces ONE schema.org type —
 * Article — there's no separate FAQPage schema on the Blog document.
 * Rather than fabricate three independent claims from one real field,
 * this shows one honest signal: whether structured data
 * (blog.seoSchema) exists yet.
 */

const DEBOUNCE_MS          = 1200;
const SNAPSHOT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes of active editing between history snapshots
const WORDS_PER_MINUTE     = 200; // common, defensible average (Medium uses ~265; 200 is a widely-cited conservative baseline)

function wordCount(html: string): number {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.split(' ').length : 0;
}

export default function BlogEditorPage({
  params,
}: {
  params: Promise<{ projectId: string; blogId: string }>;
}) {
  const { projectId, blogId } = use(params);
  const router = useRouter();

  const { data: blog, isLoading: blogLoading } = useBlog(projectId, blogId);
  const { data: project } = useProject(projectId);
  const { data: cmsConfig } = useCmsConfig(projectId);

  const updateContent  = useUpdateBlogContent(projectId);
  const uploadImageMut = useUploadBlogImage(projectId);

  const isPublished = blog?.status === 'published';

  // Local editable state — initialized once from the server, see header
  // comment for why this must never be re-synced from later refetches.
  const initialized = useRef(false);
  const [title,        setTitle]        = useState('');
  const [description,  setDescription]  = useState('');
  const [heroImageUrl, setHeroImageUrl] = useState<string | null>(null);
  const [content,       setContent]     = useState(''); // mirrors editor content, for word count + save payload
  const [slug,          setSlug]        = useState('');
  const [slugError,    setSlugError]    = useState<string | null>(null);
  const [lastSavedAt,  setLastSavedAt]  = useState<Date | null>(null);
  const [dirty,        setDirty]        = useState(false);

  useEffect(() => {
    if (blog && !initialized.current) {
      setTitle(blog.title);
      setDescription(blog.description ?? '');
      setHeroImageUrl(blog.heroImageUrl ?? null);
      setContent(blog.content ?? '');
      setSlug(blog.slug);
      initialized.current = true;
    }
  }, [blog]);

  // ── Debounced autosave ─────────────────────────────────────────────────
  // See header comment for the fast-vs-snapshot split. pendingRef
  // ACCUMULATES every unsaved field change (merged, not replaced) so that
  // editing title then quickly editing description — both within one
  // debounce window — saves BOTH, not just whichever was edited last.
  const saveTimer       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSnapshotAt  = useRef<number>(Date.now());
  const hasPendingEdit  = useRef(false);
  const pendingRef      = useRef<{
    title?: string; description?: string; content?: string; heroImageUrl?: string | null;
  }>({});
  const savingRef       = useRef(false);   // true while a save request is in flight
  const needsResaveRef  = useRef(false);   // true if edits arrived while one was in flight

  const flushSave = useCallback(() => {
    if (Object.keys(pendingRef.current).length === 0) return;

    // A save is already in flight — don't fire a second, concurrent one
    // (which could race and let an older/smaller payload land after a
    // newer/larger one). Mark that another flush is needed once the
    // current one settles instead.
    if (savingRef.current) {
      needsResaveRef.current = true;
      return;
    }

    const toSave = pendingRef.current;
    pendingRef.current = {};
    savingRef.current = true;

    const dueForSnapshot = hasPendingEdit.current
      && (Date.now() - lastSnapshotAt.current) >= SNAPSHOT_INTERVAL_MS;

    updateContent.mutate(
      { blogId, payload: { ...toSave, snapshot: dueForSnapshot } },
      {
        onSuccess: () => {
          setLastSavedAt(new Date());
          if (dueForSnapshot) {
            lastSnapshotAt.current = Date.now();
            hasPendingEdit.current = false;
          }
        },
        onError: () => {
          // Don't silently drop a failed save — merge the failed fields
          // back in (newer edits to the same fields, if any arrived
          // while this was in flight, take precedence) so the next
          // flush retries them.
          pendingRef.current = { ...toSave, ...pendingRef.current };
        },
        onSettled: () => {
          savingRef.current = false;
          if (Object.keys(pendingRef.current).length === 0) setDirty(false);
          if (needsResaveRef.current) {
            needsResaveRef.current = false;
            flushSave();
          }
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blogId]);

  const scheduleSave = useCallback((patch: {
    title?: string; description?: string; content?: string; heroImageUrl?: string | null;
  }) => {
    pendingRef.current = { ...pendingRef.current, ...patch };
    setDirty(true);
    hasPendingEdit.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, DEBOUNCE_MS);
  }, [flushSave]);

  // Slug edits are deliberate, low-frequency actions (not keystroke
  // events like typing) — always worth a snapshot, and sent immediately
  // (not merged into pendingRef) so a bad slug's validation error can't
  // get bundled up with, and block, an otherwise-fine content save.
  function saveSlug(nextSlug: string) {
    setSlugError(null);
    updateContent.mutate(
      { blogId, payload: { slug: nextSlug, snapshot: true } },
      {
        onSuccess: () => setLastSavedAt(new Date()),
        onError: (err) => setSlugError(extractApiErrorMessage(err, 'Could not update the slug.')),
      },
    );
  }

  // Warn on tab-close/navigation-away if a save hasn't fully settled yet
  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      if (dirty) { e.preventDefault(); e.returnValue = ''; }
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Ref mirror of the latest flushSave — the unmount cleanup below needs
  // to call the CURRENT flushSave (which itself closes over the current
  // updateContent.mutate), not one captured at mount time. Putting
  // flushSave directly in that effect's deps would re-fire its cleanup on
  // every render instead of only on true unmount (flushSave is a new
  // function reference each render, same reasoning as the mutation
  // object itself not being referentially stable).
  const flushSaveRef = useRef(flushSave);
  useEffect(() => { flushSaveRef.current = flushSave; });

  // Flush any pending edits on unmount — a natural "done editing"
  // boundary, so force it to count as a snapshot regardless of the
  // normal snapshot-interval gating (best-effort: this is a
  // fire-and-forget call during cleanup, same inherent limitation any
  // unmount/beforeunload flush has — not specific to this design).
  // Empty deps array is intentional and safe here: blogId is a route
  // param that's stable for this component's entire lifetime (routing to
  // a different blog is a full remount in Next.js, not a prop change).
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    hasPendingEdit.current = true; // force the final flush to snapshot
    lastSnapshotAt.current = 0;    // ensure the snapshot-interval check passes
    flushSaveRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (blogLoading || !blog) {
    return (
      <div className="p-8">
        <Skeleton className="h-8 w-48 mb-6" />
        <div className="grid grid-cols-[340px_1fr] gap-8">
          <Skeleton className="h-[600px] w-full" />
          <Skeleton className="h-[600px] w-full" />
        </div>
      </div>
    );
  }

  const previewUrl = blog.publishedUrl
    ?? (project ? `https://${project.domain}/${cmsConfig?.blogPostPath ?? 'blog'}/${slug}` : '');

  const words   = wordCount(content);
  const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));

  return (
    <div className="flex h-full">
      {/* ── Left panel ─────────────────────────────────────────────── */}
      <div className="w-[340px] shrink-0 border-r border-border p-6 overflow-y-auto space-y-6">
        <div className="flex items-center gap-3">
          <button onClick={() => router.back()} className="p-1 -ml-1 rounded hover:bg-accent">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-sm font-semibold">Overview</h1>
        </div>

        {/* Search preview */}
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Search Preview
          </p>
          <div className="border border-border rounded-lg p-3">
            <p className="text-[11px] text-muted-foreground truncate">{previewUrl}</p>
            <p className="text-sm text-blue-500 font-medium mt-0.5 line-clamp-2">{title}</p>
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{description}</p>
          </div>
        </div>

        {/* Status note */}
        <div className="border border-border rounded-lg p-3 text-xs text-muted-foreground">
          {isPublished
            ? 'This post is live. Edits here are saved as a new version and do not unpublish it.'
            : 'This post is ready to go. If you want to refine future blog posts, you can customize your knowledge, style, or images in Settings anytime.'}
        </div>

        {/* SEO settings */}
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            SEO Settings
          </p>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground flex items-center gap-1.5">
                URL Slug
                {isPublished && <Lock className="h-3 w-3" />}
              </label>
              {isPublished ? (
                <div className="flex items-center gap-1 mt-1 border border-border rounded px-2 py-1.5 bg-muted/30">
                  <span className="text-xs text-muted-foreground">/</span>
                  <span className="text-xs truncate">{slug}</span>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1 mt-1 border border-border rounded px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring">
                    <span className="text-xs text-muted-foreground">/</span>
                    <input
                      value={slug}
                      onChange={e => { setSlug(e.target.value); setSlugError(null); }}
                      onBlur={() => { if (slug !== blog.slug) saveSlug(slug); }}
                      className="flex-1 text-xs bg-transparent outline-none"
                    />
                  </div>
                  {slugError && <p className="text-xs text-destructive mt-1">{slugError}</p>}
                </>
              )}
              {isPublished && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Locked after publish — renaming it could create a duplicate post on your CMS. See code
                  comment for the full reason.
                </p>
              )}
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Title</label>
              <input
                value={title}
                onChange={e => { setTitle(e.target.value); scheduleSave({ title: e.target.value }); }}
                className="w-full mt-1 border border-border rounded px-2 py-1.5 text-sm bg-background"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Meta Description</label>
              <Textarea
                value={description}
                onChange={e => { setDescription(e.target.value); scheduleSave({ description: e.target.value }); }}
                className="mt-1 text-sm min-h-20"
              />
            </div>
          </div>
        </div>

        {/* AI optimization — one honest signal, see header comment for
            why this isn't the reference's three separate badges */}
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            AI Optimization
          </p>
          {blog.seoSchema ? (
            <div className="bg-green-500/5 border border-green-500/20 rounded-lg p-3">
              <p className="text-xs mb-2">This post has structured data for AI-powered search engines:</p>
              <Badge variant="outline" className="text-xs gap-1">
                <Crown className="h-3 w-3" /> Schema.org markup
              </Badge>
            </div>
          ) : (
            <div className="bg-muted/30 border border-border rounded-lg p-3">
              <p className="text-xs text-muted-foreground">No structured data generated for this post yet.</p>
            </div>
          )}
        </div>

        {/* Editing guidelines */}
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            <p className="text-xs font-medium">Editing Guidelines</p>
          </div>
          <p className="text-xs text-muted-foreground">
            <strong className="text-foreground">Only edit content in this SearchPilot editor.</strong> Any changes
            made directly on your CMS will not be reflected here and may cause sync issues.
          </p>
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground pt-2 border-t border-border">
          <span>{words} words</span>
          <span>·</span>
          <span>{minutes} min read</span>
          <span className="ml-auto">
            {updateContent.isPending ? 'Saving…' : dirty ? 'Unsaved changes' : lastSavedAt ? 'Saved' : ''}
          </span>
        </div>
      </div>

      {/* ── Right panel ────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto py-10 px-8">
          {blog.publishedUrl && (
            <a
              href={blog.publishedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-4"
            >
              View live <ExternalLink className="h-3 w-3" />
            </a>
          )}

          <input
            value={title}
            onChange={e => { setTitle(e.target.value); scheduleSave({ title: e.target.value }); }}
            className="w-full text-4xl font-bold mb-6 bg-transparent outline-none"
          />

          <HeroImage
            url={heroImageUrl}
            onChange={(url) => { setHeroImageUrl(url); scheduleSave({ heroImageUrl: url }); }}
            uploadImage={(file) => uploadImageMut.mutateAsync({ blogId, file })}
            editable
          />

          <div className="mt-8">
            <RichTextEditor
              content={content}
              onChange={(html) => { setContent(html); scheduleSave({ content: html }); }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
