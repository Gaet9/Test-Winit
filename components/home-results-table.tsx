"use client";

import * as React from "react";
import Papa from "papaparse";

import type { ScrapeResultLineRow, WorkerScrapeJobRow } from "@/types/scrape-result-line";
import type { WorkerScrapeRunArchive, WorkerScrapeRunLatest } from "@/lib/scrape-results-query";
import { ResultLineDetailSheet } from "@/components/result-line-detail-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { jobLinesToResultRows } from "@/lib/scrape-result-mappers";

/** Archive rows with `updatedAt` (run processed_at) newer than this are grouped under “current export”. */
const CURRENT_EXPORT_WINDOW_MS = 15 * 60 * 1000;

function isCurrentExportRow(row: ScrapeResultLineRow, nowMs: number): boolean {
    if (row.source === "live") return true;
    const t = new Date(row.updatedAt).getTime();
    if (Number.isNaN(t)) return false;
    return nowMs - t <= CURRENT_EXPORT_WINDOW_MS;
}

function partitionResultsByRecency(rows: ScrapeResultLineRow[], nowMs: number) {
    const current: ScrapeResultLineRow[] = [];
    const passed: ScrapeResultLineRow[] = [];
    for (const r of rows) {
        if (isCurrentExportRow(r, nowMs)) current.push(r);
        else passed.push(r);
    }
    return { current, passed };
}

