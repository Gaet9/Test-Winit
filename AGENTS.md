<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:winit-tech-test-context -->

# Winit technical test context

Build a fleet-management tool to **monitor NYC parking summons in real-time**:

- ingest a CSV of summons/ticket IDs
- scrape the New York DMV website asynchronously (bounded concurrency)
- stream progress updates to a modern dashboard

Preferred stack:

- Next.js (App Router) + TypeScript
- Tailwind + shadcn/ui
- Playwright (preferred) or Selenium for scraping
  <!-- END:winit-tech-test-context -->
