-- Link each archive row to the live job so we can keep exactly one row per job (full `results` JSON).
-- Without this, retries / duplicate completes append multiple `worker_scrape_runs` rows for the same run.

alter table public.worker_scrape_runs
  add column if not exists scrape_job_id uuid references public.worker_scrape_jobs(id) on delete cascade;

comment on column public.worker_scrape_runs.scrape_job_id is
  'FK to worker_scrape_jobs. When set, workers replace the prior row for this job instead of inserting another.';

create unique index if not exists worker_scrape_runs_one_per_scrape_job
  on public.worker_scrape_runs (scrape_job_id)
  where scrape_job_id is not null;
