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


# Same label/value extraction as scripts/va-gdcourts-scrape.playwright.ts exportCaseDetailLabelValues
_EXPORT_CASE_DETAIL_FIELDS_JS = r"""() => {
  const norm = (s) =>
    String(s ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  function guessTitle(table) {
    const prev = table.closest("td")?.previousElementSibling;
    const t1 = prev ? norm(prev.textContent) : "";
    if (t1) return t1;
    const headerTd = table.querySelector("td.subheader, td.pageheader, th");
    const t2 = headerTd ? norm(headerTd.textContent) : "";
    return t2 || undefined;
  }
  function isLabelCell(el) {
    const cn = el.className || "";
    return typeof cn === "string" && cn.includes("labelgrid");
  }
  function looksLikeAnotherLabelCell(el) {
    if (!el) return false;
    if (!isLabelCell(el)) return false;
    const t = norm(el.textContent || "");
    return /:\s*$/.test(t);
  }
  const tables = Array.from(document.querySelectorAll("table")).filter((t) => {
    const rect = t.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  // Keep payload compact: merge all label/value fields across all tables into one list.
  const fields = [];
  const seen = new Set();
  function pushField(labelRaw, valueRaw) {
    const label = norm(labelRaw).replace(/:\s*$/, "");
    const value = norm(valueRaw);
    if (!label || !value) return;
    if (label.length > 60 || value.length > 200) return;
    const bad = /function\s+\w+|\bvar\b|document\.getelementbyid|clientsearchcounter|name search|case number search|hearing date search|service\/process search/i;
    if (bad.test(label) || bad.test(value)) return;
    const k = `${label}\u0000${value}`;
    if (seen.has(k)) return;
    seen.add(k);
    fields.push({ label, value });
  }
  const isCivilPage = /civil/i.test(document.body?.innerText || "");
  const labelLikeRe = /^[A-Za-z][A-Za-z0-9 /#()'".,-]{0,50}:\s*$/;
  const inlinePairRe = /^([A-Za-z][A-Za-z0-9 /#()'".,-]{0,50}):\s*(.{1,120})$/;
  for (const table of tables) {
    for (const tr of table.querySelectorAll("tr")) {
      const cells = Array.from(tr.querySelectorAll("td, th"));
      for (let i = 0; i < cells.length; i++) {
        const td = cells[i];
        const text = norm(td.textContent || "");
        if (isLabelCell(td)) {
          const rawLabel = text.replace(/:\s*$/, "");
          const next = cells[i + 1];
          const value = next && !looksLikeAnotherLabelCell(next) ? norm(next.textContent) : "";
          pushField(rawLabel, value);
          continue;
        }
        if (isCivilPage) {
          if (labelLikeRe.test(text)) {
            const next = cells[i + 1];
            pushField(text, norm((next && next.textContent) || ""));
            continue;
          }
          const m = text.match(inlinePairRe);
          if (m) {
            pushField(m[1] || "", m[2] || "");
            continue;
          }
        }
      }
    }
  }
  return fields.length ? [{ title: "Case detail", fields }] : [];
}"""


async def list_case_link_locators(page: Page) -> list[Locator]:
    """Case # style links on the results grid (aligned with TS listCaseLinks)."""
    candidates = page.locator("a").filter(has_text=re.compile(r"[A-Z]{1,4}\d{2,}"))
    n = await candidates.count()
    return [candidates.nth(i) for i in range(n)]


async def export_all_tables_on_page(page: Page) -> list[dict[str, Any]]:
    raw = await page.evaluate(_EXPORT_CASE_DETAIL_FIELDS_JS)
    return list(raw) if isinstance(raw, list) else []


async def back_to_results(page: Page) -> None:
    back_btn = page.locator('input[type="submit"][value="Back to Search Results"]')
    if await safe_is_visible(back_btn):
        await back_btn.click()
        await page.wait_for_load_state("domcontentloaded")
        return
    await page.go_back()
    await page.wait_for_load_state("domcontentloaded")


