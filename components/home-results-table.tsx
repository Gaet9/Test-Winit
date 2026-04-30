"use client"

import * as React from "react"

import type {
  ScrapeResultLineRow,
  WorkerScrapeJobRow,
} from "@/types/scrape-result-line"
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

function badgeVariant(state: string): "default" | "secondary" | "destructive" | "outline" {
  const s = state.toLowerCase()
  if (s === "scraping_complete" || s === "succeeded") return "default"
  if (s === "failed") return "destructive"
  if (s === "queued" || s === "initiating") return "secondary"
  return "outline"
}

export function HomeResultsTable() {
  const [archive, setArchive] = React.useState<ScrapeResultLineRow[]>([])
  const [configured, setConfigured] = React.useState(true)
  const [liveJob, setLiveJob] = React.useState<WorkerScrapeJobRow | null>(null)
  const [jobIdOverride, setJobIdOverride] = React.useState("")
  const [sseStatus, setSseStatus] = React.useState<"idle" | "open" | "closed">("idle")

  const load = React.useCallback(async () => {
    const res = await fetch("/api/scrape-results", { cache: "no-store" })
    const body = (await res.json()) as {
      archive: ScrapeResultLineRow[]
      activeJob: WorkerScrapeJobRow | null
      configured?: boolean
    }
    setConfigured(body.configured !== false)
    setArchive(body.archive ?? [])
    setLiveJob(body.activeJob ?? null)
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

  const liveRows = liveJob ? jobLinesToResultRows(liveJob) : []
  const displayRows = [...liveRows, ...archive]

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
            SSE: {sseStatus}. Defaults to latest active job when the field is empty.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => void load()}>
          Refresh results
        </Button>
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
