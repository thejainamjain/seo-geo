# Frontend Implementation Plan
## SEO-GEO SaaS — Next.js 15

---

## 1. Context

Backend is complete. 9-phase AI pipeline runs end-to-end. This document covers
the frontend from scaffold to production — architecture decisions, file structure,
data contracts, component hierarchy, and build sequence.

Stack locked in: **Next.js 15 App Router · TypeScript · Tailwind · shadcn/ui**

---

## 2. Principles

- **Data first, UI second.** Every screen is designed around what the API returns,
  not what looks good in Figma. No mock data, no placeholder states that never get replaced.
- **One source of truth per concern.** Server state in React Query. Client state in Zustand.
  URL state in searchParams. Never duplicate.
- **Optimistic where it matters, pessimistic where it doesn't.** Blog approval is optimistic.
  Pipeline trigger is not — user should see confirmation, not assumed success.
- **No over-engineering for v1.** No micro-frontends, no monorepo tooling, no i18n.
  Ship a working product. Refactor when the problem actually exists.

---

## 3. Repository structure

```
seo-geo/
├── backend/                  # existing — Express + BullMQ
└── frontend/                 # this document
    ├── app/
    │   ├── (auth)/           # public routes — no layout chrome
    │   │   ├── login/
    │   │   └── register/
    │   ├── (app)/            # protected routes — sidebar + topbar
    │   │   ├── layout.tsx
    │   │   ├── page.tsx                          # redirect → /projects
    │   │   └── projects/
    │   │       ├── page.tsx                      # project list
    │   │       ├── new/page.tsx                  # create project
    │   │       └── [projectId]/
    │   │           ├── layout.tsx                # project shell + nav tabs
    │   │           ├── page.tsx                  # redirect → /overview
    │   │           ├── overview/page.tsx          # pipeline status
    │   │           ├── audit/page.tsx             # technical SEO fixes
    │   │           ├── keywords/page.tsx          # keyword table
    │   │           ├── blogs/
    │   │           │   ├── page.tsx              # blog list
    │   │           │   └── [blogId]/page.tsx     # blog detail + editor
    │   │           ├── geo/page.tsx              # GEO analytics
    │   │           └── settings/page.tsx         # CMS, GSC, knowledge files
    ├── components/
    │   ├── ui/               # shadcn primitives (auto-generated, do not edit)
    │   ├── layout/
    │   │   ├── sidebar.tsx
    │   │   ├── topbar.tsx
    │   │   └── project-nav.tsx
    │   ├── pipeline/
    │   │   ├── pipeline-tracker.tsx
    │   │   ├── pipeline-step.tsx
    │   │   └── resume-button.tsx
    │   ├── audit/
    │   │   ├── code-change-table.tsx
    │   │   └── diff-viewer.tsx
    │   ├── blog/
    │   │   ├── blog-card.tsx
    │   │   ├── blog-editor.tsx
    │   │   └── blog-history.tsx
    │   ├── keyword/
    │   │   └── keyword-table.tsx
    │   └── geo/
    │       └── geo-chart.tsx
    ├── lib/
    │   ├── api/
    │   │   ├── client.ts     # axios instance
    │   │   ├── auth.ts       # auth endpoints
    │   │   ├── projects.ts   # project endpoints
    │   │   ├── pipeline.ts   # pipeline status + resume
    │   │   ├── blogs.ts      # blog endpoints
    │   │   ├── audit.ts      # audit + code changes
    │   │   ├── keywords.ts   # keyword endpoints
    │   │   └── geo.ts        # GEO analytics
    │   ├── hooks/
    │   │   ├── use-pipeline.ts     # polling hook for pipeline status
    │   │   ├── use-project.ts
    │   │   ├── use-blogs.ts
    │   │   └── use-auth.ts
    │   ├── stores/
    │   │   └── auth.store.ts       # Zustand — token + user
    │   └── utils/
    │       ├── format.ts           # dates, numbers, truncation
    │       └── pipeline.ts         # step label/color/icon helpers
    ├── types/
    │   └── api.ts            # mirrors backend response shapes exactly
    ├── middleware.ts          # Next.js edge middleware — auth redirect
    ├── next.config.ts
    └── .env.local
```

---

## 4. Scaffold

