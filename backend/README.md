# SEO-GEO Backend

API reference, project structure, and troubleshooting. For startup and deployment see the root `README.md`.

---

## What the pipeline does

```
Your website URL
      ↓
Phase 1 — Crawl your site (finds all pages, detects SEO issues)
      ↓
Phase 2 — Build business profile (understands what you sell)
      ↓
Phase 3 — Technical SEO audit (generates fixes for every page)
      ↓
Phase 4 — Find competitors (via Google SERP)
      ↓
Phase 5 — Keyword research (260 keywords scored for your business)
      ↓
Phase 6 — SERP analysis (studies what already ranks for each keyword)
      ↓
Phase 7 — Blog generation (writes 25 full blog posts with Gemini)
      ↓
Phase 8 — CMS publish (pushes to WordPress / Shopify / Webflow / etc.)
      ↓
Phase 9 — Weekly: GEO tracking + GSC monitoring (are AI engines citing you?)
```

---

## Project structure

```
backend/
├── src/
│   ├── app.ts                          # API server entry point
│   ├── worker.ts                       # Worker entry point
│   │
│   ├── workers/
│   │   ├── seo-pipeline.worker.ts      # Orchestrates all pipeline phases
│   │   └── jobs/
│   │       ├── site-crawl.job.ts       # Phase 1
│   │       ├── business-profile.job.ts # Phase 2
│   │       ├── technical-audit.job.ts  # Phase 3
│   │       ├── competitor-discovery.job.ts # Phase 4
│   │       ├── keyword-research.job.ts # Phase 5
│   │       ├── serp-research.job.ts    # Phase 6
│   │       ├── blog-generation.job.ts  # Phase 7
│   │       ├── cms-publish.job.ts      # Phase 8
│   │       ├── geo-analytics.job.ts    # Weekly cron
│   │       └── gsc-monitor.job.ts      # Weekly cron
│   │
│   ├── lib/
│   │   ├── crawler.ts                  # Sitemap, redirects, broken links
│   │   ├── llm.ts                      # All Gemini API calls
│   │   ├── serp.ts                     # SerpAPI wrapper
│   │   ├── dataforseo.ts               # DataForSEO wrapper
│   │   ├── knowledge-loader.ts         # Reads knowledge files from Cloudinary
│   │   ├── pipeline-resume.ts          # Resume failed pipeline from exact step
│   │   └── page-selector.ts            # Classifies pages by tier for LLM context
│   │
│   ├── models/                         # Mongoose models
│   ├── routes/api-v1/                  # Express routes
│   ├── handlers/                       # Route handlers
│   ├── services/                       # Business logic
│   ├── middleware/                     # Auth, validation, errors
│   ├── loaders/                        # DB and Redis connection
│   └── constants/                      # Pipeline config, prompts
│
├── Dockerfile.api
├── Dockerfile.worker
├── docker-compose.yml
└── ecosystem.config.js
```

---

## API reference

All routes prefixed `/api/v1`. Everything except auth requires `Authorization: Bearer <token>`.

### Auth
```
POST   /api/v1/auth/register             # Body: { name, email, password }
POST   /api/v1/auth/login                # Body: { email, password }
```

### Projects
```
POST   /api/v1/projects                  # Body: { domain, keywordPrimaryCountryCode? }
GET    /api/v1/projects
GET    /api/v1/projects/:projectId
GET    /api/v1/projects/:projectId/business
```

### Onboarding
```
POST   /api/v1/projects/:projectId/onboarding/step
```
Body: `{ step: 1-5, data: { ...fields } }`

| Step | Fields |
|---|---|
| 1 — Company | `name, website, targetRegions, languages` |
| 2 — Product | `description, features, pricingTiers, freeTrial, ltv` |
| 3 — Customers | `segments, painPoints, keywords, useCases` |
| 4 — Competition | `competitors, differentiation, strengths, tradeOffs, proof` |
| 5 — Social Proof | `caseStudies, organicDiscussions, socialMedia` |

Each step saves independently. Pipeline should not start until all 5 steps are complete.

### Pipeline
```
POST   /api/v1/projects/:projectId/pipeline/start    # Body: { keywordPrimaryCountryCode? }
GET    /api/v1/projects/:projectId/pipeline/status
POST   /api/v1/projects/:projectId/pipeline/resume   # Body: { fromStep? } — auto-detects if omitted
```

`fromStep` values: `SITE_CRAWL`, `BUSINESS_PROFILE`, `TECHNICAL_AUDIT`, `COMPETITOR_DISCOVERY`, `KEYWORD_RESEARCH`, `SERP_RESEARCH`, `BLOG_GENERATION`, `CMS_PUBLISH`

