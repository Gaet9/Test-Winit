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

- Create a **Web Service** with **Docker** runtime
- Root directory: `worker`
- Add env vars:
    - `SUPABASE_URL`
    - `SUPABASE_SERVICE_ROLE_KEY`
    - optional: `WORKER_CONCURRENCY`, `WORKER_HEADLESS`
