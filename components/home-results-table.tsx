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

function resolveLineDisputeSummary(
    r: ScrapeResultLineRow,
    archiveRuns: WorkerScrapeRunArchive[],
): { classification: string; recommended_action: string } | null {
    if (r.source !== "archive") return null;
    const run = archiveRuns.find((x) => x.id === r.runId);
    if (!run) return null;
    const arr = run.dispute_analysis as unknown;
    if (!Array.isArray(arr)) return null;
    const line = arr[r.lineIndex - 1] as Record<string, unknown> | undefined;
    const cases = (line && (line.cases as unknown)) as unknown[] | undefined;
    if (!Array.isArray(cases) || cases.length === 0) return null;

    const analyses = cases
        .map((c) => (c as Record<string, unknown>)?.analysis as Record<string, unknown> | undefined)
        .filter(Boolean);
    if (!analyses.length) return null;

    const pick = (cls: string) =>
        analyses.find((a) => (a?.classification as string | undefined) === cls) ?? null;

    const best =
        pick("DISPUTABLE") ??
        pick("CONDITIONALLY DISPUTABLE") ??
        pick("NOT DISPUTABLE") ??
        null;
    if (!best) return null;

    const classification = (best.classification as string | undefined) ?? "";
    const recommended_action = (best.recommended_action as string | undefined) ?? "";
    if (!classification) return null;
    return { classification, recommended_action };
}

function resolveArchiveLineExportItem(r: ScrapeResultLineRow, archiveRuns: WorkerScrapeRunArchive[]): Record<string, unknown> | null {
    if (r.source !== "archive") return null;
    const run = archiveRuns.find((x) => x.id === r.runId);
    if (!run) return null;
    const arr = run.results as unknown;
    if (!Array.isArray(arr)) return null;
    const item = arr[r.lineIndex - 1] as unknown;
    return typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
}

function resolveArchiveLineCaseCount(r: ScrapeResultLineRow, archiveRuns: WorkerScrapeRunArchive[]): number | null {
    if (r.source !== "archive") return null;
    const run = archiveRuns.find((x) => x.id === r.runId);
    if (!run) return null;
    const arr = run.results as unknown;
    if (!Array.isArray(arr)) return null;
    const item = arr[r.lineIndex - 1] as Record<string, unknown> | undefined;
    const cases = item && (item.cases as unknown);
    return Array.isArray(cases) ? cases.length : null;
}

type LineIssueKind = "site_down" | "scrape_error" | null;

function resolveLineIssueKind(r: ScrapeResultLineRow): LineIssueKind {
    const msg = (r.message ?? "").toLowerCase();
    const st = (r.state ?? "").toLowerCase();
    if (st === "failed") {
        // Try to differentiate infra vs scrape errors.
        if (
            msg.includes("timeout") ||
            msg.includes("timed out") ||
            msg.includes("net::") ||
            msg.includes("econnrefused") ||
            msg.includes("enotfound") ||
            msg.includes("dns") ||
            msg.includes("502") ||
            msg.includes("503") ||
            msg.includes("504") ||
            msg.includes("service unavailable") ||
            msg.includes("bad gateway") ||
            msg.includes("gateway timeout")
        ) {
            return "site_down";
        }
        return "scrape_error";
    }
    // Non-failed but still indicates infra issue.
    if (
        msg.includes("service unavailable") ||
        msg.includes("bad gateway") ||
        msg.includes("gateway timeout") ||
        msg.includes("net::") ||
        msg.includes("econnrefused") ||
        msg.includes("enotfound")
    ) {
        return "site_down";
    }
    return null;
}

