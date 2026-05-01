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
npm run test:va-scrape:headed
npm run test:va-scrape -- ./path/to/sample.csv
```

On **Windows**, use `npm run test:va-scrape:headed` (not `PLAYWRIGHT_HEADED=1 npm …`, which is Unix-only). Optional: `VA_COURT_INPUT_TIMEOUT_MS=120000` if `#txtcourts1` is slow to appear.

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

Note: the Python worker updates **`worker_scrape_jobs`** for live SSE and writes **`worker_scrape_runs`** with **`scrape_job_id`** set to that job’s id. Each completed job keeps **one** archive row (full `results` array for every CSV line); retries replace the same row instead of stacking duplicates. Apply migration `20260430150000_worker_scrape_runs_link_job.sql` in Supabase before relying on `scrape_job_id`.

**Logs look empty?** The worker logs `[va-worker] …` to stdout and stderr with flush. `PYTHONUNBUFFERED=1` is set in `worker/Dockerfile`. Scrape failures are logged and **re-raised** so uvicorn still prints `ERROR: Exception in ASGI application` with a traceback (same as before we swallowed errors). If you see `RuntimeError: … 0 rows`, the request had no `rows` and no `job_items` data for `job_id`.

## How we filtered noise and repetitive data (without AI)

The VA case detail pages contain many table cells and repeated UI elements. Exporting “every table cell” produces huge, repetitive JSON that is hard to read and expensive to store.

Instead, we generate **clean, compact, deterministic exports** using simple DOM rules:

- **Extract only label/value pairs**: we treat cells with `labelgrid…` classes as labels (e.g. “Case Number:”) and capture the adjacent value cell.
- **Avoid accidental label-as-value**: the value cell is accepted unless it *looks like another label* (typically ends with `:`).
- **Skip empty values**: we drop label entries that have no value, which removes lots of decorative or placeholder fields.
- **Deduplicate repeated fields**: we remove duplicate `{label, value}` pairs (the site repeats some blocks).
- **Merge into a single “Case detail” section**: rather than storing many tables with the same info, we store one compact section per case: `[{ title: "Case detail", fields: [...] }]`.

This keeps the exported data **small, readable, and consistent**, and it ensures downstream logic (like dispute eligibility rules) has high-signal structured inputs.

## Why we did not use AI for dispute eligibility

We intentionally **did not use an AI model** to decide whether a case is eligible for dispute.

- **Deterministic data**: the scraper exports a structured set of label/value fields (e.g. “Final Disposition”, “Fine/Costs Paid”, dates). This is a good fit for a rules-based classifier.
- **Auditability**: eligibility decisions should be explainable and testable. A deterministic algorithm can always point to the exact rule and field that drove the outcome.
- **Reliability & cost**: AI outputs can vary run-to-run, require extra latency, and add per-case cost. A rules engine is fast and consistent.
- **Safety**: eligibility is “legal-ish”. We want conservative, predictable behavior with clear “missing info” fallbacks instead of a model hallucinating certainty.

AI can still be useful _optionally_ **after** the deterministic decision (e.g., summarizing the case, drafting a user-facing explanation, or suggesting what documents to collect), but the actual classification should remain rules-driven for this workflow.
