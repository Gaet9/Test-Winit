/**
 * VA General District Court (GDC) name-search scraping flow (Playwright).
 *
 * This script is intentionally verbose + commented for the technical test.
 * The app will eventually call the same logic from a server-side job runner,
 * while streaming SSE progress events to the dashboard.
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

import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Page } from "playwright"

type SearchType = "civil" | "traffic/criminal"

export type VaSearchRow = {
  firstName: string
  lastName: string
  court: string
  type: SearchType
}

type CaseExport = {
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

type ExportedTable = {
  title?: string
  headers?: string[]
  rows: string[][]
}

const LANDING_URL = "https://eapps.courts.state.va.us/gdcourts/landing.do"

function isCivil(type: SearchType): boolean {
  return type === "civil"
}

async function maybeAcceptDisclaimer(page: Page) {
  // Some environments show a disclaimer/accept gate. We handle it defensively:
  // - Try common "Accept" / "I Agree" buttons/links
  // - If not found, proceed without failing
  const acceptCandidates = [
    page.getByRole("button", { name: /accept|i\s*agree|agree/i }),
    page.getByRole("link", { name: /accept|i\s*agree|agree/i }),
    page.locator('input[type="submit"][value*="Accept" i]'),
    page.locator('button:has-text("Accept")'),
    page.locator('a:has-text("Accept")'),
  ]

  for (const loc of acceptCandidates) {
    if (await loc.first().isVisible().catch(() => false)) {
      await loc.first().click()
      await page.waitForLoadState("domcontentloaded")
      return
    }
  }
}

async function selectCourt(page: Page, courtName: string) {
  // Autocomplete input provided by the site:
  // <input type="text" ... id="txtcourts1" class="ui-autocomplete-input" ...>
  const input = page.locator("#txtcourts1")
  await input.waitFor({ state: "visible" })

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

async function exportAllTablesOnPage(page: Page): Promise<ExportedTable[]> {
  // The case detail page is table-heavy. For a robust “export everything” approach,
  // we serialize ALL visible <table> elements into:
  // - optional title (from nearby headers)
  // - headers (first row of <th>)
  // - rows (all <tr> cells as text)
  return await page.evaluate(() => {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim()

    function guessTitle(table: HTMLTableElement): string | undefined {
      // Try: closest preceding element that looks like a section header.
      const prev = table.closest("td")?.previousElementSibling
      const t1 = prev ? norm(prev.textContent ?? "") : ""
      if (t1) return t1
      const headerTd = table.querySelector("td.subheader, td.pageheader, th")
      const t2 = headerTd ? norm(headerTd.textContent ?? "") : ""
      return t2 || undefined
    }

    const tables = Array.from(document.querySelectorAll("table")).filter((t) => {
      const rect = (t as HTMLElement).getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })

    return tables.map((t) => {
      const table = t as HTMLTableElement
      const title = guessTitle(table)

      const ths = Array.from(table.querySelectorAll("tr th")).map((th) => norm(th.textContent ?? ""))
      const headers = ths.length > 0 ? ths : undefined

      const rows = Array.from(table.querySelectorAll("tr")).map((tr) => {
        const cells = Array.from(tr.querySelectorAll("th,td")).map((td) => norm(td.textContent ?? ""))
        return cells.filter((c) => c !== "")
      })

      return { title, headers, rows: rows.filter((r) => r.length > 0) }
    })
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

export async function runVaGdcourtsFlow(rows: VaSearchRow[], outFile: string) {
  const browser = await chromium.launch({
    headless: true,
  })

  const context = await browser.newContext()
  const page = await context.newPage()

  const exports: CaseExport[] = []

  for (const row of rows) {
    const item: CaseExport = {
      row,
      searchedAt: new Date().toISOString(),
      cases: [],
    }

    await page.goto(LANDING_URL, { waitUntil: "domcontentloaded" })
    await maybeAcceptDisclaimer(page)
    await selectCourt(page, row.court)
    await clickNameSearch(page, row.type)
    await submitNameSearch(page, row)

    // After submitting, the results page should contain clickable case links.
    const links = await listCaseLinks(page)

    for (let i = 0; i < links.length; i++) {
      // Re-acquire the locator list each time because the DOM can change after navigation.
      const freshLinks = await listCaseLinks(page)
      const link = freshLinks[i]?.locator
      if (!link) break

      const caseIdText = (await link.textContent().catch(() => null))?.trim() ?? undefined
      await link.click()
      await page.waitForLoadState("domcontentloaded")
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {})

      const tables = await exportAllTablesOnPage(page)
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

    exports.push(item)
  }

  await browser.close()

  const outDir = path.dirname(outFile)
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(outFile, JSON.stringify(exports, null, 2), "utf8")
}

/**
 * CLI usage:
 *   node --loader ts-node/esm scripts/va-gdcourts-scrape.playwright.ts out.json
 *
 * For the technical test, you’ll likely invoke `runVaGdcourtsFlow()` from an API
 * route / background job using the parsed CSV rows, then stream SSE.
 */
async function main() {
  // This file focuses on the browser flow. To keep it standalone, we accept a minimal
  // inline demo dataset if no job runner is wired yet.
  const outFile = process.argv[2] ?? "output/va-gdcourts-export.json"

  const demoRows: VaSearchRow[] = [
    { firstName: "JOHN", lastName: "DOE", court: "Accomack", type: "traffic/criminal" },
  ]

  await runVaGdcourtsFlow(demoRows, outFile)
}

// Allow importing from the app without auto-running.
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main()
}

