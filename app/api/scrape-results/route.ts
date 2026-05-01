import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import {
  fetchArchivedResultLines,
  fetchLatestWorkerScrapeRun,
  getLatestActiveJob,
} from "@/lib/scrape-results-query"

export async function GET() {
  const supabase = createSupabaseAdminClient()
  if (!supabase) {
    return Response.json({
      archive: [],
      activeJob: null,
      configured: false,
    })
  }

  const [archive, activeJob, latestRun] = await Promise.all([
    fetchArchivedResultLines(supabase),
    getLatestActiveJob(supabase),
    fetchLatestWorkerScrapeRun(supabase),
  ])

  return Response.json({
    archive,
    activeJob,
    latestRun,
    configured: true,
  })
}