function ResultsSection({
    title,
    description,
    rows,
    emptyHint,
    onRowClick,
    archiveRuns,
    hasMore,
    onEndReached,
}: {
    title: string;
    description: string;
    rows: ScrapeResultLineRow[];
    emptyHint: string;
    onRowClick: (r: ScrapeResultLineRow) => void;
    archiveRuns: WorkerScrapeRunArchive[];
    hasMore: boolean;
    onEndReached: () => void;
}) {
    type SortKey = "source" | "run" | "label" | "dispute" | "state" | "progress" | "detail" | "updated" | "cases";
    const [sortKey, setSortKey] = React.useState<SortKey>("updated");
    const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");

    const toggleSort = React.useCallback((k: SortKey) => {
        setSortKey((prev) => {
            if (prev !== k) {
                setSortDir("asc");
                return k;
            }
            setSortDir((d) => (d === "asc" ? "desc" : "asc"));
            return prev;
        });
    }, []);

    const sortedRows = React.useMemo(() => {
        const dir = sortDir === "asc" ? 1 : -1;
        const get = (r: ScrapeResultLineRow) => {
            switch (sortKey) {
                case "source":
                    return r.source;
                case "run":
                    return `${r.runName}\u0000${String(r.lineIndex).padStart(6, "0")}`;
                case "label":
                    return r.lineLabel;
                case "state":
                    return r.state;
                case "progress":
                    return r.progressPct;
                case "updated":
                    return new Date(r.updatedAt).getTime() || 0;
                case "detail":
                    return r.message ?? "";
                case "dispute":
                    return resolveLineDisputeClassification(r, archiveRuns) ?? "";
                case "cases":
                    return resolveArchiveLineCaseCount(r, archiveRuns) ?? -1;
                default:
                    return "";
            }
        };
        const copy = [...rows];
        copy.sort((a, b) => {
            const av = get(a) as unknown;
            const bv = get(b) as unknown;
            if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
            return String(av).localeCompare(String(bv)) * dir;
        });
        return copy;
    }, [rows, sortKey, sortDir, archiveRuns]);

    const sentinelRef = React.useRef<HTMLDivElement | null>(null);
    React.useEffect(() => {
        if (!hasMore) return;
        const el = sentinelRef.current;
        if (!el) return;
        const obs = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) onEndReached();
            },
            { rootMargin: "600px 0px" },
        );
        obs.observe(el);
        return () => obs.disconnect();
    }, [hasMore, onEndReached]);

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
                            <TableHead className='hidden sm:table-cell cursor-pointer select-none' onClick={() => toggleSort("source")}>
                                Source
                            </TableHead>
                            <TableHead className='cursor-pointer select-none' onClick={() => toggleSort("run")}>
                                Run / line
                            </TableHead>
                            <TableHead className='cursor-pointer select-none' onClick={() => toggleSort("label")}>
                                Label
                            </TableHead>
                            <TableHead className='cursor-pointer select-none' onClick={() => toggleSort("dispute")}>
                                Dispute
                            </TableHead>
                            <TableHead className='cursor-pointer select-none' onClick={() => toggleSort("state")}>
                                State
                            </TableHead>
                            <TableHead className='text-right w-24 cursor-pointer select-none' onClick={() => toggleSort("progress")}>
                                Progress
                            </TableHead>
                            <TableHead className='hidden md:table-cell cursor-pointer select-none' onClick={() => toggleSort("detail")}>
                                Detail
                            </TableHead>
                            <TableHead className='hidden lg:table-cell cursor-pointer select-none' onClick={() => toggleSort("updated")}>
                                Updated
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {sortedRows.map((r) => (
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
                                <TableCell className='max-w-[260px]'>
                                    {(() => {
                                        const s = resolveLineDisputeSummary(r, archiveRuns);
                                        if (!s) return <span className='text-muted-foreground'>—</span>;
                                        return (
                                            <div className='space-y-1'>
                                                <Badge variant={disputeVariant(s.classification)}>{s.classification}</Badge>
                                                {s.recommended_action ?
                                                    <p className='text-xs text-muted-foreground line-clamp-2'>{s.recommended_action}</p>
                                                :   null}
                                            </div>
                                        );
                                    })()}
                                </TableCell>
                                <TableCell>
                                    <Badge variant={badgeVariant(r.state)}>{r.state}</Badge>
                                </TableCell>
                                <TableCell className='text-right tabular-nums whitespace-nowrap'>{r.progressPct}%</TableCell>
                                <TableCell className='hidden md:table-cell max-w-[320px] truncate text-muted-foreground text-sm'>
                                    {(() => {
                                        const issue = resolveLineIssueKind(r);
                                        const cases = resolveArchiveLineCaseCount(r, archiveRuns);
                                        if (issue === "site_down") {
                                            return <span className='text-destructive font-medium'>Site down / network error</span>;
                                        }
                                        if (issue === "scrape_error") {
                                            return <span className='text-destructive font-medium'>Scrape error</span>;
                                        }
                                        if (cases === 0) {
                                            return <span className='text-muted-foreground font-medium'>No cases found</span>;
                                        }
                                        return r.message || "—";
                                    })()}
                                </TableCell>
                                <TableCell className='hidden lg:table-cell text-xs text-muted-foreground whitespace-nowrap'>
                                    {new Date(r.updatedAt).toLocaleString()}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
            {hasMore ? <div ref={sentinelRef} className='h-8' /> : null}
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
    const [nextCursor, setNextCursor] = React.useState<string | null>(null);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [visibleCurrent, setVisibleCurrent] = React.useState(20);
    const [visiblePassed, setVisiblePassed] = React.useState(20);

    React.useEffect(() => {
        const id = focusJobId?.trim();
        if (!id) return;
        queueMicrotask(() => {
            setJobIdOverride(id);
        });
    }, [focusJobId]);

    const loadPage = React.useCallback(async (cursor: string | null) => {
        const qs = new URLSearchParams();
        qs.set("limit", "20");
        if (cursor) qs.set("cursor", cursor);
        const res = await fetch(`/api/scrape-results?${qs.toString()}`, { cache: "no-store" });
        const body = (await res.json()) as {
            archive: ScrapeResultLineRow[];
            archiveRuns?: WorkerScrapeRunArchive[];
            nextCursor?: string | null;
            activeJob: WorkerScrapeJobRow | null;
            latestRun?: WorkerScrapeRunLatest | null;
            configured?: boolean;
        };
        setNextCursor(body.nextCursor ?? null);
        setConfigured(body.configured !== false);
        if (cursor) {
            setArchive((prev) => [...prev, ...(body.archive ?? [])]);
            setArchiveRuns((prev) => [...prev, ...(body.archiveRuns ?? [])]);
        } else {
            setArchive(body.archive ?? []);
            setArchiveRuns(body.archiveRuns ?? []);
        }
        setLiveJob(body.activeJob ?? null);
        setLatestRun(body.latestRun ?? null);
    }, []);

    const loadInitial = React.useCallback(async () => {
        setVisibleCurrent(20);
        setVisiblePassed(20);
        await loadPage(null);
    }, [loadPage]);

    React.useEffect(() => {
        queueMicrotask(() => {
            void loadInitial();
        });
    }, [loadInitial]);

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
                    void loadInitial();
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
    }, [watchJobId, configured, loadInitial]);

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

    const shownCurrent = React.useMemo(() => currentRows.slice(0, visibleCurrent), [currentRows, visibleCurrent]);
    const shownPassed = React.useMemo(() => passedRows.slice(0, visiblePassed), [passedRows, visiblePassed]);

    const hasMoreCurrent = shownCurrent.length < currentRows.length || (!!nextCursor && !loadingMore);
    const hasMorePassed = shownPassed.length < passedRows.length || (!!nextCursor && !loadingMore);

    const maybeFetchMore = React.useCallback(async () => {
        if (!nextCursor || loadingMore) return;
        setLoadingMore(true);
        try {
            await loadPage(nextCursor);
        } finally {
            setLoadingMore(false);
        }
    }, [nextCursor, loadingMore, loadPage]);

    const onEndReachedCurrent = React.useCallback(() => {
        setVisibleCurrent((n) => n + 20);
        if (visibleCurrent >= currentRows.length) void maybeFetchMore();
    }, [visibleCurrent, currentRows.length, maybeFetchMore]);

    const onEndReachedPassed = React.useCallback(() => {
        setVisiblePassed((n) => n + 20);
        if (visiblePassed >= passedRows.length) void maybeFetchMore();
    }, [visiblePassed, passedRows.length, maybeFetchMore]);

    const rowToExportFields = React.useCallback(
        (r: ScrapeResultLineRow) => {
            const dispute = resolveLineDisputeSummary(r, archiveRuns);
            const issue = resolveLineIssueKind(r);
            const caseCount = resolveArchiveLineCaseCount(r, archiveRuns);
            return {
            section: isCurrentExportRow(r, partitionNow) ? "current" : "passed",
            source: r.source,
            runName: r.runName,
            lineIndex: r.lineIndex,
            lineLabel: r.lineLabel,
            disputeClassification: dispute?.classification ?? "",
            disputeRecommendedAction: dispute?.recommended_action ?? "",
            caseCount: caseCount ?? "",
            issueKind: issue ?? "",
            state: r.state,
            progressPct: r.progressPct,
            message: r.message,
            updatedAt: r.updatedAt,
            };
        },
        [partitionNow, archiveRuns],
    );

    const exportCsv = React.useCallback(() => {
        if (!displayRows.length) return;
        const csv = Papa.unparse(displayRows.map(rowToExportFields));
        triggerDownload(`scrape-results-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`, "text/csv;charset=utf-8", csv);
    }, [displayRows, rowToExportFields]);

    const exportJson = React.useCallback(() => {
        const enrichedRows = displayRows.map((r) => {
            const base = rowToExportFields(r);
            return {
                ...base,
                archiveDetail: resolveArchiveLineExportItem(r, archiveRuns),
            };
        });
        const payload = {
            exportedAt: new Date().toISOString(),
            currentExportWindowMinutes: 15,
            tableRowsCurrent: currentRows,
            tableRowsPassed: passedRows,
            tableRows: displayRows,
            exportedRows: enrichedRows,
            archiveRuns: archiveRuns,
            latestWorkerRun: latestRun,
        };
        triggerDownload(
            `scrape-export-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`,
            "application/json;charset=utf-8",
            JSON.stringify(payload, null, 2),
        );
    }, [currentRows, passedRows, displayRows, latestRun, archiveRuns, rowToExportFields]);

    return (
        <div className='space-y-3'>
            {!configured ?
                <p className='text-sm text-amber-600 dark:text-amber-500'>
                    Configure Supabase server keys to load archived results and live jobs.
                </p>
            :   null}

            <div className='grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end'>
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
                <div className='flex flex-wrap gap-2 sm:justify-end'>
                    <Button type='button' variant='outline' onClick={() => void loadInitial()}>
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
                    rows={shownCurrent}
                    emptyHint='No current activity. Start a scrape or wait for an archive row in the window below after a run completes.'
                    onRowClick={setDetailRow}
                    archiveRuns={archiveRuns}
                    hasMore={hasMoreCurrent}
                    onEndReached={onEndReachedCurrent}
                />
                <ResultsSection
                    title='Previously exported'
                    description='Older archived lines. Click a row for the same full detail sheet.'
                    rows={shownPassed}
                    emptyHint='No older exports in view.'
                    onRowClick={setDetailRow}
                    archiveRuns={archiveRuns}
                    hasMore={hasMorePassed}
                    onEndReached={onEndReachedPassed}
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
