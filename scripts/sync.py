#!/usr/bin/env python3
"""
Sync job for the static site. Run by GitHub Actions a few times a day (see .github/workflows/sync.yml).

Fetches, with the standard library only:
  * day-ahead prices for DK1/DK2 (Energi Data Service, DayAheadPrices, 15 min -> hourly)
  * tariffs and taxes (Energi Data Service, DatahubPricelist) for Energinet and every grid company
    listed in config/grid-companies.json
  * elpriser.org's public 7-day price forecast for DK1/DK2

and writes:
  data/prices.json     hourly prices, last 14 days + today (+ tomorrow once published)
  data/tariffs.json    current and future DatahubPricelist rows
  data/forecast.json   the forecast as of now
  data/meta.json       sync time, what succeeded, errors
  data/history/prices/YYYY-MM-DD.json      archive of actual prices, one file per day
  data/history/forecasts/YYYY-MM-DD.json   the forecast as it looked on that day (last sync of the day wins)
  data/skill.json      how well archived forecasts hit the actual prices, per area and lead time

Usage:  python scripts/sync.py [--out data] [--mock]
--mock replaces the HTTP calls with synthetic payloads in the real APIs' shapes (offline test).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Copenhagen")
EDS = "https://api.energidataservice.dk/dataset"
ELPRISER = "https://elpriser.org/api"
AREAS = ["DK1", "DK2"]
ENERGINET_CODES = ["40000", "41000", "EA-001"]          # transmissions nettarif, systemtarif, elafgift
ENERGINET_GLNS = ["5790000432752", "5790001330552"]      # Energinet Systemansvar A/S (SYO), Energinet DataHub A/S
PRICE_HISTORY_DAYS = 14
TARIFF_FIELDS = ["ChargeOwner", "GLN_Number", "ChargeType", "ChargeTypeCode", "Note", "ValidFrom", "ValidTo", "ResolutionDuration"] + [f"Price{i}" for i in range(1, 25)]
ROOT = Path(__file__).resolve().parent.parent

MOCK = False


# ----------------------------------------------------------------------------- HTTP
def get_json(url: str, params: dict | None = None, tries: int = 3, timeout: int = 60):
    if params:
        url = f"{url}?{urllib.parse.urlencode(params, quote_via=urllib.parse.quote)}"
    if MOCK:
        return mock_api(url)
    last: Exception | None = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "powerprices-sync/1.0 (+github)", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as e:  # noqa: PERF203
            last = e
            time.sleep(3 * (i + 1))
    raise RuntimeError(f"GET {url} failed after {tries} tries: {last}")


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_eds_time(s: str) -> datetime:
    """EDS TimeUTC has no zone suffix ("2026-10-17T22:00:00")."""
    s = s.rstrip("Z")
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def local_date(dt: datetime) -> date:
    return dt.astimezone(TZ).date()


# ----------------------------------------------------------------------------- prices
def fetch_prices(start: date, end: date) -> dict[str, list[dict]]:
    """Hourly mean of 15-minute DayAheadPrices for local dates [start, end). Returns {area: [{t, dkk, eur}]}."""
    js = get_json(f"{EDS}/DayAheadPrices", {
        "start": start.isoformat(), "end": end.isoformat(),
        "filter": json.dumps({"PriceArea": AREAS}),
        "columns": "TimeUTC,PriceArea,DayAheadPriceDKK,DayAheadPriceEUR",
        "sort": "TimeUTC asc", "limit": 20000,
    })
    acc: dict[tuple[str, datetime], list] = {}
    for r in js.get("records", []):
        if r.get("DayAheadPriceDKK") is None or not r.get("TimeUTC") or r.get("PriceArea") not in AREAS:
            continue
        t = parse_eds_time(r["TimeUTC"]).replace(minute=0, second=0, microsecond=0)
        acc.setdefault((r["PriceArea"], t), []).append((float(r["DayAheadPriceDKK"]), r.get("DayAheadPriceEUR")))
    out: dict[str, list[dict]] = {a: [] for a in AREAS}
    for (area, t), vals in sorted(acc.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        dkk = sum(v[0] for v in vals) / len(vals)
        eurs = [float(v[1]) for v in vals if v[1] is not None]
        out[area].append({"t": iso_utc(t), "dkk": round(dkk, 2), "eur": round(sum(eurs) / len(eurs), 2) if eurs else None, "n": len(vals)})
    if not any(out.values()):
        raise RuntimeError("DayAheadPrices returned no usable records")
    return out


# ----------------------------------------------------------------------------- tariffs
def fetch_tariffs(companies: list[dict], today: date) -> dict:
    codes = sorted({c for comp in companies for c in comp["codes"]} | set(ENERGINET_CODES))
    glns = sorted({comp["gln"] for comp in companies} | set(ENERGINET_GLNS))
    js = get_json(f"{EDS}/DatahubPricelist", {
        "filter": json.dumps({"ChargeTypeCode": codes, "GLN_Number": glns}),
        "sort": "ValidFrom desc", "limit": 5000,
    })
    cutoff = (today - timedelta(days=2)).isoformat()
    energinet: dict[str, list] = {c: [] for c in ENERGINET_CODES}
    grid: dict[str, list] = {comp["gln"]: [] for comp in companies}
    wanted = {comp["gln"]: set(comp["codes"]) for comp in companies}
    for r in js.get("records", []):
        if r.get("ValidTo") and r["ValidTo"][:10] < cutoff:
            continue  # expired
        if r.get("ChargeType") != "D03":
            continue  # D01 = subscription (kr/month), D02 = fee; only D03 tariffs are per kWh
        row = {k: r.get(k) for k in TARIFF_FIELDS}
        gln, code = str(r.get("GLN_Number")), r.get("ChargeTypeCode")
        if gln in ENERGINET_GLNS and code in energinet:
            energinet[code].append(row)
        elif gln in wanted and code in wanted[gln]:
            grid[gln].append(row)
    missing = [c for c, rows in energinet.items() if not rows]
    if missing:
        raise RuntimeError(f"DatahubPricelist: no current rows for Energinet codes {missing}")
    # Companies whose configured codes returned nothing (renamed codes): fall back to every
    # per-kWh row of that GLN whose note looks like the household C tariff, and log what we saw.
    for comp in companies:
        if grid[comp["gln"]]:
            continue
        try:
            js = get_json(f"{EDS}/DatahubPricelist", {
                "filter": json.dumps({"GLN_Number": [comp["gln"]], "ChargeType": ["D03"]}),
                "sort": "ValidFrom desc", "limit": 500,
            })
        except Exception as e:  # noqa: BLE001
            print(f"     [warn] {comp['name']}: configured codes {comp['codes']} returned nothing and fallback lookup failed: {e}", flush=True)
            continue
        current = [r for r in js.get("records", []) if not (r.get("ValidTo") and r["ValidTo"][:10] < cutoff)]
        seen = sorted({(r.get("ChargeTypeCode"), r.get("Note")) for r in current})
        # Household tariff notes look like "Nettarif C", "Nettarif C time", "Nettarif C time (Rabat)".
        def is_c(note: str) -> bool:
            n = note.lower().strip()
            return n == "nettarif c" or n.startswith("nettarif c ") or n.startswith("nettarif c(")
        candidates = {code: note for code, note in seen if is_c(note or "")}
        primary = [c for c, n in candidates.items() if "rabat" not in n.lower()]
        primary.sort(key=lambda c: ("time" not in candidates[c].lower(), c))  # prefer the time-differentiated one
        chosen = primary[:1] + [c for c, n in candidates.items() if "rabat" in n.lower()]
        grid[comp["gln"]] = [{k: r.get(k) for k in TARIFF_FIELDS} for r in current if r.get("ChargeTypeCode") in chosen]
        print(f"     [warn] {comp['name']}: configured codes {comp['codes']} returned nothing; fallback chose {chosen} "
              f"({len(grid[comp['gln']])} rows). Update config/grid-companies.json. Codes seen: {seen}", flush=True)
    return {"energinet": energinet, "grid": grid}


# ----------------------------------------------------------------------------- forecast
def fetch_forecast(area: str) -> list[dict]:
    """elpriser.org forecast -> [{t (UTC hour start), dkk (DKK/MWh), kind: actual|forecast}]."""
    js = get_json(f"{ELPRISER}/forecast", {"area": area, "mode": "spot_ex"})
    days = js.get("days") if isinstance(js, dict) else None
    if not isinstance(days, list):
        raise RuntimeError(f"elpriser.org forecast for {area}: unexpected shape")
    out = []
    for d in days:
        try:
            day = date.fromisoformat(str(d.get("date"))[:10])
        except ValueError:
            continue
        kind = "actual" if str(d.get("type", "")).startswith(("actual", "official")) else "forecast"
        for p in d.get("prices") or []:
            if p is None or p.get("price") is None or p.get("hour") is None:
                continue
            hour = int(p["hour"])
            if not 0 <= hour <= 23:
                continue
            local = datetime(day.year, day.month, day.day, hour, tzinfo=TZ)
            out.append({"t": iso_utc(local), "dkk": round(float(p["price"]) * 1000, 2), "kind": kind})
    out.sort(key=lambda x: x["t"])
    if not out:
        raise RuntimeError(f"elpriser.org forecast for {area}: empty")
    return out


# ----------------------------------------------------------------------------- archive & evaluation
def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def archive_prices(out: Path, prices: dict[str, list[dict]]) -> int:
    """One file per complete local day: history/prices/YYYY-MM-DD.json -> {date, areas: {area: [{t, dkk}]}}."""
    by_day: dict[date, dict[str, list]] = {}
    for area, rows in prices.items():
        for r in rows:
            d = local_date(datetime.strptime(r["t"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc))
            by_day.setdefault(d, {}).setdefault(area, []).append({"t": r["t"], "dkk": r["dkk"]})
    n = 0
    for d, areas in by_day.items():
        if all(len(rows) >= 23 for rows in areas.values()) and len(areas) == len(AREAS):
            write_json(out / "history" / "prices" / f"{d.isoformat()}.json", {"date": d.isoformat(), "areas": areas})
            n += 1
    return n


def evaluate(out: Path, today: date) -> dict:
    """Compare every archived forecast with archived actual prices, per area and lead (days after the snapshot date)."""
    actual: dict[tuple[str, str], float] = {}
    daily_actual: dict[tuple[str, date], float] = {}
    for f in sorted((out / "history" / "prices").glob("*.json")):
        js = read_json(f) or {}
        for area, rows in (js.get("areas") or {}).items():
            vals = []
            for r in rows:
                actual[(area, r["t"])] = r["dkk"]
                vals.append(r["dkk"])
            if vals:
                daily_actual[(area, date.fromisoformat(js["date"]))] = sum(vals) / len(vals)
    pairs: dict[tuple[str, int], list[tuple[float, float]]] = {}
    days: dict[tuple[str, int, date], list[tuple[float, float]]] = {}
    for f in sorted((out / "history" / "forecasts").glob("*.json")):
        js = read_json(f) or {}
        try:
            snap = date.fromisoformat(js["date"])
        except (KeyError, ValueError):
            continue
        for area, rows in (js.get("areas") or {}).items():
            for r in rows:
                if r.get("kind") != "forecast":
                    continue
                a = actual.get((area, r["t"]))
                if a is None:
                    continue
                target = local_date(datetime.strptime(r["t"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc))
                lead = (target - snap).days
                if lead < 2:
                    continue  # tomorrow is published, not forecast
                pairs.setdefault((area, lead), []).append((r["dkk"], a))
                days.setdefault((area, lead, target), []).append((r["dkk"], a))
    summary = []
    for (area, lead), ps in sorted(pairs.items()):
        day_items = [(k, v) for k, v in days.items() if k[0] == area and k[1] == lead]
        daily = []
        hits, n_hits = 0, 0
        for (a_, l_, target), v in day_items:
            fm = sum(x[0] for x in v) / len(v)
            am = sum(x[1] for x in v) / len(v)
            daily.append(abs(fm - am))
            # Did the forecast correctly say whether the day would be above or below the week before the snapshot?
            snap = target - timedelta(days=lead)
            ref = [daily_actual.get((area, snap - timedelta(days=i))) for i in range(0, 7)]
            ref = [x for x in ref if x is not None]
            if len(ref) >= 4:
                level = sum(ref) / len(ref)
                n_hits += 1
                hits += int((fm - level) * (am - level) > 0)
        summary.append({
            "area": area, "lead": lead, "n_hours": len(ps), "n_days": len(day_items),
            "mae_hourly_ore": round(sum(abs(f - a) for f, a in ps) / len(ps) / 10, 2),
            "rmse_hourly_ore": round(math.sqrt(sum((f - a) ** 2 for f, a in ps) / len(ps)) / 10, 2),
            "mae_daily_mean_ore": round(sum(daily) / len(daily) / 10, 2) if daily else None,
            "bias_ore": round(sum(f - a for f, a in ps) / len(ps) / 10, 2),
            "level_hit_rate": round(hits / n_hits, 3) if n_hits else None,
        })
    recent = []
    for (area, lead, target), v in sorted(days.items(), key=lambda kv: (kv[0][2], kv[0][0], kv[0][1]))[-200:]:
        recent.append({"area": area, "lead": lead, "date": target.isoformat(),
                       "forecast_avg_ore": round(sum(x[0] for x in v) / len(v) / 10, 1),
                       "actual_avg_ore": round(sum(x[1] for x in v) / len(v) / 10, 1)})
    return {"updated": iso_utc(datetime.now(timezone.utc)), "evaluated_until": today.isoformat(), "summary": summary, "recent_days": recent}


# ----------------------------------------------------------------------------- mock API (offline tests)
def mock_api(url: str):
    """Synthetic payloads in the real APIs' shapes, driven by a deterministic 'world'."""
    u = urllib.parse.urlparse(url)
    q = dict(urllib.parse.parse_qsl(u.query))
    now = datetime.now(timezone.utc)
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def wind(t: datetime, off: float) -> float:
        d = (t - t0).total_seconds() / 86400
        return max(0.0, 9 + 6 * math.sin(d / 1.7 + off) + 3 * math.sin(d * 2.3 + 2 * off))

    def price(t: datetime, area: str) -> float:  # DKK/MWh
        h = t.astimezone(TZ).hour
        demand = 1 + 0.35 * math.sin((h - 9) / 24 * 2 * math.pi)
        residual = demand - 0.06 * wind(t, 0.4 if area == "DK2" else 0) - 0.05 * wind(t, 1.1)
        return 200 + 900 * max(0.0, residual) ** 1.5 - 150 * max(0.0, -residual)

    if u.path.endswith("/DayAheadPrices"):
        start, end = date.fromisoformat(q["start"]), date.fromisoformat(q["end"])
        # pretend tomorrow is published only after 13:00 local
        published_until = min(end, date.today() + timedelta(days=2 if datetime.now(TZ).hour >= 13 else 1))
        recs = []
        t = datetime(start.year, start.month, start.day, tzinfo=TZ).astimezone(timezone.utc) - timedelta(hours=3)
        while t < datetime(end.year, end.month, end.day, tzinfo=TZ).astimezone(timezone.utc) + timedelta(hours=3):
            d = local_date(t)
            if start <= d < published_until:
                for a in AREAS:
                    recs.append({"TimeUTC": t.strftime("%Y-%m-%dT%H:%M:%S"), "PriceArea": a, "DayAheadPriceDKK": round(price(t, a), 2), "DayAheadPriceEUR": round(price(t, a) / 7.46, 2)})
            t += timedelta(minutes=15)
        return {"total": len(recs), "records": recs}
    if u.path.endswith("/DatahubPricelist"):
        flt = json.loads(q["filter"])
        recs = []
        for gln in flt["GLN_Number"]:
            for code in flt["ChargeTypeCode"]:
                base = {"40000": 0.043, "41000": 0.072, "EA-001": 0.008}.get(code, -0.05 if code.endswith((" R", "_R")) else 0.2)
                row = {"ChargeOwner": f"owner {gln}", "GLN_Number": gln, "ChargeType": "D03", "ChargeTypeCode": code, "Note": code,
                       "ValidFrom": "2026-01-01T00:00:00", "ValidTo": None, "ResolutionDuration": "PT1H"}
                for i in range(1, 25):
                    row[f"Price{i}"] = base * (4 if base == 0.2 and 17 <= i - 1 <= 20 else 1)
                recs.append(row)
                recs.append({**row, "ValidFrom": "2025-01-01T00:00:00", "ValidTo": "2026-01-01T00:00:00"})  # expired, must be dropped
        return {"total": len(recs), "records": recs}
    if u.path.endswith("/forecast"):
        area = q.get("area", "DK1")
        days = []
        for i in range(7):
            d = date.today() + timedelta(days=i)
            days.append({"date": d.isoformat(), "type": "actual" if i < 2 else "forecast",
                         "prices": [{"hour": h, "price": round(price(datetime(d.year, d.month, d.day, h, tzinfo=TZ), area) / 1000 * 1.05, 4)} for h in range(24)]})
        return {"area": area, "mode": "spot_ex", "days": days}
    raise RuntimeError(f"mock: unknown url {url}")


