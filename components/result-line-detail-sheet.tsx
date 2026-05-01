"use client"

import * as React from "react"

import type { ScrapeResultLineRow, WorkerScrapeJobRow } from "@/types/scrape-result-line"
import type { WorkerScrapeRunArchive } from "@/lib/scrape-results-query"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type VaTable = {
  title?: string
  headers?: string[]
  rows?: string[][]
}

type VaCase = {
  caseIndex?: number
  caseIdText?: string | null
  url?: string
  exportedAt?: string
  tables?: VaTable[]
}

type VaLineExport = {
  row?: Record<string, unknown>
  searchedAt?: string
  cases?: VaCase[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function resolveArchiveLineExport(
  row: ScrapeResultLineRow,
  runs: WorkerScrapeRunArchive[]
): VaLineExport | null {
  const run = runs.find((r) => r.id === row.runId)
  if (!run) return null
  const arr = run.results
  if (!Array.isArray(arr)) return null
  const item = arr[row.lineIndex - 1]
  if (!isRecord(item)) return null
  const casesRaw = item.cases
  const cases: VaCase[] = Array.isArray(casesRaw)
    ? casesRaw.map((c) => (isRecord(c) ? (c as unknown as VaCase) : {}))
    : []
  return {
    row: isRecord(item.row) ? item.row : {},
    searchedAt: typeof item.searchedAt === "string" ? item.searchedAt : undefined,
    cases,
  }
}

function resolveLiveLineState(row: ScrapeResultLineRow, job: WorkerScrapeJobRow | null) {
  if (!job || job.id !== row.runId) return null
  const lines = job.lines_state ?? []
  return lines.find((l) => l.lineIndex === row.lineIndex) ?? null
}

function badgeVariant(state: string): "default" | "secondary" | "destructive" | "outline" {
  const s = state.toLowerCase()
  if (s === "scraping_complete" || s === "succeeded") return "default"
  if (s === "failed") return "destructive"
  if (s === "queued" || s === "initiating") return "secondary"
  return "outline"
}

export function ResultLineDetailSheet(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  row: ScrapeResultLineRow | null
  archiveRuns: WorkerScrapeRunArchive[]
  liveJob: WorkerScrapeJobRow | null
}) {
  const { open, onOpenChange, row, archiveRuns, liveJob } = props

  const archiveExport = React.useMemo(() => {
    if (!row || row.source !== "archive") return null
    return resolveArchiveLineExport(row, archiveRuns)
  }, [row, archiveRuns])

  const liveLine = React.useMemo(() => {
    if (!row || row.source !== "live") return null
    return resolveLiveLineState(row, liveJob)
  }, [row, liveJob])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        {row ?
          <>
            <SheetHeader className="text-left">
              <SheetTitle className="pr-8">Result detail</SheetTitle>
              <SheetDescription>Scrape line summary and full export when archived.</SheetDescription>
              <div className="space-y-1 text-left">
                <p className="font-medium text-foreground">{row.lineLabel}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {row.runName} · line {row.lineIndex} · {row.source}
                </p>
              </div>
            </SheetHeader>

            <div className="flex flex-col gap-4 px-4 pb-8">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={badgeVariant(row.state)}>{row.state}</Badge>
                <span className="text-sm text-muted-foreground tabular-nums">{row.progressPct}%</span>
                <span className="text-xs text-muted-foreground">
                  Updated {new Date(row.updatedAt).toLocaleString()}
                </span>
              </div>
              {row.message ?
                <p className="text-sm text-muted-foreground">{row.message}</p>
              : null}

              {row.source === "live" && liveJob && liveLine ?
                <>
                  <Separator />
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base">Live job</CardTitle>
                      <CardDescription>
                        Job state: {liveJob.state} — {liveJob.detail_message || "—"}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <p>
                        <span className="text-muted-foreground">Line message:</span> {liveLine.message || "—"}
                      </p>
                      <p>
                        <span className="text-muted-foreground">Line progress:</span>{" "}
                        {liveLine.progress_pct}%
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Full case exports appear here after the job finishes and the row is archived.
                      </p>
                    </CardContent>
                  </Card>
                </>
              : null}

              {row.source === "archive" ?
                archiveExport ?
                  <ArchiveExportBody data={archiveExport} runName={row.runName} />
                : <EmptyDetail message="Could not load export payload for this row. Try Refresh results." />
              : null}

              {row.source === "live" && !liveLine ?
                <EmptyDetail message="No line state found for this job." />
              : null}
            </div>
          </>
        : null}
      </SheetContent>
    </Sheet>
  )
}

