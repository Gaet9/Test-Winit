import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import {
  fetchArchivedResultLines,
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

  const [archive, activeJob] = await Promise.all([
    fetchArchivedResultLines(supabase),
    getLatestActiveJob(supabase),
  ])

  return Response.json({
    archive,
    activeJob,
    configured: true,
  })
}