```bash
# Run from repo root (seo-geo/)
npx create-next-app@latest frontend \
  --typescript \
  --tailwind \
  --app \
  --no-src-dir \
  --import-alias "@/*"

cd frontend

# Core dependencies
npm install \
  axios \
  @tanstack/react-query \
  @tanstack/react-query-devtools \
  zustand \
  date-fns \
  lucide-react

# shadcn/ui
npx shadcn@latest init
# choose: Default style, Slate base color, CSS variables yes

# shadcn components needed for v1
npx shadcn@latest add \
  button card input label \
  table badge progress \
  tabs separator skeleton \
  dialog sheet dropdown-menu \
  toast alert
```

---

## 5. Environment

**`frontend/.env.local`**
```bash
NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1
```

**`frontend/.env.production`**
```bash
NEXT_PUBLIC_API_URL=https://your-backend.railway.app/api/v1
```

---

## 6. API client

**`lib/api/client.ts`**
```typescript
import axios, { type AxiosError } from 'axios';

export const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30_000,
});

apiClient.interceptors.request.use((config) => {
  const token = typeof window !== 'undefined'
    ? localStorage.getItem('token')
    : null;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

apiClient.interceptors.response.use(
  (res) => res,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);
```

---

## 7. Types

**`types/api.ts`** — mirrors backend exactly. Never infer shapes from component props.

```typescript
// Auth
export interface AuthResponse {
  token: string;
  user: { _id: string; email: string; name: string };
}

// Project + Pipeline
export type PipelineStepStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'ERRORED';
export type PipelineStep =
  | 'SITE_CRAWL' | 'BUSINESS_PROFILE' | 'TECHNICAL_AUDIT'
  | 'COMPETITOR_DISCOVERY' | 'KEYWORD_RESEARCH' | 'SERP_RESEARCH'
  | 'BLOG_GENERATION' | 'CMS_PUBLISH';

export interface PipelineStatus {
  status:      PipelineStepStatus;
  currentStep: PipelineStep | null;
  steps: Array<{
    step:   PipelineStep;
    status: PipelineStepStatus;
    error?: string;
  }>;
  canResume:  boolean;
  resumeFrom: PipelineStep | null;
}

export interface Project {
  _id:            string;
  domain:         string;
  pipeline:       { status: PipelineStepStatus; currentStep: PipelineStep | null };
  isGscConnected: boolean;
  isCmsConnected: boolean;
  createdAt:      string;
}

// Blog
export type BlogStatus = 'draft' | 'ready' | 'published' | 'archived';
export interface Blog {
  _id:         string;
  title:       string;
  slug:        string;
  description: string;
  content?:    string;
  status:      BlogStatus;
  heroImageUrl?: string;
  publishedUrl?: string;
  createdAt:   string;
  updatedAt:   string;
}

// Audit
export type CodeChangeStatus = 'pending' | 'applied' | 'disabled' | 'failed';
export interface CodeChange {
  _id:     string;
  url:     string;
  type:    string;
  status:  CodeChangeStatus;
  oldHtml: string;
  newHtml: string;
}

// Keyword
export type KeywordStatus = 'upcoming' | 'draft' | 'published';
export interface Keyword {
  _id:            string;
  keyword:        string;
  searchVolume:   number;
  difficulty:     number;
  alignmentScore: number;
  status:         KeywordStatus;
}

// GEO
export interface GeoRun {
  _id:                 string;
  objectivePercentage: number;
  successfulPrompts:   number;
  failedPrompts:       number;
  runAt:               string;
}
```

---

## 8. Auth

**`lib/stores/auth.store.ts`**
```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  token:   string | null;
  user:    { _id: string; email: string; name: string } | null;
  setAuth: (token: string, user: AuthState['user']) => void;
  clear:   () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token:   null,
      user:    null,
      setAuth: (token, user) => set({ token, user }),
      clear:   () => set({ token: null, user: null }),
    }),
    { name: 'auth' },
  ),
);
```

**`middleware.ts`** — edge middleware, runs before every request
```typescript
import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/register'];

export function middleware(request: NextRequest) {
  const token = request.cookies.get('token')?.value
    ?? request.headers.get('authorization')?.replace('Bearer ', '');

  const isPublic = PUBLIC_PATHS.some(p => request.nextUrl.pathname.startsWith(p));

  if (!token && !isPublic) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  if (token && isPublic) {
    return NextResponse.redirect(new URL('/projects', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next|favicon.ico|api).*)'],
};
```

