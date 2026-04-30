/**
 * Long-running HTTP entrypoint for Render (or any host).
 * Vercel calls POST /run with Bearer WORKER_WEBHOOK_SECRET; this process spawns
 * the same Playwright script as local `npm run worker:va-gdcourts`.
 *
 * Start: npx tsx scripts/render-scrape-webhook.ts
 * Render: set PORT, WORKER_WEBHOOK_SECRET, Supabase env + Playwright browsers (see Dockerfile.scrape).
 */

import { randomUUID, timingSafeEqual } from "node:crypto"
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import http from "node:http"
import Papa from "papaparse"

const SECRET = process.env.WORKER_WEBHOOK_SECRET?.trim()
const PORT = Number(process.env.PORT || 8787)

type Row = { firstName: string; lastName: string; court: string; type: "civil" | "traffic/criminal" }

function verifyBearer(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("Bearer ")) return false
  const token = header.slice(7)
  const a = Buffer.from(token, "utf8")
  const b = Buffer.from(secret, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function parseBody(raw: string): { job_id: string; name: string; rows: Row[] } | null {
  let data: unknown
  try {
    data = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!data || typeof data !== "object") return null
  const o = data as Record<string, unknown>
  const job_id = typeof o.job_id === "string" ? o.job_id : typeof o.jobId === "string" ? o.jobId : ""
  const name = typeof o.name === "string" ? o.name.trim() : ""
  const rows = o.rows
  if (!job_id || !name || !Array.isArray(rows) || rows.length === 0 || rows.length > 500) return null
  const out: Row[] = []
  for (const r of rows) {
    if (!r || typeof r !== "object") return null
    const row = r as Record<string, unknown>
    const firstName = typeof row.firstName === "string" ? row.firstName : ""
    const lastName = typeof row.lastName === "string" ? row.lastName : ""
    const court = typeof row.court === "string" ? row.court : ""
    const type = row.type
    if (type !== "civil" && type !== "traffic/criminal") return null
    if (!firstName.trim() || !lastName.trim() || !court.trim()) return null
    out.push({ firstName: firstName.trim(), lastName: lastName.trim(), court: court.trim(), type })
  }
  return { job_id, name: name.slice(0, 200), rows: out }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c as Buffer))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true, service: "render-scrape-webhook" }))
    return
  }

  if (req.method !== "POST" || req.url !== "/run") {
    res.writeHead(404).end()
    return
  }

  if (!SECRET) {
    res.writeHead(503, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "WORKER_WEBHOOK_SECRET is not set" }))
    return
  }

  if (!verifyBearer(req.headers.authorization, SECRET)) {
    res.writeHead(401).end("Unauthorized")
    return
  }

  const raw = await readBody(req)
  const body = parseBody(raw)
  if (!body) {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "Invalid body: expect job_id, name, rows (max 500)" }))
    return
  }

  const stamp = randomUUID()
  const csvPath = join(tmpdir(), `va-gdcourts-${stamp}.csv`)
  const outPath = join(tmpdir(), `va-gdcourts-${stamp}.json`)
  const csv = Papa.unparse(body.rows)
  writeFileSync(csvPath, csv, "utf8")

  const cwd = process.cwd()
  const scriptPath = join(cwd, "scripts", "va-gdcourts-scrape.playwright.ts")
  const args = ["tsx", scriptPath, "--csv", csvPath, "--name", body.name, "--job-id", body.job_id, outPath]

  try {
    const child = spawn("npx", args, {
      cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    })
    child.unref()
    child.on("error", () => {})
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    res.writeHead(500, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: msg }))
    return
  }

  res.writeHead(202, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ ok: true, job_id: body.job_id }))
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[render-scrape-webhook] listening on 0.0.0.0:${PORT}`)
})
