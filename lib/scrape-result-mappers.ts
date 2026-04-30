import type {
  LineProgressState,
  ScrapeResultLineRow,
  WorkerScrapeJobRow,
} from "@/types/scrape-result-line"

export function jobLinesToResultRows(job: WorkerScrapeJobRow): ScrapeResultLineRow[] {
  const lines = (job.lines_state ?? []) as LineProgressState[]
  return lines.map((line, idx) => {
    const key = `live-${job.id}-${line.lineIndex}-${idx}`
    return {
      key,
      source: "live" as const,
      runId: job.id,
      runName: job.name,
      lineIndex: line.lineIndex,
      lineLabel: `Line ${line.lineIndex} of ${job.total_lines}`,
      state: line.state,
      message: line.message || job.detail_message,
      progressPct: line.progress_pct,
      updatedAt: line.updated_at,
    }
  })
}