function triggerDownload(filename: string, mime: string, body: string) {
    const blob = new Blob([body], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function badgeVariant(state: string): "default" | "secondary" | "destructive" | "outline" {
    const s = state.toLowerCase();
    if (s === "scraping_complete" || s === "succeeded") return "default";
    if (s === "failed") return "destructive";
    if (s === "queued" || s === "initiating") return "secondary";
    return "outline";
}

function disputeVariant(classification: string | null | undefined): "default" | "secondary" | "destructive" | "outline" {
    const c = (classification ?? "").toLowerCase();
    if (c === "disputable") return "default";
    if (c === "conditionally disputable") return "secondary";
    if (c === "not disputable") return "destructive";
    return "outline";
}

function resolveLineDisputeClassification(
    r: ScrapeResultLineRow,
    archiveRuns: WorkerScrapeRunArchive[],
): string | null {
    if (r.source !== "archive") return null;
    const run = archiveRuns.find((x) => x.id === r.runId);
    if (!run) return null;
    const arr = (run.dispute_analysis as unknown) as unknown[];
    if (!Array.isArray(arr)) return null;
    const line = arr[r.lineIndex - 1] as Record<string, unknown> | undefined;
    const cases = (line && (line.cases as unknown)) as unknown[] | undefined;
    if (!Array.isArray(cases) || cases.length === 0) return null;
    const classes = cases
        .map((c) => (c as Record<string, unknown>)?.analysis as Record<string, unknown> | undefined)
        .map((a) => (a?.classification as string | undefined) ?? "")
        .filter(Boolean);
    if (!classes.length) return null;
    if (classes.some((x) => x === "DISPUTABLE")) return "DISPUTABLE";
    if (classes.some((x) => x === "CONDITIONALLY DISPUTABLE")) return "CONDITIONALLY DISPUTABLE";
    return "NOT DISPUTABLE";
}

function ResultsSection({
    title,
    description,
    rows,
    emptyHint,
    onRowClick,
    archiveRuns,
}: {
    title: string;
    description: string;
    rows: ScrapeResultLineRow[];
    emptyHint: string;
    onRowClick: (r: ScrapeResultLineRow) => void;
    archiveRuns: WorkerScrapeRunArchive[];
}) {
    return (
        <section className='space-y-2'>
            <div>
                <h3 className='text-sm font-semibold text-foreground'>{title}</h3>
                <p className='text-xs text-muted-foreground'>{description}</p>
            </div>
            <div className='w-full overflow-x-auto rounded-md border'>
                <Table className='min-w-[720px]'>
                    <TableCaption>
                        {rows.length ? `${rows.length} row(s). Click a row for full export detail.` : emptyHint}
                    </TableCaption>
                    <TableHeader>
                        <TableRow>
                            <TableHead className='hidden sm:table-cell'>Source</TableHead>
                            <TableHead>Run / line</TableHead>
                            <TableHead>Label</TableHead>
                            <TableHead className='hidden sm:table-cell'>Dispute</TableHead>
                            <TableHead>State</TableHead>
                            <TableHead className='text-right w-24'>Progress</TableHead>
                            <TableHead className='hidden md:table-cell'>Detail</TableHead>
                            <TableHead className='hidden lg:table-cell'>Updated</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((r) => (
                            <TableRow
                                key={r.key}
                                role='button'
                                tabIndex={0}
                                className='cursor-pointer hover:bg-muted/60'
                                onClick={() => onRowClick(r)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        onRowClick(r);
                                    }
                                }}
                            >
                                <TableCell className='hidden sm:table-cell text-muted-foreground text-xs capitalize'>
                                    {r.source}
                                </TableCell>
                                <TableCell className='font-mono text-xs whitespace-nowrap'>
                                    {r.runName}
                                    <br />
                                    <span className='text-muted-foreground'>#{r.lineIndex}</span>
                                </TableCell>
                                <TableCell className='max-w-[220px] sm:max-w-[320px] truncate'>{r.lineLabel}</TableCell>
                                <TableCell className='hidden sm:table-cell'>
                                    {(() => {
                                        const c = resolveLineDisputeClassification(r, archiveRuns);
                                        return <Badge variant={disputeVariant(c)}>{c ?? "—"}</Badge>;
                                    })()}
                                </TableCell>
                                <TableCell>
                                    <Badge variant={badgeVariant(r.state)}>{r.state}</Badge>
                                </TableCell>
                                <TableCell className='text-right tabular-nums whitespace-nowrap'>{r.progressPct}%</TableCell>
                                <TableCell className='hidden md:table-cell max-w-[320px] truncate text-muted-foreground text-sm'>
                                    {r.message || "—"}
                                </TableCell>
                                <TableCell className='hidden lg:table-cell text-xs text-muted-foreground whitespace-nowrap'>
                                    {new Date(r.updatedAt).toLocaleString()}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </section>
    );
}

export function HomeResultsTable({ focusJobId }: { focusJobId?: string | null } = {}) {
    const [archive, setArchive] = React.useState<ScrapeResultLineRow[]>([]);
    const [archiveRuns, setArchiveRuns] = React.useState<WorkerScrapeRunArchive[]>([]);
    const [latestRun, setLatestRun] = React.useState<WorkerScrapeRunLatest | null>(null);
    const [detailRow, setDetailRow] = React.useState<ScrapeResultLineRow | null>(null);
    const [configured, setConfigured] = React.useState(true);
    const [liveJob, setLiveJob] = React.useState<WorkerScrapeJobRow | null>(null);
    const [jobIdOverride, setJobIdOverride] = React.useState("");
    const [sseStatus, setSseStatus] = React.useState<"idle" | "open" | "closed">("idle");

    React.useEffect(() => {
        const id = focusJobId?.trim();
        if (!id) return;
        queueMicrotask(() => {
            setJobIdOverride(id);
        });
    }, [focusJobId]);

    const load = React.useCallback(async () => {
        const res = await fetch("/api/scrape-results", { cache: "no-store" });
        const body = (await res.json()) as {
            archive: ScrapeResultLineRow[];
            archiveRuns?: WorkerScrapeRunArchive[];
            activeJob: WorkerScrapeJobRow | null;
            latestRun?: WorkerScrapeRunLatest | null;
            configured?: boolean;
        };
        setConfigured(body.configured !== false);
        setArchive(body.archive ?? []);
        setArchiveRuns(body.archiveRuns ?? []);
        setLiveJob(body.activeJob ?? null);
        setLatestRun(body.latestRun ?? null);
    }, []);

    React.useEffect(() => {
        queueMicrotask(() => {
            void load();
        });
    }, [load]);

    const watchJobId = jobIdOverride.trim() || liveJob?.id || null;

    React.useEffect(() => {
        if (!watchJobId || !configured) {
            queueMicrotask(() => {
                setSseStatus("idle");
            });
            return;
        }

        const url = `/api/scrape-jobs/${watchJobId}/sse`;
        const es = new EventSource(url);
        queueMicrotask(() => {
            setSseStatus("open");
        });

        es.onmessage = (ev) => {
            try {
                const raw = JSON.parse(ev.data as string) as Record<string, unknown>;
                if (raw.error === "not_found" || raw.error === "not_configured") {
                    es.close();
                    setSseStatus("closed");
                    return;
                }
                if (typeof raw.id === "string" && Array.isArray(raw.lines_state)) {
                    setLiveJob(raw as unknown as WorkerScrapeJobRow);
                }
                if (raw.state === "scraping_complete" || raw.state === "failed") {
                    es.close();
                    setSseStatus("closed");
                    void load();
                }
            } catch {
                /* ignore malformed chunks */
            }
        };

        es.onerror = () => {
            es.close();
            setSseStatus("closed");
        };

        return () => {
            es.close();
            setSseStatus("closed");
        };
    }, [watchJobId, configured, load]);

    const liveRows = React.useMemo(() => (liveJob ? jobLinesToResultRows(liveJob) : []), [liveJob]);
    const displayRows = React.useMemo(() => [...liveRows, ...archive], [liveRows, archive]);

    const [partitionNow, setPartitionNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        queueMicrotask(() => {
            setPartitionNow(Date.now());
        });
    }, [displayRows]);
    React.useEffect(() => {
        const id = window.setInterval(() => setPartitionNow(Date.now()), 30_000);
        return () => window.clearInterval(id);
    }, []);

    const { current: currentRows, passed: passedRows } = React.useMemo(
        () => partitionResultsByRecency(displayRows, partitionNow),
        [displayRows, partitionNow],
    );

    const rowToExportFields = React.useCallback(
        (r: ScrapeResultLineRow) => ({
            section: isCurrentExportRow(r, partitionNow) ? "current" : "passed",
            source: r.source,
            runName: r.runName,
            lineIndex: r.lineIndex,
            lineLabel: r.lineLabel,
            state: r.state,
            progressPct: r.progressPct,
            message: r.message,
            updatedAt: r.updatedAt,
        }),
        [partitionNow],
    );

    const exportCsv = React.useCallback(() => {
        if (!displayRows.length) return;
        const csv = Papa.unparse(displayRows.map(rowToExportFields));
        triggerDownload(`scrape-results-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`, "text/csv;charset=utf-8", csv);
    }, [displayRows, rowToExportFields]);

    const exportJson = React.useCallback(() => {
        const payload = {
            exportedAt: new Date().toISOString(),
            currentExportWindowMinutes: 15,
            tableRowsCurrent: currentRows,
            tableRowsPassed: passedRows,
            tableRows: displayRows,
            latestWorkerRun: latestRun,
        };
        triggerDownload(
            `scrape-export-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`,
            "application/json;charset=utf-8",
            JSON.stringify(payload, null, 2),
        );
    }, [currentRows, passedRows, displayRows, latestRun]);

    return (
        <div className='space-y-3'>
            {!configured ?
                <p className='text-sm text-amber-600 dark:text-amber-500'>
                    Configure Supabase server keys to load archived results and live jobs.
                </p>
            :   null}

            <div className='flex flex-col gap-2 sm:flex-row sm:items-end'>
                <div className='flex-1 space-y-1'>
                    <Label htmlFor='job-sse-id'>Watch job (optional)</Label>
                    <Input
                        id='job-sse-id'
                        placeholder='Paste job UUID from worker JSON log…'
                        value={jobIdOverride}
                        onChange={(e) => setJobIdOverride(e.target.value)}
                    />
                    <p className='text-xs text-muted-foreground'>Live updates (SSE): {sseStatus}</p>
                </div>
                <div className='flex flex-wrap gap-2'>
                    <Button type='button' variant='outline' onClick={() => void load()}>
                        Refresh results
                    </Button>
                    <Button type='button' variant='outline' disabled={!displayRows.length} onClick={exportCsv}>
                        Export CSV
                    </Button>
                    <Button
                        type='button'
                        variant='outline'
                        disabled={!displayRows.length && !latestRun}
                        onClick={exportJson}
                    >
                        Export JSON
                    </Button>
                </div>
            </div>

            {liveJob ?
                <div className='space-y-2'>
                    <p className='text-sm text-muted-foreground'>
                        Live job: <span className='font-medium text-foreground'>{liveJob.name}</span> —{" "}
                        <span className='tabular-nums'>{liveJob.progress_pct}%</span> overall ({liveJob.state}
                        {liveJob.detail_message ? `: ${liveJob.detail_message}` : ""})
                    </p>
                    <div className='flex items-center gap-3'>
                        <Progress value={liveJob.progress_pct} className='h-2 flex-1' />
                        <span className='text-xs tabular-nums text-muted-foreground w-12 text-right'>
                            {liveJob.progress_pct}%
                        </span>
                    </div>
                </div>
            :   null}

            <div className='space-y-8'>
                <ResultsSection
                    title='Current export'
                    description='Live job lines plus archive rows from runs finished in the last 15 minutes (by processed time).'
                    rows={currentRows}
                    emptyHint='No current activity. Start a scrape or wait for an archive row in the window below after a run completes.'
                    onRowClick={setDetailRow}
                    archiveRuns={archiveRuns}
                />
                <ResultsSection
                    title='Previously exported'
                    description='Older archived lines. Click a row for the same full detail sheet.'
                    rows={passedRows}
                    emptyHint='No older exports in view.'
                    onRowClick={setDetailRow}
                    archiveRuns={archiveRuns}
                />
            </div>

            <ResultLineDetailSheet
                open={detailRow !== null}
                onOpenChange={(o) => {
                    if (!o) setDetailRow(null);
                }}
                row={detailRow}
                archiveRuns={archiveRuns}
                liveJob={liveJob}
            />
        </div>
    );
}
