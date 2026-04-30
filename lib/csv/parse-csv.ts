import Papa from "papaparse"

/**
 * CSV contract for this technical test.
 *
 * Required columns (header row):
 * - first name
 * - last name
 * - court
 * - type
 *
 * Notes:
 * - This parser is tolerant to header formatting differences:
 *   "First Name", "first_name", "firstname" all map to `firstName`.
 * - Values are trimmed; empty rows are skipped.
 * - The returned objects are normalized for the scraper step.
 */

export type SearchType = "civil" | "traffic/criminal"

export type CsvRow = {
  firstName: string
  lastName: string
  court: string
  type: SearchType
}

type CsvParseOk = { ok: true; rows: CsvRow[] }
type CsvParseErr = { ok: false; error: string }

export type CsvParseResult = CsvParseOk | CsvParseErr

const REQUIRED_CANONICAL_HEADERS = ["firstname", "lastname", "court", "type"] as const

function canonicalizeHeader(header: string): string {
  // Normalize header names so the UI can accept "First Name", "first_name", etc.
  return header
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/g, "")
    .replaceAll(/[_-]+/g, "")
}

function toSearchType(raw: string): SearchType | null {
  const v = raw.trim().toLowerCase()
  if (v === "civil") return "civil"
  if (v === "traffic/criminal") return "traffic/criminal"
  if (v === "traffic" || v === "criminal" || v === "trafficcriminal") return "traffic/criminal"
  if (v === "t") return "traffic/criminal"
  if (v === "v") return "civil"
  return null
}

/**
 * Parse and validate a CSV file selected in the browser.
 * Intended usage: call this when the user clicks "Validate CSV".
 */
export async function parseAndValidateCsvFile(file: File): Promise<CsvParseResult> {
  const text = await file.text()

  // PapaParse returns `data` as an array of objects when `header: true`.
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => canonicalizeHeader(h),
  })

  if (parsed.errors.length > 0) {
    const first = parsed.errors[0]
    return {
      ok: false,
      error: `CSV parse error at row ${first.row ?? "?"}: ${first.message}`,
    }
  }

  // Ensure the header contains the required columns.
  const fields = (parsed.meta.fields ?? []).map((f) => canonicalizeHeader(f))
  const missing = REQUIRED_CANONICAL_HEADERS.filter((req) => !fields.includes(req))
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `Missing required column(s): ${missing.join(", ")}. ` +
        `Expected headers: first name, last name, court, type.`,
    }
  }

  const rows: CsvRow[] = []

  for (let i = 0; i < parsed.data.length; i++) {
    const raw = parsed.data[i] ?? {}

    // Because we normalized the headers via `transformHeader`, we can safely look up
    // the canonical keys here.
    const firstName = String(raw.firstname ?? "").trim()
    const lastName = String(raw.lastname ?? "").trim()
    const court = String(raw.court ?? "").trim()
    const typeRaw = String(raw.type ?? "").trim()

    // Skip completely empty rows (a common CSV artifact).
    if (!firstName && !lastName && !court && !typeRaw) continue

    // Validate each required value; report row index using CSV-friendly 1-based display.
    const rowDisplay = i + 2 // +1 for 0-based index, +1 because header is row 1
    if (!firstName) return { ok: false, error: `Row ${rowDisplay}: "first name" is required.` }
    if (!lastName) return { ok: false, error: `Row ${rowDisplay}: "last name" is required.` }
    if (!court) return { ok: false, error: `Row ${rowDisplay}: "court" is required.` }

    const type = toSearchType(typeRaw)
    if (!type) {
      return {
        ok: false,
        error:
          `Row ${rowDisplay}: invalid "type" value "${typeRaw}". ` +
          `Allowed: "civil" or "traffic/criminal".`,
      }
    }

    rows.push({ firstName, lastName, court, type })
  }

  if (rows.length === 0) {
    return { ok: false, error: "CSV contains no data rows." }
  }

  return { ok: true, rows }
}

