import type { SupabaseClient } from "@supabase/supabase-js"

import type { LineProgressState } from "@/types/scrape-result-line"

/** Job-level progress: arithmetic mean of each line’s `progress_pct` (0–100). */
export function averageLineProgressPct(lines: LineProgressState[]): number {
  if (!lines.length) return 0
  let sum = 0
  for (const l of lines) {
    const v = Number(l.progress_pct)
    sum += Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : 0
  }
  return Math.round(sum / lines.length)
}

export function buildInitialLineStates(totalLines: number): LineProgressState[] {
  const now = new Date().toISOString()
  return Array.from({ length: totalLines }, (_, i) => ({
    lineIndex: i + 1,
    state: "queued",
    message: "",
    progress_pct: 0,
    updated_at: now,
  }))
}

export async function insertScrapeJob(
  supabase: SupabaseClient,
  name: string,
  totalLines: number
): Promise<string> {
  const lines_state = buildInitialLineStates(totalLines)
  const { data, error } = await supabase
    .from("worker_scrape_jobs")
    .insert({
      name,
      total_lines: totalLines,
      progress_pct: 0,
      state: "initiating",
      detail_message: "Initializing…",
      lines_state,
    })
    .select("id")
    .single()

  if (error) throw error
  return data.id as string
}

export async function updateScrapeJob(
  supabase: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>
) {
  const { error } = await supabase
    .from("worker_scrape_jobs")
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)

  if (error) throw error
}

export async function completeScrapeJob(supabase: SupabaseClient, jobId: string) {
  await updateScrapeJob(supabase, jobId, {
    state: "scraping_complete",
    detail_message: "Scraping complete",
    progress_pct: 100,
    completed_at: new Date().toISOString(),
  })
}

export async function failScrapeJob(
  supabase: SupabaseClient,
  jobId: string,
  message: string
) {
  await updateScrapeJob(supabase, jobId, {
    state: "failed",
    detail_message: "Job failed",
    error_message: message.slice(0, 4000),
    completed_at: new Date().toISOString(),
  })
}
