"use client";

import * as React from "react";
import { AlertCircleIcon, FileSpreadsheetIcon, Loader2Icon, UploadIcon } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HomeResultsTable } from "@/components/home-results-table";
import type { CsvRow } from "@/lib/csv/parse-csv";
import { parseAndValidateCsvFile } from "@/lib/csv/parse-csv";
import { cn } from "@/lib/utils";

function suggestedJobNameFromFilename(fileName: string): string {
    const base = fileName.replace(/\.csv$/i, "").trim() || `Run ${new Date().toISOString().slice(0, 16)}`;
    return base.length > 200 ? base.slice(0, 200) : base;
}

export default function Home() {
    const [jobName, setJobName] = React.useState("");
    const [mainTab, setMainTab] = React.useState("overview");
    const [csvRows, setCsvRows] = React.useState<CsvRow[]>([]);
    const [csvFileName, setCsvFileName] = React.useState<string | null>(null);
    const [csvError, setCsvError] = React.useState<string | null>(null);
    const [dragActive, setDragActive] = React.useState(false);
    const [starting, setStarting] = React.useState(false);
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const total = csvRows.length;
    const done = 0;
    const running = 0;
    const queued = total;
    const blocked = 0;
    const pct = 0;

    const processFile = React.useCallback(async (file: File) => {
        if (!file.name.toLowerCase().endsWith(".csv")) {
            setCsvError("Please choose a .csv file.");
            setCsvRows([]);
            setCsvFileName(file.name);
            return;
        }
        const result = await parseAndValidateCsvFile(file);
        if (!result.ok) {
            setCsvError(result.error);
            setCsvRows([]);
            setCsvFileName(file.name);
            return;
        }
        setCsvError(null);
        setCsvRows(result.rows);
        setCsvFileName(file.name);
        setJobName((prev) => (prev.trim() ? prev : suggestedJobNameFromFilename(file.name)));
    }, []);

    const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) void processFile(file);
        e.target.value = "";
    };

    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setDragActive(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void processFile(file);
    };

    const canStart = jobName.trim().length > 0 && csvRows.length > 0 && !csvError && !starting;

    async function startScraping() {
        if (!canStart) return;
        setStarting(true);
        try {
            const res = await fetch("/api/scrape/va-gdcourts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: jobName.trim(), rows: csvRows }),
            });
            const data = (await res.json()) as { error?: unknown; jobId?: string; ssePath?: string };
            if (!res.ok) {
                const msg =
                    typeof data.error === "string" ? data.error
                    : res.status === 501 ? "Scraping cannot be started from this hosting environment."
                    : `Request failed (${res.status})`;
                throw new Error(msg);
            }
            toast.success("Scraping started", {
                description: data.jobId ? `Job ${data.jobId.slice(0, 8)}… — open Results for live updates.` : undefined,
            });
            setMainTab("results");
        } catch (e) {
            toast.error("Could not start scraping", {
                description: e instanceof Error ? e.message : String(e),
            });
        } finally {
            setStarting(false);
        }
    }

    return (
        <div className='min-h-full flex flex-col bg-background'>
            <header className='border-b'>
                <div className='mx-auto w-full max-w-6xl px-4 py-4'>
                    <div className='min-w-0'>
                        <div className='flex items-center gap-2'>
                            <h1 className='truncate text-lg font-semibold'>Parking Summons Monitor</h1>
                            <Badge variant='secondary'>Winit test</Badge>
                        </div>
                    </div>
                </div>
            </header>

            <main className='mx-auto w-full max-w-6xl flex-1 px-4 py-6'>
                <Tabs value={mainTab} onValueChange={setMainTab} className='gap-4'>
                    <TabsList>
                        <TabsTrigger value='overview'>Overview</TabsTrigger>
                        <TabsTrigger value='results'>Results</TabsTrigger>
                    </TabsList>

                    <TabsContent value='overview' className='space-y-4'>
                        <Card>
                            <CardHeader className='border-b'>
                                <CardTitle>Run setup</CardTitle>
                                <CardDescription>
                                    Drop a CSV (first name, last name, court, type). The job name defaults to the file name; you can edit
                                    it anytime.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className='space-y-6'>
                                <div className='space-y-2'>
                                    <Label htmlFor='job-name'>Job name</Label>
                                    <p className='text-xs text-muted-foreground'>
                                        Filled automatically from the CSV file name when the file validates; required before starting.
                                    </p>
                                    <Input
                                        id='job-name'
                                        value={jobName}
                                        onChange={(e) => setJobName(e.target.value)}
                                        placeholder='e.g. Fleet batch 2026-04-30'
                                        className='max-w-xl'
                                    />
                                </div>

                                <div className='space-y-2'>
                                    <Label>CSV file</Label>
                                    <input
                                        ref={fileInputRef}
                                        type='file'
                                        accept='.csv,text/csv'
                                        className='sr-only'
                                        onChange={onInputChange}
                                    />
                                    <button
                                        type='button'
                                        onClick={() => fileInputRef.current?.click()}
                                        onDragEnter={(e) => {
                                            e.preventDefault();
                                            setDragActive(true);
                                        }}
                                        onDragLeave={(e) => {
                                            e.preventDefault();
                                            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                                setDragActive(false);
                                            }
                                        }}
                                        onDragOver={(e) => e.preventDefault()}
                                        onDrop={onDrop}
                                        className={cn(
                                            "group flex w-full max-w-2xl flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
                                            "hover:border-primary/50 hover:bg-muted/40",
                                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                                            dragActive && "border-primary bg-primary/5",
                                            csvError && "border-destructive/60 bg-destructive/5",
                                        )}>
                                        <div className='flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors group-hover:bg-background group-hover:text-foreground'>
                                            <UploadIcon className='size-6' aria-hidden />
                                        </div>
                                        <div>
                                            <p className='text-sm font-medium'>Drop a CSV here or click to browse</p>
                                            <p className='mt-1 text-xs text-muted-foreground'>
                                                Columns: first name, last name, court, type (civil or traffic/criminal)
                                            </p>
                                        </div>
                                    </button>

                                    {csvFileName ?
                                        <div className='flex max-w-2xl flex-wrap items-center gap-2 text-sm'>
                                            <FileSpreadsheetIcon className='size-4 shrink-0 text-muted-foreground' aria-hidden />
                                            <span className='font-medium text-foreground'>{csvFileName}</span>
                                            {csvError ? null : (
                                                <Badge variant='secondary' className='tabular-nums'>
                                                    {total} row{total === 1 ? "" : "s"} validated
                                                </Badge>
                                            )}
                                            <Button
                                                type='button'
                                                variant='ghost'
                                                size='sm'
                                                className='h-7 text-muted-foreground'
                                                onClick={() => {
                                                    setCsvRows([]);
                                                    setCsvFileName(null);
                                                    setCsvError(null);
                                                }}>
                                                Clear
                                            </Button>
                                        </div>
                                    :   null}

                                    {csvError ?
                                        <div
                                            role='alert'
                                            className='flex max-w-2xl gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive'>
                                            <AlertCircleIcon className='mt-0.5 size-4 shrink-0' aria-hidden />
                                            <span>{csvError}</span>
                                        </div>
                                    :   null}

                                    <div className='flex flex-wrap items-center gap-2'>
                                        <Button type='button' disabled={!canStart} onClick={() => void startScraping()}>
                                            {starting ?
                                                <>
                                                    <Loader2Icon className='mr-2 size-4 animate-spin' aria-hidden />
                                                    Starting…
                                                </>
                                            :   "Start scraping"}
                                        </Button>
                                        <p className='text-xs text-muted-foreground'>
                                            Needs a validated CSV and a non-empty job name. Runs the Playwright worker on this machine
                                            (not on Vercel serverless).
                                        </p>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        <div className='grid gap-4 md:grid-cols-4'>
                            <Card size='sm'>
                                <CardHeader className='border-b'>
                                    <CardTitle>Progress</CardTitle>
                                    <CardDescription>{total ? `${pct}% complete` : "No CSV loaded"}</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className='mt-1 text-2xl font-semibold'>
                                        {done}/{total}
                                    </div>
                                    <p className='text-xs text-muted-foreground'>Succeeded + failed out of total</p>
                                </CardContent>
                            </Card>
                            <Card size='sm'>
                                <CardHeader className='border-b'>
                                    <CardTitle>Running</CardTitle>
                                    <CardDescription>Active workers</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className='mt-1 text-2xl font-semibold'>{running}</div>
                                    <p className='text-xs text-muted-foreground'>Tickets currently being scraped</p>
                                </CardContent>
                            </Card>
                            <Card size='sm'>
                                <CardHeader className='border-b'>
                                    <CardTitle>Queued</CardTitle>
                                    <CardDescription>Ready from CSV</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className='mt-1 text-2xl font-semibold'>{queued}</div>
                                    <p className='text-xs text-muted-foreground'>Validated rows waiting to start</p>
                                </CardContent>
                            </Card>
                            <Card size='sm'>
                                <CardHeader className='border-b'>
                                    <CardTitle>Blocked</CardTitle>
                                    <CardDescription>Rate-limit / CAPTCHA</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className='mt-1 text-2xl font-semibold'>{blocked}</div>
                                    <p className='text-xs text-muted-foreground'>Backoff or manual review</p>
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>

                    <TabsContent value='results' className='space-y-4'>
                        <Card>
                            <CardHeader className='border-b'>
                                <CardTitle>Scrape results</CardTitle>
                                <CardDescription>
                                    All completed lines from Supabase archive, plus live per-line state from the worker over SSE
                                    (initiating, searching, scraping, scraping complete).
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <HomeResultsTable />
                            </CardContent>
                            <CardFooter className='justify-between'>
                                <p className='text-xs text-muted-foreground'>
                                    Worker prints <code className='rounded bg-muted px-1'>job_started</code> JSON with{" "}
                                    <code className='rounded bg-muted px-1'>ssePath</code> for this app origin.
                                </p>
                                <div className='flex items-center gap-2'>
                                    <Button variant='outline' type='button' disabled>
                                        Export CSV
                                    </Button>
                                    <Button variant='outline' type='button' disabled>
                                        Export JSON
                                    </Button>
                                </div>
                            </CardFooter>
                        </Card>
                    </TabsContent>
                </Tabs>
            </main>
        </div>
    );
}
