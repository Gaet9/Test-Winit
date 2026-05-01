/**
 * VA General District Court (GDC) name-search scraping flow (Playwright).
 *
 * This script is intentionally verbose + commented for the technical test.
 * The app will eventually call the same logic from a server-side job runner,
 * while streaming SSE progress events to the web UI.
 *
 * Target site:
 *   https://eapps.courts.state.va.us/gdcourts/landing.do
 *
 * Flow per CSV row:
 * 1) Open landing page
 * 2) If there is a pre-landing "Accept" step, click it
 * 3) Select the court via the autocomplete input (txtcourts1)
 * 4) Click the correct "Name Search" link based on row.type:
 *    - traffic/criminal -> searchDivision=T
 *    - civil            -> searchDivision=V
 * 5) Fill last name + first name
 * 6) Submit Search and wait for results table
 * 7) For each Case # link:
 *    - open case detail
 *    - export the page tables into JSON
 *    - go back to results
 */

import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createClient } from "@supabase/supabase-js"
import Papa from "papaparse"
import { chromium, type Page } from "playwright"

import {
  averageLineProgressPct,
  buildInitialLineStates,
  completeScrapeJob,
  failScrapeJob,
  insertScrapeJob,
  updateScrapeJob,
} from "@/lib/scrape-job-worker"
import { resolveSupabaseProjectUrl, resolveSupabaseServiceRoleKey } from "@/lib/supabase/worker-env"
import type { LineProgressState } from "@/types/scrape-result-line"

type SearchType = "civil" | "traffic/criminal"

export type VaSearchRow = {
  firstName: string
  lastName: string
  court: string
  type: SearchType
}

export type CaseExport = {
  row: VaSearchRow
  searchedAt: string
  cases: Array<{
    caseIndex: number
    caseIdText?: string
    url: string
    exportedAt: string
    tables: ExportedTable[]
  }>
}

/** One section of case detail (VA GDC uses label/value grid cells). */
type ExportedTable = {
  title?: string
  fields: Array<{ label: string; value: string }>
}

const LANDING_URL = "https://eapps.courts.state.va.us/gdcourts/landing.do"

function isCivil(type: SearchType): boolean {
  return type === "civil"
}

async function maybeAcceptDisclaimer(page: Page) {
  // Some environments show a disclaimer/accept gate. We handle it defensively:
  // - Try common "Accept" / "I Agree" buttons/links
  // - If not found, proceed without failing
  const nameRe = /accept|i\s*agree|agree|continue|submit|i\s*accept|acknowledge|proceed/i
  const acceptCandidates = [
    page.getByRole("button", { name: nameRe }),
    page.getByRole("link", { name: nameRe }),
    page.locator('input[type="submit"][value*="Accept" i]'),
    page.locator('input[type="submit"][value*="Agree" i]'),
    page.locator('input[type="button"][value*="Accept" i]'),
    page.locator('button:has-text("Accept")'),
    page.locator('a:has-text("Accept")'),
    page.locator("a:has-text(\"I Agree\")"),
    page.locator("button:has-text(\"Continue\")"),
  ]

  for (let round = 0; round < 3; round++) {
    for (const loc of acceptCandidates) {
      if (await loc.first().isVisible().catch(() => false)) {
        await loc.first().click()
        await page.waitForLoadState("domcontentloaded")
        await page.waitForTimeout(600)
        return
      }
    }
    await page.waitForTimeout(700)
  }
}

async function selectCourt(page: Page, courtName: string) {
  // Autocomplete input provided by the site:
  // <input type="text" ... id="txtcourts1" class="ui-autocomplete-input" ...>
  const input = page.locator("#txtcourts1")
  const courtWaitMs = Number(process.env.VA_COURT_INPUT_TIMEOUT_MS ?? 90_000)
  await input.waitFor({ state: "visible", timeout: courtWaitMs })

  await input.fill("")
  await input.type(courtName, { delay: 20 })

  // jQuery UI autocomplete usually renders a listbox. We try to pick the best match.
  const list = page.locator(".ui-autocomplete:visible, ul.ui-menu:visible").first()
  const option = list.locator("li").filter({ hasText: courtName }).first()

  if (await list.isVisible().catch(() => false)) {
    if (await option.isVisible().catch(() => false)) {
      await option.click()
    } else {
      // Fallback: choose the first suggestion.
      await list.locator("li").first().click()
    }
  } else {
    // Fallback: accept typed value.
    await page.keyboard.press("Enter")
  }
}