function EmptyDetail({ message }: { message: string }) {
  return (
    <p className="text-sm text-muted-foreground border border-dashed rounded-lg p-4">{message}</p>
  )
}

function ArchiveExportBody({ data, runName }: { data: VaLineExport; runName: string }) {
  const r = data.row ?? {}
  const first = String(r.firstName ?? "")
  const last = String(r.lastName ?? "")
  const court = String(r.court ?? "")
  const typ = String(r.type ?? "")

  return (
    <>
      <Separator />
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Search row</CardTitle>
          <CardDescription>Run: {runName}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <DetailField label="Last name" value={last || "—"} />
          <DetailField label="First name" value={first || "—"} />
          <DetailField label="Court" value={court || "—"} className="sm:col-span-2" />
          <DetailField label="Division / type" value={typ || "—"} />
          <DetailField label="Searched at" value={data.searchedAt ? new Date(data.searchedAt).toLocaleString() : "—"} />
        </CardContent>
      </Card>

      <h3 className="text-sm font-medium text-foreground">
        Cases ({data.cases?.length ?? 0})
      </h3>
      {(data.cases ?? []).length === 0 ?
        <p className="text-sm text-muted-foreground">No cases linked for this search.</p>
      : (data.cases ?? []).map((c, i) => (
          <CaseBlock key={`${c.caseIdText ?? i}-${c.caseIndex ?? i}`} caseIndex={i} c={c} />
        ))}
    </>
  )
}

function DetailField({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className={className}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-foreground wrap-break-word">{value}</p>
    </div>
  )
}

function CaseBlock({ c, caseIndex }: { c: VaCase; caseIndex: number }) {
  const tables = Array.isArray(c.tables) ? c.tables : []
  const label = c.caseIdText?.trim() || `Case ${caseIndex + 1}`

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-mono">{label}</CardTitle>
        <CardDescription className="space-y-1">
          {c.url ?
            <a
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-primary underline-offset-4 hover:underline text-xs"
            >
              {c.url}
            </a>
          : null}
          {c.exportedAt ?
            <span className="block text-xs">Exported {new Date(c.exportedAt).toLocaleString()}</span>
          : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {tables.length === 0 ?
          <p className="text-sm text-muted-foreground">No tables captured for this case.</p>
        : tables.map((t, ti) => (
            <div key={ti} className="space-y-2">
              <h4 className="text-xs font-semibold text-foreground">
                {t.title?.trim() || `Table ${ti + 1}`}
              </h4>
              <div className="overflow-x-auto rounded-md border">
                <CaseTable table={t} />
              </div>
            </div>
          ))}
      </CardContent>
    </Card>
  )
}

function CaseTable({ table }: { table: VaTable }) {
  const headers = Array.isArray(table.headers) && table.headers.length > 0 ? table.headers : null
  const bodyRows = Array.isArray(table.rows) ? table.rows : []

  if (!headers && bodyRows.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground">Empty table.</p>
  }

  if (!headers) {
    return (
      <Table>
        <TableBody>
          {bodyRows.map((cells, ri) => (
            <TableRow key={ri}>
              {(cells ?? []).map((cell, ci) => (
                <TableCell key={ci} className="text-xs whitespace-nowrap max-w-[240px] truncate">
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {headers.map((h, hi) => (
            <TableHead key={hi} className="text-xs whitespace-nowrap">
              {h}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {bodyRows.map((cells, ri) => (
          <TableRow key={ri}>
            {headers.map((_, ci) => (
              <TableCell key={ci} className="text-xs max-w-[min(280px,28vw)] wrap-break-word">
                {(cells ?? [])[ci] ?? ""}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
