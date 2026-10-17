// A small, transparent price model that runs in the browser.
//
// Idea: for the next 2-7 days the only thing that changes a lot and is forecastable
// is the weather. Gas/CO2 prices, hydro levels and plant outages move slowly, so a
// model trained on the LAST FEW WEEKS of actual prices implicitly carries the current
// "price regime". We therefore fit, every time the page loads:
//
//   price(hour) ~ f(wind in own area, wind in Germany, solar, temperature, hour, off-day)
//
// on the last ~6 weeks (ridge regression with piecewise-linear wind terms, blended with
// a nearest-neighbour "analog hours" estimate), check it on a 7-day holdout, then
// apply it to Open-Meteo's weather forecast for the coming days.

import { localParts, isOffDay } from "./tariffs.js";

export const WEATHER_POINTS = [
  // DK1 (Jylland/Fyn) onshore
  { name: "Ringkøbing", lat: 56.09, lon: 8.24, group: "dk1" },
  { name: "Esbjerg", lat: 55.47, lon: 8.45, group: "dk1" },
  { name: "Aalborg", lat: 57.05, lon: 9.92, group: "dk1" },
  { name: "Herning", lat: 56.14, lon: 8.98, group: "dk1" },
  { name: "Odense", lat: 55.40, lon: 10.39, group: "dk1" },
  // DK1 offshore
  { name: "Horns Rev", lat: 55.50, lon: 7.80, group: "dk1" },
  { name: "Anholt", lat: 56.60, lon: 11.20, group: "dk1" },
  // DK2 (Sjælland, Lolland-Falster, Bornholm)
  { name: "København", lat: 55.68, lon: 12.57, group: "dk2" },
  { name: "Kalundborg", lat: 55.68, lon: 11.09, group: "dk2" },
  { name: "Nakskov", lat: 54.83, lon: 11.13, group: "dk2" },
  { name: "Kriegers Flak", lat: 55.00, lon: 12.90, group: "dk2" },
  { name: "Rødsand", lat: 54.55, lon: 11.70, group: "dk2" },
  // Northern Germany (Denmark's biggest trading partner)
  { name: "Schleswig", lat: 54.30, lon: 9.50, group: "de" },
  { name: "Cuxhaven", lat: 53.87, lon: 8.70, group: "de" },
  { name: "Rostock", lat: 54.10, lon: 12.10, group: "de" },
  { name: "Tyske Bugt", lat: 54.20, lon: 7.00, group: "de" },
  { name: "Hannover", lat: 52.40, lon: 9.70, group: "de" },
];

// Approximate fleet-aggregated wind power curve: 100 m wind speed (m/s) -> capacity factor.
const CURVE = [[0, 0], [3, 0], [4, 0.03], [5, 0.08], [6, 0.16], [7, 0.27], [8, 0.40], [9, 0.54],
  [10, 0.67], [11, 0.78], [12, 0.87], [13, 0.93], [14, 0.97], [15, 1], [24, 1], [26, 0.3], [30, 0]];
