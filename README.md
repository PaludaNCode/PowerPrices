# PowerPrices – Danish electricity prices, today, tomorrow and a few days ahead

A small static website (plain HTML/CSS/JS, no build step, no server) that shows the Danish
day-ahead ("spot") electricity price for **DK1 (West)** and **DK2 (East)**, optionally with
grid tariffs, Energinet tariffs, electricity tax and VAT added, plus an **experimental
weather-based outlook 2–7 days ahead** – together with an investigation of *how* the price is
set and *whether* it can be guessed several days ahead.

The site's UI is in Danish. This README is in English.

## Contents

| Path | What |
|---|---|
| `index.html`, `css/style.css` | The page and its styling (light/dark, mobile friendly) |
| `js/api.js` | Data access: Energi Data Service, elpriser.org (fallback), Open-Meteo |
| `js/tariffs.js` | Grid-company table (GLN + charge codes), Energinet charges, Danish holidays, time-zone helpers |
| `js/model.js` | The in-browser price model (ridge regression + nearest-neighbour blend) |
| `js/app.js` | UI wiring, charts (Chart.js from cdnjs) |
| `analysis/backtest.py` | A proper backtest of 2–7-day-ahead forecasting skill using archived weather forecasts |

## Running it

It is a static site. Either open `index.html` directly in a browser, or serve the folder:

```bash
python3 -m http.server 8000     # then open http://localhost:8000/
```

To publish, enable **GitHub Pages** for the repository (Settings → Pages → Deploy from a branch,
branch `main`/`master`, folder `/ (root)`). No build step is needed.

All data is fetched by the browser directly from public, keyless APIs:

* **Energi Data Service** (Energinet, CC BY 4.0) – `DayAheadPrices` (15-minute day-ahead prices,
  replaced `Elspotprices` on 1 Oct 2025) and `DatahubPricelist` (tariffs and taxes).
* **Open-Meteo** (CC BY 4.0) – hourly wind (100 m), solar radiation and temperature forecasts for
  17 points in Denmark, offshore and northern Germany.
* **elpriser.org** – used as a fallback source for prices if Energi Data Service cannot be reached
  from the browser, and to overlay its own 7-day forecast as an external comparison.

Settings (price area, grid company, markup) are kept in `localStorage` only.

## How the price is set (the short version)

1. The spot price shown by Norlys ("FlexEl") and everyone else is the result of the **day-ahead
   auction** on Nord Pool, which is coupled with the other European exchanges (EPEX etc.) in the
   single day-ahead coupling (SDAC).
2. Every day before **12:00 CET** (gate closure) producers, large consumers and traders submit
   buy/sell orders for each of the 96 quarter-hours of the **following day** (15-minute
   resolution since 1 October 2025; hourly before).
3. The coupling algorithm (Euphemia) finds, for each quarter-hour and each bidding zone, the
   price where supply meets demand, subject to the capacity of the interconnectors.
4. Results are published around **12:45–13:00 CET**. That is why nobody can show the day after
   tomorrow: that auction has not run yet.

The price is a **marginal price**: every producer that runs gets the price of the most expensive
unit needed to cover demand ("merit order"). Wind, solar and nuclear bid close to zero, hydro bids
the value of saving its water, coal and gas plants bid fuel + CO₂ costs and sit at the top. Lots of
wind → cheap (sometimes negative) prices; no wind → gas plants, often in Germany, set the price.

Denmark has two zones, DK1 (Jutland/Funen) and DK2 (Zealand and the islands east of the Great
Belt), both coupled to Germany, Norway, Sweden, the Netherlands and Great Britain. When the cables
are not congested, DK1 usually follows the German price and DK2 the south-Swedish (SE4) price.

### What drives the level

| Driver | Time scale | Forecastable 2–5 days out? |
|---|---|---|
| Wind in DK and northern Germany | hours–days | Yes, reasonably (weather models) |
| Solar | hours–days, seasonal | Yes |
| Demand (hour of day, weekday/holiday, temperature) | hours–days | Yes (calendar + temperature forecast) |
| Gas (TTF) and CO₂ (EUA) prices | weeks–months | Assume unchanged |
| Nordic hydro reservoir levels | weeks–months | Assume unchanged |
| Interconnector / plant outages (UMMs) | sudden | No (unless pre-announced) |

### What you pay per kWh (2026)

`(spot + grid tariff + Energinet transmission & system tariff + elafgift) × 1.25 VAT + supplier markup`

* Grid tariff: time-differentiated per grid company (low at night, high by day, peak 17–21,
  highest in winter). Fetched live from `DatahubPricelist`; see the GLN/charge-code table in
  `js/tariffs.js` (adapted from the MTrab/energidataservice Home Assistant integration).
