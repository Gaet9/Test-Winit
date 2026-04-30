import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { fetchScrapeJobById } from "@/lib/scrape-results-query"

export const dynamic = "force-dynamic"

const TERMINAL = new Set(["scraping_complete", "failed"])

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  const supabase = createSupabaseAdminClient()
  if (!supabase) {
    return new Response("data: " + JSON.stringify({ error: "not_configured" }) + "\n\n", {
      status: 503,
      headers: sseHeaders(),
    })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
      }
      try {
        for (;;) {
          const job = await fetchScrapeJobById(supabase, id)
          if (!job) {
            send({ error: "not_found" })
            break
          }
          send(job)
          if (TERMINAL.has(job.state)) break
          await new Promise((r) => setTimeout(r, 1000))
        }
      } catch (e) {
        send({
          error: "stream_error",
          message: e instanceof Error ? e.message : String(e),
        })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, { headers: sseHeaders() })
}

function sseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  }
}