async function clickNameSearch(page: Page, type: SearchType) {
  // The app shows two "Name Search" links with different query params:
  // - traffic/criminal => searchDivision=T
  // - civil            => searchDivision=V
  const division = isCivil(type) ? "V" : "T"
  const link = page.locator(`a[name="moduleLink"][href*="nameSearch.do"][href*="searchDivision=${division}"]`)

  await link.first().waitFor({ state: "visible" })
  await link.first().click()
  await page.waitForLoadState("domcontentloaded")
}

async function submitNameSearch(page: Page, row: VaSearchRow) {
  // Inputs:
  //  - last name:  #localnamesearchlastname
  //  - first name: #localnamesearchfirstname
  await page.locator("#localnamesearchlastname").waitFor({ state: "visible" })
  await page.fill("#localnamesearchlastname", row.lastName)
  await page.fill("#localnamesearchfirstname", row.firstName)

  // Submit:
  // <input type="submit" class="submitBox" ... value="Search">
  const searchBtn = page.locator('input[type="submit"].submitBox[value="Search"]')
  await searchBtn.click()

  // Results take a couple seconds; wait for network idle + some table presence.
  await page.waitForLoadState("networkidle", { timeout: 30_000 })
}

async function listCaseLinks(page: Page) {
  // The results table has a "Case #" column; each row has a clickable cell/link.
  // We capture locators for links found in the results grid.
  //
  // We keep it flexible: pick anchors that look like case navigation links.
  const candidates = page.locator('a:visible').filter({ hasText: /[A-Z]{1,4}\d{2,}/ })
  const count = await candidates.count()
  const links: Array<{ index: number; locator: ReturnType<Page["locator"]> }> = []
  for (let i = 0; i < count; i++) links.push({ index: i, locator: candidates.nth(i) })
  return links
}

/**
 * Export only VA case-detail label/value pairs (e.g. td.labelgridtopleft + adjacent value cell).
 * Avoids dumping every decorative table cell into Supabase.
 */
