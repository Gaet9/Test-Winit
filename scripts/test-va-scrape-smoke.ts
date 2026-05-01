/**
 * Smoke-test the VA GDC scrape in a real Chromium instance (headless by default).
 *
 *   npx tsx scripts/test-va-scrape-smoke.ts
 *   PLAYWRIGHT_HEADED=1 npx tsx scripts/test-va-scrape-smoke.ts
 *   npx tsx scripts/test-va-scrape-smoke.ts path/to/file.csv
 *
 * Uses the same `runVaGdcourtsFlow` as production. Optional: `node --env-file=.env.local` for Supabase progress.
 */

import path from "node:path";

import { loadVaRowsFromCsvPath, runVaGdcourtsFlow, type VaSearchRow } from "./va-gdcourts-scrape.playwright";

const DEFAULT_ROW: VaSearchRow = {
    firstName: "JESUS",
    lastName: "PARRA",
    court: "Accomack General District Court",
    type: "traffic/criminal",
};

async function main() {
    const csvArg = process.argv.find((a, i) => i >= 2 && !a.startsWith("-"));
    let rows: VaSearchRow[];
    if (csvArg) {
        const p = path.resolve(csvArg);
        rows = loadVaRowsFromCsvPath(p);
        if (rows.length > 3) {
            console.log(`[smoke] Using first 3 of ${rows.length} rows from CSV`);
            rows = rows.slice(0, 3);
        }
    } else {
        rows = [DEFAULT_ROW];
        console.log("[smoke] No CSV path: using built-in sample row (override with a .csv path)");
    }

    const headed = process.env.PLAYWRIGHT_HEADED === "1" || process.env.VA_SCRAPE_HEADED === "1" || process.env.HEADED === "1";
    console.log(`[smoke] rows=${rows.length} headless=${!headed}`);
    if (!headed) {
        console.log("[smoke] headed: npm run test:va-scrape:headed   OR   PowerShell: $env:PLAYWRIGHT_HEADED='1'; npm run test:va-scrape");
    }

    const exports = await runVaGdcourtsFlow(rows);

    for (let i = 0; i < exports.length; i++) {
        const ex = exports[i];
        const summary = {
            line: i + 1,
            name: `${ex.row.lastName}, ${ex.row.firstName}`,
            cases: ex.cases.length,
            tablesPerCase: ex.cases.map((c) => c.tables?.length ?? 0),
        };
        console.log("[smoke] result:", JSON.stringify(summary));
    }
    console.log("[smoke] OK");
}

main().catch((e) => {
    console.error("[smoke] FAILED:", e);
    process.exit(1);
});
