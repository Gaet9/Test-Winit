-- Store post-scrape dispute eligibility analysis (one entry per CSV line / case).
alter table public.worker_scrape_runs
  add column if not exists dispute_analysis jsonb not null default '[]'::jsonb;

comment on column public.worker_scrape_runs.dispute_analysis is
  'Post-extraction eligibility analysis for dispute workflows. JSON array aligned to results.';

