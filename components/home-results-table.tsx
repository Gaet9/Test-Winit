"use client"

import * as React from "react"
import Papa from "papaparse"

import type {
  ScrapeResultLineRow,
  WorkerScrapeJobRow,
} from "@/types/scrape-result-line"
import type { WorkerScrapeRunLatest } from "@/lib/scrape-results-query"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { jobLinesToResultRows } from "@/lib/scrape-result-mappers"

function triggerDownload(filename: string, mime: string, body: string) {
  const blob = new Blob([body], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function badgeVariant(state: string): "default" | "secondary" | "destructive" | "outline" {
  const s = state.toLowerCase()
  if (s === "scraping_complete" || s === "succeeded") return "default"
  if (s === "failed") return "destructive"
  if (s === "queued" || s === "initiating") return "secondary"
  return "outline"
}

export function HomeResultsTable({ focusJobId }: { focusJobId?: string | null } = {}) {
  const [archive, setArchive] = React.useState<ScrapeResultLineRow[]>([])
  const [latestRun, setLatestRun] = React.useState<WorkerScrapeRunLatest | null>(null)
  const [configured, setConfigured] = React.useState(true)
  const [liveJob, setLiveJob] = React.useState<WorkerScrapeJobRow | null>(null)
  const [jobIdOverride, setJobIdOverride] = React.useState("")
  const [sseStatus, setSseStatus] = React.useState<"idle" | "open" | "closed">("idle")

  React.useEffect(() => {
    const id = focusJobId?.trim()
    if (id) setJobIdOverride(id)
  }, [focusJobId])

  const load = React.useCallback(async () => {
    const res = await fetch("/api/scrape-results", { cache: "no-store" })
    const body = (await res.json()) as {
      archive: ScrapeResultLineRow[]
      activeJob: WorkerScrapeJobRow | null
      latestRun?: WorkerScrapeRunLatest | null
      configured?: boolean
    }
    setConfigured(body.configured !== false)
    setArchive(body.archive ?? [])
    setLiveJob(body.activeJob ?? null)
    setLatestRun(body.latestRun ?? null)
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const watchJobId = jobIdOverride.trim() || liveJob?.id || null

  React.useEffect(() => {
    if (!watchJobId || !configured) {
      setSseStatus("idle")
      return
    }

    const url = `/api/scrape-jobs/${watchJobId}/sse`
    const es = new EventSource(url)
    setSseStatus("open")

    es.onmessage = (ev) => {
      try {
        const raw = JSON.parse(ev.data as string) as Record<string, unknown>
        if (raw.error === "not_found" || raw.error === "not_configured") {
          es.close()
          setSseStatus("closed")
          return
        }
        if (typeof raw.id === "string" && Array.isArray(raw.lines_state)) {
          setLiveJob(raw as unknown as WorkerScrapeJobRow)
        }
        if (raw.state === "scraping_complete" || raw.state === "failed") {
          es.close()
          setSseStatus("closed")
          void load()
        }
      } catch {
        /* ignore malformed chunks */
      }
    }

    es.onerror = () => {
      es.close()
      setSseStatus("closed")
    }

    return () => {
      es.close()
      setSseStatus("closed")
    }
  }, [watchJobId, configured, load])

  const liveRows = React.useMemo(
    () => (liveJob ? jobLinesToResultRows(liveJob) : []),
    [liveJob]
  )
  const displayRows = React.useMemo(() => [...liveRows, ...archive], [liveRows, archive])

  const exportCsv = React.useCallback(() => {
    if (!displayRows.length) return
    const csv = Papa.unparse(
      displayRows.map((r) => ({
        source: r.source,
        runName: r.runName,
        lineIndex: r.lineIndex,
        lineLabel: r.lineLabel,
        state: r.state,
        progressPct: r.progressPct,
        message: r.message,
        updatedAt: r.updatedAt,
      }))
    )
    triggerDownload(`scrape-results-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`, "text/csv;charset=utf-8", csv)
  }, [displayRows])

  const exportJson = React.useCallback(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      tableRows: displayRows,
      latestWorkerRun: latestRun,
    }
    triggerDownload(
      `scrape-export-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`,
      "application/json;charset=utf-8",
      JSON.stringify(payload, null, 2)
    )
  }, [displayRows, latestRun])

  return (
    <div className="space-y-3">
      {!configured ? (
        <p className="text-sm text-amber-600 dark:text-amber-500">
          Configure Supabase server keys to load archived results and live jobs.
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1">
          <Label htmlFor="job-sse-id">Watch job (optional)</Label>
          <Input
            id="job-sse-id"
            placeholder="Paste job UUID from worker JSON log…"
            value={jobIdOverride}
            onChange={(e) => setJobIdOverride(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            SSE: {sseStatus}. Empty field = latest incomplete job in Supabase; after Start scraping the new job id is
            filled automatically. If progress stays 0%, check Render logs and that the worker has{" "}
            <span className="font-mono">SUPABASE_URL</span> or{" "}
            <span className="font-mono">NEXT_PUBLIC_SUPABASE_URL</span> plus{" "}
            <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span>.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void load()}>
            Refresh results
          </Button>
          <Button type="button" variant="outline" disabled={!displayRows.length} onClick={exportCsv}>
            Export CSV
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!displayRows.length && !latestRun}
            onClick={exportJson}
          >
            Export JSON
          </Button>
        </div>
      </div>

      {liveJob ? (
        <p className="text-sm text-muted-foreground">
          Live job: <span className="font-medium text-foreground">{liveJob.name}</span> —{" "}
          <span className="tabular-nums">{liveJob.progress_pct}%</span> overall (
          {liveJob.state}
          {liveJob.detail_message ? `: ${liveJob.detail_message}` : ""})
        </p>
      ) : null}

      <Table>
        <TableCaption>
          {displayRows.length
            ? "Archived lines plus the current job (when running). Updates every second over SSE."
            : "No rows yet. Run the worker with Supabase configured, then refresh."}
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Source</TableHead>
            <TableHead>Run / line</TableHead>
            <TableHead>Label</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="text-right w-24">Progress</TableHead>
            <TableHead>Detail</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {displayRows.map((r) => (
            <TableRow key={r.key}>
              <TableCell className="text-muted-foreground text-xs capitalize">
                {r.source}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {r.runName}
                <br />
                <span className="text-muted-foreground">#{r.lineIndex}</span>
              </TableCell>
              <TableCell className="max-w-[200px] truncate">{r.lineLabel}</TableCell>
              <TableCell>
                <Badge variant={badgeVariant(r.state)}>{r.state}</Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.progressPct}%</TableCell>
              <TableCell className="max-w-[280px] truncate text-muted-foreground text-sm">
                {r.message || "—"}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                {new Date(r.updatedAt).toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
