## Winit technical test — agent context

### Product context

You are building a **fleet management** tool that helps companies **monitor NYC parking summons** in near real-time.

The system must:
- **Process a CSV** containing summons/ticket IDs.
- **Scrape the New York DMV website** for each ID.
- Run scraping **asynchronously** (non-blocking, controlled concurrency).
- **Stream progress updates** to a dashboard while work is ongoing.

### Constraints & expectations

- **Professional-grade behavior**: input validation, clear error states, retries/timeouts, predictable performance, and a UI that looks like a real ops dashboard.
- **Streaming progress**: users should see live status per summons ID (queued/running/succeeded/failed) and overall job progress.
- **Scraping reliability**: DMV pages may be dynamic; prefer browser automation over raw HTTP.

### Chosen stack (and why)

- **Next.js (App Router) + TypeScript**: one repo for UI and backend endpoints; strong conventions; good ergonomics for streaming patterns.
- **Tailwind CSS + shadcn/ui**: rapid build of a clean, accessible dashboard with consistent components.
- **Playwright (preferred) / Selenium (acceptable)**: browser automation for dynamic sites; Playwright is typically faster and more reliable with modern waiting semantics and parallelism.

### Engineering goals for the agent

When implementing features, optimize for:
- **Correctness**: deterministic parsing, stable selectors, robust waiting, typed contracts.
- **Observability**: structured progress events, useful error messages, and job summaries.
- **Scalability**: bounded concurrency, avoiding one-browser-per-ticket patterns; reusing contexts where possible.
- **User experience**: immediate feedback after CSV upload; progressive rendering of results.

### Suggested milestone breakdown

- CSV upload + validation → job created
- Job execution model (in-memory for test; can be extended to a queue/db)
- Scraper module with concurrency control
- Progress streaming to UI (SSE)
- Dashboard: job list, job detail, live table of ticket statuses + export
