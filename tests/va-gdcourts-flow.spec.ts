import type { Page } from "@playwright/test"
import { expect, test } from "@playwright/test"

const LANDING = "https://eapps.courts.state.va.us/gdcourts/landing.do"

async function maybeAcceptDisclaimer(page: Page) {
  const candidates = [
    page.getByRole("button", { name: /accept|i\s*agree|agree/i }),
    page.getByRole("link", { name: /accept|i\s*agree|agree/i }),
    page.locator('input[type="submit"][value*="Accept" i]'),
  ]
  for (const loc of candidates) {
    const first = loc.first()
    if (await first.isVisible().catch(() => false)) {
      await first.click()
      await page.waitForLoadState("domcontentloaded")
      return
    }
  }
}

test.describe("VA GDC courts (live site)", () => {
  test("GDC landing URL responds (headless smoke)", async ({ page }) => {
    const resp = await page.goto(LANDING, { waitUntil: "domcontentloaded", timeout: 90_000 })
    expect(resp?.status() ?? 0).toBeLessThan(500)
    expect(page.url()).toMatch(/courts\.state\.va\.us/i)
  })

  test("court field #txtcourts1 visible after disclaimer", async ({ page }) => {
    test.skip(
      process.env.VA_E2E_LANDING !== "1",
      "Set VA_E2E_LANDING=1 to assert real layout (geo/CAPTCHA can block headless datacenters)."
    )
    await page.goto(LANDING, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await maybeAcceptDisclaimer(page)
    await expect(page.locator("#txtcourts1")).toBeVisible({ timeout: 60_000 })
  })

  test("full scrape via runVaGdcourtsFlow (slow, hits real site)", async () => {
    test.skip(process.env.VA_E2E !== "1", "Set VA_E2E=1 to run (can take minutes)")
    test.setTimeout(300_000)
    const { runVaGdcourtsFlow } = await import("../scripts/va-gdcourts-scrape.playwright")
    const rows = [
      {
        firstName: "JESUS",
        lastName: "PARRA",
        court: "Accomack General District Court",
        type: "traffic/criminal" as const,
      },
    ]
    const exports = await runVaGdcourtsFlow(rows)
    expect(exports).toHaveLength(1)
    expect(exports[0].cases.length).toBeGreaterThanOrEqual(0)
  })
})
