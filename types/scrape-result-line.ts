/** One row in the home Results table (archive and/or live job lines). */
export type ScrapeResultLineRow = {
  key: string
  source: "archive" | "live"
  runId: string
  runName: string
  lineIndex: number
  lineLabel: string
  state: string
  message: string
  progressPct: number
  updatedAt: string
}

/** SSE + REST payload for `worker_scrape_jobs`. */
export type WorkerScrapeJobRow = {
  id: string
  name: string
  total_lines: number
  progress_pct: number
  state: string
  detail_message: string
  lines_state: LineProgressState[]
  completed_at: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export type LineProgressState = {
  lineIndex: number
  state: string
  message: string
  progress_pct: number
  updated_at: string
}
