# SEO-GEO

AI-powered SEO and GEO SaaS. Give it a domain — it crawls, researches keywords, writes blogs, publishes to your CMS, and tracks AI engine citations.

---

## Quick start

You need two terminals.

### 1. Backend

```bash
cd backend
cp .env.example .env   # fill in values — minimum listed below
npm install
npm run dev:all        # starts API (port 3000) + worker together
```

### 2. Frontend

```bash
cd frontend
cp .env.local.example .env.local
npm install
npm run dev            # starts on port 3001
```

Open [http://localhost:3001](http://localhost:3001)

---

## Minimum environment variables

**`backend/.env`**
```bash
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster.mongodb.net/seo-geo
UPSTASH_REDIS_URL=rediss://default:TOKEN@HOST.upstash.io:6379
JWT_SECRET=any-random-32-character-string
ENCRYPTION_KEY=     # openssl rand -hex 32
GEMINI_API_KEY=
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
UNSPLASH_ACCESS_KEY=
SERPAPI_KEY=
DATAFORSEO_LOGIN=
DATAFORSEO_PASSWORD=
DATAFORSEO_SANDBOX=true
USE_MOCK_SERP=true
USE_MOCK_DATAFORSEO=true
CHECK_BROKEN_LINKS=false
MAX_CRAWL_PAGES=50
```

**`frontend/.env.local`**
```bash
NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1
```

---

## Ports

| Service | Port |
|---|---|
| Backend API | 3000 |
| Frontend | 3001 |

---

## Production deployment

### Docker (recommended)

```bash
# Build backend
cd backend
npm run build
docker compose up -d

# Deploy frontend to Vercel (easiest)
cd frontend
vercel deploy
```

Set `NEXT_PUBLIC_API_URL` in Vercel to your backend's public URL.

### Backend on Railway

1. Push to GitHub → Railway → New project → Deploy from GitHub
2. Add all `backend/.env` variables in Railway dashboard
3. Add a second Railway service for the worker — start command: `npm run start:worker`

### Backend on VPS with PM2

```bash
cd backend
npm run build
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup    # run the printed sudo command to survive reboots
```

### Production environment changes

```bash
# backend/.env
NODE_ENV=production
USE_MOCK_SERP=false
USE_MOCK_DATAFORSEO=false
DATAFORSEO_SANDBOX=false
CHECK_BROKEN_LINKS=true
MAX_CRAWL_PAGES=100
GOOGLE_REDIRECT_URI=https://yourdomain.com/api/v1/projects/gsc/callback

# frontend/.env.local
NEXT_PUBLIC_API_URL=https://yourdomain.com/api/v1
```

---

## Docs

- `backend/README.md` — API reference, project structure, troubleshooting
- `frontend/README.md` — frontend patterns, hooks, adding new pages
