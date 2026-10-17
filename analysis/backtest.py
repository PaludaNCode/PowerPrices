#!/usr/bin/env python3
"""
Backtest: how well can Danish day-ahead prices be guessed 2-5 days ahead?

The question the script answers, per price area and per lead time L (days ahead of
"today"): if at ~14:00 on day D (tomorrow's prices just published) we use the weather
forecast issued that day to predict prices for day D+L, how big is the error, and how
does it compare with naive guesses?

Data (all free, keyless):
  * Energi Data Service  DayAheadPrices (15-min, since 2025-10-01) and Elspotprices (hourly, before)
  * Open-Meteo           Previous Runs API: for every past hour, the forecast that was issued
                         0..7 days earlier (wind 100 m, solar radiation, temperature)
                         Archive API (ERA5): optional extra history for training

Model: one LightGBM regressor per lead time (fallback: sklearn HistGradientBoosting) on
  wind capacity factors (own area, other DK area, northern Germany), solar, temperature,
  hour/weekday/holiday, day-of-year and the mean price of the last 7 published days.

Usage:
  python backtest.py                       # DK1+DK2, last 60 days rolling evaluation
  python backtest.py --areas DK1 --eval-days 30 --archive-days 0
  python backtest.py --synthetic           # offline smoke test with fake data

Outputs (in --out, default ./results): summary.md, summary.csv, predictions.csv, mae_by_lead.png
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None

TZ = ZoneInfo("Europe/Copenhagen")
EDS = "https://api.energidataservice.dk/dataset"
OM_PREVIOUS = "https://previous-runs-api.open-meteo.com/v1/forecast"
OM_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
QUARTER_HOUR_START = date(2025, 10, 1)  # DayAheadPrices (15 min) replaces Elspotprices (hourly)

# Same points as the website (js/model.js)
POINTS = [
    ("Ringkøbing", 56.09, 8.24, "dk1"), ("Esbjerg", 55.47, 8.45, "dk1"), ("Aalborg", 57.05, 9.92, "dk1"),
    ("Herning", 56.14, 8.98, "dk1"), ("Odense", 55.40, 10.39, "dk1"), ("Horns Rev", 55.50, 7.80, "dk1"),
    ("Anholt", 56.60, 11.20, "dk1"),
    ("København", 55.68, 12.57, "dk2"), ("Kalundborg", 55.68, 11.09, "dk2"), ("Nakskov", 54.83, 11.13, "dk2"),
    ("Kriegers Flak", 55.00, 12.90, "dk2"), ("Rødsand", 54.55, 11.70, "dk2"),
    ("Schleswig", 54.30, 9.50, "de"), ("Cuxhaven", 53.87, 8.70, "de"), ("Rostock", 54.10, 12.10, "de"),
    ("Tyske Bugt", 54.20, 7.00, "de"), ("Hannover", 52.40, 9.70, "de"),
]
VARS = ["wind_speed_100m", "shortwave_radiation", "temperature_2m"]
LEADS = [1, 2, 3, 4, 5, 6, 7]  # days ahead of "today"; lead 1 is published, kept as a reference

# Approximate fleet-aggregated power curve (m/s -> capacity factor), identical to the website.
_CURVE = np.array([[0, 0], [3, 0], [4, .03], [5, .08], [6, .16], [7, .27], [8, .40], [9, .54], [10, .67],
                   [11, .78], [12, .87], [13, .93], [14, .97], [15, 1], [24, 1], [26, .3], [30, 0]])


def power_curve(v):
    v = np.asarray(v, dtype=float)
    return np.interp(np.clip(v, 0, 30), _CURVE[:, 0], _CURVE[:, 1])


# ----------------------------------------------------------------------------- HTTP helpers
def get_json(url, params, tries=4, timeout=120):
    if requests is None:
        raise RuntimeError("pip install requests")
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, params=params, timeout=timeout, headers={"User-Agent": "powerprices-backtest/1.0"})
            if r.status_code == 429:
                time.sleep(10 * (i + 1))
                continue
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 ** i)
    raise RuntimeError(f"GET {url} failed: {last}")


# ----------------------------------------------------------------------------- prices
def fetch_prices(start: date, end: date, areas: list[str]) -> pd.DataFrame:
    """Hourly day-ahead prices (DKK/MWh), columns: time (UTC), area, price."""
    frames = []
    flt = json.dumps({"PriceArea": areas})
    if start < QUARTER_HOUR_START:
        e = min(end, QUARTER_HOUR_START)
        js = get_json(f"{EDS}/Elspotprices", {"start": start.isoformat(), "end": e.isoformat(), "filter": flt,
                                              "columns": "HourUTC,PriceArea,SpotPriceDKK", "sort": "HourUTC asc", "limit": 0})
        df = pd.DataFrame(js["records"]).rename(columns={"HourUTC": "time", "PriceArea": "area", "SpotPriceDKK": "price"})
        frames.append(df)
    if end > QUARTER_HOUR_START:
        s = max(start, QUARTER_HOUR_START)
        js = get_json(f"{EDS}/DayAheadPrices", {"start": s.isoformat(), "end": end.isoformat(), "filter": flt,
                                                "columns": "TimeUTC,PriceArea,DayAheadPriceDKK", "sort": "TimeUTC asc", "limit": 0})
        df = pd.DataFrame(js["records"]).rename(columns={"TimeUTC": "time", "PriceArea": "area", "DayAheadPriceDKK": "price"})
        frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    df["time"] = pd.to_datetime(df["time"], utc=True).dt.floor("h")
    df = df.groupby(["area", "time"], as_index=False)["price"].mean()
    return df


# ----------------------------------------------------------------------------- weather
def fetch_previous_runs(past_days: int, max_lead: int) -> pd.DataFrame:
    """Open-Meteo previous-runs: columns time (UTC), point, lead, wind, ghi, temp. lead=0 is the latest run."""
    hourly = []
    for v in VARS:
        hourly.append(v)
        hourly += [f"{v}_previous_day{k}" for k in range(1, max_lead + 1)]
    rows = []
    for name, lat, lon, _ in POINTS:
        js = get_json(OM_PREVIOUS, {"latitude": lat, "longitude": lon, "hourly": ",".join(hourly), "wind_speed_unit": "ms",
                                    "timezone": "UTC", "timeformat": "unixtime", "past_days": past_days, "forecast_days": 1})
        h = js["hourly"]
        t = pd.to_datetime(np.asarray(h["time"]), unit="s", utc=True)
        for k in range(0, max_lead + 1):
            suf = "" if k == 0 else f"_previous_day{k}"
            rows.append(pd.DataFrame({"time": t, "point": name, "lead": k,
                                      "wind": h[f"wind_speed_100m{suf}"], "ghi": h[f"shortwave_radiation{suf}"], "temp": h[f"temperature_2m{suf}"]}))
    return pd.concat(rows, ignore_index=True)


def fetch_archive(start: date, end: date) -> pd.DataFrame:
    """ERA5 reanalysis (lead = 0) for extra training history."""
    rows = []
    for name, lat, lon, _ in POINTS:
        js = get_json(OM_ARCHIVE, {"latitude": lat, "longitude": lon, "start_date": start.isoformat(), "end_date": end.isoformat(),
                                   "hourly": ",".join(VARS), "wind_speed_unit": "ms", "timezone": "UTC", "timeformat": "unixtime"})
        h = js["hourly"]
        t = pd.to_datetime(np.asarray(h["time"]), unit="s", utc=True)
        rows.append(pd.DataFrame({"time": t, "point": name, "lead": 0, "wind": h["wind_speed_100m"], "ghi": h["shortwave_radiation"], "temp": h["temperature_2m"]}))
    return pd.concat(rows, ignore_index=True)


def aggregate_weather(w: pd.DataFrame) -> pd.DataFrame:
    """Per (time, lead): wind CF per group, solar (kW/m2) and temperature over Danish points."""
    w = w.dropna(subset=["wind"]).copy()
    group = {p[0]: p[3] for p in POINTS}
    w["group"] = w["point"].map(group)
    w["cf"] = power_curve(w["wind"])
    cf = w.pivot_table(index=["time", "lead"], columns="group", values="cf", aggfunc="mean")
    cf.columns = [f"w_{c}" for c in cf.columns]
    dk = w[w["group"] != "de"].groupby(["time", "lead"]).agg(solar=("ghi", "mean"), temp=("temp", "mean"))
    out = cf.join(dk).reset_index()
    out["solar"] = out["solar"].fillna(0) / 1000.0
    return out.dropna(subset=["w_dk1", "w_dk2", "w_de", "temp"])


# ----------------------------------------------------------------------------- calendar
def easter(year: int) -> date:
    a, b, c = year % 19, year // 100, year % 100
    d, e, f = b // 4, b % 4, (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = (h + l - 7 * m + 114) % 31 + 1
    return date(year, month, day)


def holidays(year: int) -> set[date]:
    e = easter(year)
    fixed = {date(year, 1, 1), date(year, 6, 5), date(year, 12, 24), date(year, 12, 25), date(year, 12, 26), date(year, 12, 31)}
    return fixed | {e + timedelta(days=d) for d in (-3, -2, 0, 1, 39, 49, 50)}


def add_calendar(df: pd.DataFrame) -> pd.DataFrame:
    local = df["time"].dt.tz_convert(TZ)
    df["date"] = local.dt.date
    df["hour"] = local.dt.hour
    df["dow"] = local.dt.dayofweek
    years = {d.year for d in df["date"].unique()}
    hol = set().union(*(holidays(y) for y in years))
    df["offday"] = ((df["dow"] >= 5) | df["date"].isin(hol)).astype(int)
    doy = local.dt.dayofyear
    df["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    df["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
    return df


# ----------------------------------------------------------------------------- features
FEATURES = ["w_local", "w_other", "w_de", "solar", "temp", "hour", "dow", "offday", "doy_sin", "doy_cos", "level7", "level1"]


def build_table(prices: pd.DataFrame, weather: pd.DataFrame, area: str) -> pd.DataFrame:
    """Rows = (hour, lead) for one area with target price, weather at that lead, and lagged price levels."""
    p = prices[prices["area"] == area][["time", "price"]].copy()
    p = add_calendar(p)
    daily = p.groupby("date")["price"].mean().sort_index()
    daily_idx = pd.Series(daily.values, index=pd.to_datetime(daily.index))
    level7 = daily_idx.rolling(7, min_periods=4).mean()
    w = weather.copy()
    w["w_local"] = w["w_dk1"] if area == "DK1" else w["w_dk2"]
    w["w_other"] = w["w_dk2"] if area == "DK1" else w["w_dk1"]
    t = p.merge(w[["time", "lead", "w_local", "w_other", "w_de", "solar", "temp"]], on="time", how="inner")
    # Last published day K for a target date T at lead L: K = T - (L - 1)  (lead 0 treated like lead 1)
    tdate = pd.to_datetime(t["date"])
    k = tdate - pd.to_timedelta(np.maximum(t["lead"] - 1, 0), unit="D")
    t["level7"] = level7.reindex(k).to_numpy()
    t["level1"] = daily_idx.reindex(k).to_numpy()
    t["k_date"] = k.dt.date
    return t.dropna(subset=["level7", "level1"])


def make_model():
    try:
        import lightgbm as lgb
        return lgb.LGBMRegressor(n_estimators=500, learning_rate=0.03, num_leaves=31, min_child_samples=20,
                                 subsample=0.8, subsample_freq=1, colsample_bytree=0.8, verbose=-1)
    except ImportError:
        from sklearn.ensemble import HistGradientBoostingRegressor
        return HistGradientBoostingRegressor(max_iter=400, learning_rate=0.05)


# ----------------------------------------------------------------------------- evaluation
def run_backtest(prices: pd.DataFrame, weather: pd.DataFrame, area: str, eval_days: int, retrain_every: int, leads: list[int]):
    table = build_table(prices, weather, area)
    analysis = table[table["lead"] == 0]  # "what the weather turned out to be"
    last_date = max(analysis["date"])
    origins = [last_date - timedelta(days=i) for i in range(max(leads) + 1, max(leads) + eval_days + 1)]
    origins.sort()
    preds = []
    models: dict[int, tuple[date, object]] = {}
    # Lagged hourly price lookups for baselines
    hourly = prices[prices["area"] == area].set_index("time")["price"]
    for origin in origins:  # "today" = origin; tomorrow (origin+1) is already published
        known_until = origin + timedelta(days=1)
        for L in leads:
            target = origin + timedelta(days=L)
            if L <= 1:
                continue  # published, nothing to forecast
            retrain = L not in models or (origin - models[L][0]).days >= retrain_every
            if retrain:
                train = analysis[(analysis["date"] <= known_until) & (analysis["k_date"] <= known_until)]
                # training rows for lead L use lagged levels as they would be known L-1 days before the target
                train = build_level_for_lead(train, prices, area, L)
                m = make_model().fit(train[FEATURES], train["price"])
                models[L] = (origin, m)
            m = models[L][1]
            # Weather as forecast at the origin: previous_day{L} for the target day's hours
            rows_fc = table[(table["date"] == target) & (table["lead"] == L)]
            rows_an = analysis[analysis["date"] == target]
            if rows_fc.empty or rows_an.empty:
                continue
            rows_fc = build_level_for_lead(rows_fc, prices, area, L)
            rows_an = build_level_for_lead(rows_an, prices, area, L)
            y_fc = m.predict(rows_fc[FEATURES])
            y_an = m.predict(rows_an[FEATURES])
            an_by_hour = dict(zip(rows_an["hour"], y_an))
            for (_, r), yf in zip(rows_fc.iterrows(), y_fc):
                t = r["time"]
                persist = hourly.get(t - pd.Timedelta(days=L - 1), np.nan)
                week = hourly.get(t - pd.Timedelta(days=7 if L - 1 <= 7 else 14), np.nan)
                preds.append({"area": area, "origin": origin, "target": target, "lead": L, "time": t, "hour": r["hour"],
                              "actual": r["price"], "model": yf, "model_perfect_weather": an_by_hour.get(r["hour"], np.nan),
                              "persistence": persist, "same_weekday_last_week": week, "level7": r["level7"]})
    return pd.DataFrame(preds)


def build_level_for_lead(rows: pd.DataFrame, prices: pd.DataFrame, area: str, L: int) -> pd.DataFrame:
    """Recompute level7/level1 for a given lead (K = target - (L-1))."""
    p = prices[prices["area"] == area][["time", "price"]].copy()
    local = p["time"].dt.tz_convert(TZ)
    p["date"] = local.dt.date
    daily = p.groupby("date")["price"].mean().sort_index()
    daily_idx = pd.Series(daily.values, index=pd.to_datetime(daily.index))
    level7 = daily_idx.rolling(7, min_periods=4).mean()
    rows = rows.copy()
    k = pd.to_datetime(rows["date"]) - pd.to_timedelta(L - 1, unit="D")
    rows["level7"] = level7.reindex(k).to_numpy()
    rows["level1"] = daily_idx.reindex(k).to_numpy()
    return rows.dropna(subset=["level7", "level1"])


def summarise(preds: pd.DataFrame) -> pd.DataFrame:
    out = []
    for (area, L), g in preds.groupby(["area", "lead"]):
        d = g.groupby(["origin", "target"]).agg(actual=("actual", "mean"), model=("model", "mean"))
        # tercile classification of the daily mean relative to the trailing level distribution
        terc = g.groupby(["origin", "target"]).agg(actual=("actual", "mean"), model=("model", "mean"), level=("level7", "first"))
        def shape_corr(x):
            return np.corrcoef(x["actual"], x["model"])[0, 1] if len(x) > 3 and x["actual"].std() > 0 and x["model"].std() > 0 else np.nan
        corr = g.groupby(["origin", "target"]).apply(shape_corr, include_groups=False).mean()
        row = {
            "area": area, "lead_days": L, "n_days": len(d), "n_hours": len(g),
            "mae_model": (g["model"] - g["actual"]).abs().mean(),
            "rmse_model": math.sqrt(((g["model"] - g["actual"]) ** 2).mean()),
            "mae_perfect_weather": (g["model_perfect_weather"] - g["actual"]).abs().mean(),
            "mae_persistence": (g["persistence"] - g["actual"]).abs().mean(),
            "mae_same_weekday": (g["same_weekday_last_week"] - g["actual"]).abs().mean(),
            "mae_daily_mean": (d["model"] - d["actual"]).abs().mean(),
            "mae_daily_mean_level7": (terc["level"] - terc["actual"]).abs().mean(),
            "shape_corr": corr,
            "sign_hit_rate_vs_level7": float(np.mean(np.sign(terc["model"] - terc["level"]) == np.sign(terc["actual"] - terc["level"]))),
        }
        out.append(row)
    return pd.DataFrame(out)


def to_markdown(s: pd.DataFrame) -> str:
    cols = ["area", "lead_days", "n_days", "mae_model", "mae_perfect_weather", "mae_persistence", "mae_same_weekday", "mae_daily_mean", "shape_corr", "sign_hit_rate_vs_level7"]
    head = "| " + " | ".join(cols) + " |\n|" + "---|" * len(cols) + "\n"
    body = ""
    for _, r in s.iterrows():
        body += "| " + " | ".join(f"{r[c]:.1f}" if isinstance(r[c], float) and "corr" not in c and "rate" not in c else (f"{r[c]:.2f}" if isinstance(r[c], float) else str(r[c])) for c in cols) + " |\n"
    return ("All errors in DKK/MWh (divide by 10 for øre/kWh). lead_days = days ahead of 'today' (tomorrow = 1 is published).\n"
            "mae_perfect_weather = same model fed with the weather that actually occurred (isolates weather-forecast error).\n"
            "shape_corr = mean within-day correlation between predicted and actual hourly profile.\n"
            "sign_hit_rate_vs_level7 = how often the model correctly says whether the day will be above or below the last 7 days' mean.\n\n" + head + body)


# ----------------------------------------------------------------------------- synthetic data (offline smoke test)
def synthetic(days: int, max_lead: int, areas: list[str]):
    rng = np.random.default_rng(0)
    end = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    times = pd.date_range(end - timedelta(days=days), end, freq="h", tz="UTC")
    n = len(times)
    hours = np.arange(n)
    wind_true = {g: np.clip(9 + 6 * np.sin(hours / 41 + o) + 3 * np.sin(hours / 7 + 2 * o) + rng.normal(0, 0.5, n), 0, None) for g, o in [("dk1", 0), ("dk2", 0.4), ("de", 1.1)]}
    wrows = []
    for name, _, _, g in POINTS:
        for lead in range(0, max_lead + 1):
            noise = rng.normal(0, 0.6 * lead, n)  # forecast error grows with lead
            wrows.append(pd.DataFrame({"time": times, "point": name, "lead": lead, "wind": np.clip(wind_true[g] + noise, 0, None),
                                       "ghi": np.maximum(0, 600 * np.sin(np.pi * ((hours % 24) - 6) / 13)) * (((hours % 24) >= 6) & ((hours % 24) <= 19)),
                                       "temp": 10 + 4 * np.sin((hours % 24 - 8) / 24 * 2 * np.pi)}))
    weather = pd.concat(wrows, ignore_index=True)
    prows = []
    for area in areas:
        cf = power_curve(wind_true["dk1" if area == "DK1" else "dk2"])
        cfde = power_curve(wind_true["de"])
        local_hour = (times.tz_convert(TZ).hour.to_numpy())
        demand = 1 + 0.35 * np.sin((local_hour - 9) / 24 * 2 * np.pi)
        residual = demand - 0.6 * cf - 0.5 * cfde
        price = 200 + 900 * np.maximum(0, residual) ** 1.5 - 150 * np.maximum(0, -residual) + rng.normal(0, 25, n)
        prows.append(pd.DataFrame({"area": area, "time": times, "price": price}))
    return pd.concat(prows, ignore_index=True), weather


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--areas", nargs="+", default=["DK1", "DK2"])
    ap.add_argument("--eval-days", type=int, default=60, help="number of forecast origins (days) to evaluate")
    ap.add_argument("--previous-days", type=int, default=92, help="days of Open-Meteo previous-run history (max 92)")
    ap.add_argument("--archive-days", type=int, default=180, help="extra ERA5 days before that for training (0 = off)")
    ap.add_argument("--retrain-every", type=int, default=7)
    ap.add_argument("--leads", nargs="+", type=int, default=[2, 3, 4, 5, 6, 7])
    ap.add_argument("--out", default="results")
    ap.add_argument("--synthetic", action="store_true", help="offline smoke test with fake data")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    max_lead = max(args.leads)

    if args.synthetic:
        prices, weather_raw = synthetic(days=args.previous_days, max_lead=max_lead, areas=args.areas)
    else:
        today = datetime.now(TZ).date()
        start_prev = today - timedelta(days=args.previous_days)
        print(f"Fetching prices {start_prev - timedelta(days=args.archive_days)} .. {today + timedelta(days=2)} ...", flush=True)
        prices = fetch_prices(start_prev - timedelta(days=args.archive_days), today + timedelta(days=2), args.areas)
        print(f"  {len(prices)} hourly rows", flush=True)
        print(f"Fetching Open-Meteo previous runs ({args.previous_days} days, {len(POINTS)} points, leads 0..{max_lead}) ...", flush=True)
        weather_raw = fetch_previous_runs(args.previous_days, max_lead)
        if args.archive_days > 0:
            print(f"Fetching ERA5 archive for {args.archive_days} extra days ...", flush=True)
            arch = fetch_archive(start_prev - timedelta(days=args.archive_days), start_prev - timedelta(days=1))
            weather_raw = pd.concat([arch, weather_raw], ignore_index=True)
    weather = aggregate_weather(weather_raw)
    print(f"Weather table: {len(weather)} (time, lead) rows", flush=True)

    all_preds, all_sum = [], []
    for area in args.areas:
        print(f"Backtesting {area} ...", flush=True)
        preds = run_backtest(prices, weather, area, args.eval_days, args.retrain_every, args.leads)
        if preds.empty:
            print(f"  no predictions for {area} (not enough overlapping data)")
            continue
        all_preds.append(preds)
        all_sum.append(summarise(preds))
    if not all_preds:
        sys.exit("Nothing evaluated.")
    preds = pd.concat(all_preds, ignore_index=True)
    summary = pd.concat(all_sum, ignore_index=True)
    preds.to_csv(out / "predictions.csv", index=False)
    summary.to_csv(out / "summary.csv", index=False)
    md = to_markdown(summary)
    (out / "summary.md").write_text(md, encoding="utf-8")
    print("\n" + md)
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(figsize=(7, 4))
        for area, g in summary.groupby("area"):
            ax.plot(g["lead_days"], g["mae_model"] / 10, marker="o", label=f"{area} model")
            ax.plot(g["lead_days"], g["mae_persistence"] / 10, marker="x", linestyle="--", label=f"{area} persistence")
            ax.plot(g["lead_days"], g["mae_perfect_weather"] / 10, marker=".", linestyle=":", label=f"{area} perfect weather")
        ax.set_xlabel("days ahead of today")
        ax.set_ylabel("MAE, øre/kWh (hourly)")
        ax.set_title("Day-ahead price forecast error vs lead time")
        ax.grid(alpha=0.3)
        ax.legend(fontsize=8)
        fig.tight_layout()
        fig.savefig(out / "mae_by_lead.png", dpi=130)
        print(f"Saved {out / 'mae_by_lead.png'}")
    except Exception as e:  # noqa: BLE001
        print(f"(no plot: {e})")


if __name__ == "__main__":
    main()