export function powerCurve(v) {
  if (v == null || Number.isNaN(v)) return null;
  if (v <= 0) return 0;
  for (let i = 1; i < CURVE.length; i++) {
    if (v <= CURVE[i][0]) {
      const [x0, y0] = CURVE[i - 1], [x1, y1] = CURVE[i];
      return y0 + ((v - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return 0;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/** Collapse per-point weather series into per-hour group features: Map(epochMs -> {wDK1,wDK2,wDE,solar,temp}). */
export function buildWeatherTable(series) {
  const table = new Map();
  if (!series.length) return table;
  const n = series[0].time.length;
  for (let i = 0; i < n; i++) {
    const t = series[0].time[i];
    const g = { dk1: [], dk2: [], de: [] }, solar = [], temp = [];
    let ok = true;
    for (const s of series) {
      if (s.time[i] !== t) { ok = false; break; }
      const cf = powerCurve(s.wind100[i]);
      if (cf == null) continue;
      g[s.group].push(cf);
      if (s.group !== "de") {
        if (s.ghi[i] != null) solar.push(s.ghi[i]);
        if (s.temp[i] != null) temp.push(s.temp[i]);
      }
    }
    if (!ok || !g.dk1.length || !g.dk2.length || !g.de.length || !temp.length) continue;
    table.set(t, { wDK1: mean(g.dk1), wDK2: mean(g.dk2), wDE: mean(g.de), solar: (mean(solar) ?? 0) / 1000, temp: mean(temp) });
  }
  return table;
}

const hinge = (x, k) => Math.max(0, x - k);
const block = (h) => (h < 6 ? 0 : h < 11 ? 1 : h < 16 ? 2 : 3);

/** Ridge-regression feature row (see header comment). */
export function featureRow(area, t, w) {
  const p = localParts(t);
  const off = isOffDay(p.date, p.dow) ? 1 : 0;
  const wLocal = area === "DK2" ? w.wDK2 : w.wDK1;
  const wOther = area === "DK2" ? w.wDK1 : w.wDK2;
  const wAll = 0.5 * (wLocal + w.wDE);
  const row = [1];
  for (let h = 1; h < 24; h++) row.push(p.hour === h ? 1 : 0);
  for (let b = 0; b < 4; b++) row.push(off && block(p.hour) === b ? 1 : 0);
  row.push(wLocal, hinge(wLocal, 0.2), hinge(wLocal, 0.4), hinge(wLocal, 0.6));
  row.push(wOther);
  row.push(w.wDE, hinge(w.wDE, 0.2), hinge(w.wDE, 0.4), hinge(w.wDE, 0.6));
  for (let b = 0; b < 4; b++) row.push(block(p.hour) === b ? wAll : 0);
  row.push(w.solar);
  row.push(w.temp, hinge(12 - w.temp, 0));
  return row;
}

/** Scaled coordinates for the nearest-neighbour ("analog hours") estimate. */
export function knnRow(area, t, w) {
  const p = localParts(t);
  const off = isOffDay(p.date, p.dow) ? 1 : 0;
  const wLocal = area === "DK2" ? w.wDK2 : w.wDK1;
  const ang = (2 * Math.PI * p.hour) / 24;
  return [3 * wLocal, 2 * w.wDE, 1.5 * w.solar, 0.05 * w.temp, 1.0 * off, 1.5 * Math.sin(ang), 1.5 * Math.cos(ang)];
}

/** Solve (XᵀX + λI)β = Xᵀy with column standardisation (intercept in column 0). */
export function fitRidge(X, y, lambda = 0.5) {
  const n = X.length, p = X[0].length;
  const mu = new Array(p).fill(0), sd = new Array(p).fill(1);
  for (let j = 1; j < p; j++) {
    let s = 0; for (let i = 0; i < n; i++) s += X[i][j]; mu[j] = s / n;
    let v = 0; for (let i = 0; i < n; i++) v += (X[i][j] - mu[j]) ** 2; sd[j] = Math.sqrt(v / n) || 1;
  }
  const Z = X.map((r) => r.map((x, j) => (j === 0 ? 1 : (x - mu[j]) / sd[j])));
  const A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < n; i++) {
    const r = Z[i];
    for (let a = 0; a < p; a++) {
      const ra = r[a];
      if (ra === 0) continue;
      const Aa = A[a];
      for (let b = 0; b < p; b++) Aa[b] += ra * r[b];
      Aa[p] += ra * y[i];
    }
  }
  for (let j = 1; j < p; j++) A[j][j] += lambda * n / 100;
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k];
    }
  }
  const beta = A.map((row, j) => row[p] / (row[j] || 1e-12));
  return (row) => {
    let s = beta[0];
    for (let j = 1; j < p; j++) s += beta[j] * ((row[j] - mu[j]) / sd[j]);
    return s;
  };
}

/** Inverse-distance-weighted k-nearest-neighbour regressor. */
export function fitKnn(K, y, k = 12) {
  return (q) => {
    const d = new Array(K.length);
    for (let i = 0; i < K.length; i++) {
      let s = 0; const r = K[i];
      for (let j = 0; j < q.length; j++) s += (r[j] - q[j]) ** 2;
      d[i] = [Math.sqrt(s), i];
    }
    d.sort((a, b) => a[0] - b[0]);
    let ws = 0, acc = 0;
    for (let m = 0; m < Math.min(k, d.length); m++) {
      const w = 1 / (d[m][0] + 0.05);
      ws += w; acc += w * y[d[m][1]];
    }
    return ws ? acc / ws : null;
  };
}

function fitBlend(samples, area) {
  const X = samples.map((s) => featureRow(area, s.t, s.w));
  const K = samples.map((s) => knnRow(area, s.t, s.w));
  const y = samples.map((s) => s.y);
  const ridge = fitRidge(X, y), knn = fitKnn(K, y);
  return (t, w) => 0.5 * ridge(featureRow(area, t, w)) + 0.5 * knn(knnRow(area, t, w));
}

const mae = (pairs) => (pairs.length ? mean(pairs.map(([a, b]) => Math.abs(a - b))) : null);

/**
 * Train on hourly prices (DKK/MWh) + weather table, evaluate on a holdout, then forecast.
 * @param {string} area "DK1"|"DK2"
 * @param {{t:number,dkk:number}[]} hourlyPrices known day-ahead prices (any range)
 * @param {Map} weather from buildWeatherTable (past + forecast hours)
 * @returns forecast in øre/kWh with evaluation details
 */
export function trainAndForecast({ area, hourlyPrices, weather, holdoutDays = 7, trainDays = 42 }) {
  const byDate = new Map(); // local date -> samples
  for (const r of hourlyPrices) {
    const w = weather.get(r.t);
    if (!w) continue;
    const d = localParts(r.t).date;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push({ t: r.t, w, y: r.dkk / 10 }); // øre/kWh
  }
  const dates = [...byDate.keys()].sort().filter((d) => byDate.get(d).length >= 20);
  const useDates = dates.slice(-trainDays);
  if (useDates.length < holdoutDays + 10) throw new Error(`For få dage med både priser og vejr (${useDates.length})`);

  // Holdout evaluation: train on the first part, test on the last `holdoutDays` days.
  const trainDates = useDates.slice(0, -holdoutDays), testDates = useDates.slice(-holdoutDays);
  const trainSamples = trainDates.flatMap((d) => byDate.get(d));
  const predictHold = fitBlend(trainSamples, area);
  const lastTrain = byDate.get(trainDates[trainDates.length - 1]);
  const byHourLastTrain = new Map(lastTrain.map((s) => [localParts(s.t).hour, s.y]));
  const pairsModel = [], pairsPersist = [], pairsWeek = [], pairsDailyMean = [], holdout = [];
  for (const d of testDates) {
    const samples = byDate.get(d);
    let sumA = 0, sumP = 0;
    for (const s of samples) {
      const p = predictHold(s.t, s.w);
      pairsModel.push([p, s.y]); sumA += s.y; sumP += p;
      holdout.push({ t: s.t, pred: p, actual: s.y });
      const h = localParts(s.t).hour;
      if (byHourLastTrain.has(h)) pairsPersist.push([byHourLastTrain.get(h), s.y]);
      const weekAgo = byDate.get(localParts(s.t - 7 * 86400000).date);
      const wk = weekAgo?.find((x) => localParts(x.t).hour === h);
      if (wk) pairsWeek.push([wk.y, s.y]);
    }
    pairsDailyMean.push([sumP / samples.length, sumA / samples.length]);
  }
  const residuals = pairsModel.map(([p, a]) => a - p);
  const sigma = Math.sqrt(mean(residuals.map((r) => r * r)) || 0);
  const evaluation = {
    testDates, nTrainDays: trainDates.length, holdout,
    maeModel: mae(pairsModel), maePersist: mae(pairsPersist), maeWeekAgo: mae(pairsWeek), maeDailyMean: mae(pairsDailyMean), sigma,
  };

  // Final fit on everything, then forecast every weather hour after the last known price.
  const allSamples = useDates.flatMap((d) => byDate.get(d));
  const predict = fitBlend(allSamples, area);
  const lastKnown = Math.max(...hourlyPrices.map((r) => r.t));
  const todayDate = localParts(Date.now()).date;
  const forecast = [];
  for (const [t, w] of [...weather.entries()].sort((a, b) => a[0] - b[0])) {
    if (t <= lastKnown) continue;
    const p = localParts(t);
    // leadDay = calendar days ahead of today (tomorrow = 1, which is normally already published)
    const leadDay = Math.round((Date.parse(p.date) - Date.parse(todayDate)) / 86400000);
    const band = sigma * (1 + 0.15 * Math.max(0, leadDay - 2));
    const pred = predict(t, w);
    const wLocal = area === "DK2" ? w.wDK2 : w.wDK1;
    forecast.push({ t, pred, lo: pred - band, hi: pred + band, leadDay, date: p.date, hour: p.hour, wind: 0.5 * (wLocal + w.wDE), solar: w.solar, temp: w.temp });
  }

  // Daily reference levels from the training window (for cheap/normal/expensive labels).
  const dailyMeans = useDates.map((d) => mean(byDate.get(d).map((s) => s.y))).sort((a, b) => a - b);
  const q = (f) => dailyMeans[Math.min(dailyMeans.length - 1, Math.floor(f * dailyMeans.length))];
  const terciles = { low: q(1 / 3), high: q(2 / 3), median: q(0.5) };

  return { evaluation, forecast, terciles, trainedDates: useDates, lastKnown };
}

/** Group a forecast into per-local-date summaries. */
export function summariseByDay(forecast, terciles) {
  const days = new Map();
  for (const f of forecast) {
    if (!days.has(f.date)) days.set(f.date, []);
    days.get(f.date).push(f);
  }
  return [...days.entries()].map(([date, rows]) => {
    const preds = rows.map((r) => r.pred);
    const avg = mean(preds);
    return {
      date, hours: rows.length, leadDay: rows[0].leadDay, avg, min: Math.min(...preds), max: Math.max(...preds),
      wind: mean(rows.map((r) => r.wind)), solar: mean(rows.map((r) => r.solar)), temp: mean(rows.map((r) => r.temp)),
      label: avg < terciles.low ? "billig" : avg > terciles.high ? "dyr" : "normal",
      cheapestHour: rows.reduce((a, b) => (b.pred < a.pred ? b : a)).hour,
      priciestHour: rows.reduce((a, b) => (b.pred > a.pred ? b : a)).hour,
    };
  });
}
