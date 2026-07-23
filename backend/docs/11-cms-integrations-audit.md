# CMS Platform Integrations (8 platforms): Backend Audit

**Files:** `lib/cms/{wordpress,webflow,framer,wix,shopify,sanity,gohighlevel,custom-api}.ts`,
plus `lib/cms/types.ts` and `lib/cms/index.ts` (shared dispatcher)
**Status: 🔴 One critical finding. One real cross-cutting bug. Several
medium/low content-completeness gaps.**

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

## 🟠 Related — `sanity.ts` bakes "RankAI" into the schema contract with users' own Sanity projects

```ts
// lib/cms/sanity.ts
const documentId = `rankAiBlogPost-${payload.slug}`;
// ...
_type: 'RankAIBlogPosts',
```

Unlike the Framer issue, this doesn't call out to any external server —
but it means **for Sanity publishing to work at all, the connecting
customer's own Sanity project must have a custom schema type literally
named `RankAIBlogPosts`** (presumably from installing a RankAI-branded
schema package). This only makes sense if this product ships its own
identically-named schema package — otherwise every Sanity publish will
fail with a schema-type-not-found error. Needs renaming to match this
product's actual name once decided.

Also worth a look before any Sanity setup docs ship: the file's own
comments (not runtime code, but written as if they were setup
instructions) tell users to fetch content from `rankai.ai/api/v1/...` and
whitelist `https://rankai.ai` in their Sanity CORS settings. If this
phrasing made it into user-facing docs anywhere (not checked — frontend
wasn't in this pass), it would tell users to whitelist the wrong domain.

## 🟠 Real cross-cutting bug: no idempotency in 7 of 8 publishers

`sanity.ts` is the **only** publisher that's actually retry-safe — it uses
Sanity's `createOrReplace` mutation with a deterministic document ID
derived from the slug, so calling it twice updates the same document
instead of creating a duplicate.

**Every other publisher blindly creates a new post/item on every call,
with no check for "does content with this slug already exist."** Since
`publishBlog()` runs inside a BullMQ job with `attempts: 3` (both the
on-demand path in `content-generation.job.ts` and the cron path in
`cms-publish.job.ts`), a transient failure **after** the post was
successfully created but **before** the job function returns (e.g. the
network blip happens on WordPress's step 4 "publish" call, or on parsing
the response) means the retry runs the whole function again from
scratch — creating a second post. Most platforms will auto-suffix the
slug (e.g. `-2`) rather than reject it, so this fails silently: the user
ends up with duplicate published posts and no error surfaced anywhere.

Affected: `wordpress.ts`, `webflow.ts`, `framer.ts`, `wix.ts`,
`shopify.ts`, `gohighlevel.ts`, `custom-api.ts`.

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

## 🟡 Medium — `seoSchema` (JSON-LD structured data) silently dropped on 3 platforms

The whole point of the technical-audit phase (Phase 3) is generating
correct schema markup — but it never reaches the live page on:
- `webflow.ts` — `payload.seoSchema` isn't referenced anywhere in the file
- `wix.ts` — same
- `gohighlevel.ts` — same

WordPress, Framer, Sanity, and Custom API all pass it through correctly.
Shopify stores it (see below) but likely doesn't render it. This means
schema markup — a real SEO factor this product's own technical-audit phase
scores — silently doesn't make it to the live page for roughly half the
supported CMS platforms.

## 🟡 Medium — Shopify's schema storage likely isn't rendered anywhere

```ts
metafields: payload.seoSchema
  ? [{ key: 'schema_json', value: JSON.stringify(payload.seoSchema), type: 'json', namespace: 'seo' }]
  : [],
```

This stores the schema as a Shopify metafield, which is real data storage
— but metafields don't automatically appear on the storefront. A theme
has to be explicitly customized with Liquid template code to read
`seo.schema_json` and output it as a `<script type="application/ld+json">`
tag. For any store using a default/unmodified theme, this schema is
stored but invisible to search engines and AI crawlers — same practical
effect as the Webflow/Wix/GHL gap above, just via a different mechanism.

## 🟡 Medium — Wix content field likely wrong for HTML content (needs live verification, not certain)

```ts
post: { contentText: payload.content, ... }
```

`payload.content` is full HTML. Wix's Blog API v3 content model is
generally structured "Ricos" rich-content JSON, not raw HTML — a plain
`contentText`-style field is more likely meant for plain text, which would
mean HTML tags render literally as text in the published post rather than
being interpreted as formatting. I don't have live API access to confirm
this definitively, so flagging with appropriate uncertainty rather than
certainty — worth a real test publish to Wix before trusting this path in
production.

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
