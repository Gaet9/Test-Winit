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

## Headless / headed scrape tests (same flow as production TS worker)

From repo root:

```bash
npm run test:va-scrape
PLAYWRIGHT_HEADED=1 npm run test:va-scrape
npm run test:va-scrape -- ./path/to/sample.csv
```

Playwright Test (Chromium): `npm run test:e2e` (quick live URL smoke). For `#txtcourts1` + full `runVaGdcourtsFlow`, set `VA_E2E_LANDING=1` and `VA_E2E=1` respectively. Headed UI: `npm run test:e2e:headed`.

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

Note: the Python worker still does **not** update **`worker_scrape_jobs`** (live SSE / progress bar). It **does** export case tables and inserts a row into **`worker_scrape_runs`** after each job (same archive shape as the TS worker) when Supabase env is set — refresh **Results** in the Next app to see archived lines.

**Logs look empty?** The worker logs `[va-worker] …` to stdout and stderr with flush. `PYTHONUNBUFFERED=1` is set in `worker/Dockerfile`. Scrape failures are logged and **re-raised** so uvicorn still prints `ERROR: Exception in ASGI application` with a traceback (same as before we swallowed errors). If you see `RuntimeError: … 0 rows`, the request had no `rows` and no `job_items` data for `job_id`.
