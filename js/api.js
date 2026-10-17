// Data access. All sources are free, public and keyless, and are called straight
// from the browser (the site is static). Base URLs can be overridden by defining
// window.POWERPRICES_CONFIG before the app loads, which is used by the mock-server test.

const DEFAULTS = {
  eds: "https://api.energidataservice.dk/dataset",
  elpriser: "https://elpriser.org/api",
  openMeteo: "https://api.open-meteo.com/v1/forecast",
  fetchTimeoutMs: 20000,
};

export function config() {
  return { ...DEFAULTS, ...(globalThis.POWERPRICES_CONFIG || {}) };
}

async function getJSON(url, { timeoutMs } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs ?? config().fetchTimeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} fra ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function edsUrl(dataset, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    q.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return `${config().eds}/${dataset}?${q.toString()}`;
}

/** Parse "2026-10-17T22:00:00" (EDS TimeUTC, no zone suffix) to epoch ms. */
export function parseEdsUtc(s) {
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
}

/**
 * Day-ahead prices for the given local dates [startDate, endDate) as a list of
 *   { t: epochMs, area: "DK1"|"DK2", dkk: DKK/MWh }
 * at the dataset's native 15-minute resolution. Tries Energi Data Service first and
 * falls back to elpriser.org's raw proxy of the same dataset.
 */
export async function fetchDayAheadPrices(startDate, endDate, areas = ["DK1", "DK2"]) {
  const errors = [];
  try {
    const url = edsUrl("DayAheadPrices", {
      start: startDate, end: endDate,
      filter: { PriceArea: areas },
      columns: "TimeUTC,PriceArea,DayAheadPriceDKK,DayAheadPriceEUR",
      sort: "TimeUTC asc",
      limit: 100000,
    });
    const data = await getJSON(url);
    const recs = normaliseRecords(data);
    if (recs.length) return { records: recs, source: "Energi Data Service" };
    errors.push("Energi Data Service returnerede ingen rækker");
  } catch (e) {
    errors.push(`Energi Data Service: ${e.message}`);
  }
  try {
    const out = [];
    for (const area of areas) {
      const url = `${config().elpriser}/raw/prices?area=${area}&start=${startDate}&end=${endDate}`;
      out.push(...normaliseRecords(await getJSON(url)).filter((r) => r.area === area));
    }
    if (out.length) return { records: out, source: "elpriser.org (proxy for Energi Data Service)" };
    errors.push("elpriser.org returnerede ingen rækker");
  } catch (e) {
    errors.push(`elpriser.org: ${e.message}`);
  }
  throw new Error(errors.join(" · "));
}

function normaliseRecords(data) {
  const recs = Array.isArray(data) ? data : data?.records || [];
  const out = [];
  for (const r of recs) {
    if (r.DayAheadPriceDKK == null || !r.TimeUTC) continue;
    out.push({ t: parseEdsUtc(r.TimeUTC), area: r.PriceArea, dkk: Number(r.DayAheadPriceDKK), eur: r.DayAheadPriceEUR == null ? null : Number(r.DayAheadPriceEUR) });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Aggregate 15-minute records to hourly means: Map(area -> [{t, dkk, n}]) keyed by hour epoch. */
export function toHourly(records) {
  const byArea = new Map();
  for (const r of records) {
    const hourT = Math.floor(r.t / 3600000) * 3600000;
    let m = byArea.get(r.area);
    if (!m) byArea.set(r.area, (m = new Map()));
    const cur = m.get(hourT) || { t: hourT, sum: 0, n: 0 };
    cur.sum += r.dkk; cur.n += 1;
    m.set(hourT, cur);
  }
  const out = new Map();
  for (const [area, m] of byArea) {
    out.set(area, [...m.values()].sort((a, b) => a.t - b.t).map((x) => ({ t: x.t, dkk: x.sum / x.n, n: x.n })));
  }
  return out;
}

/** Charge rows (DatahubPricelist) for the given charge-type codes, optionally limited to GLNs. */
export async function fetchPricelist({ codes, glns, chargeType = "D03", limit = 500 }) {
  const filter = { ChargeTypeCode: codes };
  if (glns?.length) filter.GLN_Number = glns;
  if (chargeType) filter.ChargeType = [chargeType];
  try {
    const data = await getJSON(edsUrl("DatahubPricelist", { filter, sort: "ValidFrom desc", limit }));
    return data?.records || [];
  } catch (e) {
    // Fallback: elpriser.org proxies the same DatahubPricelist rows.
    //   /raw/encharges            -> Energinet's 40000, 41000 and EA-001 rows
    //   /raw/tariff?gln=<GLN>     -> all tariff rows of one grid company
    const isEnerginet = codes.every((c) => ["40000", "41000", "EA-001"].includes(c));
    const url = isEnerginet ? `${config().elpriser}/raw/encharges` : `${config().elpriser}/raw/tariff?gln=${glns?.[0] || ""}`;
    if (!isEnerginet && !glns?.length) throw e;
    const data = await getJSON(url);
    const rows = Array.isArray(data) ? data : data?.records || [];
    return rows.filter((r) => codes.includes(r.ChargeTypeCode) && (!glns?.length || glns.includes(String(r.GLN_Number))));
  }
}

/**
 * Open-Meteo hourly weather for several points in one request.
 * Returns [{ lat, lon, group, time: [epochMs], wind100: [m/s], ghi: [W/m2], temp: [°C] }].
 */
export async function fetchWeather(points, { pastDays = 42, forecastDays = 7 } = {}) {
  const q = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(","),
    longitude: points.map((p) => p.lon).join(","),
    hourly: "wind_speed_100m,shortwave_radiation,temperature_2m",
    wind_speed_unit: "ms",
    timezone: "UTC",
    timeformat: "unixtime",
    past_days: String(pastDays),
    forecast_days: String(forecastDays),
  });
  const data = await getJSON(`${config().openMeteo}?${q}`, { timeoutMs: 30000 });
  const list = Array.isArray(data) ? data : [data];
  if (list.length !== points.length) throw new Error(`Open-Meteo svarede med ${list.length} punkter, forventede ${points.length}`);
  return list.map((d, i) => ({
    ...points[i],
    time: d.hourly.time.map((s) => s * 1000),
    wind100: d.hourly.wind_speed_100m,
    ghi: d.hourly.shortwave_radiation,
    temp: d.hourly.temperature_2m,
  }));
}

/**
 * elpriser.org's own 7-day forecast (quantile LightGBM, retrained daily), used as an
 * external comparison. Returns [{ t: epochMs (local hour start), dkk: DKK/MWh, kind: "actual"|"forecast" }]
 * or null when unavailable. Shape: { area, mode, days: [{ date, type, prices: [{ hour, price }] }] }.
 */
export async function fetchExternalForecast(area, localHourToEpoch) {
  try {
    const data = await getJSON(`${config().elpriser}/forecast?area=${area}&mode=spot_ex`);
    if (!Array.isArray(data?.days)) return null;
    const out = [];
    for (const d of data.days) {
      for (const p of d.prices || []) {
        if (p?.price == null || p.hour == null) continue;
        const t = localHourToEpoch(d.date, Number(p.hour));
        if (t == null) continue;
        out.push({ t, dkk: Number(p.price) * 1000, kind: String(d.type || "").startsWith("actual") || d.type === "official" ? "actual" : "forecast" });
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out.length ? out : null;
  } catch {
    return null;
  }
}