### Blogs
```
GET    /api/v1/projects/:projectId/blogs                         # query: ?status=draft|ready|published|archived
GET    /api/v1/projects/:projectId/blogs/:blogId
PATCH  /api/v1/projects/:projectId/blogs/:blogId                 # Body: { title?, content?, description?, status? }
POST   /api/v1/projects/:projectId/blogs/:blogId/publish
POST   /api/v1/projects/:projectId/blogs/:blogId/unpublish
DELETE /api/v1/projects/:projectId/blogs/:blogId
```

### Keywords
```
GET    /api/v1/projects/:projectId/keywords          # query: ?status=&weekNumber=&page=&limit=
                                                     # returns { keywords: [...], total, page, limit }
POST   /api/v1/projects/:projectId/keywords          # Body: { keyword }
DELETE /api/v1/projects/:projectId/keywords/:keywordId
```

### Audit
```
GET    /api/v1/projects/:projectId/audit
GET    /api/v1/projects/:projectId/audit/code-changes            # query: ?type=&status=
POST   /api/v1/projects/:projectId/audit/code-changes/:changeId/apply
POST   /api/v1/projects/:projectId/audit/code-changes/:changeId/disable
GET    /api/v1/projects/:projectId/audit/faqs
GET    /api/v1/projects/:projectId/audit/tldrs
```

### CMS
```
GET    /api/v1/projects/:projectId/cms
POST   /api/v1/projects/:projectId/cms/connect       # Body: { cmsType, credentials, blogPostPath? }
PATCH  /api/v1/projects/:projectId/cms               # Body: { autoPublish?, allowedPublishDays?, blogPostPath? }
DELETE /api/v1/projects/:projectId/cms/disconnect
```

`credentials` shape by platform:

| Platform | Fields |
|---|---|
| WordPress | `{ siteUrl, username, applicationPassword }` |
| Webflow | `{ apiToken }` |
| Shopify | `{ storeName, clientId, clientSecret }` |
| Wix | `{ apiKey }` |
| Framer | `{ pluginId, postPath }` |
| Sanity | `{ projectId, dataset, apiToken, blogPostPath }` |
| Squarespace | `{ dashboardUrl, blogPostPath }` |
| GoHighLevel | `{ privateIntegrationToken, blogDashboardUrl }` |

### GSC
```
GET    /api/v1/projects/:projectId/gsc
POST   /api/v1/projects/:projectId/gsc/connect       # Body: { accessToken, refreshToken, expiryDate }
DELETE /api/v1/projects/:projectId/gsc/disconnect
```

### GEO
```
GET    /api/v1/projects/:projectId/geo
```

### Knowledge files
```
GET    /api/v1/projects/:projectId/knowledge
POST   /api/v1/projects/:projectId/knowledge         # multipart/form-data, field: file, max 10MB
DELETE /api/v1/projects/:projectId/knowledge/:fileId
```

Supported formats: PDF, plain text, markdown, CSV, JSON — max 10MB, 25 files per project.

Files start as `status: pending`. For v1, mark ready directly in MongoDB:
```js
db.projectknowledgefiles.updateMany({}, { $set: { status: 'ready' } })
```

---

## Troubleshooting

**Build fails**
```bash
npx tsc --noEmit
```

**Pipeline stuck on a step**
```bash
GET  /api/v1/projects/:projectId/pipeline/status   # see which step errored
POST /api/v1/projects/:projectId/pipeline/resume   # resume from that step
```

**Redis crawl cache expired (> 24 hours)**

Resume auto-detects this and restarts from `SITE_CRAWL`.

**Gemini 429 rate limit errors**

Increase the delay in `src/constants/seo-pipeline.constants.ts`:
```ts
export const LLM_RATE_LIMIT = {
  REQUESTS_PER_MINUTE: 15,
  DELAY_MS: 5000,   // default 4500
}
```

**Keywords returning object instead of array**

The keywords endpoint returns a paginated object — unwrap it in `src/lib/api/index.ts`:
```ts
apiClient.get<{ keywords: Keyword[] }>(`/projects/${projectId}/keywords`).then(r => r.data.keywords)
```

**Worker not processing jobs**

Both processes must be running — `npm run dev` alone is not enough.

---

## Adding a new CMS

1. Create `src/lib/cms/yourcms.ts` — implement `publish(blog, config)` returning `{ url, id }`
2. Add the platform to `CMS_PLATFORMS` in `src/constants/seo-pipeline.constants.ts`
3. Wire it in `src/services/cms.service.ts`

---

## Stack

| Layer | Technology |
|---|---|
| API | Node.js + Express + TypeScript |
| Database | MongoDB Atlas + Mongoose |
| Job queue | BullMQ + Upstash Redis |
| LLM | Google Gemini 1.5 Flash |
| Crawler | Crawlee (Cheerio + Playwright) |
| SERP data | SerpAPI |
| Keyword data | DataForSEO |
| Images | Unsplash → Cloudinary (.avif) |
| Observability | OpenTelemetry |
