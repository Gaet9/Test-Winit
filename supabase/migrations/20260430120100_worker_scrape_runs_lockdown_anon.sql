-- Removes public read (payloads may contain PII). Dashboard uses service role on the server only.
drop policy if exists "Allow anon read scrape runs" on public.worker_scrape_runs;
