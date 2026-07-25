# 13. Knowledge & Learning System

**Status: ✅ Built and type-checked. Requires one manual step before it works live — see "Required Atlas setup" below. Three known follow-ups flagged at the end.**

Based on `LEARNING_SYSTEM_ARCHITECTURE.md` (uploaded reference doc), adapted to
this codebase's actual conventions rather than following the source doc's
folder structure/infra literally (SQS/EventBridge → BullMQ/Redis,
`handlers/` → `services/` + `workers/jobs/`, two chunk collections → one
unified collection). Several pieces of this were *already* designed in the
codebase before this build — models existed (`ProjectKnowledgeFile`,
`BlogLearning`, `BlogOptimization`, `ProjectLearningChunk`,
`business-context-formatter.ts`) but were never wired to anything. That
scaffolding turned out to already make better calls than the source doc in
a couple of places, so this build kept those and built the missing pieces
around them rather than replacing them.

## What actually got built

### Engine 1 — Knowledge (RAG over uploaded brand documents)
- `lib/file-extractor.ts` — extract text from PDF/txt/md/csv/json (extracted
  out of the old `lib/knowledge-loader.ts`, which is now a degraded-mode
  fallback, not the primary path)
- `lib/chunker.ts` — table/section/paragraph chunking by doc type
- `lib/embeddings.ts` — Gemini `text-embedding-004` (768-dim, free with the
  existing Gemini key — no new provider needed)
- `workers/jobs/knowledge-processing.job.ts` + `.worker.ts` — the pipeline
  that was completely missing: uploaded files sat at `status: 'pending'`
  forever before this. Now: extract → classify (1 LLM call per **file**,
  not per chunk — see that job's doc comment for the cost tradeoff) → chunk
  → embed → store as `ProjectLearningChunk`
- Wired into `knowledgeService.uploadFile()` (enqueues the job) and
  `deleteFile()` (was leaving orphaned chunks behind forever — fixed)

### Engine 2 — Learning (closing the GSC feedback loop)
- `gsc-monitor.job.ts` already created `BlogLearning` insights (and, from
  the earlier session, deduped them) — but nothing ever *acted* on them.
  Now, for each blog with fresh insights this run:
  - Each `BlogLearning` gets embedded into `ProjectLearningChunk`
    (`sourceType: "learning"`) so it's retrievable
  - `workers/jobs/blog-optimization.job.ts` is enqueued — the actual
    rewrite engine

### The rewrite engine — `blog-optimization.job.ts`
Retrieves relevant learnings + brand knowledge via hybrid search, rewrites
the post. **Tiered by risk** (confirmed with the team):
- `contentOptimization` (full body rewrite) → `pending_review`. A human
  must approve via the new endpoint below before it touches the live blog.
- `seoTagOptimization` (title/description/schema) → **auto-applied
  immediately**, with a `Blog.history[]` snapshot taken first (so it's
  always revertible) and a rollback check added to `gsc-monitor.job.ts`'s
  next cycle: if CTR drops >10% relative to the pre-change baseline within
  7-35 days, it's automatically reverted using the exact original values
  stored on the `BlogOptimization` record.

### Retrieval — `lib/vector-search.ts`
One `hybridSearch()` function (Atlas `$vectorSearch` + `$search` BM25,
fused with Reciprocal Rank Fusion) serves both knowledge and learning
retrieval, filtered by `sourceType`. Degrades to an empty result (not a
throw) if the Atlas Search indexes below don't exist yet — blog generation
still works, just without RAG context, exactly like it did before this
system existed.

Wired into both blog-generation paths (`content-generation.job.ts`,
`blog-generation.job.ts`), replacing the old whole-file-truncation
approach — retrieval is now scoped to the actual keyword being generated,
and **new** blog generation now also pulls in past learnings, not just
optimization runs.

### Human review — `optimization.service.ts` / `.handler.ts` / `.route.ts`
`GET/PATCH /projects/:projectId/optimizations` — list (defaults to
`pending_review`), approve, reject. Approving snapshots the blog's current
content to history, then applies the rewrite. Access model: any project
member, same as everything else in this codebase today (see that file's
doc comment — this is a flagged, deliberate choice, not an oversight).

## Required Atlas setup (manual — cannot be done in code)

Two Atlas Search indexes need to exist on the `projectlearningchunks`
collection before hybrid search actually returns anything (until then,
`hybridSearch()` degrades to empty results, logged as a warning — nothing
breaks, RAG context is just absent).

**1. Vector index** — name: `chunk_vector_index`

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 768,
      "similarity": "cosine"
    },
    { "type": "filter", "path": "projectId" },
    { "type": "filter", "path": "sourceType" }
  ]
}
```

**2. Full-text (BM25) index** — name: `chunk_text_index`

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "content":    { "type": "string" },
      "keyword":    { "type": "string" },
      "projectId":  { "type": "objectId" },
      "sourceType": { "type": "string" }
    }
  }
}
```

Create both via Atlas UI (Search tab -> Create Search Index -> JSON Editor) or
`mongosh`/Atlas CLI, on the `projectlearningchunks` collection. No app code
changes needed once these exist — `lib/vector-search.ts` will just start
returning real results.

## Known follow-ups (flagged, not built — out of scope for this pass)

1. **CMS re-sync gap — narrower than originally scoped, correcting here.**
   Both `blog-optimization.job.ts` (tag auto-apply) and
   `optimization.service.ts` (content approval) update the `Blog` document
   but do **not** push the change to an already-published CMS post yet —
   `cmsResyncPending` is set and logged, but nothing currently reads it to
   act.
   
   This doc originally said "7 of 8 CMS publishers can't update an
   existing post yet" — that was accurate when written, but a parallel
   idempotency fix (see `docs/11-cms-integrations-audit.md`) has since
   added real update-by-slug support to WordPress, Webflow, Wix, Shopify,
   and GoHighLevel, and Sanity already had it via `createOrReplace`. That's
   **6 of 8 platforms that can now genuinely update an existing post** —
   only Framer (blocked on the separate RankAI-domain issue) and Custom
   API (receiving endpoint's schema isn't ours to control) still can't.
   
   So actually wiring `cmsResyncPending` to trigger a re-publish is more
   tractable than it looked when this was first scoped — but it's not
   just a mechanical fix. `lib/blog-cms-publisher.ts`'s `publishBlogToCms()`
   currently treats "this blog already has a `cmsReference`" as "skip,
   don't call the CMS again" — that's the right behavior for avoiding a
   duplicate post on a BullMQ retry, but it's the wrong behavior here,
   where the content has legitimately changed and an update SHOULD go out.
   Needs a deliberate decision (e.g. a separate `updateBlogOnCms()` path,
   or a `forceUpdate` flag on the existing function) rather than just
   flipping the guard, since those two cases need to stay distinguishable.
   Left as a follow-up rather than assumed — flagging for a decision, not
   deciding it here.
2. **Approve/reject access is unrestricted** (any project member). Flagged
   during design as a candidate to restrict to `owner`/`admin` — two-line
   change in `optimization.service.ts`'s `assertProjectAccess()` — once
   there's real need for tighter review gatekeeping.
3. **DOCX upload support** — deferred per your call earlier in this build.
   `lib/file-extractor.ts` only handles pdf/txt/md/csv/json.
