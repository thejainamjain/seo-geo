# SEO-GEO Backend

AI-powered SEO and GEO (Generative Engine Optimization) pipeline. Give it a website domain — it crawls the site, researches keywords, writes blog posts, publishes them to your CMS, and tracks how often AI engines like Gemini cite your domain.

---

## What it does

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

## Prerequisites

You need these accounts before starting. All have free tiers.

| Service | What for | Free tier |
|---|---|---|
| [MongoDB Atlas](https://cloud.mongodb.com) | Database | 512MB — enough for dev |
| [Upstash](https://upstash.com) | Redis (job queue) | 10K commands/day |
| [Google AI Studio](https://aistudio.google.com) | Gemini (LLM) | 15 requests/min |
| [Cloudinary](https://cloudinary.com) | Image storage | 25GB |
| [SerpAPI](https://serpapi.com) | Google SERP data | 100 searches/month |
| [DataForSEO](https://dataforseo.com) | Keyword volume data | Sandbox is free |
| [Unsplash](https://unsplash.com/developers) | Hero images | 50 requests/hour |

For production you also need:
| [Google Cloud Console](https://console.cloud.google.com) | GSC OAuth | Free |

---

## Setup

### 1. Install dependencies

```bash
cd backend
npm install
npm install pdf-parse
npm install --save-dev @types/pdf-parse
```

### 2. Set up environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in the values below. Start with the **required** ones — the rest can wait until you need that feature.

**Required to start the server:**
```bash
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster.mongodb.net/seo-geo
UPSTASH_REDIS_URL=rediss://default:TOKEN@HOST.upstash.io:6379
JWT_SECRET=any-random-32-character-string-here
ENCRYPTION_KEY=    # Run: openssl rand -hex 32
```

**Required to run the pipeline:**
```bash
GEMINI_API_KEY=    # from aistudio.google.com → Get API key
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

**Required for keyword research (use sandbox/mock in dev):**
```bash
SERPAPI_KEY=
DATAFORSEO_LOGIN=
DATAFORSEO_PASSWORD=
DATAFORSEO_SANDBOX=true    # keep true in dev — free, unlimited
```

**Required for hero images:**
```bash
UNSPLASH_ACCESS_KEY=
```

**Required for GSC monitoring (optional for v1):**
```bash
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/api/v1/seo/google/callback
```

**Dev shortcuts — keep these as-is while building:**
```bash
USE_MOCK_SERP=true          # skips SerpAPI calls
USE_MOCK_DATAFORSEO=true    # skips DataForSEO calls
CHECK_BROKEN_LINKS=false    # speeds up crawling
MAX_CRAWL_PAGES=50          # pages per crawl (increase in prod)
```

### 3. MongoDB Atlas setup

1. Create a free cluster at [cloud.mongodb.com](https://cloud.mongodb.com)
2. Create a database user (Database Access → Add New User)
3. Whitelist your IP (Network Access → Add IP Address → `0.0.0.0/0` for dev)
4. Get connection string (Connect → Drivers → copy the URI)
5. Replace `<password>` in the URI with your database user's password
6. Paste into `MONGODB_URI` in `.env`

No collections to create manually — Mongoose creates them on first use.

**One index to create manually** (for vector search — needed for knowledge file RAG):

In Atlas UI → your cluster → Browse Collections → Create Search Index:
```json
{
  "mappings": {
    "fields": {
      "embedding": {
        "type": "knnVector",
        "dimensions": 768,
        "similarity": "cosine"
      }
    }
  }
}
```
Index name: `vector_index`, Collection: `projectlearningchunks`

> Skip this for v1 — blog generation works without it. Add when you implement RAG.

### 4. Upstash Redis setup

1. Create a free database at [upstash.com](https://upstash.com)
2. Choose Redis → Create Database → pick region closest to your server
3. Copy the **ioredis** connection string (starts with `rediss://`)
4. Paste into `UPSTASH_REDIS_URL` in `.env`

### 5. Cloudinary setup

1. Sign up at [cloudinary.com](https://cloudinary.com)
2. Dashboard → copy Cloud Name, API Key, API Secret
3. Paste into `.env`

### 6. Run locally

The app runs as **two separate processes** — API server and background worker. Both must be running for the pipeline to work.

```bash
# Terminal 1 — API server (handles HTTP requests)
npm run dev

# Terminal 2 — Worker (processes pipeline jobs)
npm run dev:worker
```

Or run both together:
```bash
npm install --save-dev concurrently
```

Add to `package.json` scripts:
```json
"dev:all": "concurrently \"npm run dev\" \"npm run dev:worker\""
```

Then:
```bash
npm run dev:all
```

Server starts at `http://localhost:3000`

Health check: `GET http://localhost:3000/health` → `{ "status": "ok" }`

---

## Project structure

```
backend/
├── src/
│   ├── app.ts                    # API server entry point
│   ├── worker.ts                 # Background worker entry point
│   │
│   ├── workers/
│   │   ├── seo-pipeline.worker.ts        # Orchestrates all pipeline steps
│   │   └── jobs/
│   │       ├── site-crawl.job.ts         # Phase 1 — crawl site
│   │       ├── business-profile.job.ts   # Phase 2 — understand business
│   │       ├── technical-audit.job.ts    # Phase 3 — SEO fixes
│   │       ├── competitor-discovery.job.ts # Phase 4 — find competitors
│   │       ├── keyword-research.job.ts   # Phase 5 — find keywords
│   │       ├── serp-research.job.ts      # Phase 6 — analyze SERP
│   │       ├── blog-generation.job.ts    # Phase 7 — write blogs
│   │       ├── cms-publish.job.ts        # Phase 8 — publish to CMS
│   │       ├── geo-analytics.job.ts      # Weekly — GEO tracking
│   │       └── gsc-monitor.job.ts        # Weekly — GSC monitoring
│   │
│   ├── lib/
│   │   ├── crawler.ts            # Shared crawler library (sitemap, redirects, broken links)
│   │   ├── llm.ts                # All Gemini API calls
│   │   ├── serp.ts               # SerpAPI wrapper
│   │   ├── dataforseo.ts         # DataForSEO wrapper
│   │   ├── knowledge-loader.ts   # Reads knowledge files from Cloudinary
│   │   ├── pipeline-resume.ts    # Resume failed pipeline from exact failure point
│   │   └── page-selector.ts      # Classifies pages by tier for LLM context
│   │
│   ├── models/                   # Mongoose models
│   ├── routes/api-v1/            # Express routes
│   ├── handlers/                 # Route handlers
│   ├── services/                 # Business logic
│   ├── middleware/               # Auth, validation, errors
│   ├── loaders/                  # DB and Redis connection
│   └── constants/                # Pipeline config, prompts
```

---

## API overview

All routes are prefixed with `/api/v1`. Auth routes are public, everything else requires `Authorization: Bearer <token>`.

**Auth**
```
POST /api/v1/auth/register
POST /api/v1/auth/login
```

**Projects**
```
POST   /api/v1/projects                           # Create project (provide domain)
GET    /api/v1/projects                           # List all projects
GET    /api/v1/projects/:id                       # Get project details
GET    /api/v1/projects/:id/pipeline/status       # Check pipeline progress
POST   /api/v1/projects/:id/pipeline/resume       # Resume failed pipeline
```

**Pipeline resume** — if a step fails after max retries, resume it without restarting from scratch:
```bash
# Auto-detect which step failed and resume from there
POST /api/v1/projects/:id/pipeline/resume

# Force resume from a specific step
POST /api/v1/projects/:id/pipeline/resume
{ "fromStep": "KEYWORD_RESEARCH" }
```

Available steps: `SITE_CRAWL`, `BUSINESS_PROFILE`, `TECHNICAL_AUDIT`, `COMPETITOR_DISCOVERY`, `KEYWORD_RESEARCH`, `SERP_RESEARCH`, `BLOG_GENERATION`, `CMS_PUBLISH`

**Content**
```
GET /api/v1/projects/:id/blogs
GET /api/v1/projects/:id/keywords
GET /api/v1/projects/:id/audit
GET /api/v1/projects/:id/geo
GET /api/v1/projects/:id/gsc
```

---

## Production deployment

### What changes for production

**1. Environment variables**
```bash
NODE_ENV=production
USE_MOCK_SERP=false
USE_MOCK_DATAFORSEO=false
DATAFORSEO_SANDBOX=false
CHECK_BROKEN_LINKS=true
MAX_CRAWL_PAGES=100
GOOGLE_REDIRECT_URI=https://yourdomain.com/api/v1/seo/google/callback
```

**2. Build**
```bash
npm run build         # compiles TypeScript → dist/
```

**3. Start commands**
```bash
# API server
npm run start         # node dist/app.js

# Worker (separate process/container)
npm run start:worker  # node dist/worker.js
```

### Deploying to Railway (simplest option)

1. Push repo to GitHub
2. New project → Deploy from GitHub repo
3. Add environment variables in Railway dashboard
4. Railway auto-detects `npm run start` for the API

For the worker — add a second Railway service pointing to the same repo:
- Start command: `npm run start:worker`
- Same environment variables

### Deploying with Docker

```dockerfile
# Dockerfile.api
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
CMD ["node", "dist/app.js"]

# Dockerfile.worker
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
CMD ["node", "dist/worker.js"]
```

```yaml
# docker-compose.yml
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile.api
    env_file: .env
    ports:
      - "3000:3000"

  worker:
    build:
      context: .
      dockerfile: Dockerfile.worker
    env_file: .env
    # No ports — worker doesn't serve HTTP
```

```bash
npm run build
docker compose up
```

---

## Knowledge files

Users can upload brand documents (PDFs, markdown, text) to give the AI context about their business. These are used during blog generation to write content that matches the brand voice.

**Supported formats:** PDF, plain text, markdown, CSV, JSON (max 10MB, 25 files per project)

**Upload:**
```
POST /api/v1/projects/:id/knowledge
Content-Type: multipart/form-data
file: <your file>
```

Files are stored in Cloudinary and their text is extracted automatically when blogs are generated. PDFs are parsed with `pdf-parse` — no extra setup needed.

Knowledge files with `status: pending` are not used until a background classifier marks them `ready`. For v1, set them to `ready` directly in MongoDB:
```js
db.projectknowledgefiles.updateMany({}, { $set: { status: 'ready' } })
```

---

## Troubleshooting

**Pipeline stuck on a step**
```bash
GET /api/v1/projects/:id/pipeline/status
# Shows which step is ERRORED and what the error was

POST /api/v1/projects/:id/pipeline/resume
# Resumes from the failed step — does not re-crawl if cache is still valid
```

**Redis crawl cache expired (>24 hours)**

If you resume more than 24 hours after a failure, the crawl cache will be gone. The resume endpoint detects this automatically and restarts from `SITE_CRAWL`.

**Gemini rate limit errors**

You're hitting 15 requests/minute. The pipeline has built-in delays (`LLM_RATE_LIMIT.DELAY_MS = 4500ms`) — if you're still hitting limits, increase this in `src/constants/seo-pipeline.constants.ts`:
```ts
export const LLM_RATE_LIMIT = {
  REQUESTS_PER_MINUTE: 15,
  DELAY_MS: 5000,   // increase if hitting 429s
}
```

**Worker not processing jobs**

Make sure both processes are running — `npm run dev` alone is not enough. The worker (`npm run dev:worker`) is what actually processes pipeline jobs.

**`pdf-parse` import error**

```bash
npm install pdf-parse @types/pdf-parse
```

**TypeScript errors after pulling new changes**

```bash
npx tsc --noEmit 2>&1
```

---

## Adding a new CMS

Supported: WordPress, Shopify, Webflow, Wix, Squarespace, Framer, Sanity, GoHighLevel

To add a new one:
1. Create `src/lib/cms/yourcms.ts` — implement `publish(blog, config)` returning `{ url, id }`
2. Add the platform name to `CMS_PLATFORMS` in `src/constants/seo-pipeline.constants.ts`
3. Import and wire it in `src/services/cms.service.ts`

---

## Stack

| Layer | Technology | Why |
|---|---|---|
| API | Node.js + Express + TypeScript | Standalone backend |
| Database | MongoDB Atlas + Mongoose | Flexible schema for LLM outputs |
| Job queue | BullMQ + Upstash Redis | Retry logic, cron, parallel jobs |
| LLM | Google Gemini 1.5 Flash | Free tier, fast, good JSON output |
| Crawler | Crawlee (Cheerio + Playwright) | Handles static + JS-rendered sites |
| SERP data | SerpAPI | 100 free searches/month |
| Keyword data | DataForSEO | Sandbox is free, prod is cheap |
| Images | Unsplash → Cloudinary (.avif) | Free search + CDN + conversion |
| Observability | OpenTelemetry + Jaeger | Traces every LLM call and crawl |