async function exportCaseDetailLabelValues(page: Page): Promise<ExportedTable[]> {
  return await page.evaluate(() => {
    const norm = (s: string) =>
      String(s ?? "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim()

    function isLabelCell(el: Element): boolean {
      const cn = (el as HTMLElement).className
      return typeof cn === "string" && cn.includes("labelgrid")
    }

    function looksLikeAnotherLabelCell(el: Element | undefined): boolean {
      if (!el) return false
      if (!isLabelCell(el)) return false
      const t = norm(el.textContent ?? "")
      // On the VA pages, label cells typically end with ":" (or ": ").
      return /:\s*$/.test(t)
    }

    function pushField(labelRaw: string, valueRaw: string) {
      const label = norm(labelRaw).replace(/:\s*$/, "")
      const value = norm(valueRaw)
      if (!label || !value) return
      // Hard guards against noisy captures (navigation/script blobs).
      if (label.length > 60 || value.length > 200) return
      const bad = /function\s+\w+|\bvar\b|document\.getelementbyid|clientsearchcounter|name search|case number search|hearing date search|service\/process search/i
      if (bad.test(label) || bad.test(value)) return
      const k = `${label}\u0000${value}`
      if (seen.has(k)) return
      seen.add(k)
      mergedFields.push({ label, value })
    }

    const isCivilPage = /civil/i.test(document.body?.innerText ?? "")
    const labelLikeRe = /^[A-Za-z][A-Za-z0-9 /#()'".,-]{0,50}:\s*$/
    const inlinePairRe = /^([A-Za-z][A-Za-z0-9 /#()'".,-]{0,50}):\s*(.{1,120})$/

    const tables = Array.from(document.querySelectorAll("table")).filter((t) => {
      const rect = (t as HTMLElement).getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })

    // To keep Supabase payloads compact, we merge all extracted fields across all tables
    // into a single section and dedupe repeated label/value pairs.
    const mergedFields: Array<{ label: string; value: string }> = []
    const seen = new Set<string>()

    for (const t of tables) {
      const table = t as HTMLTableElement
      for (const tr of table.querySelectorAll("tr")) {
        const cells = Array.from(tr.querySelectorAll("td, th"))
        for (let i = 0; i < cells.length; i++) {
          const td = cells[i]
          const text = norm(td.textContent ?? "")

          // Primary: labelgrid layouts (traffic/criminal detail pages)
          if (isLabelCell(td)) {
            const rawLabel = text.replace(/:\s*$/, "")
            const next = cells[i + 1]
            const value = next && !looksLikeAnotherLabelCell(next) ? norm(next.textContent ?? "") : ""
            pushField(rawLabel, value)
            continue
          }

          // Fallback (civil only): look for compact label cells that end with ":" and read value from next cell.
          if (isCivilPage) {
            if (labelLikeRe.test(text)) {
              const next = cells[i + 1]
              pushField(text, norm(next?.textContent ?? ""))
              continue
            }
            // Or an inline "Label: Value" pair when both sides are small.
            const m = text.match(inlinePairRe)
            if (m) {
              pushField(m[1] ?? "", m[2] ?? "")
              continue
            }
          }
        }
      }
    }

    return mergedFields.length ? [{ title: "Case detail", fields: mergedFields }] : []
  })
}

async function backToResults(page: Page) {
  // The case detail page typically has:
  // <input ... value="Back to Search Results">
  const backBtn = page.locator('input[type="submit"][value="Back to Search Results"]')
  if (await backBtn.isVisible().catch(() => false)) {
    await backBtn.click()
    await page.waitForLoadState("domcontentloaded")
    return
  }

  // Fallback to browser history.
  await page.goBack()
  await page.waitForLoadState("domcontentloaded")
}

export type VaFlowProgressCtx = {
  supabase: SupabaseClient
  jobId: string
  totalLines: number
}

function playwrightHeadless(): boolean {
  const headed =
    process.env.PLAYWRIGHT_HEADED === "1" ||
    process.env.VA_SCRAPE_HEADED === "1" ||
    process.env.HEADED === "1"
  return !headed
}

export async function runVaGdcourtsFlow(
  rows: VaSearchRow[],
  progress?: VaFlowProgressCtx
): Promise<CaseExport[]> {
  const browser = await chromium.launch({
    headless: playwrightHeadless(),
    slowMo: playwrightHeadless() ? 0 : 150,
  })

  const context = await browser.newContext()
  const page = await context.newPage()

  const totalLines = rows.length
  let lineStates: LineProgressState[] | undefined
  if (progress) {
    lineStates = buildInitialLineStates(totalLines)
    await updateScrapeJob(progress.supabase, progress.jobId, {
      state: "initiating",
      detail_message: "Launching browser…",
      lines_state: lineStates,
      progress_pct: 0,
    })
    await updateScrapeJob(progress.supabase, progress.jobId, {
      detail_message: "Browser ready. Processing CSV lines…",
    })
  }

  const syncLine = async (
    lineIdx: number,
    linePatch: Partial<LineProgressState>,
    jobPatch: Record<string, unknown>
  ) => {
    if (!progress || !lineStates) return
    const now = new Date().toISOString()
    lineStates[lineIdx] = {
      ...lineStates[lineIdx],
      ...linePatch,
      updated_at: now,
    }
    // Disallow callers from setting job progress directly; overall is always computed as avg(line progress).
    const restJob = { ...(jobPatch as Record<string, unknown>) }
    delete (restJob as Record<string, unknown>).progress_pct
    await updateScrapeJob(progress.supabase, progress.jobId, {
      lines_state: lineStates,
      progress_pct: averageLineProgressPct(lineStates),
      ...restJob,
    })
  }

  const exports: CaseExport[] = []

  for (let lineIdx = 0; lineIdx < rows.length; lineIdx++) {
    const row = rows[lineIdx]
    const lineNo = lineIdx + 1
    await syncLine(
      lineIdx,
      {
        state: "searching",
        message: `Searching for line ${lineNo}`,
        progress_pct: 5,
      },
      {
        state: "searching",
        detail_message: `Searching for line ${lineNo}`,
      }
    )

    const item: CaseExport = {
      row,
      searchedAt: new Date().toISOString(),
      cases: [],
    }

    await page.goto(LANDING_URL, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForLoadState("domcontentloaded")
    await maybeAcceptDisclaimer(page)
    await maybeAcceptDisclaimer(page)
    await selectCourt(page, row.court)
    await clickNameSearch(page, row.type)
    await submitNameSearch(page, row)

    // After submitting, the results page should contain clickable case links.
    const links = await listCaseLinks(page)
    const linkCount = Math.max(links.length, 1)

    for (let i = 0; i < links.length; i++) {
      const linePct = Math.min(99, Math.round(15 + ((i + 1) / linkCount) * 80))
      await syncLine(
        lineIdx,
        {
          state: "scraping",
          message: `Scraping line ${lineNo} (case ${i + 1} of ${links.length})`,
          progress_pct: linePct,
        },
        {
          state: "scraping",
          detail_message: `Scraping line ${lineNo} (case ${i + 1})`,
        }
      )

      // Re-acquire the locator list each time because the DOM can change after navigation.
      const freshLinks = await listCaseLinks(page)
      const link = freshLinks[i]?.locator
      if (!link) break

      const caseIdText = (await link.textContent().catch(() => null))?.trim() ?? undefined
      await link.click()
      await page.waitForLoadState("domcontentloaded")
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {})

      const tables = await exportCaseDetailLabelValues(page)
      item.cases.push({
        caseIndex: i,
        caseIdText,
        url: page.url(),
        exportedAt: new Date().toISOString(),
        tables,
      })

      await backToResults(page)
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {})
    }

    await syncLine(
      lineIdx,
      {
        state: "scraping_complete",
        message: `Line ${lineNo} complete (${item.cases.length} case(s))`,
        progress_pct: 100,
        export: item,
      },
      {
        state: "running",
        detail_message: `Finished line ${lineNo} of ${totalLines}`,
      }
    )

    exports.push(item)
  }

  await browser.close()
  return exports
}

function parseSearchType(raw: string | undefined): SearchType {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "civil" || v === "v") return "civil"
  return "traffic/criminal"
}

export function loadVaRowsFromCsvPath(csvPath: string): VaSearchRow[] {
  const text = readFileSync(csvPath, "utf8")
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  })
  if (parsed.errors.length) {
    throw new Error(parsed.errors.map((e) => e.message).join("; "))
  }
  const rows: VaSearchRow[] = []
  for (const r of parsed.data) {
    const firstName = (r.firstName ?? r.firstname ?? "").trim()
    const lastName = (r.lastName ?? r.lastname ?? "").trim()
    const court = (r.court ?? "").trim()
    if (!firstName || !lastName || !court) continue
    rows.push({
      firstName,
      lastName,
      court,
      type: parseSearchType(r.type),
    })
  }
  if (!rows.length) {
    throw new Error(
      "CSV contained no valid rows (need firstName, lastName, court, type columns)."
    )
  }
  return rows
}