# ----------------------------------------------------------------------------- main
def main() -> int:
    global MOCK
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "data"))
    ap.add_argument("--mock", action="store_true")
    args = ap.parse_args()
    MOCK = args.mock
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    today = datetime.now(TZ).date()
    companies = (read_json(ROOT / "config" / "grid-companies.json") or {}).get("companies", [])
    meta = {"synced_at": iso_utc(now), "ok": {}, "errors": [], "mock": MOCK}

    def step(name, fn):
        try:
            result = fn()
            meta["ok"][name] = True
            print(f"[ok] {name}", flush=True)
            return result
        except Exception as e:  # noqa: BLE001
            meta["ok"][name] = False
            meta["errors"].append(f"{name}: {e}")
            print(f"[FAIL] {name}: {e}", file=sys.stderr, flush=True)
            return None

    prices = step("prices", lambda: fetch_prices(today - timedelta(days=PRICE_HISTORY_DAYS), today + timedelta(days=2)))
    if prices:
        has_tomorrow = any(local_date(datetime.strptime(r["t"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)) > today for r in prices["DK1"])
        write_json(out / "prices.json", {"updated": iso_utc(now), "source": "Energi Data Service, DayAheadPrices (15 min -> hourly mean)", "unit": "DKK/MWh", "has_tomorrow": has_tomorrow, "areas": prices})
        n = archive_prices(out, prices)
        print(f"     archived {n} complete days; tomorrow published: {has_tomorrow}")

    tariffs = step("tariffs", lambda: fetch_tariffs(companies, today))
    if tariffs:
        write_json(out / "tariffs.json", {"updated": iso_utc(now), "source": "Energi Data Service, DatahubPricelist", "unit": "DKK/kWh ex VAT", **tariffs})

    forecast = step("forecast", lambda: {a: fetch_forecast(a) for a in AREAS})
    if forecast:
        doc = {"updated": iso_utc(now), "date": today.isoformat(), "source": "elpriser.org (quantile LightGBM, retrained daily)", "unit": "DKK/MWh", "areas": forecast}
        write_json(out / "forecast.json", doc)
        write_json(out / "history" / "forecasts" / f"{today.isoformat()}.json", doc)

    skill = step("skill", lambda: evaluate(out, today))
    if skill:
        write_json(out / "skill.json", skill)
        print(f"     skill rows: {len(skill['summary'])}")

    write_json(out / "meta.json", meta)
    if not meta["ok"].get("prices"):
        return 1  # prices are the one thing the page cannot do without
    return 0


if __name__ == "__main__":
    sys.exit(main())