* Energinet consumer tariffs: ~11.5 øre/kWh in total in 2026 (after Energinet's tariff cap).
* Elafgift: temporarily cut to **0.8 øre/kWh for 2026–2027** (normally ~72.7 øre/kWh).

## Can you guess prices 2–5 days ahead?

**Partly, yes.** The slow drivers (gas, CO₂, hydro, outages) can be assumed constant a few days
out, so the question is mostly the weather forecast. Wind forecasts are good 1–3 days ahead and
useful up to 5–6 days; beyond that it is statistics.

* You *can* get: the level of the day (cheap / normal / expensive), the shape of the day (when it
  is cheapest), and whether negative prices are likely.
* You *cannot* get: the exact øre/kWh in a given hour, price spikes when Germany is short, or the
  effect of sudden outages.
* Errors grow with lead time; at 6–7 days the guess is not much better than "like last week".

Others already do this with heavier models, and the site shows one of them for comparison:

* [elpriser.org/prognose](https://elpriser.org/prognose) – free, quantile LightGBM, DK1/DK2, 2–9 days, retrained daily
  (open model card on Hugging Face: `Elpriser/denmark-price-forecast`)
* [Carnot.dk](https://www.carnot.dk/) – 5 days, API key required (Home Assistant integration exists)
* [energypriceforecast.eu](https://energypriceforecast.eu/) – 5 days, DK1/DK2
* [nordpool-predict-fi](https://github.com/vividfog/nordpool-predict-fi) – open-source Finnish equivalent (random forest on weather, nuclear, hydro, transmission)
* Energi Danmark's weekly "Fokus" market letter – qualitative outlook

### The model in the site (`js/model.js`)

Trained in the browser every time the page loads:

* **Target:** hourly day-ahead price (øre/kWh) for the chosen area, last 42 days.
* **Features:** wind capacity factor (own area, other DK area, northern Germany) from 100 m wind
  speed through a generic fleet power curve; solar radiation; temperature; hour of day; weekend/
  holiday × time-of-day block.
* **Model:** ridge regression with hinge (piecewise-linear) wind terms, blended 50/50 with an
  inverse-distance-weighted 12-nearest-neighbour estimate ("analog hours").
* **Why only 42 days:** the price *level* set by gas/CO₂/hydro changes slowly; training on recent
  data lets the model inherit the current regime without modelling those drivers.
* **Self-check:** before the final fit the model is trained on the first 35 days and tested on the
  last 7, and the page shows its MAE against two naive baselines (same hour of the last known
  day; same hour one week earlier). Note that this test uses the weather that *actually occurred*
  (Open-Meteo's short-range data), so it is an upper bound on multi-day skill.
* **Uncertainty band:** holdout residual spread, widened 15 % per day of lead – indicative only.

### The real backtest (`analysis/backtest.py`)

Measures honest multi-day skill by using the weather forecasts that were *issued* 2–7 days
before each target day (Open-Meteo Previous Runs API), with one LightGBM model per lead time and
a rolling forecast origin over the last N days:

```bash
cd analysis
pip install -r requirements.txt
python backtest.py                      # DK1 + DK2, 60 forecast origins, leads 2..7 days
python backtest.py --areas DK1 --eval-days 30 --archive-days 0
python backtest.py --synthetic          # offline smoke test with fake data (no network)
```

Outputs `results/summary.md` (MAE per lead vs. persistence and "same weekday last week",
plus a "perfect weather" variant that isolates the weather-forecast error), `predictions.csv`
and `mae_by_lead.png`.

The script was validated end-to-end on synthetic data; it has not yet been run against the live
APIs from the environment this repository was created in (outbound network was restricted), so
the first real run may surface API quirks – please report them.

## Known limitations / to do

* The grid-company charge-code table needs occasional maintenance when companies rename codes.
  If your company is missing, add a line to `GRID_COMPANIES` in `js/tariffs.js` (find your GLN on
  eloverblik.dk).
* Energinet's 2026 tariff reform splits the transmission tariff for *TSO-connected* consumers into
  a capacity part and a spot-dependent loss part; households still see a per-kWh figure through
  `DatahubPricelist`, which is what the site uses. Fallback constants are approximate.
* The page shows 15-minute prices as hourly averages.
* Open-Meteo's free tier is generous but each page load costs ~17 location-requests; fine for
  personal use, not for a high-traffic site.

## Offline test

`test/page_test.mjs` serves the site locally and replaces every external API with synthetic
data (Playwright route interception), so the whole page – including the model – can be
exercised without network access:

```bash
npm install --no-save playwright chart.js && npx playwright install chromium
node test/page_test.mjs            # scenario "ok"
node test/page_test.mjs eds-down   # Energi Data Service unreachable → elpriser.org fallback
node test/page_test.mjs all-down   # everything unreachable → error notices, no crashes
```