---

## 9. Data fetching pattern

React Query for all server state. Never fetch in components directly.

**`lib/hooks/use-pipeline.ts`**
```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import type { PipelineStatus, PipelineStep } from '@/types/api';

// Polls every 5s while pipeline is RUNNING
export function usePipelineStatus(projectId: string) {
  return useQuery({
    queryKey:  ['pipeline', projectId],
    queryFn:   () =>
      apiClient.get<PipelineStatus>(`/projects/${projectId}/pipeline/status`)
        .then(r => r.data),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'RUNNING' ? 5_000 : false;
    },
  });
}

export function usePipelineResume(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fromStep?: PipelineStep) =>
      apiClient.post(`/projects/${projectId}/pipeline/resume`, { fromStep })
        .then(r => r.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pipeline', projectId] });
    },
  });
}
```

---

## 10. Build sequence

Build in this order. Each phase is independently shippable and testable.

### Phase 1 — Auth + shell (2 days)

**Goal:** User can register, log in, and see an empty dashboard.

- `/login` — email + password form → POST `/auth/login` → store token → redirect
- `/register` — same pattern
- `(app)/layout.tsx` — sidebar with nav links, topbar with user menu
- `middleware.ts` — redirect unauthenticated users to `/login`

**Done when:** You can log in and see a sidebar. Nothing breaks on refresh.

---

### Phase 2 — Project list + create (1 day)

**Goal:** User can create a project and trigger the pipeline.

- `/projects` — list of projects with domain, pipeline status badge, created date
- `/projects/new` — single input: domain name → POST `/projects` → redirect to project overview
- Pipeline status badge: color-coded by status (PENDING grey, RUNNING blue, COMPLETED green, ERRORED red)

**Done when:** User enters a domain, hits create, gets redirected to a page that shows the pipeline starting.

---

### Phase 3 — Pipeline tracker (2 days)

**Goal:** User can watch the pipeline run in real time.

`/projects/[id]/overview` — the most important screen in the product.

```
[Step]  Site Crawl          ✓ Completed   2 min ago
[Step]  Business Profile    ✓ Completed   1 min ago
[Step]  Technical Audit     ● Running...
[Step]  Competitor Discovery  ○ Pending
[Step]  Keyword Research      ○ Pending
[Step]  SERP Research         ○ Pending
[Step]  Blog Generation       ○ Pending
[Step]  CMS Publish           ○ Pending
```

- Polls `GET /projects/:id/pipeline/status` every 5s while RUNNING
- Stops polling when COMPLETED or ERRORED
- If ERRORED: shows error message + "Resume from this step" button
- Resume calls `POST /projects/:id/pipeline/resume`

**Done when:** You can watch a real pipeline run from start to finish on screen.

---

### Phase 4 — Blogs (2 days)

**Goal:** User can see, read, and approve generated blogs.

`/projects/[id]/blogs` — grid of blog cards
- title, status badge, word count, created date
- filter by status (draft / ready / published)

`/projects/[id]/blogs/[blogId]` — blog detail
- renders `blog.content` (full HTML) in a sandboxed iframe or prose container
- "Mark as Ready" button → PATCH `/blogs/:id` `{ status: 'ready' }`
- version history panel showing `blog.history` entries

**Done when:** User can read a generated blog and approve it for publishing.

---

### Phase 5 — Audit (1 day)

**Goal:** User can see all technical SEO fixes detected on their site.

`/projects/[id]/audit` — table of CodeChange records
- columns: page URL, fix type, status
- expandable row: before/after diff (oldHtml vs newHtml)
- filter by type (title / description / schema / broken_link / etc.)
- filter by status (pending / applied)

**Done when:** User can see every SEO issue detected and what the fix looks like.

---

### Phase 6 — Keywords (1 day)

**Goal:** User can see all researched keywords and their metrics.

`/projects/[id]/keywords` — sortable table
- columns: keyword, search volume, difficulty, alignment score, status
- sort by alignment score desc by default (highest value keywords first)
- status badge: upcoming / draft / published

**Done when:** User can see what keywords their blogs are targeting and why.

---

### Phase 7 — GEO analytics (1 day)

**Goal:** User can see how often AI engines cite their domain.

