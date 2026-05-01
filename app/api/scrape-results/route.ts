import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import {
  fetchLatestWorkerScrapeRun,
  fetchScrapeArchiveBundle,
  getLatestActiveJob,
} from "@/lib/scrape-results-query"

export async function GET() {
  const supabase = createSupabaseAdminClient()
  if (!supabase) {
    return Response.json({
      archive: [],
      archiveRuns: [],
      activeJob: null,
      latestRun: null,
      configured: false,
    })
  }

  const [bundle, activeJob, latestRun] = await Promise.all([
    fetchScrapeArchiveBundle(supabase),
    getLatestActiveJob(supabase),
    fetchLatestWorkerScrapeRun(supabase),
  ])

  return Response.json({
    archive: bundle.lines,
    archiveRuns: bundle.runs,
    activeJob,
    latestRun,
    configured: true,
  })
}