def persist_worker_scrape_run(
    name: str,
    line_count: int,
    results: list[dict[str, Any]],
    scrape_job_id: Optional[str] = None,
) -> None:
    """
    Write one `worker_scrape_runs` row for the Next.js Results tab.

    When scrape_job_id is set (normal Vercel + Render flow), any previous archive row for that
    job is removed first so only a single row holds the full `results` array for all CSV lines.
    """
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
    dispute_analysis = analyze_dispute_eligibility_for_run(results, now=now)
    row: dict[str, Any] = {
        "name": name,
        "run_date": now.date().isoformat(),
        "processed_at": now.isoformat(),
        "line_count": line_count,
        "results": results,
        "dispute_analysis": dispute_analysis,
    }
    jid = (scrape_job_id or "").strip()
    if jid:
        sb.table("worker_scrape_runs").delete().eq("scrape_job_id", jid).execute()
        row["scrape_job_id"] = jid
        wl(f"persist_worker_scrape_run replace job_id={jid!r} name={name!r} export_lines={line_count}")
    sb.table("worker_scrape_runs").insert(row).execute()
    wl(
        f"persist_worker_scrape_run inserted name={name!r} export_lines={line_count} "
        f"case_blocks={len(results)} scrape_job_id={jid or '—'}"
    )


