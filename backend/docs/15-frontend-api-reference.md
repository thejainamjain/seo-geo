# Backend API Reference — for Frontend Integration

**Purpose of this doc:** every endpoint in this backend, organized by feature
area, with exactly what to send, what you get back, why the endpoint exists,
and when to call it. Written for whoever is building or maintaining the
frontend — including a future you, six months from now, who forgot the
details.

**Why this format, not just "read the code":** this is the pragmatic version
of what industries call an API contract. Full-time API-first companies
(Stripe, GitHub) maintain a machine-readable OpenAPI spec that generates
both docs and client types automatically — the strongest version of this,
because the spec can't drift from reality (code generation forces it to stay
in sync). This repo doesn't have that yet. The realistic middle ground,
given the current codebase (Express + Mongoose, no OpenAPI tooling
installed), is: **this document as the human-readable contract, plus
`frontend/src/types/api.ts` as the machine-checked contract** — the frontend
never hand-guesses a shape, it imports the type. If the two ever disagree,
`types/api.ts` should be corrected to match the actual backend response
(verified against the service/handler code), not the other way around.

**One security note relevant to how you build against this:** every
endpoint below still needs your frontend to enforce nothing on its own for
security — access control, ownership checks, and validation all happen
server-side (`assertProjectAccess` on every project-scoped service). The
frontend hiding a button or route is a UX nicety, never a security boundary.
Treat every response shape below as the actual security-relevant contract —
if a field isn't in the response shape here, it isn't supposed to reach the
client, and if you ever see one that shouldn't be there, that's a bug to
report, not a feature to rely on.

---

## Conventions used across every endpoint

**Base URL:** `/api/v1` prefix on everything below (paths shown are relative
to that).

