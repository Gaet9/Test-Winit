# Winit Technical Test — NYC Parking Summons Monitor

## Purpose

Build a professional-grade tool for fleet management companies to **monitor NYC parking summons in real-time**.

The app must:
- **Ingest a CSV** containing ticket/summons IDs.
- **Scrape the New York DMV website asynchronously** for each ID (at scale).
- **Stream progress updates** (queued/running/succeeded/failed + partial results) to a **modern dashboard**.

## Stack (chosen)

- **Next.js (App Router)**: Full-stack (UI + API routes) in one codebase, great DX, easy streaming patterns, deployment-friendly.
- **TypeScript**: Safer refactors and clearer contracts between UI/API/scraper.
- **Tailwind CSS + shadcn/ui**: Fast, consistent UI with accessible components and a “production dashboard” look quickly.
- **Playwright (preferred) or Selenium**: Browser automation for DMV scraping where HTML is dynamic/hostile to simple HTTP scraping.
  - **Why Playwright**: Faster, more modern APIs, strong waiting semantics, reliable headless mode and parallelism.
  - **Why Selenium**: Widely known, lots of examples; acceptable fallback if required by environment.

## Development steps (from zero)

### 1) Create the app

```bash
npx create-next-app@latest my-app
```

Recommended options for this test:
- TypeScript: **Yes**
- ESLint: **Yes**
- Tailwind: **Yes**
- App Router: **Yes**
- `src/` directory: optional (either is fine)

### 2) Install UI tooling

```bash
cd my-app
npm install
```

Then initialize shadcn/ui (will prompt for settings):

```bash
npx shadcn@latest init
```

Add the components you need (example):

```bash
npx shadcn@latest add button card input table badge progress tabs toast
```

### 3) Add scraper dependency

Playwright:

```bash
npm i playwright
npx playwright install
```

### 4) Run locally

```bash
npm run dev
```

App runs at `http://localhost:3000`.

## Suggested architecture (high-level)

- **Dashboard UI**: upload CSV, show job runs, live progress + results table.
- **API**:
  - `POST /api/jobs`: upload CSV → create job, enqueue summons IDs
  - `GET /api/jobs/:id/stream`: stream progress events (SSE) to the dashboard
  - `GET /api/jobs/:id`: fetch final results / summary
- **Scraping worker**:
  - Controlled concurrency (e.g., 3–10 tabs) + retries + timeouts
  - Emits events per ticket ID (started, found, not found, error)

## What “done” looks like

- CSV upload works and validates IDs.
- Scraper runs asynchronously and doesn’t block the UI.
- Dashboard updates continuously while the scrape is running.
- Results are exportable (CSV/JSON) and errors are visible.
