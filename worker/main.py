"""
FastAPI worker service for the Winit technical test.

Why a separate worker?
- Running Playwright for 10k CSV rows is long-running and resource-heavy.
- Vercel/Next serverless runtimes are not ideal for browser automation jobs.

This worker is meant to be deployed as a long-running web service (e.g. Render).
The Next.js app can:
1) validate/normalize CSV in the UI
2) create a Job in Supabase (recommended)
3) call this worker with a job_id to execute scraping
4) stream progress to the dashboard (SSE) by reading job state from Supabase
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated, Any, Literal, Optional

from dotenv import load_dotenv
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field
from playwright.async_api import Locator, Page, async_playwright

try:
    # Optional dependency. If you don't use Supabase yet, the worker can still run
    # a "demo job" by accepting rows in the request body.
    from supabase import create_client  # type: ignore

    _SUPABASE_AVAILABLE = True
except Exception:
    _SUPABASE_AVAILABLE = False


load_dotenv()

app = FastAPI(title="VA Courts Scraper Worker", version="0.1.0")


def wl(msg: str) -> None:
    """Worker log: flush both streams so Render / Docker always show lines."""
    line = f"[va-worker] {msg}\n"
    sys.stdout.write(line)
    sys.stdout.flush()
    sys.stderr.write(line)
    sys.stderr.flush()

SearchType = Literal["civil", "traffic/criminal"]


class VaSearchRow(BaseModel):
    firstName: str = Field(min_length=1)
    lastName: str = Field(min_length=1)
    court: str = Field(min_length=1)
    type: SearchType


class RunJobRequest(BaseModel):
    """
    Preferred mode:
      - pass job_id, the worker loads rows from Supabase.

    Demo mode (no DB):
      - pass rows directly (useful while wiring the system).

    Next.js (Vercel) forwards: job_id, name, rows — `name` is used for the worker_scrape_runs archive row.
    """

    model_config = ConfigDict(extra="ignore")

    job_id: Optional[str] = None
    name: Optional[str] = None
    rows: Optional[list[VaSearchRow]] = None


class RunJobResponse(BaseModel):
    queued: bool
    job_id: Optional[str] = None
    message: str


@dataclass(frozen=True)
class WorkerConfig:
    concurrency: int
    headless: bool


async def safe_is_visible(loc: Locator) -> bool:
    """Playwright-Python has no .catch(); use try/except like the TS .catch(() => false) pattern."""
    try:
        return await loc.is_visible()
    except Exception:
        return False


def get_config() -> WorkerConfig:
    concurrency = int(os.getenv("WORKER_CONCURRENCY", "3"))
    headless = os.getenv("WORKER_HEADLESS", "true").lower() != "false"
    return WorkerConfig(concurrency=max(1, concurrency), headless=headless)


def get_supabase():
    """
    Create a Supabase client using service role key.
    This should only run in the worker (server-side).
    """

    if not _SUPABASE_AVAILABLE:
        raise RuntimeError("supabase python client not installed")

    url = (os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").strip()
    key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL, plus SUPABASE_SERVICE_ROLE_KEY, must be set"
        )
    return create_client(url, key)


# Same table serialization as scripts/va-gdcourts-scrape.playwright.ts exportAllTablesOnPage
_EXPORT_TABLES_JS = r"""() => {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  function guessTitle(table) {
    const prev = table.closest("td")?.previousElementSibling;
    const t1 = prev ? norm(prev.textContent) : "";
    if (t1) return t1;
    const headerTd = table.querySelector("td.subheader, td.pageheader, th");
    const t2 = headerTd ? norm(headerTd.textContent) : "";
    return t2 || undefined;
  }
  const tables = Array.from(document.querySelectorAll("table")).filter((t) => {
    const rect = t.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  return tables.map((t) => {
    const title = guessTitle(t);
    const ths = Array.from(t.querySelectorAll("tr th")).map((th) => norm(th.textContent));
    const headers = ths.length > 0 ? ths : undefined;
    const rows = Array.from(t.querySelectorAll("tr")).map((tr) => {
      const cells = Array.from(tr.querySelectorAll("th,td")).map((td) => norm(td.textContent));
      return cells.filter((c) => c !== "");
    });
    return { title, headers, rows: rows.filter((r) => r.length > 0) };
  });
}"""


async def list_case_link_locators(page: Page) -> list[Locator]:
    """Case # style links on the results grid (aligned with TS listCaseLinks)."""
    candidates = page.locator("a").filter(has_text=re.compile(r"[A-Z]{1,4}\d{2,}"))
    n = await candidates.count()
    return [candidates.nth(i) for i in range(n)]


async def export_all_tables_on_page(page: Page) -> list[dict[str, Any]]:
    raw = await page.evaluate(_EXPORT_TABLES_JS)
    return list(raw) if isinstance(raw, list) else []


async def back_to_results(page: Page) -> None:
    back_btn = page.locator('input[type="submit"][value="Back to Search Results"]')
    if await safe_is_visible(back_btn):
        await back_btn.click()
        await page.wait_for_load_state("domcontentloaded")
        return
    await page.go_back()
    await page.wait_for_load_state("domcontentloaded")


def persist_worker_scrape_run(name: str, line_count: int, results: list[dict[str, Any]]) -> None:
    """Append one archive row set for the Next.js Results tab (worker_scrape_runs)."""
    if not _SUPABASE_AVAILABLE:
        wl("persist_worker_scrape_run skipped: supabase package not installed")
        return
    url = (os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").strip()
    key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not url or not key:
        wl("persist_worker_scrape_run skipped: no Supabase URL/key — set SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY")
        return
    sb = create_client(url, key)
    now = datetime.now(timezone.utc)
    row = {
        "name": name,
        "run_date": now.date().isoformat(),
        "processed_at": now.isoformat(),
        "line_count": line_count,
        "results": results,
    }
    sb.table("worker_scrape_runs").insert(row).execute()
    wl(f"persist_worker_scrape_run inserted name={name!r} export_lines={line_count} case_blocks={len(results)}")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "supabase": _SUPABASE_AVAILABLE}


_bearer = HTTPBearer(auto_error=False)


def require_webhook_secret(
    creds: Annotated[Optional[HTTPAuthorizationCredentials], Depends(_bearer)],
) -> None:
    secret = os.getenv("WORKER_WEBHOOK_SECRET", "").strip()
    if not secret:
        return
    token = creds.credentials if creds and creds.scheme.lower() == "bearer" else ""
    if token != secret:
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.post("/run", response_model=RunJobResponse)
async def run(
    req: RunJobRequest,
    bg: BackgroundTasks,
    _: Annotated[None, Depends(require_webhook_secret)],
) -> RunJobResponse:
    """
    Queue a scraping job.

    In production:
    - This endpoint should *only enqueue* work (or start a background task)
      and return immediately.
    - Job state should be written to Supabase so the Next.js app can stream it via SSE.

    If WORKER_WEBHOOK_SECRET is set, require Authorization: Bearer <secret>.
    """

    if not req.job_id and not req.rows:
        raise HTTPException(
            status_code=400,
            detail="Provide either job_id (preferred) or rows (demo mode).",
        )

    n = len(req.rows) if req.rows else 0
    wl(f"POST /run queued job_id={req.job_id!r} inline_rows={n}")

    # BackgroundTasks runs in-process. On Render (long-running service) this is fine.
    # For maximum reliability you can replace this with a real queue later.
    bg.add_task(execute_job, req.job_id, req.rows, req.name)

    return RunJobResponse(
        queued=True,
        job_id=req.job_id,
        message="Job accepted. Worker started background execution.",
    )


async def execute_job(
    job_id: Optional[str],
    rows: Optional[list[VaSearchRow]],
    run_name: Optional[str] = None,
):
    """
    Main worker entry point.

    TODO (when adding Supabase schema):
    - load rows from supabase table (job_items) if job_id provided
    - update job/job_items status fields as progress occurs
    - store case detail JSON to case_exports table (or storage)
    """

    cfg = get_config()
    archive_name = (run_name or "").strip() or (f"job-{job_id[:8]}" if job_id else "va-python-worker")
    wl(
        f"execute_job start job_id={job_id!r} archive_name={archive_name!r} rows_param_is_none={rows is None} "
        "(live job % on Vercel still needs the Node worker + worker_scrape_jobs updates; this worker writes worker_scrape_runs when Supabase is configured.)"
    )

    # If rows were not provided, try to load them from Supabase.
    if rows is None:
        if job_id is None:
            msg = "execute_job: no rows and no job_id"
            wl(msg)
            raise RuntimeError(msg)

        wl("execute_job loading rows from Supabase table job_items …")
        sb = get_supabase()
        # Placeholder schema assumption:
        # - table: job_items
        # - columns: job_id, first_name, last_name, court, type
        #
        # If your schema differs, update here.
        resp = sb.table("job_items").select("*").eq("job_id", job_id).execute()
        data = resp.data or []
        rows = [
            VaSearchRow(
                firstName=str(r.get("first_name") or r.get("firstName") or "").strip(),
                lastName=str(r.get("last_name") or r.get("lastName") or "").strip(),
                court=str(r.get("court") or "").strip(),
                type=str(r.get("type") or "").strip(),  # type: ignore[arg-type]
            )
            for r in data
        ]
        wl(f"execute_job loaded {len(rows)} row(s) from job_items")

    assert rows is not None
    if len(rows) == 0:
        msg = (
            "execute_job: 0 rows to scrape. "
            "Vercel must send a non-empty `rows` array, or load rows from `job_items` for this job_id, "
            "or use the Node Dockerfile.scrape worker."
        )
        wl(msg)
        raise RuntimeError(msg)

    wl(f"execute_job running {len(rows)} line(s) concurrency={cfg.concurrency} headless={cfg.headless}")

    # Run bounded concurrency.
    sem = asyncio.Semaphore(cfg.concurrency)

    async def run_one(row: VaSearchRow) -> dict[str, Any]:
        label = f"{row.lastName}, {row.firstName} · {row.court}"
        wl(f"line START {label}")
        try:
            async with sem:
                export_block = await scrape_one_row(row, job_id=job_id, headless=cfg.headless)
        except Exception as e:
            wl(f"line FAIL {label}: {type(e).__name__}: {e}")
            raise
        wl(f"line OK   {label} cases={len(export_block.get('cases') or [])}")
        return export_block

    try:
        exports = await asyncio.gather(*(run_one(r) for r in rows))
        wl(f"execute_job scrape OK job_id={job_id!r} lines={len(rows)} export_blocks={len(exports)}")
        try:
            persist_worker_scrape_run(archive_name, len(exports), list(exports))
        except Exception as pe:
            wl(f"execute_job persist_worker_scrape_run FAILED: {pe!r}")
            traceback.print_exc()
            raise
        wl(f"execute_job finished OK job_id={job_id!r} lines={len(rows)}")
    except Exception:
        wl("execute_job FAILED (full traceback on stderr, then re-raised for uvicorn)")
        traceback.print_exc()
        raise


async def scrape_one_row(row: VaSearchRow, job_id: Optional[str], headless: bool) -> dict[str, Any]:
    """
    One-row Playwright flow + case detail table export (aligned with TS va-gdcourts-scrape).

    Returns one JSON-serializable block for `worker_scrape_runs.results` (array of these).
    """

    landing_url = "https://eapps.courts.state.va.us/gdcourts/landing.do"
    label = f"{row.lastName}, {row.firstName} · {row.court} ({row.type})"
    item: dict[str, Any] = {
        "row": row.model_dump(),
        "searchedAt": datetime.now(timezone.utc).isoformat(),
        "cases": [],
    }

    async with async_playwright() as p:
        wl(f"scrape playwright START {label}")
        browser = await p.chromium.launch(headless=headless)
        context = await browser.new_context()
        page = await context.new_page()

        await page.goto(landing_url, wait_until="domcontentloaded")
        wl(f"scrape landed {label}")

        # Optional "accept" step (best-effort).
        for sel in [
            'button:has-text("Accept")',
            'button:has-text("I Agree")',
            'a:has-text("Accept")',
            'a:has-text("I Agree")',
            'input[type="submit"][value*="Accept" i]',
        ]:
            loc = page.locator(sel).first
            if await safe_is_visible(loc):
                await loc.click()
                await page.wait_for_load_state("domcontentloaded")
                break

        # Select court autocomplete (#txtcourts1).
        court_input = page.locator("#txtcourts1")
        await court_input.wait_for(state="visible")
        await court_input.fill("")
        await court_input.type(row.court, delay=20)

        # Try to click a suggestion; otherwise press Enter.
        menu = page.locator(".ui-autocomplete:visible, ul.ui-menu:visible").first
        if await safe_is_visible(menu):
            opt = menu.locator("li").filter(has_text=row.court).first
            if await safe_is_visible(opt):
                await opt.click()
            else:
                await menu.locator("li").first.click()
        else:
            await page.keyboard.press("Enter")

        # jQuery UI leaves the court autocomplete <ul> open; it intercepts clicks on sidebar links.
        await court_input.evaluate("e => e.blur()")
        await page.keyboard.press("Escape")
        overlay = page.locator("ul.ui-autocomplete.ui-menu:visible, ul.ui-menu.ui-widget:visible").first
        if await safe_is_visible(overlay):
            await page.keyboard.press("Escape")
            try:
                await overlay.wait_for(state="hidden", timeout=5_000)
            except Exception:
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(400)

        # Click correct Name Search (division T or V).
        division = "V" if row.type == "civil" else "T"
        link = page.locator(
            f'a[name="moduleLink"][href*="nameSearch.do"][href*="searchDivision={division}"]'
        ).first
        await link.wait_for(state="visible")
        try:
            await link.click(timeout=15_000)
        except Exception:
            wl(f"scrape name-search click retry force=True {label}")
            await link.click(force=True, timeout=15_000)
        await page.wait_for_load_state("domcontentloaded")
        wl(f"scrape name-search page loaded {label}")

        # Fill search fields + submit.
        await page.locator("#localnamesearchlastname").wait_for(state="visible")
        await page.fill("#localnamesearchlastname", row.lastName)
        await page.fill("#localnamesearchfirstname", row.firstName)
        await page.locator('input[type="submit"].submitBox[value="Search"]').click()
        await page.wait_for_load_state("networkidle", timeout=30_000)
        try:
            title = await page.title()
            wl(
                f"scrape post-search url={page.url()[:200]!r} title={title[:80]!r}… "
                f"(if stuck next, check captcha / zero results / wrong court) {label}"
            )
        except Exception as e:
            wl(f"scrape post-search (could not read title/url): {e!r} {label}")

        initial_links = await list_case_link_locators(page)
        n_case = len(initial_links)
        wl(f"scrape results: {n_case} case link(s) {label}")
        for i in range(n_case):
            fresh = await list_case_link_locators(page)
            if i >= len(fresh):
                wl(f"scrape case loop stop: index {i} no longer present {label}")
                break
            link_loc = fresh[i]
            case_id_text = ((await link_loc.text_content()) or "").strip() or None
            await link_loc.click()
            await page.wait_for_load_state("domcontentloaded")
            try:
                await page.wait_for_load_state("networkidle", timeout=30_000)
            except Exception:
                pass
            tables = await export_all_tables_on_page(page)
            wl(f"scrape case {i + 1}/{n_case} tables={len(tables)} id={case_id_text!r} {label}")
            item["cases"].append(
                {
                    "caseIndex": i,
                    "caseIdText": case_id_text,
                    "url": page.url(),
                    "exportedAt": datetime.now(timezone.utc).isoformat(),
                    "tables": tables,
                }
            )
            await back_to_results(page)
            try:
                await page.wait_for_load_state("networkidle", timeout=30_000)
            except Exception:
                pass

        await context.close()
        await browser.close()
        wl(f"scrape playwright END {label} exported_cases={len(item['cases'])}")
    return item