`/projects/[id]/geo` — simple line chart over time
- x-axis: run date, y-axis: citation percentage (0–100%)
- latest run summary: "Cited in X% of AI responses (N/M keywords)"
- trend: +N% vs last run

Use recharts — already available in React artifacts, works fine in Next.js.

**Done when:** User can see their GEO score trending over time.

---

### Phase 8 — Settings (1 day)

**Goal:** User can connect CMS and GSC, upload knowledge files.

`/projects/[id]/settings` — tabbed settings page

Tab 1: CMS — select platform, enter credentials, test connection
Tab 2: GSC — "Connect Google Search Console" OAuth button
Tab 3: Knowledge Files — upload PDFs/docs, see processing status, delete

**Done when:** User can connect their CMS and trigger publishing.

---

## 11. Component design rules

**No prop drilling past 2 levels.** If a prop goes 3 levels deep, lift it to React Query or Zustand.

**Server Components for static shells, Client Components for interactivity.**
- Page layouts, navigation → Server Components
- Anything with useState, useEffect, polling → Client Components (`'use client'`)
- Mark Client Components at the lowest possible level — not the whole page

**Loading states on every data-dependent component.** Use shadcn `Skeleton` — never an empty div.

**Error states on every query.** If the API call fails, show the error message from the response, not a generic "Something went wrong".

**Empty states on every list.** Empty projects list, empty blogs list, empty keywords — each needs a message and a CTA, not a blank screen.

---

## 12. Pipeline step metadata

Centralise this in `lib/utils/pipeline.ts` — used by the tracker, badges, and resume button.

```typescript
import type { PipelineStep, PipelineStepStatus } from '@/types/api';

export const STEP_META: Record<PipelineStep, { label: string; description: string }> = {
  SITE_CRAWL:           { label: 'Site Crawl',           description: 'Crawling all pages' },
  BUSINESS_PROFILE:     { label: 'Business Profile',     description: 'Understanding your business' },
  TECHNICAL_AUDIT:      { label: 'Technical Audit',      description: 'Finding SEO issues' },
  COMPETITOR_DISCOVERY: { label: 'Competitor Discovery', description: 'Finding competitors' },
  KEYWORD_RESEARCH:     { label: 'Keyword Research',     description: 'Researching 260 keywords' },
  SERP_RESEARCH:        { label: 'SERP Research',        description: 'Analyzing search results' },
  BLOG_GENERATION:      { label: 'Blog Generation',      description: 'Writing 25 blog posts' },
  CMS_PUBLISH:          { label: 'CMS Publish',          description: 'Publishing to your CMS' },
};

export const STATUS_COLOR: Record<PipelineStepStatus, string> = {
  PENDING:   'text-muted-foreground',
  RUNNING:   'text-blue-500',
  COMPLETED: 'text-green-500',
  ERRORED:   'text-red-500',
};
```

---

## 13. Running everything locally

Three terminals:

```bash
# Terminal 1
cd backend && npm run dev

# Terminal 2
cd backend && npm run dev:worker

# Terminal 3
cd frontend && npm run dev
```

Frontend: `http://localhost:3001`
Backend: `http://localhost:3000`

No proxy needed — `NEXT_PUBLIC_API_URL` points directly to the backend.
CORS is handled by Express middleware on the backend side.

---

## 14. Production deployment

**Backend** (Railway — two services, same repo):
- Service 1: `npm run start` — API
- Service 2: `npm run start:worker` — Worker

**Frontend** (Vercel — zero config for Next.js):
```bash
# In Vercel dashboard
Root Directory: frontend
Build Command:  npm run build
Output:         .next
Environment:    NEXT_PUBLIC_API_URL=https://your-backend.railway.app/api/v1
```

Push to GitHub → Vercel auto-deploys on every merge to main.

---

## 15. What NOT to build in v1

- Email notifications — backend comment says "not in scope for v1"
- Per-project timezone — UTC for v1, documented in backend constants
- OpenAI fallback LLM — abstraction exists in llm.ts, wire when needed
- Vector search / RAG — ProjectLearningChunk model exists, implement after basic flow works
- Blog optimization loop — BlogLearning and BlogOptimization models exist, build after GSC data accumulates
- Team/multi-user per project — OrganizationMember model exists, expose in UI when needed

Build these when users ask for them, not before.
