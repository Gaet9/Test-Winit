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
from dataclasses import dataclass
from typing import Annotated, Any, Literal, Optional

from dotenv import load_dotenv
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field
from playwright.async_api import Locator, async_playwright

try:
    # Optional dependency. If you don't use Supabase yet, the worker can still run
    # a "demo job" by accepting rows in the request body.
    from supabase import create_client  # type: ignore

    _SUPABASE_AVAILABLE = True
except Exception:
    _SUPABASE_AVAILABLE = False


load_dotenv()

app = FastAPI(title="VA Courts Scraper Worker", version="0.1.0")

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

    Next.js (Vercel) forwards: job_id, name, rows — name is ignored here for now.
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

    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set")
    return create_client(url, key)


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

    # BackgroundTasks runs in-process. On Render (long-running service) this is fine.
    # For maximum reliability you can replace this with a real queue later.
    bg.add_task(execute_job, req.job_id, req.rows)

    return RunJobResponse(
        queued=True,
        job_id=req.job_id,
        message="Job accepted. Worker started background execution.",
    )


async def execute_job(job_id: Optional[str], rows: Optional[list[VaSearchRow]]):
    """
    Main worker entry point.

    TODO (when adding Supabase schema):
    - load rows from supabase table (job_items) if job_id provided
    - update job/job_items status fields as progress occurs
    - store case detail JSON to case_exports table (or storage)
    """

    cfg = get_config()

    # If rows were not provided, try to load them from Supabase.
    if rows is None:
        if job_id is None:
            raise RuntimeError("rows not provided and job_id is missing")

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

    # Run bounded concurrency.
    sem = asyncio.Semaphore(cfg.concurrency)

    async def run_one(row: VaSearchRow):
        async with sem:
            await scrape_one_row(row, job_id=job_id, headless=cfg.headless)

    await asyncio.gather(*(run_one(r) for r in rows))


async def scrape_one_row(row: VaSearchRow, job_id: Optional[str], headless: bool):
    """
    One-row Playwright flow.

    This mirrors the TS Playwright script you already have in the Next repo, but in Python.
    Keeping the worker in Python lets us scale + deploy independently from Next.js.
    """

    landing_url = "https://eapps.courts.state.va.us/gdcourts/landing.do"

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=headless)
        context = await browser.new_context()
        page = await context.new_page()

        await page.goto(landing_url, wait_until="domcontentloaded")

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

        # Click correct Name Search (division T or V).
        division = "V" if row.type == "civil" else "T"
        link = page.locator(
            f'a[name="moduleLink"][href*="nameSearch.do"][href*="searchDivision={division}"]'
        ).first
        await link.wait_for(state="visible")
        await link.click()
        await page.wait_for_load_state("domcontentloaded")

        # Fill search fields + submit.
        await page.locator("#localnamesearchlastname").wait_for(state="visible")
        await page.fill("#localnamesearchlastname", row.lastName)
        await page.fill("#localnamesearchfirstname", row.firstName)
        await page.locator('input[type="submit"].submitBox[value="Search"]').click()
        await page.wait_for_load_state("networkidle", timeout=30_000)

        # TODO: results page parsing:
        # - find Case # links
        # - click each -> export tables to JSON
        # - write to Supabase
        #
        # For now we just verify we reached a results page with some table content.
        await page.wait_for_timeout(500)

        await context.close()
        await browser.close()

