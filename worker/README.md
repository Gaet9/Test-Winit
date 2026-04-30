# Worker service (FastAPI + Playwright)

This folder is a **separate worker** intended to run Playwright scraping for large CSV jobs (e.g. 10,000 rows).

The Next.js app should remain responsible for:

- CSV upload + validation (PapaParse)
- job creation + dashboard UI
- streaming progress to the browser (SSE) by reading job state from Supabase

The worker is responsible for:

- running browser automation (Playwright)
- bounded concurrency + retries/backoff (to be added)
- writing progress + results to Supabase (recommended)

## Local run (no Docker)

```bash
cd worker
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python -m playwright install chromium
uvicorn main:app --reload --port 8000
```

Health check:

- `GET http://localhost:8000/health`

## Docker build/run

```bash
cd worker
docker build -t va-worker .
docker run -p 8000:8000 --env-file .env.example va-worker
```

## Deploy on Render (recommended)

### Option A — Node webhook + same TS Playwright script (matches local + Vercel SSE)

Use this when the Next app on **Vercel** calls `RENDER_WORKER_URL` with `POST /run` and the UI reads **`worker_scrape_jobs`** from Supabase.

- Repo root on Render, **Dockerfile path**: `Dockerfile.scrape` (see repo root).
- Env on Render:
  - `WORKER_WEBHOOK_SECRET` (same value as on Vercel)
  - `SUPABASE_SERVICE_ROLE_KEY`
  - **Project URL:** `NEXT_PUBLIC_SUPABASE_URL` **or** `SUPABASE_URL` (if only `SUPABASE_URL` was set before, progress stayed at 0% — the TS worker now accepts both)
- **Vercel** env: `RENDER_WORKER_URL` = `https://<your-service>.onrender.com` (no `/run` suffix), same `WORKER_WEBHOOK_SECRET`.
- Health: `GET /health` on the service.

Start locally: `npm run worker:render-webhook` (set `PORT`, `WORKER_WEBHOOK_SECRET`, Supabase vars).

### Option B — Python FastAPI worker (`worker/`)

- Create a **Web Service** with **Docker** runtime
- Root directory: `worker`
- Add env vars:
    - `SUPABASE_URL` (or align with `NEXT_PUBLIC_SUPABASE_URL` if you map them)
    - `SUPABASE_SERVICE_ROLE_KEY`
    - `WORKER_WEBHOOK_SECRET` (required if set — Next sends `Authorization: Bearer …` when forwarding)
    - optional: `WORKER_CONCURRENCY`, `WORKER_HEADLESS`

Note: the Python `/run` path does not yet write to the same **`worker_scrape_jobs`** rows as the TypeScript scraper; use **Option A** for identical progress in the Results tab.