export async function persistWorkerScrapeRunToSupabase(options: {
  name: string
  lineCount: number
  results: CaseExport[]
  /** When set, replaces any prior archive row for this job so only one DB row holds all CSV lines. */
  scrapeJobId?: string
}) {
  const url = resolveSupabaseProjectUrl()
  const key = resolveSupabaseServiceRoleKey()
  if (!url || !key) {
    console.warn(
      "[worker] Supabase URL or service role key missing (set NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL, plus SUPABASE_SERVICE_ROLE_KEY); skip DB insert."
    )
    return
  }
  const supabase = createClient(url, key)
  const now = new Date()
  const scrapeJobId = options.scrapeJobId?.trim()
  if (scrapeJobId) {
    const { error: delErr } = await supabase.from("worker_scrape_runs").delete().eq("scrape_job_id", scrapeJobId)
    if (delErr) throw delErr
  }
  const row = {
    name: options.name,
    run_date: now.toISOString().slice(0, 10),
    processed_at: now.toISOString(),
    line_count: options.lineCount,
    results: options.results,
    ...(scrapeJobId ? { scrape_job_id: scrapeJobId } : {}),
  }
  const { error } = await supabase.from("worker_scrape_runs").insert(row)
  if (error) throw error
  console.log(
    "[worker] worker_scrape_runs row written:",
    options.name,
    scrapeJobId ? `(scrape_job_id=${scrapeJobId}, single row per job)` : "(no job id, append)"
  )
}

