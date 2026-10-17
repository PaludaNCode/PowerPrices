# PowerPrices – Danish electricity prices, today, tomorrow and a few days ahead

> **Status: parked.** [elpriser.org](https://elpriser.org/) already delivers exactly what this
> site set out to do, so the automatic sync and deployment are switched off. Everything is kept
> working: run *Actions → "Sync data and deploy site" → Run workflow* for a one-off refresh, or
> restore the `schedule`/`push` triggers in `.github/workflows/sync.yml` to turn it back on.

A small static website hosted on **GitHub Pages**, kept up to date by a **GitHub Actions job**
that runs a few times a day. It shows the Danish day-ahead ("spot") electricity price for
**DK1 (West)** and **DK2 (East)**, optionally with grid tariffs, Energinet tariffs, electricity
tax and VAT added, and a **2–7 day outlook** taken from elpriser.org's public forecast. Every
day's forecast is archived in the repo, and the site measures how well the forecast actually hit.

The site's UI is in Danish. This README is in English.

## How it works

```
GitHub Actions (cron, 6×/day)            GitHub Pages (static)            Browser
┌──────────────────────────────┐   ┌──────────────────────────┐   ┌─────────────────────┐
│ scripts/sync.py              │   │ index.html, js/, css/    │   │ reads data/*.json   │
│  • Energi Data Service       │──▶│ data/prices.json         │──▶│ renders charts,     │
│    DayAheadPrices (15 min)   │   │ data/tariffs.json        │   │ "now", cheapest     │
│    DatahubPricelist (tariffs)│   │ data/forecast.json       │   │ hours, outlook,     │
│  • elpriser.org forecast     │   │ data/skill.json          │   │ forecast track      │
│  • scores archived forecasts │   │ data/history/...         │   │ record              │
└──────────────────────────────┘   └──────────────────────────┘   └─────────────────────┘
```

* The browser never calls an external API, so CORS, rate limits and API outages do not affect
  visitors; at worst the page shows data from the last successful sync, with its timestamp.
* The sync commits `data/` back to the branch only when something changed (roughly 1–3 commits a
  day) and then deploys the repository root to GitHub Pages.
* Tomorrow's prices are published around 13:00 Danish time, so the schedule runs at 11:20, 12:20
  and 13:20 UTC (covers summer and winter time, with retries), plus 04:20, 15:20 and 19:20 UTC
  for forecast refreshes. GitHub's cron can be a few minutes late; the page shows the sync time.

| Path | What |
|---|---|
| `index.html`, `css/style.css` | The page (light/dark, mobile friendly) |
| `js/app.js` | Rendering from the JSON files; Chart.js is loaded from cdnjs |
| `js/tariffs.js` | Price composition helpers, Danish holidays, time-zone helpers |
| `config/grid-companies.json` | Grid companies (netselskaber): GLN + DatahubPricelist charge codes |
| `scripts/sync.py` | The sync job (standard library only) |
| `.github/workflows/sync.yml` | Schedule, commit of `data/`, Pages deployment |
| `test/page_test.mjs` | Offline browser test with synthetic data |
| `data/` | Written by the sync job (do not edit by hand) |

## Setup

1. **Pages:** repository *Settings → Pages → Build and deployment → Source: GitHub Actions*.
   (GitHub Pages on a private repository requires a paid plan; public repositories are free.)
2. **Default branch:** scheduled workflows only run on the default branch. Merge this branch
   into `main`/`master` (or make it the default) so the cron fires.
3. **First run:** *Actions → "Sync data and deploy site" → Run workflow*. It fetches the data,
   commits `data/`, and deploys the site. Check `data/meta.json` (also printed in the job log)
   for what succeeded.

Run the sync locally with `python3 scripts/sync.py` (writes to `data/`), or `--mock` for
synthetic data without network access.

## Data files

* `data/prices.json` – hourly means of the 15-minute day-ahead prices (DKK/MWh), last 14 days,
  today and tomorrow once published (`has_tomorrow`).
* `data/tariffs.json` – current/future `DatahubPricelist` rows for Energinet (codes 40000, 41000,
  EA-001) and for every grid company in `config/grid-companies.json`.
* `data/forecast.json` – elpriser.org's forecast (spot ex VAT, converted to DKK/MWh, UTC hours),
  with `kind` = `actual` for days already published and `forecast` otherwise.
* `data/history/prices/YYYY-MM-DD.json` – archive of actual prices, one file per day.
* `data/history/forecasts/YYYY-MM-DD.json` – the forecast as of that day (last sync of the day).
* `data/skill.json` – forecast vs. actual, per area and lead time (days after the forecast day):
  hourly MAE, daily-mean MAE, bias and how often the forecast got the direction right relative
  to the previous week. It fills up as days pass.
* `data/meta.json` – sync time, which steps succeeded, errors.

## How the price is set (the short version)

1. The spot price shown by Norlys ("FlexEl") and everyone else is the result of the **day-ahead
   auction** on Nord Pool, coupled with the other European exchanges (EPEX etc.) in the single
   day-ahead coupling (SDAC).
2. Every day before **12:00 CET** (gate closure) producers, large consumers and traders submit
   orders for each of the 96 quarter-hours of the **following day** (15-minute resolution since
   1 October 2025; hourly before).
3. The coupling algorithm (Euphemia) finds, per quarter-hour and bidding zone, the price where
   supply meets demand, subject to interconnector capacity.
4. Results are published around **12:45–13:00 CET**. Nobody can show the day after tomorrow,
   because that auction has not run yet.

The price is a **marginal price**: every producer that runs gets the price of the most expensive
unit needed to cover demand ("merit order"). Wind, solar and nuclear bid close to zero, hydro bids
the value of saving its water, coal and gas plants bid fuel + CO₂ and sit at the top. Lots of wind
→ cheap (sometimes negative) prices; no wind → gas plants, often in Germany, set the price.

Denmark has two zones, DK1 (Jutland/Funen) and DK2 (Zealand and the islands east of the Great
Belt), both coupled to Germany, Norway, Sweden, the Netherlands and Great Britain. When the cables
are not congested, DK1 usually follows the German price and DK2 the south-Swedish (SE4) price.

| Driver | Time scale | Forecastable 2–5 days out? |
|---|---|---|
| Wind in DK and northern Germany | hours–days | Yes, reasonably (weather models) |
| Solar | hours–days, seasonal | Yes |
| Demand (hour, weekday/holiday, temperature) | hours–days | Yes |
| Gas (TTF) and CO₂ (EUA) prices | weeks–months | Assume unchanged |
| Nordic hydro reservoir levels | weeks–months | Assume unchanged |
| Interconnector / plant outages | sudden | No (unless pre-announced) |

### What you pay per kWh (2026)

`(spot + grid tariff + Energinet transmission & system tariff + elafgift) × 1.25 VAT + supplier markup`

* Grid tariff: time-differentiated per grid company (low at night, high by day, peak 17–21,
  highest in winter). Taken from `DatahubPricelist`.
* Energinet consumer tariffs: ~11.5 øre/kWh in total in 2026 (after Energinet's tariff cap).
* Elafgift: temporarily cut to **0.8 øre/kWh for 2026–2027** (normally ~72.7 øre/kWh).

## Can you guess prices 2–5 days ahead?

**Partly, yes.** The slow drivers (gas, CO₂, hydro, outages) can be assumed constant a few days
out, so the question is mostly the weather forecast, which is useful up to about 5 days. You can
expect to get the level of a day (cheap / normal / expensive) and its shape (when it is cheapest)
right, not the exact øre in a given hour, and the error grows with every day of lead time.

Rather than building a forecaster, the site uses a public one and keeps score:

* [elpriser.org/prognose](https://elpriser.org/prognose) – free, keyless API, quantile LightGBM on
  weather forecasts, DK1/DK2, 2–9 days, retrained daily (model card: `Elpriser/denmark-price-forecast`
  on Hugging Face). **Used by this site.** Best-effort uptime, no SLA.
* [Carnot.dk](https://www.carnot.dk/) – 5 days, API key required. Could be added to the sync job
  with the key stored as a repository secret.
* [energypriceforecast.eu](https://energypriceforecast.eu/) – 5 days, DK1/DK2.

The scoreboard in `data/skill.json` (shown on the page under "Hvor godt rammer prognosen?") is
the empirical answer to the question, and it gets better the longer the sync runs.

## Offline test

```bash
npm install --no-save playwright chart.js && npx playwright install chromium
node test/page_test.mjs            # synthetic data from scripts/sync.py --mock
node test/page_test.mjs no-data    # no data files at all → graceful notices
```

## Known limitations

* The grid-company charge-code table needs occasional maintenance when companies rename codes.
  If your company is missing, add it to `config/grid-companies.json` (find your GLN on eloverblik.dk).
* 15-minute prices are shown as hourly averages.
* The sync script was validated with synthetic payloads in the real APIs' shapes; the first live
  run is the real test – see the job log and `data/meta.json`.
