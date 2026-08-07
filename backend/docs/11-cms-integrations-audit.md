# CMS Platform Integrations (8 platforms): Backend Audit

**Files:** `lib/cms/{wordpress,webflow,framer,wix,shopify,sanity,gohighlevel,custom-api}.ts`,
plus `lib/cms/types.ts`, `lib/cms/index.ts` (shared dispatcher), and
`lib/cms/shared.ts` (new — shared `injectSchema` helper)
**Status: 🔴 One critical finding still open (Framer/RankAI domain — needs
a product decision, not a code fix). Everything else — idempotency, schema
markup, Sanity branding, Wix content format — resolved (Wix and GoHighLevel
still want a live test to confirm, honestly flagged where confidence is
lower than "verified").**

## 🔴 CRITICAL — `framer.ts` calls out to RankAI's actual live infrastructure

```ts
// lib/cms/framer.ts, line 25
function buildWebhookUrl(projectId: string): string {
  return `https://framer-plugin.rankai.ai/api/publish/${projectId}`;
}
```

This is not a documentation reference (like the many "this matches how
RankAI does X" design-rationale comments scattered through the codebase,
which are fine) — this is a **live `fetch()` call in the actual runtime
publish path**. Any customer of this product who connects Framer as their
CMS would have their blog content POSTed to `framer-plugin.rankai.ai` —
RankAI's own domain, not this product's.

Two possible outcomes, both bad:
1. The endpoint doesn't recognize this product's `projectId` values and
   the call fails — Framer publishing is simply broken for every user.
2. Worse case: if that endpoint responds to unrecognized project IDs in
   any generic way, this product would be **sending customer blog content
   to a third party's (RankAI's) servers** without their knowledge — a
   real data-handling concern, not just a functionality bug.

**This must be fixed before Framer is offered as a CMS option to any real
user.** The actual fix depends on product decisions outside what I can
resolve alone — flagging rather than guessing:
- Does this product have its own Framer plugin built and published yet?
  If not, Framer publishing has no real backend to point at until one
  exists — this may need to be disabled/hidden as a CMS option until then,
  rather than silently pointing at a placeholder.
- If a plugin exists under a different domain, this needs to point there
  instead.

## ✅ RESOLVED — `sanity.ts` baked "RankAI" into the schema contract with users' own Sanity projects

```ts
// lib/cms/sanity.ts (before)
const documentId = `rankAiBlogPost-${payload.slug}`;
// ...
_type: 'RankAIBlogPosts',
```

Unlike the Framer issue, this didn't call out to any external server —
but it meant **for Sanity publishing to work at all, the connecting
customer's own Sanity project needed a custom schema type literally
named `RankAIBlogPosts`**, which only made sense if this product shipped
its own identically-named schema package — otherwise every Sanity publish
would fail with a schema-type-not-found error.

The old CORS/fetch-URL comments (pointing at `rankai.ai/api/v1/...`) were
never live code — just misleading documentation-style comments in the
file, written as if they were setup instructions. Not checked against
user-facing docs/frontend in this pass, but flagging: if that exact
phrasing appears anywhere in real setup instructions, it should be fixed
too.

Fix: renamed to `post` / `post-${slug}` — matches Sanity's own official
blog starter template convention (and the community-standard
`sanity-plugin-blog` package), so this now works against any Sanity
project with a standard blog schema already, rather than requiring a
product-specific schema package that doesn't exist yet. If this product
ever ships its own installable Sanity schema package, the type name
should be updated to match that package exactly rather than this generic
default.

## ✅ RESOLVED — no idempotency in 7 of 8 publishers

`sanity.ts` was the **only** publisher that was actually retry-safe — it
uses Sanity's `createOrReplace` mutation with a deterministic document ID
derived from the slug, so calling it twice updates the same document
instead of creating a duplicate.

**Every other publisher blindly created a new post/item on every call,
with no check for "does content with this slug already exist."** Since
`publishBlog()` runs inside a BullMQ job with `attempts: 3` (both the
on-demand path in `content-generation.job.ts` and the cron path in
`cms-publish.job.ts`), a transient failure **after** the post was
successfully created but **before** the job function returned (e.g. the
network blip happens on WordPress's step 4 "publish" call, or on parsing
the response) meant the retry ran the whole function again from
scratch — creating a second post. Most platforms auto-suffix the slug
(e.g. `-2`) rather than reject it, so this failed silently: the user ended
up with duplicate published posts and no error surfaced anywhere.

Affected: `wordpress.ts`, `webflow.ts`, `framer.ts`, `wix.ts`,
`shopify.ts`, `gohighlevel.ts`, `custom-api.ts`.

**Fix, done two ways:**
- **Consolidated the publish path**: three independently-duplicated
  "publish then persist" implementations (`blog.service.ts`,
  `content-generation.job.ts`, `cms-publish.job.ts`) merged into one
  shared `lib/blog-cms-publisher.ts`, with a guard — if `Blog.cmsReference`
  is already set, skip the CMS call entirely and return the existing
  result. This closes the duplicate-post risk across all 8 platforms at
  once from a single choke point, rather than needing every platform's
  API-specific upsert logic to be the only line of defense.
- **Per-platform upsert-by-slug, added anyway** (defense in depth — closes
  the narrower gap where the guard above can't help, i.e. a crash between
  the CMS call succeeding and the DB write recording it): WordPress
  (`GET /posts?slug=X&status=any`), Webflow (`slug` query param on List
  Collection Items, v2 API), Wix (`GET /v3/posts/slugs/{slug}`), Shopify
  (`handle` query param on the Article list endpoint — this actually
  contradicts what the original finding below assumed was hard to do),
  and GoHighLevel (`url-slug-exists` + list-and-match fallback, since the
  exact response shape of the existence check wasn't fully confirmed from
  docs alone). Each verified against real platform API documentation, not
  guessed. Framer deliberately excluded — no real, owned API to query yet
  (see the critical finding above). Custom API given a stable `blogId` in
  the outbound payload as an idempotency key the receiving endpoint can
  use if it wants to, since we don't control its schema.

<details>
<summary>Original finding (for reference)</summary>

**Fix direction** (pattern to copy from `sanity.ts`, adapted per platform):
- **Easiest fix, checked and confirmed available**: `Blog.cmsReference` is
  already stored after a successful publish (`blog.service.ts` line ~152),
  but nothing checks it before calling `cmsPushBlog()` again. Adding a
  guard — "if this blog already has a `cmsReference`, don't republish" —
  in `blog.service.ts`'s publish method would prevent the duplicate-post
  scenario across **all 8 platforms at once**, without needing to fix each
  file's API-specific upsert behavior individually. This is a much smaller
  change than fixing per-platform upsert logic and would close most of the
  real-world risk immediately.
- **Fuller fix** (per-platform, still worth doing eventually): WordPress/Wix
  check for an existing post by `slug` before creating
  (`GET /posts?slug=X`), update it if found instead of creating new.
  Webflow's CMS API supports upsert-by-slug in some API versions — worth
  checking. Shopify Articles don't have a natural upsert-by-handle in the
  REST API — would need to query existing articles by handle first.
  GoHighLevel/Framer/CustomApi depend on what each API actually supports.

</details>

## ✅ RESOLVED — `seoSchema` (JSON-LD structured data) was silently dropped on 3 platforms

The whole point of the technical-audit phase (Phase 3) is generating
correct schema markup — but it wasn't reaching the live page on:
- `webflow.ts` — `payload.seoSchema` wasn't referenced anywhere in the file
- `wix.ts` — same
- `gohighlevel.ts` — same

WordPress, Framer, Sanity, and Custom API all passed it through correctly.
Shopify stored it (see below) but didn't render it. So schema markup — a
real SEO factor this product's own technical-audit phase scores — was
silently not reaching the live page for roughly half the supported CMS
platforms.

Fix: extracted WordPress's existing `injectSchema()` helper (which appends
a `<script type="application/ld+json">` tag to the end of the HTML content)
into a new shared `lib/cms/shared.ts`, and wired it into `webflow.ts`
(`post-body`), `gohighlevel.ts` (`rawHtml`), and `wix.ts` (`contentText` —
see the caveat below, this one still needs live verification). All three
accept plain HTML content fields, so this is a direct, reliable fix — no
platform-specific API quirks to work around.

## ✅ RESOLVED — Shopify's schema storage wasn't rendered anywhere

```ts
metafields: payload.seoSchema
  ? [{ key: 'schema_json', value: JSON.stringify(payload.seoSchema), type: 'json', namespace: 'seo' }]
  : [],
