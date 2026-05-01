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
import threading
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


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _complete_worker_scrape_job_sync(sb: Any, job_id: str) -> None:
    sb.table("worker_scrape_jobs").update(
        {
            "state": "scraping_complete",
            "detail_message": "Scraping complete",
            "progress_pct": 100,
            "completed_at": iso_now(),
            "updated_at": iso_now(),
        }
    ).eq("id", job_id).execute()


def _fail_worker_scrape_job_sync(sb: Any, job_id: str, message: str) -> None:
    sb.table("worker_scrape_jobs").update(
        {
            "state": "failed",
            "detail_message": "Job failed",
            "error_message": message[:4000],
            "completed_at": iso_now(),
            "updated_at": iso_now(),
        }
    ).eq("id", job_id).execute()


def _patch_worker_scrape_job_line_sync(
    sb: Any,
    job_id: str,
    line_idx_0: int,
    line_no: int,
    line_patch: dict[str, Any],
    job_patch: dict[str, Any],
) -> None:
    r = sb.table("worker_scrape_jobs").select("lines_state").eq("id", job_id).single().execute()
    raw = (r.data or {}).get("lines_state")
    existing: list[Any] = list(raw) if isinstance(raw, list) else []
    lines: list[dict[str, Any]] = []
    for x in existing:
        lines.append(dict(x) if isinstance(x, dict) else {})
    while len(lines) <= line_idx_0:
        k = len(lines)
        lines.append(
            {
                "lineIndex": k + 1,
                "state": "queued",
                "message": "",
                "progress_pct": 0,
                "updated_at": iso_now(),
            }
        )
    cur = lines[line_idx_0]
    merged = {**cur, **line_patch, "updated_at": iso_now()}
    merged.setdefault("lineIndex", line_no)
    lines[line_idx_0] = merged
    top: dict[str, Any] = {"lines_state": lines, "updated_at": iso_now(), **job_patch}
    sb.table("worker_scrape_jobs").update(top).eq("id", job_id).execute()


async def patch_worker_scrape_job_line(
    sb: Any,
    lock: asyncio.Lock,
    job_id: str,
    line_idx_0: int,
    line_no: int,
    line_patch: dict[str, Any],
    job_patch: dict[str, Any],
) -> None:
    if sb is None or not job_id:
        return

    def _run() -> None:
        _patch_worker_scrape_job_line_sync(sb, job_id, line_idx_0, line_no, line_patch, job_patch)

    async with lock:
        await asyncio.to_thread(_run)


async def patch_worker_scrape_job_simple(sb: Any, lock: asyncio.Lock, job_id: str, patch: dict[str, Any]) -> None:
    if sb is None or not job_id:
        return

    def _run() -> None:
        row = {**patch, "updated_at": iso_now()}
        sb.table("worker_scrape_jobs").update(row).eq("id", job_id).execute()

    async with lock:
        await asyncio.to_thread(_run)


@app.get("/")
def root() -> dict[str, Any]:
    """Render / uptime checks often hit `/`; avoid 404 noise."""
    return {"ok": True, "service": "va-worker", "health": "/health", "run": "POST /run"}


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "supabase": _SUPABASE_AVAILABLE}


_bearer = HTTPBearer(auto_error=False)

