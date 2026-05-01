import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import {
  fetchLatestWorkerScrapeRun,
  fetchScrapeArchiveBundle,
  getLatestActiveJob,
} from "@/lib/scrape-results-query"

function decodeCursor(raw: string | null): { processed_at: string; id: string } | null {
  if (!raw) return null
  try {
    const json = Buffer.from(raw, "base64").toString("utf8")
    const v = JSON.parse(json) as { processed_at?: unknown; id?: unknown }
    if (typeof v.processed_at !== "string" || typeof v.id !== "string") return null
    return { processed_at: v.processed_at, id: v.id }
  } catch {
    return null
  }
}

function encodeCursor(v: { processed_at: string; id: string } | null): string | null {
  if (!v) return null
  return Buffer.from(JSON.stringify(v), "utf8").toString("base64")
}

export async function GET(req: Request) {
  const supabase = createSupabaseAdminClient()
  if (!supabase) {
    return Response.json({
      archive: [],
      archiveRuns: [],
      nextCursor: null,
      activeJob: null,
      latestRun: null,
      configured: false,
    })
  }

  const url = new URL(req.url)
  const limitRaw = url.searchParams.get("limit")
  const limit = Math.max(1, Math.min(200, Number(limitRaw ?? "20") || 20))
  const cursor = decodeCursor(url.searchParams.get("cursor"))

  const [bundle, activeJob, latestRun] = await Promise.all([
    fetchScrapeArchiveBundle(supabase, { runLimit: limit, cursor }),
    getLatestActiveJob(supabase),
    fetchLatestWorkerScrapeRun(supabase),
  ])

  return Response.json({
    archive: bundle.lines,
    archiveRuns: bundle.runs,
    nextCursor: encodeCursor(bundle.nextCursor),
    activeJob,
    latestRun,
    configured: true,
  })
}