```

This stored the schema as a Shopify metafield, which is real data storage
— but metafields don't automatically appear on the storefront. A theme
has to be explicitly customized with Liquid template code to read
`seo.schema_json` and output it as a `<script type="application/ld+json">`
tag. For any store using a default/unmodified theme, this schema was
stored but invisible to search engines and AI crawlers.

Fix: switched to injecting the schema directly into `body_html` (same
`injectSchema()` helper as above) — `body_html` renders on the storefront
unconditionally, regardless of theme customization. Kept the
`seo.schema_json` metafield write as well, as a bonus for any theme that
has been customized to read it separately, but `body_html` is what now
guarantees the schema actually reaches the live page by default.

## 🟡 Best-effort fix applied — Wix content format (confirmed real bug, fix confidence still needs a live test)

```ts
// before
post: { contentText: payload.content, ... }
```

This was confirmed to be a real problem, not just a hunch — Wix's own
docs and multiple developer forum threads confirm the blog post content
field expects a "Ricos Document" (structured JSON node tree), not raw
HTML. Sending HTML in `contentText` was very likely producing literal
HTML-tags-as-text rather than formatted content, and the injected schema
`<script>` tag (from the fix above) would have had the same problem.

**Fix:** now calls Wix's own "Convert To Ricos Document" endpoint
(`POST /ricos/v1/ricos-document/convert/to-ricos`, confirmed to exist and
documented as accepting HTML input) to do the conversion server-side,
instead of hand-writing an HTML→Ricos parser — multiple forum threads
show other developers struggling to do this by hand, since Ricos' node
structure has non-trivial nesting rules. Falls back to a minimal,
manually-built single-paragraph Ricos document (plain text, HTML tags
stripped) if the conversion call fails for any reason.

**Being upfront about confidence here**: the endpoint's existence and
purpose are confirmed from Wix's official docs. The exact request/response
field names were NOT confirmable — Wix's interactive API reference renders
the schema client-side in a way I couldn't extract via fetch. The
implementation uses a best-effort body shape based on Wix's conventions
elsewhere in the same API family. This is meaningfully better than the
previous state (which was confirmed wrong), but **still needs a real live
test against a Wix account** before being trusted in production — also
requires the "Manage Ricos Document" permission to be enabled on whatever
Wix API key/app is used, which is worth checking is granted.

## 🟢 Low-priority / minor
- `wordpress.ts`: uploaded featured images are always named with a
  hardcoded `.avif` extension regardless of the actual `Content-Type`
  returned by the image fetch — cosmetic/filename-only, unlikely to break
  functionality but could confuse anyone browsing the WP media library.
- `shopify.ts`: publishes under "the first Blog found" on the store with
  no way to choose a different one — already self-documented as a known
  simplification in the file's own comments, not a silent gap.
- `custom-api.ts`: comment says "user exports from RankAI" — just
  phrasing, not a functional issue, but part of the same pattern as the
  Sanity comments above; worth a pass to update copy once branding is
  finalized.
- `'other'` cmsType: accepted at connect-time (zero required credential
  fields in `cms.service.ts`), but `lib/cms/index.ts`'s dispatcher throws
  `Unsupported CMS type: other` at actual publish-time. A user could
  connect with this type and only discover it doesn't work when their
  first scheduled publish silently fails. Minor — worth either removing
  `'other'` as a connectable option, or handling it explicitly (e.g. as an
  alias for `custom_api` requiring the same fields).

## What's genuinely solid across all 8
- Consistent, well-structured error handling (HTTP status + response body
  truncated to 300 chars in every thrown error) — good for debugging
  failed publishes.
- Consistent 30s fetch timeouts everywhere via `AbortSignal.timeout`.
- `publishedUrl` construction is consistent and correct across all
  platforms (`https://{domain}/{blogPostPath}/{slug}`).
- Credential decryption is centralized in `index.ts` — no platform file
  touches raw encrypted credentials, matches the codebase's own stated
  security design.
- Hero image handling is consistently treated as non-fatal (publish
  continues without it on failure) — matches the codebase's established
  "partial success over total failure" philosophy seen everywhere else.

## Not yet audited (flagging, not forgetting)
`blog.service.ts` — to confirm whether a successful `cmsReference` gets
stored on the `Blog` document in a way that could support the idempotency
fix above, and `knowledge.service.ts`/`audit.service.ts` (the read-side
APIs) — still outstanding from the original master summary.