# Same-process duplicate POST /run (e.g. double Vercel invoke). Does not coordinate across multiple worker replicas.
_job_flight = threading.Lock()
_job_ids_running: set[str] = set()


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

    jid = (req.job_id or "").strip()
    if jid:
        with _job_flight:
            if jid in _job_ids_running:
                wl(f"POST /run duplicate ignored job_id={jid!r} (already running)")
                return RunJobResponse(
                    queued=True,
                    job_id=jid,
                    message="Job already running (duplicate request ignored).",
                )
            _job_ids_running.add(jid)

    async def _execute_with_cleanup() -> None:
        try:
            await execute_job(req.job_id, req.rows, req.name)
        finally:
            if jid:
                with _job_flight:
                    _job_ids_running.discard(jid)

    # BackgroundTasks runs in-process. On Render (long-running service) this is fine.
    bg.add_task(_execute_with_cleanup)

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
        f"execute_job start job_id={job_id!r} archive_name={archive_name!r} rows_param_is_none={rows is None}"
    )

    sb: Any = None
    job_lock = asyncio.Lock()
    if job_id and _SUPABASE_AVAILABLE:
        try:
            sb = get_supabase()
        except Exception as e:
            wl(f"execute_job: Supabase client unavailable (job progress + archive may be limited): {e!r}")

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
        if sb is None and _SUPABASE_AVAILABLE:
            try:
                sb = get_supabase()
            except Exception as e:
                wl(f"execute_job: could not init Supabase after job_items load: {e!r}")

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

    total_lines = len(rows)
    if sb and job_id:
        await patch_worker_scrape_job_simple(
            sb,
            job_lock,
            job_id,
            {
                "state": "running",
                "detail_message": f"Scraping {total_lines} line(s) on Python worker…",
            },
        )

    # Run bounded concurrency.
    sem = asyncio.Semaphore(cfg.concurrency)

    async def run_one(row: VaSearchRow, line_idx_0: int) -> dict[str, Any]:
        label = f"{row.lastName}, {row.firstName} · {row.court}"
        wl(f"line START {label}")
        try:
            async with sem:
                export_block = await scrape_one_row(
                    row,
                    job_id=job_id,
                    headless=cfg.headless,
                    job_lock=job_lock,
                    line_idx_0=line_idx_0,
                    total_lines=total_lines,
                    sb=sb,
                )
        except Exception as e:
            wl(f"line FAIL {label}: {type(e).__name__}: {e}")
            raise
        wl(f"line OK   {label} cases={len(export_block.get('cases') or [])}")
        return export_block

    try:
        exports = await asyncio.gather(*(run_one(r, i) for i, r in enumerate(rows)))
        wl(f"execute_job scrape OK job_id={job_id!r} lines={len(rows)} export_blocks={len(exports)}")
        try:
            persist_worker_scrape_run(archive_name, len(exports), list(exports))
        except Exception as pe:
            wl(f"execute_job persist_worker_scrape_run FAILED: {pe!r}")
            traceback.print_exc()
            raise
        if sb and job_id:
            try:
                await asyncio.to_thread(_complete_worker_scrape_job_sync, sb, job_id)
            except Exception as ce:
                wl(f"execute_job: worker_scrape_jobs complete update failed: {ce!r}")
        wl(f"execute_job finished OK job_id={job_id!r} lines={len(rows)}")
    except Exception as e:
        wl("execute_job FAILED (full traceback on stderr, then re-raised for uvicorn)")
        traceback.print_exc()
        if sb and job_id:
            msg = f"{type(e).__name__}: {e}"
            try:
                await asyncio.to_thread(_fail_worker_scrape_job_sync, sb, job_id, msg)
            except Exception as fe:
                wl(f"execute_job: failed to write worker_scrape_jobs failure row: {fe!r}")
        raise


async def scrape_one_row(
    row: VaSearchRow,
    job_id: Optional[str],
    headless: bool,
    *,
    job_lock: asyncio.Lock,
    line_idx_0: int = 0,
    total_lines: int = 1,
    sb: Any = None,
) -> dict[str, Any]:
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

    line_no = line_idx_0 + 1
    tl = max(total_lines, 1)
    base_overall = round((line_idx_0 / tl) * 100)
    if job_id and sb is not None:
        await patch_worker_scrape_job_line(
            sb,
            job_lock,
            job_id,
            line_idx_0,
            line_no,
            {
                "lineIndex": line_no,
                "state": "searching",
                "message": f"Searching: {row.lastName}, {row.firstName} · {row.court}",
                "progress_pct": base_overall,
            },
            {
                "state": "searching",
                "detail_message": f"Searching line {line_no} of {total_lines}",
                "progress_pct": base_overall,
            },
        )

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
                f"scrape post-search url={page.url[:200]!r} title={title[:80]!r}… "
                f"(if stuck next, check captcha / zero results / wrong court) {label}"
            )
        except Exception as e:
            wl(f"scrape post-search (could not read title/url): {e!r} {label}")

        initial_links = await list_case_link_locators(page)
        n_case = len(initial_links)
        wl(f"scrape results: {n_case} case link(s) {label}")
        link_count = max(n_case, 1)
        for i in range(n_case):
            fresh = await list_case_link_locators(page)
            if i >= len(fresh):
                wl(f"scrape case loop stop: index {i} no longer present {label}")
                break
            link_loc = fresh[i]
            case_id_text = ((await link_loc.text_content()) or "").strip() or None
            intra = (i + 1) / link_count
            overall = min(99, round(((line_idx_0 + intra) / tl) * 100))
            if job_id and sb is not None:
                await patch_worker_scrape_job_line(
                    sb,
                    job_lock,
                    job_id,
                    line_idx_0,
                    line_no,
                    {
                        "lineIndex": line_no,
                        "state": "scraping",
                        "message": f"Scraping line {line_no} (case {i + 1} of {n_case})",
                        "progress_pct": overall,
                    },
                    {
                        "state": "scraping",
                        "detail_message": f"Scraping line {line_no} (case {i + 1})",
                        "progress_pct": overall,
                    },
                )
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
                    "url": page.url,
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
    line_done_pct = round(((line_idx_0 + 1) / tl) * 100)
    if job_id and sb is not None:
        await patch_worker_scrape_job_line(
            sb,
            job_lock,
            job_id,
            line_idx_0,
            line_no,
            {
                "lineIndex": line_no,
                "state": "scraping_complete",
                "message": f"Line {line_no} complete ({len(item['cases'])} case(s))",
                "progress_pct": 100,
            },
            {
                "state": "running",
                "detail_message": f"Finished line {line_no} of {total_lines}",
                "progress_pct": line_done_pct,
            },
        )
    return item

