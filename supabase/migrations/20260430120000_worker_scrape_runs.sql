-- Applied via Supabase MCP / SQL editor. Kept in repo for history.
create table if not exists public.worker_scrape_runs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  run_date date not null,
  processed_at timestamptz not null default now(),
  line_count integer not null check (line_count >= 0),
  results jsonb not null default '[]'::jsonb
);

comment on table public.worker_scrape_runs is 'Playwright worker exports: one row per job run.';
comment on column public.worker_scrape_runs.name is 'Human-readable job / run name.';
comment on column public.worker_scrape_runs.run_date is 'Calendar date associated with the run.';
comment on column public.worker_scrape_runs.processed_at is 'When processing finished and the row was written.';
comment on column public.worker_scrape_runs.line_count is 'Number of CSV lines scraped in this run.';
comment on column public.worker_scrape_runs.results is 'Array of JSON objects, one per CSV line (full extract).';

alter table public.worker_scrape_runs enable row level security;

-- Service role bypasses RLS for inserts from the worker; explicit policy optional.
create policy "Allow service role full access"
  on public.worker_scrape_runs
  for all
  to service_role
  using (true)
  with check (true);
