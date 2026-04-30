"use client"

import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

type TicketStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked_rate_limit"
  | "blocked_captcha"

type TicketRow = {
  ticketId: string
  status: TicketStatus
  updatedAt: string
  message?: string
}

const STATUS_BADGE: Record<TicketStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> =
  {
    queued: { label: "Queued", variant: "secondary" },
    running: { label: "Running", variant: "outline" },
    succeeded: { label: "Succeeded", variant: "default" },
    failed: { label: "Failed", variant: "destructive" },
    blocked_rate_limit: { label: "Rate-limited", variant: "destructive" },
    blocked_captcha: { label: "CAPTCHA", variant: "destructive" },
  }

function formatPct(done: number, total: number) {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

export default function Home() {
  const [jobName, setJobName] = React.useState("DMV Summons Check — Upload 1")
  const [rows] = React.useState<TicketRow[]>([
    {
      ticketId: "NYC-0001349912",
      status: "succeeded",
      updatedAt: "just now",
      message: "Summons found. Balance: $115",
    },
    {
      ticketId: "NYC-0001349913",
      status: "running",
      updatedAt: "2s ago",
      message: "Fetching DMV record…",
    },
    {
      ticketId: "NYC-0001349914",
      status: "queued",
      updatedAt: "—",
      message: "Waiting for available worker slot",
    },
    {
      ticketId: "NYC-0001349915",
      status: "blocked_rate_limit",
      updatedAt: "10s ago",
      message: "429 detected. Backing off before retry.",
    },
    {
      ticketId: "NYC-0001349916",
      status: "blocked_captcha",
      updatedAt: "14s ago",
      message: "Challenge page detected (mock allowed).",
    },
  ])

  const total = rows.length
  const done = rows.filter((r) => r.status === "succeeded" || r.status === "failed").length
  const running = rows.filter((r) => r.status === "running").length
  const queued = rows.filter((r) => r.status === "queued").length
  const blocked = rows.filter((r) => r.status === "blocked_rate_limit" || r.status === "blocked_captcha").length
  const pct = formatPct(done, total)

  return (
    <div className="min-h-full flex flex-col bg-background">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-semibold">Parking Summons Monitor</h1>
              <Badge variant="secondary">Winit test</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Upload a CSV of ticket IDs, scrape DMV asynchronously, and stream progress in real-time.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline">View jobs</Button>
            <Button>New run</Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <Tabs defaultValue="dashboard" className="gap-4">
          <TabsList>
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="results">Results</TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard" className="space-y-4">
            <Card>
              <CardHeader className="border-b">
                <CardTitle>Run setup</CardTitle>
                <CardDescription>Provide a name and upload a CSV with ticket IDs.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="md:col-span-2">
                    <label className="text-sm font-medium">Job name</label>
                    <div className="mt-1">
                      <Input value={jobName} onChange={(e) => setJobName(e.target.value)} />
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium">CSV file</label>
                    <div className="mt-1">
                      <Input type="file" accept=".csv" />
                    </div>
                  </div>
                </div>
                <Separator />
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-muted-foreground">
                    This page is a UI scaffold. Next step: connect upload → job creation → SSE stream.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button variant="outline">Validate CSV</Button>
                    <Button>Start scraping</Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-4 md:grid-cols-4">
              <Card size="sm">
                <CardHeader className="border-b">
                  <CardTitle>Progress</CardTitle>
                  <CardDescription>{pct}% complete</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="mt-1 text-2xl font-semibold">
                    {done}/{total}
                  </div>
                  <p className="text-xs text-muted-foreground">Succeeded + failed out of total</p>
                </CardContent>
              </Card>
              <Card size="sm">
                <CardHeader className="border-b">
                  <CardTitle>Running</CardTitle>
                  <CardDescription>Active workers</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="mt-1 text-2xl font-semibold">{running}</div>
                  <p className="text-xs text-muted-foreground">Tickets currently being scraped</p>
                </CardContent>
              </Card>
              <Card size="sm">
                <CardHeader className="border-b">
                  <CardTitle>Queued</CardTitle>
                  <CardDescription>Waiting</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="mt-1 text-2xl font-semibold">{queued}</div>
                  <p className="text-xs text-muted-foreground">Pending tickets to start</p>
                </CardContent>
              </Card>
              <Card size="sm">
                <CardHeader className="border-b">
                  <CardTitle>Blocked</CardTitle>
                  <CardDescription>Rate-limit / CAPTCHA</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="mt-1 text-2xl font-semibold">{blocked}</div>
                  <p className="text-xs text-muted-foreground">Backoff or mock allowed</p>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="results" className="space-y-4">
            <Card>
              <CardHeader className="border-b">
                <CardTitle>Live ticket status</CardTitle>
                <CardDescription>
                  This table will update via SSE as each ticket progresses through the pipeline.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableCaption>Example rows (placeholder data).</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ticket ID</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Updated</TableHead>
                      <TableHead>Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.ticketId}>
                        <TableCell className="font-medium">{r.ticketId}</TableCell>
                        <TableCell>
                          <Badge variant={STATUS_BADGE[r.status].variant}>
                            {STATUS_BADGE[r.status].label}
                          </Badge>
                        </TableCell>
                        <TableCell>{r.updatedAt}</TableCell>
                        <TableCell className="max-w-[420px] truncate text-muted-foreground">
                          {r.message ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
              <CardFooter className="justify-between">
                <p className="text-xs text-muted-foreground">
                  Next: add “Export CSV”, filtering, and a per-ticket details drawer.
                </p>
                <div className="flex items-center gap-2">
                  <Button variant="outline">Export CSV</Button>
                  <Button variant="outline">Export JSON</Button>
                </div>
              </CardFooter>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}
