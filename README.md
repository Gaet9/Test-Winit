# Winit Technical Test

## Purpose

Build a scraping tool to recover data from a url using csv input.
Exported data is saved and analyzed to give an advice wether the decision is disputable or not.

The app must:

- **Ingest a CSV** containing ticket/summons IDs. It is parsed using papa parsed library.
- **Scrape the General District Court website asynchronously** for each csv row (at scale).
- **Stream progress updates** (queued/running/succeeded/failed + partial results) to a **modern dashboard**.

## Stack (chosen)

- **Next.js (App Router)**: Full-stack UI and simple API.
- **Render**: Host the FastAPI worker for background hardwork
- **Supabase**: Database to save the export of the FastAPI worker. And serves the front end.
- **Vercel** Hosting the front end app.
- **TypeScript**: Safer refactors and clearer contracts between UI/API/scraper.
- **Tailwind CSS + shadcn/ui**: Fast, consistent UI with accessible components and a “production dashboard” look quickly.
- **Playwright**: Browser automation for scraping where HTML is dynamic/hostile to simple HTTP scraping.
    - **Why Playwright**: Faster, more modern APIs, strong waiting semantics, reliable headless mode and parallelism.

## Suggested architecture (high-level)

- **Dashboard UI**: upload CSV, show job runs, live progress + results table.
- **API**:
    - `POST /api/jobs`: upload CSV → create job, enqueue summons IDs
    - `GET /api/jobs/:id/stream`: stream progress events (SSE) to the dashboard
    - `GET /api/jobs/:id`: fetch final results / summary
- **Scraping worker**:
    - Controlled concurrency (e.g., 3–10 tabs) + retries + timeouts
    - Emits events per ticket ID (started, found, not found, error)

## Progress updates: SSE

The dashboard shows **near real-time** job progress using the browser’s **`EventSource`** API against a Next.js route.

**Endpoint:** `GET /api/scrape-jobs/:id/sse` (see `app/api/scrape-jobs/[id]/sse/route.ts`).

**Flow:**

1. The client opens a single long-lived HTTP response with `Content-Type: text/event-stream`.
2. The route uses the **server-side Supabase admin client** and loads the job row.
3. It writes one SSE frame: `data: <json>\n\n` where `<json>` is the **full `worker_scrape_jobs` row**, including `lines_state` (so the UI can replace state wholesale).
4. If the job is not finished (`state` not `scraping_complete` or `failed`), the server **waits ~800ms** and repeats from step 2.
5. When the job reaches a terminal state, it sends the final snapshot and **closes** the stream.

**Why this shape**

- **Simple integration:** no Supabase Realtime channels, triggers, or extra infra—only periodic reads of the job row the worker already updates.
- **Stable contract:** every event has the same JSON shape as a normal fetch, so the React code can treat “live” and “refetch” the same way.
- **Tradeoff:** updates are at most ~800ms late (plus network latency), not millisecond-exact database replication events. A future upgrade would replace the sleep loop with **Supabase Realtime** `postgres_changes` on `worker_scrape_jobs` (or a worker-published message bus) while keeping the same SSE URL and payload for the UI.

**Hosting note:** the SSE handler must stay open for the whole scrape. Check your host’s **maximum serverless duration**; very long jobs may need reconnect logic or a long-lived process next to the worker.

## How we filtered noise and repetitive data (without AI)

The VA case detail pages contain many table cells and repeated UI elements. Exporting “every table cell” produces huge, repetitive JSON that is hard to read and expensive to store.

Instead, we generate **clean, compact, deterministic exports** using simple DOM rules:

- **Extract only label/value pairs**: we treat cells with `labelgrid…` classes as labels (e.g. “Case Number:”) and capture the adjacent value cell.
- **Avoid accidental label-as-value**: the value cell is accepted unless it _looks like another label_ (typically ends with `:`).
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

AI can still be implemented for further analysis if needed.
