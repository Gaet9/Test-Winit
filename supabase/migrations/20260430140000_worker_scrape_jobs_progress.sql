-- Live job progress for SSE (see lib/scrape-job-worker.ts).
create table if not exists public.worker_scrape_jobs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  total_lines integer not null default 0 check (total_lines >= 0),
  progress_pct integer not null default 0 check (progress_pct between 0 and 100),
  state text not null default 'initiating',
  detail_message text not null default '',
  lines_state jsonb not null default '[]'::jsonb,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists worker_scrape_jobs_active_idx
  on public.worker_scrape_jobs (created_at desc)
  where completed_at is null;

alter table public.worker_scrape_jobs enable row level security;

create policy "service role scrape jobs"
  on public.worker_scrape_jobs
  for all
  to service_role
  using (true)
  with check (true);
