import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Papa from "papaparse"
import { z } from "zod"

import { insertScrapeJob, failScrapeJob } from "@/lib/scrape-job-worker"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"

const rowSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  court: z.string(),
  type: z.enum(["civil", "traffic/criminal"]),
})

const bodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  rows: z.array(rowSchema).min(1).max(500),
})

function remoteWorkerBaseUrl(): string | null {
  const raw = process.env.RENDER_WORKER_URL?.trim()
  if (!raw) return null
  return raw.replace(/\/$/, "")
}

function hasRemoteWorker(): boolean {
  return !!(remoteWorkerBaseUrl() && process.env.WORKER_WEBHOOK_SECRET?.trim())
}

async function forwardToRemoteWorker(jobId: string, name: string, rows: z.infer<typeof bodySchema>["rows"]) {
  const base = remoteWorkerBaseUrl()!
  const secret = process.env.WORKER_WEBHOOK_SECRET!.trim()
  const res = await fetch(`${base}/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ job_id: jobId, name, rows }),
    signal: AbortSignal.timeout(45_000),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Worker HTTP ${res.status}: ${text.slice(0, 800)}`)
  }
}

export async function POST(req: Request) {
  let json: unknown
  try {
    json = await req.json()
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { name, rows } = parsed.data

  if (process.env.VERCEL && !hasRemoteWorker()) {
    return Response.json(
      {
        error:
          "Vercel cannot run Playwright here. Set RENDER_WORKER_URL (e.g. https://your-service.onrender.com) and WORKER_WEBHOOK_SECRET on Vercel to forward jobs to a Render worker, or run `npm run dev` locally.",
      },
      { status: 501 }
    )
  }

  const supabase = createSupabaseAdminClient()
  if (!supabase) {
    return Response.json(
      { error: "Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)." },
      { status: 503 }
    )
  }

  let jobId: string
  try {
    jobId = await insertScrapeJob(supabase, name, rows.length)
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }

  if (hasRemoteWorker()) {
    try {
      await forwardToRemoteWorker(jobId, name, rows)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      try {
        await failScrapeJob(supabase, jobId, msg)
      } catch {
        // ignore
      }
      return Response.json({ error: msg }, { status: 502 })
    }
    return Response.json({ jobId, ssePath: `/api/scrape-jobs/${jobId}/sse` })
  }

  const stamp = randomUUID()
  const csvPath = join(tmpdir(), `va-gdcourts-${stamp}.csv`)
  const outPath = join(tmpdir(), `va-gdcourts-${stamp}.json`)
  const csv = Papa.unparse(
    rows.map((r) => ({
      firstName: r.firstName,
      lastName: r.lastName,
      court: r.court,
      type: r.type,
    }))
  )
  writeFileSync(csvPath, csv, "utf8")

  const scriptPath = join(process.cwd(), "scripts", "va-gdcourts-scrape.playwright.ts")
  const args = ["tsx", scriptPath, "--csv", csvPath, "--name", name, "--job-id", jobId, outPath]

  try {
    const child = spawn("npx", args, {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    })
    child.on("error", async (err) => {
      try {
        await failScrapeJob(supabase, jobId, `Worker failed to start: ${err.message}`)
      } catch {
        // ignore secondary failures
      }
    })
    child.unref()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    try {
      await failScrapeJob(supabase, jobId, `Failed to spawn worker: ${msg}`)
    } catch {
      // ignore
    }
    return Response.json({ error: msg }, { status: 500 })
  }

  return Response.json({ jobId, ssePath: `/api/scrape-jobs/${jobId}/sse` })
}