function parseCliArgs(argv: string[]) {
  let csvPath: string | undefined
  let name = "va-gdcourts"
  let outFile = "output/va-gdcourts-export.json"
  let skipSupabase = false
  let jobId: string | undefined
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--csv") {
      csvPath = argv[++i]
      continue
    }
    if (a === "--name") {
      name = argv[++i]
      continue
    }
    if (a === "--job-id") {
      jobId = argv[++i]
      continue
    }
    if (a === "--no-supabase") {
      skipSupabase = true
      continue
    }
    if (!a.startsWith("-")) {
      outFile = a
    }
  }
  return { csvPath, name, outFile, skipSupabase, jobId }
}

/**
 * CLI (load env from `.env.local` via Node 20+):
 *   node --env-file=.env.local ./node_modules/tsx/dist/cli.mjs scripts/va-gdcourts-scrape.playwright.ts --csv ./rows.csv --name "Batch 1" [--job-id <uuid>] ./out/export.json
 *
 * Or: `npm run worker:va-gdcourts -- --csv ./rows.csv --name "Batch 1"`
 * (set env in the shell first if not using --env-file).
 */
async function main() {
  const { csvPath, name, outFile, skipSupabase, jobId: existingJobId } = parseCliArgs(process.argv)
  if (!csvPath) {
    console.error(
      "Usage: npx tsx scripts/va-gdcourts-scrape.playwright.ts --csv <file.csv> [--name <job>] [--job-id <uuid>] [--no-supabase] [out.json]"
    )
    console.error("CSV columns: firstName, lastName, court, type (civil | traffic/criminal)")
    process.exit(1)
  }
  const rows = loadVaRowsFromCsvPath(csvPath)
  const url = resolveSupabaseProjectUrl()
  const key = resolveSupabaseServiceRoleKey()
  const supabase =
    !skipSupabase && url && key ? createClient(url, key) : null

  if (existingJobId && !supabase) {
    console.error(
      "[worker] --job-id was passed but Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY so job progress can update (otherwise the UI stays at 0%)."
    )
  }

  let jobId: string | undefined
  if (supabase) {
    if (existingJobId) {
      jobId = existingJobId
    } else {
      jobId = await insertScrapeJob(supabase, name, rows.length)
    }
    console.log(
      JSON.stringify({
        event: "job_started",
        jobId,
        ssePath: `/api/scrape-jobs/${jobId}/sse`,
      })
    )
  }

  let exports: CaseExport[]
  try {
    exports = await runVaGdcourtsFlow(
      rows,
      supabase && jobId
        ? { supabase, jobId, totalLines: rows.length }
        : undefined
    )
  } catch (e) {
    if (supabase && jobId) {
      await failScrapeJob(
        supabase,
        jobId,
        e instanceof Error ? e.message : String(e)
      )
    }
    throw e
  }

  const outDir = path.dirname(outFile)
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(outFile, JSON.stringify(exports, null, 2), "utf8")
  console.log("[worker] Wrote JSON:", path.resolve(outFile))

  if (supabase && jobId) {
    await completeScrapeJob(supabase, jobId)
  }
  if (!skipSupabase) {
    await persistWorkerScrapeRunToSupabase({
      name,
      lineCount: rows.length,
      results: exports,
      scrapeJobId: jobId,
    })
  }
}

// Allow importing from the app without auto-running.
if (require.main === module) {
  void main()
}