def _norm_key(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").strip().lower())


def _parse_date(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    raw = str(s).strip()
    if not raw:
        return None
    # ISO-ish first
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        pass
    # Common US formats
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
        except Exception:
            continue
    return None


def _pick_field(fields: list[dict[str, Any]], *label_keywords: str) -> Optional[str]:
    """
    Best-effort label lookup with preference for "closest" matches.

    We avoid overly generic keywords because the exported field list is long and
    substring matching can accidentally bind to the wrong label.
    """
    wants = [_norm_key(k) for k in label_keywords if k]
    wants = [w for w in wants if w]
    if not wants:
        return None

    # 1) Exact label match (normalized)
    for w in wants:
        for f in fields:
            lab = _norm_key(str(f.get("label") or ""))
            if lab == w:
                v = str(f.get("value") or "").strip()
                return v or None

    # 2) Substring match, prioritizing longer keywords
    wants_sorted = sorted(wants, key=len, reverse=True)
    for f in fields:
        lab = _norm_key(str(f.get("label") or ""))
        if not lab:
            continue
        for w in wants_sorted:
            if w and w in lab:
                v = str(f.get("value") or "").strip()
                return v or None
    return None


def analyze_dispute_eligibility_for_case(fields: list[dict[str, Any]], *, now: datetime) -> dict[str, Any]:
    # Extract relevant factors (best-effort; labels vary by jurisdiction).
    status = _pick_field(fields, "Case Status", "Status") or "Unknown"
    plea = _pick_field(fields, "Plea") or "Unknown"
    disposition = _pick_field(fields, "Final Disposition", "Disposition", "Judgment", "Result") or "Unknown"
    paid = _pick_field(fields, "Fine/Costs Paid", "Fine Paid", "Costs Paid", "Payment Status") or "Unknown"
    paid_date_raw = _pick_field(fields, "Fine/Costs Paid Date", "Paid Date", "Payment Date")
    appearance = _pick_field(fields, "Appearance", "Appeared", "Failure to Appear", "FTA") or "Unknown"
    case_type = _pick_field(fields, "Case Type") or "Unknown"
    jurisdiction = _pick_field(fields, "Jurisdiction") or "Unknown"
    hearing_date_raw = _pick_field(fields, "Hearing Date", "Court Date", "Trial Date", "Arraignment Date")
    judgment_date_raw = _pick_field(fields, "Disposition Date", "Judgment Date", "Finalized Date", "Sentenced Date")

    hearing_dt = _parse_date(hearing_date_raw)
    judgment_dt = _parse_date(judgment_date_raw) or _parse_date(paid_date_raw)

    status_l = str(status).lower()
    plea_l = str(plea).lower()
    disp_l = str(disposition).lower()
    paid_l = str(paid).lower()
    appearance_l = str(appearance).lower()

    # Data integrity flags (minimal for now; can be extended when we have explicit mismatch signals).
    data_flags: list[str] = []
    missing_critical = []
    for k, v in {
        "status": status,
        "plea": plea,
        "disposition": disposition,
        "hearing_date": hearing_date_raw,
        "judgment_date": judgment_date_raw,
        "payment": paid,
    }.items():
        if str(v).strip().lower() in ("", "unknown", "n/a", "na", "none", "null"):
            missing_critical.append(k)
    if missing_critical:
        data_flags.append(f"missing:{','.join(missing_critical)}")

    # Appeal window heuristic (default ~10 days).
    appeal_deadline_days = 10
    within_appeal = False
    appeal_window = "Unknown"
    if judgment_dt:
        delta_days = (now - judgment_dt).total_seconds() / 86400.0
        within_appeal = 0 <= delta_days <= appeal_deadline_days
        appeal_window = "within_deadline" if within_appeal else "outside_deadline"

    # Hearing timing.
    hearing_timing = "unknown"
    if hearing_dt:
        hearing_timing = "future" if now < hearing_dt else "past_or_today"

    # Classification rules (stricter, with clear precedence).
    classification = "CONDITIONALLY DISPUTABLE"
    confidence = "LOW"
    reasoning: list[str] = []

    def set_outcome(c: str, conf: str, *reasons: str) -> None:
        nonlocal classification, confidence, reasoning
        classification = c
        confidence = conf
        for r in reasons:
            if r:
                reasoning.append(r)

    # Signals
    paid_signal = any(x in paid_l for x in ("paid", "yes", "true", "prepaid"))
    guilty_signal = ("guilty" in plea_l) or ("guilty" in disp_l and "not guilty" not in disp_l)
    not_guilty_signal = "not guilty" in disp_l or "not guilty" in plea_l
    dismissed_signal = ("dismiss" in disp_l) or ("nolle" in disp_l) or ("prosequi" in disp_l)
    prepaid_signal = "prepaid" in disp_l
    certified_signal = "certified" in disp_l and "grand jury" in disp_l
    in_absentia_signal = "absentia" in disp_l
    missed_signal = (
        "miss" in appearance_l or "fta" in appearance_l or "failure" in appearance_l or in_absentia_signal
    )

    # 0) Outcomes with nothing to fight
    if dismissed_signal or not_guilty_signal:
        set_outcome(
            "NOT DISPUTABLE",
            "HIGH",
            "Final disposition indicates the matter was dismissed / not guilty (nothing to dispute).",
        )
    elif prepaid_signal:
        set_outcome(
            "NOT DISPUTABLE",
            "HIGH",
            "Disposition indicates the ticket was prepaid/accepted.",
        )

    # 1) Pending / before hearing => disputable (only if not already resolved)
    if classification != "NOT DISPUTABLE":
        if ("pending" in status_l) or ("open" in status_l) or ("active" in status_l):
            set_outcome("DISPUTABLE", "HIGH", "Case appears pending/open.")
        if hearing_dt and now < hearing_dt:
            set_outcome("DISPUTABLE", "HIGH", "Hearing date is in the future, so the case can still be contested.")

    # 2) Certified to grand jury / moved forum => conditionally disputable (needs different court record)
    if classification != "NOT DISPUTABLE" and certified_signal:
        set_outcome(
            "CONDITIONALLY DISPUTABLE",
            "MEDIUM",
            "Case indicates it was certified to a different court (need the final circuit/court record).",
        )

    # 3) Guilty handling (stricter)
    if classification not in ("DISPUTABLE", "NOT DISPUTABLE") and guilty_signal:
        reasoning.append("Guilty plea/disposition is a strong signal the case is finalized.")
        if within_appeal:
            set_outcome(
                "CONDITIONALLY DISPUTABLE",
                "MEDIUM",
                f"Judgment appears within ~{appeal_deadline_days}-day appeal window.",
            )
        elif paid_signal:
            set_outcome(
                "NOT DISPUTABLE",
                "HIGH",
                "Fine/costs appear paid, which strongly indicates acceptance/closure.",
                f"Judgment appears outside ~{appeal_deadline_days}-day appeal window.",
            )
        else:
            set_outcome(
                "NOT DISPUTABLE",
                "MEDIUM",
                f"Judgment appears outside ~{appeal_deadline_days}-day appeal window.",
            )

    # 4) Missed appearance only matters when it could realistically reopen (and isn't already closed/paid)
    if classification != "NOT DISPUTABLE" and missed_signal:
        if not paid_signal:
            set_outcome(
                "CONDITIONALLY DISPUTABLE",
                "MEDIUM",
                "Missed appearance/FTA may allow reopening under specific procedures.",
            )
        else:
            # Paid + in absentia generally indicates closure; don't keep it conditional.
            reasoning.append("In-absentia/missed-appearance signal present, but payment suggests closure.")

    # 5) Missing info fallback: only if we haven't reached a high-confidence outcome
    if missing_critical and confidence != "HIGH" and classification != "DISPUTABLE":
        set_outcome(
            "CONDITIONALLY DISPUTABLE",
            "LOW",
            "Missing critical information; eligibility may depend on additional facts/documents.",
        )

    recommended_action = "Review case details and deadlines."
    if classification == "DISPUTABLE":
        recommended_action = "Prepare dispute/defense now (collect evidence, confirm hearing details)."
    elif classification == "CONDITIONALLY DISPUTABLE":
        recommended_action = "Check appeal/reopening eligibility urgently and gather supporting documents."
    else:
        recommended_action = "Consider limited options (appeal if timely) or focus on compliance/record review."

    return {
        "classification": classification,
        "confidence": confidence,
        "reasoning": reasoning[:8],
        "key_factors": {
            "status": status,
            "plea": plea,
            "disposition": disposition,
            "appeal_window": appeal_window,
            "payment": paid,
            "hearing_timing": hearing_timing,
            "appearance": appearance,
            "case_type": case_type,
            "jurisdiction": jurisdiction,
            "data_integrity_flags": data_flags,
        },
        "recommended_action": recommended_action,
    }


def analyze_dispute_eligibility_for_run(results: list[dict[str, Any]], *, now: datetime) -> list[dict[str, Any]]:
    """
    Produce per-line analysis aligned with `results`:
    [
      { lineIndex, row, cases: [{ caseIndex, caseIdText, analysis }] }
    ]
    """
    out: list[dict[str, Any]] = []
    for li, item in enumerate(results or []):
        row = item.get("row") if isinstance(item, dict) else None
        cases = item.get("cases") if isinstance(item, dict) else None
        case_arr = list(cases) if isinstance(cases, list) else []
        analyzed_cases: list[dict[str, Any]] = []
        for c in case_arr:
            if not isinstance(c, dict):
                continue
            tables = c.get("tables")
            t0 = (tables[0] if isinstance(tables, list) and tables else {}) if tables is not None else {}
            fields = t0.get("fields") if isinstance(t0, dict) else None
            fields_arr = list(fields) if isinstance(fields, list) else []
            analyzed_cases.append(
                {
                    "caseIndex": c.get("caseIndex"),
                    "caseIdText": c.get("caseIdText"),
                    "analysis": analyze_dispute_eligibility_for_case(fields_arr, now=now),
                }
            )
        out.append({"lineIndex": li + 1, "row": row, "cases": analyzed_cases})
    return out


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


def _avg_line_progress_pct(lines: list[dict[str, Any]]) -> int:
    if not lines:
        return 0
    acc = 0
    for ln in lines:
        try:
            v = int(ln.get("progress_pct", 0))
        except (TypeError, ValueError):
            v = 0
        acc += max(0, min(100, v))
    return round(acc / len(lines))


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
    job_no_pct = {k: v for k, v in job_patch.items() if k != "progress_pct"}
    top: dict[str, Any] = {"lines_state": lines, "updated_at": iso_now(), **job_no_pct}
    top["progress_pct"] = _avg_line_progress_pct(lines)
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


async def bump_line_progress(
    sb: Any,
    job_lock: asyncio.Lock,
    job_id: Optional[str],
    line_idx_0: int,
    line_no: int,
    line_progress_pct: int,
    state: str,
    line_message: str,
    job_detail: str,
) -> None:
    """Update one line’s progress (0–100 for that CSV row). Job `progress_pct` is the mean of all lines."""
    if sb is None or not job_id:
        return
    pct = max(0, min(99, int(line_progress_pct)))
    await patch_worker_scrape_job_line(
        sb,
        job_lock,
        job_id,
        line_idx_0,
        line_no,
        {
            "lineIndex": line_no,
            "state": state,
            "message": line_message,
            "progress_pct": pct,
        },
        {
            "state": state,
            "detail_message": job_detail,
        },
    )


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
                wl(f"line slot acquired concurrency={cfg.concurrency} idx={line_idx_0} {label}")
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
        wl(f"execute_job gather start {len(rows)} parallel task(s) max_in_flight={cfg.concurrency}")
        exports = await asyncio.gather(*(run_one(r, i) for i, r in enumerate(rows)))
        wl(f"execute_job scrape OK job_id={job_id!r} lines={len(rows)} export_blocks={len(exports)}")
        try:
            persist_worker_scrape_run(archive_name, len(exports), list(exports), scrape_job_id=job_id)
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
    if job_id and sb is not None:
        await bump_line_progress(
            sb,
            job_lock,
            job_id,
            line_idx_0,
            line_no,
            0,
            "searching",
            f"Searching: {row.lastName}, {row.firstName} · {row.court}",
            f"Line {line_no}/{total_lines}: start (0%)",
        )

    async with async_playwright() as p:
        wl(f"scrape playwright START {label}")
        browser = await p.chromium.launch(headless=headless)
        if job_id and sb is not None:
            await bump_line_progress(
                sb,
                job_lock,
                job_id,
                line_idx_0,
                line_no,
                6,
                "searching",
                "Chromium launched",
                f"Line {line_no}/{total_lines}: browser ready (~6%)",
            )
        wl(f"scrape browser launched line_pct≈6% {label}")
        context = await browser.new_context()
        page = await context.new_page()

        await page.goto(landing_url, wait_until="domcontentloaded")
        if job_id and sb is not None:
            await bump_line_progress(
                sb,
                job_lock,
                job_id,
                line_idx_0,
                line_no,
                12,
                "searching",
                "GDC landing page loaded",
                f"Line {line_no}/{total_lines}: landing (~12%)",
            )
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
                wl(f"scrape disclaimer/accept clicked {label}")
                break

        if job_id and sb is not None:
            await bump_line_progress(
                sb,
                job_lock,
                job_id,
                line_idx_0,
                line_no,
                16,
                "searching",
                "Disclaimer step done (if any)",
                f"Line {line_no}/{total_lines}: post-disclaimer (~16%)",
            )

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

        if job_id and sb is not None:
            await bump_line_progress(
                sb,
                job_lock,
                job_id,
                line_idx_0,
                line_no,
                24,
                "searching",
                f"Court field set: {row.court}",
                f"Line {line_no}/{total_lines}: court selected (~24%)",
            )
        wl(f"scrape court selected {label}")

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
        if job_id and sb is not None:
            await bump_line_progress(
                sb,
                job_lock,
                job_id,
                line_idx_0,
                line_no,
                32,
                "searching",
                "Name search form open",
                f"Line {line_no}/{total_lines}: name-search page (~32%)",
            )
        wl(f"scrape name-search page loaded {label}")

        # Fill search fields + submit.
        await page.locator("#localnamesearchlastname").wait_for(state="visible")
        await page.fill("#localnamesearchlastname", row.lastName)
        await page.fill("#localnamesearchfirstname", row.firstName)
        if job_id and sb is not None:
            await bump_line_progress(
                sb,
                job_lock,
                job_id,
                line_idx_0,
                line_no,
                40,
                "searching",
                "Name fields filled; submitting search",
                f"Line {line_no}/{total_lines}: submit search (~40%)",
            )
        wl(f"scrape submitting name search {label}")
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

        if job_id and sb is not None:
            await bump_line_progress(
                sb,
                job_lock,
                job_id,
                line_idx_0,
                line_no,
                50,
                "searching",
                "Results page loaded (post-search)",
                f"Line {line_no}/{total_lines}: results DOM (~50%)",
            )
        wl(f"scrape post-search network settled {label}")

        initial_links = await list_case_link_locators(page)
        n_case = len(initial_links)
        wl(f"scrape results: {n_case} case link(s) {label}")
        link_count = max(n_case, 1)
        if job_id and sb is not None:
            await bump_line_progress(
                sb,
                job_lock,
                job_id,
                line_idx_0,
                line_no,
                56 if n_case else 88,
                "scraping" if n_case else "searching",
                f"Found {n_case} case link(s)" if n_case else "No case links — finishing line",
                f"Line {line_no}/{total_lines}: {'cases to scrape' if n_case else 'zero results'} (~{56 if n_case else 88}%)",
            )

        for i in range(n_case):
            fresh = await list_case_link_locators(page)
            if i >= len(fresh):
                wl(f"scrape case loop stop: index {i} no longer present {label}")
                break
            link_loc = fresh[i]
            case_id_text = ((await link_loc.text_content()) or "").strip() or None
            # Case i progress: 0.56..0.98 of this line's slice (room before line-complete at 1.0).
            span = 0.42
            base_frac = 0.56 + span * (i / link_count)
            mid_frac = 0.56 + span * ((i + 0.45) / link_count)
            end_frac = 0.56 + span * ((i + 0.92) / link_count)
            base_pct = min(99, round(base_frac * 100))
            mid_pct = min(99, round(mid_frac * 100))
            end_pct = min(99, round(end_frac * 100))
            if job_id and sb is not None:
                await bump_line_progress(
                    sb,
                    job_lock,
                    job_id,
                    line_idx_0,
                    line_no,
                    base_pct,
                    "scraping",
                    f"Opening case {i + 1}/{n_case} ({case_id_text or '?'})",
                    f"Line {line_no}/{total_lines}: case {i + 1}/{n_case} open",
                )
            wl(f"scrape case {i + 1}/{n_case} open line_pct≈{base_pct}% id={case_id_text!r} {label}")
            await link_loc.click()
            await page.wait_for_load_state("domcontentloaded")
            try:
                await page.wait_for_load_state("networkidle", timeout=30_000)
            except Exception:
                pass
            if job_id and sb is not None:
                await bump_line_progress(
                    sb,
                    job_lock,
                    job_id,
                    line_idx_0,
                    line_no,
                    mid_pct,
                    "scraping",
                    f"Extracting case detail for case {i + 1}/{n_case}",
                    f"Line {line_no}/{total_lines}: case detail page",
                )
            wl(f"scrape case {i + 1}/{n_case} detail page loaded {label}")
            tables = await export_all_tables_on_page(page)
            wl(f"scrape case {i + 1}/{n_case} label_sections={len(tables)} id={case_id_text!r} {label}")
            # Embed dispute analysis per case immediately (so UI can show it before the whole job finishes).
            try:
                t0 = tables[0] if isinstance(tables, list) and len(tables) > 0 else {}
                fields = t0.get("fields") if isinstance(t0, dict) else None
                fields_arr = list(fields) if isinstance(fields, list) else []
                case_analysis = analyze_dispute_eligibility_for_case(fields_arr, now=datetime.now(timezone.utc))
            except Exception as ae:
                wl(f"case analysis failed (non-fatal): {ae!r} {label}")
                case_analysis = None
            if job_id and sb is not None:
                await bump_line_progress(
                    sb,
                    job_lock,
                    job_id,
                    line_idx_0,
                    line_no,
                    end_pct,
                    "scraping",
                    f"Exported {len(tables)} field section(s); returning to results",
                    f"Line {line_no}/{total_lines}: case {i + 1}/{n_case} extracted",
                )
            item["cases"].append(
                {
                    "caseIndex": i,
                    "caseIdText": case_id_text,
                    "url": page.url,
                    "exportedAt": datetime.now(timezone.utc).isoformat(),
                    "tables": tables,
                    "analysis": case_analysis,
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
                "export": item,
            },
            {
                "state": "running",
                "detail_message": f"Finished line {line_no} of {total_lines}",
            },
        )
    return item