**Auth:** every endpoint except `POST /auth/register`, `POST /auth/login`,
and `POST /tools/audit` requires:
```
Authorization: Bearer <jwt>
```
Missing or invalid token → `401 Unauthorized`. The JWT is obtained from
`POST /auth/login` or `POST /auth/register` and should be stored client-side
(localStorage/cookie — this repo doesn't dictate which) and attached to
every subsequent request.

**Error shape** — identical across every endpoint, always:
```json
{
  "error": {
    "code":    "NOT_FOUND" | "FORBIDDEN" | "VALIDATION_ERROR" | "CONFLICT" | "UNAUTHORIZED" | "INTERNAL_ERROR",
    "message": "human-readable string, safe to show the user"
  }
}
```
`INTERNAL_ERROR` (500) never includes a stack trace or internal detail,
by design — see `middleware/error.ts`. Every other code maps to a specific
HTTP status (400 validation, 401 unauthorized, 403 forbidden, 404 not
found, 409 conflict).

**Pagination** — identical shape on every list endpoint that supports it:

Query params: `?page=1&limit=20` (limit capped at 100 server-side).

Response:
```json
{
  "<resourceName>": [ /* array */ ],
  "total": 143,
  "page": 1,
  "limit": 20
}
```

**Project scoping** — almost everything lives under
`/projects/:projectId/...`. Every one of those routes independently verifies
the logged-in user belongs to the organization that owns `:projectId` — a
user can never read or write another org's project by guessing an ID.

---

## 1. Auth

### `POST /auth/register`
**Why:** create a new user + a personal organization for them in one step
(every user belongs to exactly one org at signup; agencies can add
teammates later via org invites — not detailed in this doc, check
`OrganizationMember`/invite-related code if you need that flow).
**Auth:** none (public).
**Request body:**
```ts
{
  name:        string;        // 1-100 chars
  email:       string;        // valid email
  password:    string;        // 8-100 chars
  accountType?: 'individual' | 'agency'; // defaults to 'individual'
  utmSource?:   string;
  utmMedium?:   string;
  utmCampaign?: string;
}
```
**Response `201`:**
```ts
{
  token: string; // JWT — store this, attach as Bearer on every future request
  user: {
    id:             string;
    name:           string;
    email:          string;
    accountType:    'individual' | 'agency';
    organizationId: string;
  };
}
```
**Errors:** `409 CONFLICT` if email already registered.

### `POST /auth/login`
**Why:** exchange email+password for a JWT.
**Auth:** none (public).
**Request body:** `{ email: string; password: string }`
**Response `200`:** identical shape to register's response (`{ token, user }`).
**Errors:** `401 UNAUTHORIZED` for wrong email/password (deliberately vague
— doesn't reveal which one was wrong).

---

## 2. Projects

### `POST /projects`
**Why:** create a new project (one per domain/client the org manages).
This is the entry point to everything else — almost every other endpoint
needs a `projectId` this returns.
**Request body:**
```ts
{ domain: string; keywordPrimaryCountryCode?: string; } // e.g. "in", "us" — drives DataForSEO/SerpAPI location targeting
```
**Response `201`:** `{ project: Project }` — see `Project` shape in
`getOne` below.
**Notes:** creating a project does NOT automatically start the SEO
pipeline — see `pipeline/start` below, which is a separate explicit step
after onboarding.

### `GET /projects`
**Why:** list every project the logged-in user's org has access to (project
picker/dashboard).
**Response `200`:** `{ projects: Project[] }` (no pagination on this one —
orgs are expected to have a manageable number of projects, not thousands).

### `GET /projects/:projectId`
**Why:** single project detail (domain, connection statuses, onboarding
progress).
**Response `200`:**
```ts
{
  project: {
    _id:                string;
    domain:              string;
    organizationId:      string;
    isOnboardingComplete: boolean;
    isCmsConnected:      boolean;
    isGscConnected:      boolean;
    keywordPrimaryCountryCode?: string;
    createdAt:           string;
    updatedAt:           string;
    // pipeline status fields — check Project.ts model directly if you need
    // the exact pipeline-step tracking shape, it's more detailed than
    // shown here and evolves with the pipeline itself
  }
}
```

### `GET /projects/:projectId/business`
**Why:** fetch the structured business profile (company/product/customers/
competition/socialProof) that drives every AI-generated piece of content —
this is what the onboarding wizard reads to pre-fill and what the "why this
keyword" reasoning is scored against.
**Response `200`:** `{ businessContext: BusinessContext | null }` — null if
onboarding hasn't run yet. See `models/BusinessContext.ts` for the full
nested shape (company/product/customers/competition/socialProof, each
optional, plus `aiDraftedSteps`/`completedSteps` — see next section for why
those are two separate fields, not one).

### `POST /projects/:projectId/onboarding/step`
**Why:** the onboarding wizard saves ONE step at a time as the user fills
it in (not the whole form at once) — lets someone leave and come back
without losing progress.
**Request body:**
```ts
{
  step: 1 | 2 | 3 | 4 | 5;
  data: Record<string, unknown>; // shape depends on which step — matches that step's slice of BusinessContext
}
```
**Response `200`:** the updated project/context state (check
`project.handler.ts`'s `saveOnboardingStep` return for the exact current
shape — it evolves as onboarding steps get refined).
**Important for UI state:** this endpoint is what sets
`BusinessContext.completedSteps` — meaning "a human confirmed this step."
Separate from `aiDraftedSteps`, which is set in bulk by the backend's
AI-crawl job before any human looks at it. If you're building a progress
indicator, use `completedSteps` for "done" checkmarks, not
`aiDraftedSteps` — the latter means "AI guessed," not "confirmed."

### `POST /projects/:projectId/pipeline/start`
**Why:** explicit trigger to kick off the full automated SEO pipeline
(site crawl → business profile → technical audit → competitor discovery →
keyword research → weekly content generation) after onboarding is
confirmed complete. Not automatic on project creation — the user needs to
have gone through onboarding first.
**Request body:** `{ keywordPrimaryCountryCode?: string }`
**Response `200`:** pipeline-started acknowledgment (job queued, not
synchronous — the pipeline takes minutes, poll `pipeline/status` for
progress).

### `GET /projects/:id/pipeline/status`
**Why:** poll this to show a progress indicator while the initial pipeline
runs (site crawl, audit, keyword research all happen in the background).
**Response `200`:** current step + completion state per phase — check
`lib/pipeline-resume.ts`'s `getPipelineStatus` for the exact shape, it's
tied closely to internal job state.

### `POST /projects/:id/pipeline/resume`
**Why:** admin/support tool — resume the pipeline from a specific step if
it stalled or a step needs re-running. Not a normal user-facing action;
don't wire a button to this without understanding what step you're
resuming from, it can re-trigger downstream work.
**Request body:** `{ fromStep: string }` (a pipeline step identifier).

---

## 3. Keywords

### `GET /projects/:projectId/keywords`
**Why:** the core "Keywords & Content" list — everything about what's
being targeted and its status.
**Query params:** `?status=upcoming|in_progress|published&weekNumber=1&page=1&limit=20`
**Response `200`:** paginated (`{ keywords, total, page, limit }`), each
keyword:
```ts
{
  _id:             string;
  keyword:         string;
  searchVolume?:   number;
  difficulty?:     number;         // 0-100
  cpc?:            number;
  alignmentScore:  number;         // 0-100, how relevant to this business
  relevanceReason?: string;        // the "why this keyword" tooltip text
  suggestedTitle?:  string;        // AI-drafted title preview, before content generation ever runs
  status:          'upcoming' | 'in_progress' | 'published';
  weekNumber?:      number;        // content calendar week
  startDate?:       string;        // ISO date — when this keyword is scheduled to auto-generate
  source:          'ai_suggested' | 'dataforseo' | 'user_added';
  createdAt:       string;
}
```
**Frontend note:** there is currently NO `blogId` on this object — if you
need to show blog content/status alongside a keyword, you must separately
fetch `GET /projects/:projectId/blogs` and join client-side by matching
`Blog.keywordId === Keyword._id` (this is exactly what the existing
`blogs/page.tsx` already does — reuse that join pattern rather than
re-inventing it).

### `POST /projects/:projectId/keywords`
**Why:** user manually adds a keyword outside the automated pipeline. As
of the manual-verification feature, this is NOT a dumb insert — it
synchronously checks real search volume (DataForSEO) and real relevance
(LLM against this project's business context) before accepting it.
**Request body:** `{ keyword: string }`
**Response `201`:** `{ keyword: Keyword }` (same shape as list, now with
real `searchVolume`/`alignmentScore`/`relevanceReason` populated, not
placeholder values).
**Errors:**
- `409 CONFLICT` — this keyword (case-insensitive) already exists for this project.
- `400 VALIDATION_ERROR` — **only** when both checks clearly fail (confirmed
  zero search volume AND judged irrelevant). The message includes the
  LLM's reasoning. This is intentionally rare — a keyword only gets
  rejected when there's real evidence it's a dead end, never just because
  one signal is uncertain. See `docs/14-manual-keyword-verification.md`
  for the full fail-open reasoning if you need to explain this behavior
  to a user or in a support ticket.

### `DELETE /projects/:projectId/keywords/:keywordId`
**Why:** remove a keyword that hasn't been acted on yet.
**Errors:** `400 VALIDATION_ERROR` if status isn't `upcoming` (can't delete
one that's already generating/published), or if a `Blog` already exists
for it.

### `POST /projects/:projectId/keywords/:keywordId/generate`
**Why:** manually trigger content generation for a specific keyword right
now, instead of waiting for its scheduled week. Coexists safely with the
automatic weekly trigger — both use the same job-dedup key, so clicking
this right as the automatic trigger would have fired anyway doesn't create
a duplicate.
**Response `202`:** `{ status: 'generating', keywordId: string }` —
job queued, not synchronous. Poll `GET /keywords` (status will flip to
`in_progress` then eventually a `Blog` will exist) or `GET /blogs` for
progress.
**Errors:** `400 VALIDATION_ERROR` if the keyword isn't `upcoming` (already
generating or done).

---

## 4. Blogs

### `GET /projects/:projectId/blogs`
**Why:** every generated blog post and its status.
**Query params:** `?status=draft|ready|published|archived&page=1&limit=20`
**Response `200`:** paginated, each blog:
```ts
{
  _id:            string;
  title:          string;
  slug:           string;
  description:    string;
  content?:       string;        // full HTML — large, only needed when actually viewing/editing one post
  status:         'draft' | 'ready' | 'published' | 'archived';
  keywordId?:     string;
  seoSchema?:     Record<string, unknown>; // JSON-LD structured data
  cmsReference?:  string;        // ID of the post on the connected CMS, once published
  publishedUrl?:  string;
  lastOptimizedAt?: string;      // set whenever the learning-loop rewrite engine touches this post
  createdAt:      string;
  updatedAt:      string;
}
```
**Note:** the list endpoint likely doesn't need to return full `content`
for every row (large HTML strings × many blogs) — check whether
`blogService.listBlogs` projects that out; if it currently returns full
content on the list view, that's worth trimming for a cheap performance
win, but confirm against current code before assuming.

### `GET /projects/:projectId/blogs/:blogId`
**Why:** single blog detail — full content, `history[]` (every past
version, capped at 50 entries, each with `content`, `description`,
`status`, `writer: 'user' | 'system'`, `createdAt`) for a version-diff view.
**Response `200`:** `{ blog: Blog }` (full shape, including `content` and
`history`).

### `PATCH /projects/:projectId/blogs/:blogId`
**Why:** manual edit — title, content, description, or status.
**Request body (all optional):**
```ts
{ title?: string; content?: string; description?: string; status?: 'draft' | 'ready' | 'published' | 'archived'; }
```
**Response `200`:** `{ blog: Blog }` (updated). Editing content pushes a
`history` snapshot of the PREVIOUS version first — nothing is lost.

### `POST /projects/:projectId/blogs/:blogId/publish`
**Why:** push a `ready` blog live to the connected CMS.
**Response `200`:** `{ blog: Blog }` with `cmsReference`/`publishedUrl` now set.
**Errors:** fails if no CMS is connected, or the blog isn't `ready`.
**Known limitation worth knowing as a frontend dev:** calling this again
on an already-published blog creates a **duplicate** post on most CMS
platforms (7 of 8 publishers don't support "update existing post" yet —
see `docs/11-cms-integrations-audit.md`). Don't build a "republish" button
that calls this repeatedly without checking `cmsReference` is empty first.

### `POST /projects/:projectId/blogs/:blogId/unpublish`
**Why:** take a published blog down (DB status only — does not
currently retract the live CMS post, same underlying limitation as above).

### `DELETE /projects/:projectId/blogs/:blogId`
**Why:** remove a blog entirely.

---

## 5. Business Optimizations (the learning-loop review queue)

### `GET /projects/:projectId/optimizations`
**Why:** the human-review queue for AI-proposed content rewrites. The
automated learning loop (`gsc-monitor.job.ts` → `blog-optimization.job.ts`)
finds underperforming posts, rewrites them, and drops the *content* rewrite
here for approval — title/description/schema tag changes are auto-applied
already and don't appear in this queue (they're a lower-risk tier, applied
immediately with an automatic rollback safety net, not a review step).
**Query params:** `?status=pending_review|applied|rejected&blogId=...&page=1&limit=20`
(defaults to `pending_review` — this is meant to default to "what needs my
attention," not a full history).
**Response `200`:** paginated, each optimization:
```ts
{
  _id:        string;
  blogId:     { _id: string; title: string; slug: string; status: string }; // populated
  projectId:  string;
  contentOptimization?: {
    originalContent:  string;
    optimizedContent: string;
    changesSummary:   string;    // plain-English "what changed and why"
    learningIds:      string[];
  };
  seoTagOptimization?: {
    originalTitle?: string; optimizedTitle?: string;
    originalDescription?: string; optimizedDescription?: string;
    appliedAt?: string;           // already live — this part isn't waiting on approval
    rolledBackAt?: string;        // set if the automatic rollback safety net reverted it
  };
  cmsResyncPending?: boolean;     // true = DB updated but live CMS post is currently out of sync (see CMS limitation above)
  status:     'pending_review' | 'applied' | 'rejected';
  createdAt:  string;
}
```

### `GET /projects/:projectId/optimizations/:optimizationId`
**Why:** single optimization detail — for a before/after diff view.
**Response `200`:** `{ optimization: BlogOptimization }` (full shape,
populated blog includes `content`/`description` too for the diff).

### `PATCH /projects/:projectId/optimizations/:optimizationId/approve`
**Why:** apply the proposed content rewrite to the live blog. Snapshots
the blog's current content to `history[]` first.
**Response `200`:** `{ optimization, message: 'Optimization applied' }`
**Errors:** `400 VALIDATION_ERROR` if already applied/rejected, or if this
record has no `contentOptimization` (tag-only optimizations can't be
"approved" — they're already auto-applied).
**Access note:** currently any project member can approve/reject — there's
no reviewer-specific role yet. Flagged as a candidate to restrict to
owner/admin later; not built now since there's no broader review-role
concept in the product yet. Worth knowing if you're deciding who in your
UI should see this queue.

### `PATCH /projects/:projectId/optimizations/:optimizationId/reject`
**Why:** decline the proposal — no content change, record kept for audit
history (not deleted).
**Response `200`:** `{ optimization, message: 'Optimization rejected' }`

---

## 6. CMS Connection

### `GET /projects/:projectId/cms`
**Why:** current CMS connection status/settings for the settings page.
**Response `200`:**
```ts
{
  cmsConfig: {
    _id: string; projectId: string;
    cmsType?: string;              // 'wordpress' | 'webflow' | 'framer' | 'wix' | 'shopify' | 'sanity' | 'squarespace' | 'gohighlevel' | 'custom_api' | 'other'
    blogPostPath: string;          // e.g. "blog" → yoursite.com/blog/post-slug
    autoPublish: boolean;
    allowedPublishDays: number[];  // 1-6, Mon-Sat — Sunday (0) never allowed
    publishHourUtc?: number;
    // encryptedCredentials is NEVER included here, by design — see security note at top of this doc
  }
}
```
**Errors:** `404 NOT_FOUND` if no CMS connected yet — treat that as "show
the connect flow," not an error state.

### `POST /projects/:projectId/cms/connect`
**Why:** connect a new CMS.
**Request body:**
```ts
{
  cmsType:      string;                    // one of the types listed above
  credentials:  Record<string, unknown>;   // shape depends on cmsType — see CmsConfig.ts model comment for the exact fields each platform needs (e.g. wordpress: {siteUrl, username, applicationPassword})
  blogPostPath?: string;
}
```
**Response `200`:** `{ cmsConfig }` (credentials never echoed back).
**Errors:** `400 VALIDATION_ERROR` for an invalid `cmsType` or missing
required credential fields for that type.

### `PATCH /projects/:projectId/cms`
**Why:** update settings (auto-publish toggle, publish days, blog path) —
does NOT rotate credentials, use `connect` again for that.
**Request body (all optional):** `{ autoPublish?: boolean; allowedPublishDays?: number[]; blogPostPath?: string; }`
**Errors:** `400 VALIDATION_ERROR` if `allowedPublishDays` includes `0`
(Sunday) or anything outside 1-6.

### `DELETE /projects/:projectId/cms/disconnect`
**Why:** remove the CMS connection entirely (clears type + credentials,
turns off auto-publish).
**Response `200`:** `{ message: 'CMS disconnected' }`

---

## 7. Google Search Console

### `GET /projects/:projectId/gsc`
**Why:** connection status for the settings page.
**Response `200`:** `{ gsc: { connected: boolean; expiryDate: string | null } }`
— deliberately minimal, never returns the actual OAuth tokens (see
security note at top).

### `POST /projects/:projectId/gsc/connect`
**Why:** save OAuth tokens after the frontend completes Google's OAuth
flow (this endpoint doesn't do the OAuth dance itself — that's a frontend
+ Google redirect flow, this just persists the result).
**Request body:** `{ accessToken: string; refreshToken: string; expiryDate: string }`
**Response `200`:** `{ message: 'GSC connected' }`

### `DELETE /projects/:projectId/gsc/disconnect`
**Why:** disconnect GSC — stops the weekly performance-monitoring job for
this project.
**Response `200`:** `{ message: 'GSC disconnected' }`

---

## 8. Knowledge (brand documents / RAG source material)

### `GET /projects/:projectId/knowledge`
**Why:** list uploaded brand documents (pricing sheets, case studies,
brand guides) and their processing status.
**Response `200`:**
```ts
{
  files: Array<{
    _id: string; originalName: string; mimeType: string; status: 'pending' | 'processing' | 'ready' | 'error';
    classifiedDocumentKind?: 'pricing' | 'case_study' | 'brand_guide' | 'general';
    classifiedTrustLevel?:   'HIGH' | 'MEDIUM' | 'LOW';
    errorMessage?: string;   // set if status is 'error' — safe to show the user
    createdAt: string;
  }>
}
```
**Frontend note:** `status` moves `pending → processing → ready` (or
`error`) automatically in the background after upload — poll this list if
you want to show live processing progress, there's no separate
"processing progress %" endpoint.

### `POST /projects/:projectId/knowledge` (multipart/form-data)
**Why:** upload a brand document. Triggers background extraction →
classification → chunking → embedding — the file becomes usable for AI
content generation once `status` reaches `ready`, not immediately on
upload.
**Request:** `multipart/form-data`, field name `file`. Accepted types
currently: PDF, txt, markdown, csv, json (no DOCX yet — flagged as a
known follow-up, not built).
**Response `201`:** `{ file: KnowledgeFile }` at `status: 'pending'` —
the actual processing happens asynchronously after this returns.

### `DELETE /projects/:projectId/knowledge/:fileId`
**Why:** remove an uploaded file and all its associated embedded chunks
(both are cleaned up together — no orphaned data left behind).
**Response `200`:** `{ file: KnowledgeFile }` (the deleted record).

---

## 9. Technical Audit

### `GET /projects/:projectId/audit`
**Why:** latest full site audit summary — the dashboard's top-line
numbers (pages crawled, schemas found, internal links, fixes applied).
**Response `200`:** `{ audit: Audit | null }` — see `models/Audit.ts` for
the full `summary` shape (`totalPages`, `totalFixes`, `totalSchemas`,
`totalInternalLinks`, `totalFaqs`).

### `GET /projects/:projectId/audit/code-changes`
**Why:** list of specific fixes the technical-audit AI identified (missing
alt text, broken schema, etc.) — the "apply this fix" list.
**Query params:** `?type=...&status=...&page=1&limit=20`

### `POST /projects/:projectId/audit/code-changes/:changeId/apply`
**Why:** apply a specific suggested fix.

### `POST /projects/:projectId/audit/code-changes/:changeId/disable`
**Why:** dismiss a suggested fix without applying it (e.g., it doesn't
apply to this site, or was already handled manually).

### `GET /projects/:projectId/audit/faqs`
**Why:** AI-generated FAQ content extracted during the audit, for FAQ-schema pages.
**Query params:** `?status=...&page=1&limit=20`

### `GET /projects/:projectId/audit/tldrs`
**Why:** AI-generated TL;DR summaries per page, for GEO (AI-answer-engine
visibility) purposes.
**Query params:** `?status=...&page=1&limit=20`

---

## 10. GEO Analytics

### `GET /projects/:projectId/geo`
**Why:** list of GEO measurement runs (does this site get cited when an AI
answers questions about its keywords?).
**Response `200`:** `{ runs: GeoRun[] }`

### `GET /projects/:projectId/geo/latest`
**Why:** most recent run only — for a dashboard summary card.
**Response `200`:** `{ run: GeoRun | null }`

---

## 11. Tools (public, no auth)

### `POST /tools/audit`
**Why:** the public "free audit" lead-gen tool — someone enters their
domain + email on a marketing page and gets a basic audit without needing
an account. This is intentionally the one authenticated-user-free endpoint
in the whole API (besides register/login) — don't add `requireAuth` to it.
**Request body:**
```ts
{ domain: string; email: string; firstName: string; businessType: 'over_150k' | 'under_150k' | 'agency'; }
```
**Response:** check `tools.handler.ts`/`tools.service.ts` for the exact
shape — this is a marketing/lead-gen path, likely to change independently
of the core product API above.

---

## Quick lookup: what to call, when

| You're building...                          | Call this |
|----------------------------------------------|-----------|
| Login screen                                  | `POST /auth/login` |
| "Create your first project" onboarding        | `POST /projects` → `POST /projects/:id/onboarding/step` (×5) → `POST /projects/:id/pipeline/start` |
| Onboarding progress indicator                 | `GET /projects/:id/business` → read `completedSteps` (human-confirmed) vs `aiDraftedSteps` (AI guess, not yet reviewed) |
| Keywords & Content list page                  | `GET /keywords` + `GET /blogs`, joined client-side on `keywordId` |
| "Add a keyword" button                        | `POST /keywords` — expect an occasional real rejection, show the message verbatim, it includes the reasoning |
| Blog editor                                   | `GET /blogs/:id` → `PATCH /blogs/:id` |
| Publish button                                | `POST /blogs/:id/publish` — check `cmsReference` is empty first, don't call twice |
| "Needs your review" queue                     | `GET /optimizations` (defaults to `pending_review`) |
| Approve/reject a rewrite                      | `PATCH /optimizations/:id/approve` or `/reject` |
| CMS settings page                             | `GET /cms` for current state, `POST /cms/connect` to (re)connect, `PATCH /cms` for toggles |
| Knowledge base upload UI                      | `POST /knowledge` (multipart) → poll `GET /knowledge` for `status` |
| Technical SEO dashboard                       | `GET /audit`, `GET /audit/code-changes` |
| GEO visibility dashboard                      | `GET /geo/latest` |
