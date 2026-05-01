import type { SupabaseClient } from "@supabase/supabase-js"

import type {
  LineProgressState,
  ScrapeResultLineRow,
  WorkerScrapeJobRow,
} from "@/types/scrape-result-line"

export type ScrapeResultsCursor = {
  processed_at: string
  id: string
}

type RunRow = {
  id: string
  name: string
  processed_at: string
  results: unknown
  scrape_job_id?: string | null
  dispute_analysis?: unknown
}

/** Full run row from DB (for detail UI). */
export type WorkerScrapeRunArchive = {
  id: string
  name: string
  processed_at: string
  results: unknown
  scrape_job_id?: string | null
  dispute_analysis?: unknown
}

export type WorkerScrapeRunLatest = {
  id: string
  name: string
  processed_at: string
  line_count: number | null
  results: unknown
  scrape_job_id?: string | null
}

/** One query: flattened table rows plus full runs for line-detail modals. */
export async function fetchScrapeArchiveBundle(
  supabase: SupabaseClient,
  options?: { runLimit?: number; cursor?: ScrapeResultsCursor | null }
): Promise<{ lines: ScrapeResultLineRow[]; runs: WorkerScrapeRunArchive[]; nextCursor: ScrapeResultsCursor | null }> {
  const runLimit = Math.max(1, Math.min(200, options?.runLimit ?? 20))
  const cursor = options?.cursor ?? null

  let q = supabase
    .from("worker_scrape_runs")
    .select("id,name,processed_at,results,scrape_job_id,dispute_analysis")
    .order("processed_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(runLimit + 1)

  if (cursor) {
    // Keyset pagination:
    // (processed_at < cursor.processed_at) OR (processed_at = cursor.processed_at AND id < cursor.id)
    q = q.or(
      `processed_at.lt.${cursor.processed_at},and(processed_at.eq.${cursor.processed_at},id.lt.${cursor.id})`
    )
  }

  const { data, error } = await q

  if (error) {
    console.error("[scrape-results]", error.message)
    return { lines: [], runs: [], nextCursor: null }
  }

  const raw = (data ?? []) as RunRow[]
  const page = raw.slice(0, runLimit)
  const more = raw.length > runLimit
  const nextCursor = more
    ? { processed_at: page[page.length - 1]!.processed_at, id: page[page.length - 1]!.id }
    : null

  const runs: WorkerScrapeRunArchive[] = page.map((run) => ({
    id: run.id,
    name: run.name,
    processed_at: run.processed_at,
    results: run.results,
    scrape_job_id: run.scrape_job_id ?? null,
    dispute_analysis: run.dispute_analysis,
  }))

  const lines: ScrapeResultLineRow[] = []
  for (const run of runs) {
    const arr = run.results
    if (!Array.isArray(arr)) continue
    arr.forEach((item: { row?: { firstName?: string; lastName?: string; court?: string }; cases?: unknown[] }, idx: number) => {
      const r = item.row ?? {}
      const first = (r.firstName ?? "").toString()
      const last = (r.lastName ?? "").toString()
      const court = (r.court ?? "").toString()
      const cases = Array.isArray(item.cases) ? item.cases.length : 0
      lines.push({
        key: `archive-${run.id}-${idx}`,
        source: "archive",
        runId: run.id,
        runName: run.name,
        lineIndex: idx + 1,
        lineLabel: `${last}, ${first} · ${court}`.trim(),
        state: "scraping_complete",
        message: `${cases} case(s) exported`,
        progressPct: 100,
        updatedAt: run.processed_at,
      })
    })
  }
  return { lines, runs, nextCursor }
}

/** Flatten completed `worker_scrape_runs` into per-CSV-line rows for the Results table. */
export async function fetchArchivedResultLines(
  supabase: SupabaseClient,
  runLimit = 50
): Promise<ScrapeResultLineRow[]> {
  const { lines } = await fetchScrapeArchiveBundle(supabase, { runLimit })
  return lines
}

/** Newest archived run (full `results` JSON) for downloads / exports. */
export async function fetchLatestWorkerScrapeRun(
  supabase: SupabaseClient
): Promise<WorkerScrapeRunLatest | null> {
  const { data, error } = await supabase
    .from("worker_scrape_runs")
    .select("id,name,processed_at,line_count,results,scrape_job_id")
    .order("processed_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error("[scrape-results]", error.message)
    return null
  }
  if (!data) return null
  const row = data as Record<string, unknown>
  return {
    id: row.id as string,
    name: row.name as string,
    processed_at: row.processed_at as string,
    line_count: (row.line_count as number) ?? null,
    results: row.results,
    scrape_job_id: (row.scrape_job_id as string) ?? null,
  }
}

export async function getLatestActiveJobId(
  supabase: SupabaseClient
): Promise<string | null> {
  const job = await getLatestActiveJob(supabase)
  return job?.id ?? null
}

export async function getLatestActiveJob(
  supabase: SupabaseClient
): Promise<WorkerScrapeJobRow | null> {
  const { data, error } = await supabase
    .from("worker_scrape_jobs")
    .select("*")
    .is("completed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error("[scrape-results]", error.message)
    return null
  }
  if (!data) return null
  const row = data as Record<string, unknown>
  return {
    id: row.id as string,
    name: row.name as string,
    total_lines: row.total_lines as number,
    progress_pct: row.progress_pct as number,
    state: row.state as string,
    detail_message: row.detail_message as string,
    lines_state: (Array.isArray(row.lines_state)
      ? row.lines_state
      : []) as LineProgressState[],
    completed_at: (row.completed_at as string) ?? null,
    error_message: (row.error_message as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

export async function fetchScrapeJobById(
  supabase: SupabaseClient,
  jobId: string
): Promise<WorkerScrapeJobRow | null> {
  const { data, error } = await supabase
    .from("worker_scrape_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle()

  if (error) {
    console.error("[scrape-job]", error.message)
    return null
  }
  if (!data) return null
  const row = data as Record<string, unknown>
  return {
    id: row.id as string,
    name: row.name as string,
    total_lines: row.total_lines as number,
    progress_pct: row.progress_pct as number,
    state: row.state as string,
    detail_message: row.detail_message as string,
    lines_state: (Array.isArray(row.lines_state)
      ? row.lines_state
      : []) as LineProgressState[],
    completed_at: (row.completed_at as string) ?? null,
    error_message: (row.error_message as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}
