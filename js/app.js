// UI orchestration for the static site. Everything runs in the browser.
import { GRID_COMPANIES, ENERGINET_CHARGES, FALLBACK_CHARGES_DKK_PER_KWH, VAT, localParts, hourlyTariff } from "./tariffs.js";
import { fetchDayAheadPrices, toHourly, fetchPricelist, fetchWeather, fetchExternalForecast } from "./api.js";
import { WEATHER_POINTS, buildWeatherTable, trainAndForecast, summariseByDay } from "./model.js";

const $ = (id) => document.getElementById(id);
const HOUR = 3600000, DAY = 86400000;
const nf1 = new Intl.NumberFormat("da-DK", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 });
const dayFmt = new Intl.DateTimeFormat("da-DK", { timeZone: "Europe/Copenhagen", weekday: "short", day: "numeric", month: "numeric" });
const timeFmt = new Intl.DateTimeFormat("da-DK", { timeZone: "Europe/Copenhagen", hour: "2-digit", minute: "2-digit" });

const state = {
  area: "DK1", inclAll: false, gln: "", markup: 0,
  prices: null, pricesSource: "",
  charges: { energinet: null, grid: new Map(), energinetFallback: false },
  outlook: { history: null, weather: null, results: new Map(), external: new Map(), error: null, loading: true },
  charts: {},
};

// ---------- small helpers ----------
const fmtOre = (x) => (x == null || Number.isNaN(x) ? "–" : nf1.format(x));
function addDays(dateStr, n) {
  return new Date(Date.parse(dateStr + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
}
/** Epoch (ms) of the start of a local hour in Europe/Copenhagen. */
export function localHourToEpoch(dateStr, hour) {
  const [y, m, d] = dateStr.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d, hour);
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess);
    const actual = Date.UTC(...p.date.split("-").map((v, j) => (j === 1 ? Number(v) - 1 : Number(v))), p.hour);
    const diff = Date.UTC(y, m - 1, d, hour) - actual;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}
const todayStr = () => localParts(Date.now()).date;
const currentHourEpoch = () => Math.floor(Date.now() / HOUR) * HOUR;
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const areaColor = () => cssVar(state.area === "DK2" ? "--dk2" : "--dk1");
const withAlpha = (hex, a) => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
function notice(el, kind, html) { el.innerHTML = html ? `<div class="notice ${kind}">${html}</div>` : ""; }
function chartDefaults() {
  if (!globalThis.Chart) return false;
  Chart.defaults.color = cssVar("--muted");
  Chart.defaults.borderColor = cssVar("--line");
  Chart.defaults.font.family = cssVar("--font") || Chart.defaults.font.family;
  return true;
}

// ---------- settings ----------
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("powerprices") || "{}");
    if (s.area === "DK1" || s.area === "DK2") state.area = s.area;
    if (typeof s.inclAll === "boolean") state.inclAll = s.inclAll;
    if (typeof s.gln === "string") state.gln = s.gln;
    if (typeof s.markup === "number") state.markup = s.markup;
  } catch { /* storage unavailable */ }
}
function saveSettings() {
  try { localStorage.setItem("powerprices", JSON.stringify({ area: state.area, inclAll: state.inclAll, gln: state.gln, markup: state.markup })); } catch { /* ignore */ }
}

// ---------- charges (tariffs & taxes) ----------
async function ensureEnerginetCharges() {
  if (state.charges.energinet) return;
  try {
    const rows = await fetchPricelist({ codes: ENERGINET_CHARGES.codes, glns: ENERGINET_CHARGES.glns, chargeType: null, limit: 300 });
    const byCode = {};
    for (const r of rows) (byCode[r.ChargeTypeCode] ||= []).push(r);
    if (!ENERGINET_CHARGES.codes.every((c) => byCode[c]?.length)) throw new Error("ufuldstændige rækker");
    state.charges.energinet = byCode;
  } catch (e) {
    console.warn("Energinet charges fallback:", e);
    state.charges.energinet = null;
    state.charges.energinetFallback = true;
  }
}
async function ensureGridCharges(gln) {
  if (!gln || state.charges.grid.has(gln)) return;
  const company = GRID_COMPANIES.find((c) => c.gln === gln);
  try {
    const rows = await fetchPricelist({ codes: company.codes, glns: [gln], chargeType: "D03", limit: 300 });
    state.charges.grid.set(gln, rows.length ? rows : null);
  } catch (e) {
    console.warn("Grid tariff fetch failed:", e);
    state.charges.grid.set(gln, null);
  }
}
/** Additions (øre/kWh, ex VAT) per local hour for a date: { grid, net, system, tax, total[24], fallback, gridMissing } */
function chargesFor(dateStr) {
  const out = { grid: null, net: null, system: null, tax: null, total: new Array(24).fill(0), fallback: false, gridMissing: false };
  const codeHours = (code) => {
    const rows = state.charges.energinet?.[code];
    const h = rows ? hourlyTariff(rows, dateStr) : null;
    if (h) return h.map((v) => v * 100);
    out.fallback = true;
    return new Array(24).fill(FALLBACK_CHARGES_DKK_PER_KWH[code] * 100);
  };
  out.net = codeHours("40000"); out.system = codeHours("41000"); out.tax = codeHours("EA-001");
  if (state.gln) {
    const rows = state.charges.grid.get(state.gln);
    const h = rows ? hourlyTariff(rows, dateStr) : null;
    if (h) out.grid = h.map((v) => v * 100); else out.gridMissing = true;
  }
  for (let h = 0; h < 24; h++) out.total[h] = out.net[h] + out.system[h] + out.tax[h] + (out.grid ? out.grid[h] : 0);
  return out;
}
/** Convert a spot price (øre/kWh ex VAT) at a local date/hour to the displayed price. */
function displayPrice(spotOre, dateStr, hour, chargeCache) {
  if (!state.inclAll) return spotOre;
  const c = chargeCache.get(dateStr) || chargeCache.set(dateStr, chargesFor(dateStr)).get(dateStr);
  return (spotOre + c.total[hour]) * VAT + state.markup;
}

// ---------- today & tomorrow ----------
async function loadPrices() {
  const today = todayStr();
  try {
    const { records, source } = await fetchDayAheadPrices(today, addDays(today, 2));
    state.prices = toHourly(records);
    state.pricesSource = source;
  } catch (e) {
    state.prices = null;
    notice($("prices-notice"), "bad", `Kunne ikke hente priser: ${e.message}`);
    $("prices-sub").textContent = "ingen data";
  }
  renderPrices();
}

function renderPrices() {
  if (!state.prices) return;
  const today = todayStr(), tomorrow = addDays(today, 1);
  const rows = (state.prices.get(state.area) || []).map((r) => ({ ...r, ...localParts(r.t) })).filter((r) => r.date === today || r.date === tomorrow);
  const chargeCache = new Map();
  for (const r of rows) { r.spot = r.dkk / 10; r.shown = displayPrice(r.spot, r.date, r.hour, chargeCache); }
  const hasTomorrow = rows.some((r) => r.date === tomorrow);
  const nowT = currentHourEpoch();
  const unit = state.inclAll ? "øre/kWh inkl. moms" : "øre/kWh ekskl. moms";
  $("prices-sub").textContent = `${state.area === "DK1" ? "Vestdanmark" : "Østdanmark"} · ${unit} · opdateret ${timeFmt.format(new Date())}`;

  // Notices
  const notes = [];
  if (!hasTomorrow) {
    const h = localParts(Date.now()).hour;
    notes.push(h < 13 ? "Morgendagens priser er ikke offentliggjort endnu. Day-ahead-auktionen på Nord Pool lukker kl. 12:00, og resultatet kommer normalt kl. ca. 12:45–13:00. Siden opdaterer automatisk." : "Morgendagens priser er endnu ikke tilgængelige i Energi Data Service – de plejer at komme kl. ca. 13:00. Prøv igen om lidt.");
  }
  const cc = chargeCache.get(today) || chargesFor(today);
  if (state.inclAll && cc.fallback) notes.push("Energinets tariffer og elafgiften kunne ikke hentes fra DataHub-prislisten – der bruges omtrentlige 2026-satser.");
  if (state.inclAll && cc.gridMissing) notes.push("Nettariffen for det valgte netselskab kunne ikke hentes – prisen vises uden nettarif.");
  if (state.inclAll && !state.gln) notes.push("Vælg dit netselskab for at få nettariffen med. Uden valg vises spotpris + Energinets tariffer + elafgift + moms.");
  notice($("prices-notice"), hasTomorrow ? "info" : "warn", notes.join("<br>"));

  // Stats
  const stat = (k, v, s = "") => `<div class="stat"><div class="k">${k}</div><div class="v">${v}${s ? ` <small>${s}</small>` : ""}</div></div>`;
  const agg = (list) => (list.length ? { avg: list.reduce((a, r) => a + r.shown, 0) / list.length, min: Math.min(...list.map((r) => r.shown)), max: Math.max(...list.map((r) => r.shown)) } : null);
  const tRows = rows.filter((r) => r.date === today), mRows = rows.filter((r) => r.date === tomorrow);
  const now = rows.find((r) => r.t === nowT);
  const ta = agg(tRows), ma = agg(mRows);
  const future = rows.filter((r) => r.t >= nowT);
  let best = null;
  for (let i = 0; i + 3 <= future.length; i++) {
    if (future[i + 2].t - future[i].t !== 2 * HOUR) continue;
    const avg = (future[i].shown + future[i + 1].shown + future[i + 2].shown) / 3;
    if (!best || avg < best.avg) best = { avg, from: future[i] };
  }
  $("prices-stats").innerHTML = [
    stat("Lige nu", now ? fmtOre(now.shown) : "–", "øre/kWh"),
    stat("I dag · gennemsnit", ta ? fmtOre(ta.avg) : "–", ta ? `min ${fmtOre(ta.min)} · max ${fmtOre(ta.max)}` : ""),
    stat("I morgen · gennemsnit", ma ? fmtOre(ma.avg) : "kommer ca. kl. 13", ma ? `min ${fmtOre(ma.min)} · max ${fmtOre(ma.max)}` : ""),
    stat("Billigste 3 timer i træk", best ? `${dayFmt.format(new Date(best.from.t))} kl. ${String(best.from.hour).padStart(2, "0")}–${String((best.from.hour + 3) % 24).padStart(2, "0")}` : "–", best ? `gns. ${fmtOre(best.avg)} øre/kWh` : ""),
  ].join("");
  $("prices-source").textContent = `Kilde: ${state.pricesSource}. 15-minutters priser er vist som timegennemsnit.`;

  // Composition for the current hour
  if (now) {
    const c = chargeCache.get(now.date) || chargesFor(now.date);
    const grid = c.grid ? c.grid[now.hour] : null;
    const exVat = now.spot + c.total[now.hour];
    const company = GRID_COMPANIES.find((g) => g.gln === state.gln);
    const line = (k, v, note = "") => `<tr><td>${k}</td><td class="num">${fmtOre(v)}</td><td class="muted">${note}</td></tr>`;
    $("composition-body").innerHTML = `<table><thead><tr><th>Komponent (kl. ${String(now.hour).padStart(2, "0")}–${String((now.hour + 1) % 24).padStart(2, "0")})</th><th class="num">øre/kWh</th><th></th></tr></thead><tbody>
      ${line("Spotpris (day-ahead)", now.spot, `Nord Pool, ${state.area}`)}
      ${line(`Nettarif${company ? " – " + company.name : ""}`, grid, company ? (grid == null ? "kunne ikke hentes" : "tidsdifferentieret, fra DataHub-prislisten") : "vælg netselskab")}
      ${line("Transmissionsnettarif (Energinet)", c.net[now.hour], c.fallback ? "omtrentlig" : "DataHub-prislisten")}
      ${line("Systemtarif (Energinet)", c.system[now.hour], c.fallback ? "omtrentlig" : "DataHub-prislisten")}
      ${line("Elafgift", c.tax[now.hour], c.fallback ? "omtrentlig (nedsat 2026–27)" : "nedsat til 0,8 øre i 2026–27")}
      ${line("Moms 25 %", exVat * 0.25, "")}
      ${line("Eltillæg (din elhandler)", state.markup, "indtastet, inkl. moms")}
      <tr><th>I alt</th><th class="num">${fmtOre(exVat * VAT + state.markup)}</th><th></th></tr>
    </tbody></table>`;
  } else {
    $("composition-body").innerHTML = `<p class="muted">Ingen pris for den aktuelle time.</p>`;
  }

  // Chart
  if (!chartDefaults()) return;
  const color = areaColor();
  const labels = rows.map((r) => `${r.date === today ? "I dag" : "I morgen"} ${String(r.hour).padStart(2, "0")}`);
  const bg = rows.map((r) => (r.t === nowT ? cssVar("--accent") : withAlpha(color, r.date === today ? 0.75 : 0.4)));
  state.charts.prices?.destroy();
  state.charts.prices = new Chart($("prices-chart"), {
    type: "bar",
    data: { labels, datasets: [{ label: unit, data: rows.map((r) => r.shown), backgroundColor: bg, borderWidth: 0, borderRadius: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: (items) => { const r = rows[items[0].dataIndex]; return `${dayFmt.format(new Date(r.t))} kl. ${String(r.hour).padStart(2, "0")}–${String((r.hour + 1) % 24).padStart(2, "0")}`; }, label: (item) => ` ${fmtOre(item.parsed.y)} ${unit}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, callback: (v, i) => { const r = rows[i]; return r.hour % 6 === 0 ? (r.hour === 0 ? dayFmt.format(new Date(r.t)) : String(r.hour).padStart(2, "0")) : ""; } } },
        y: { title: { display: true, text: "øre/kWh" }, grid: { color: cssVar("--line") } },
      },
    },
  });
}

// ---------- outlook (2–7 days) ----------
async function loadOutlook() {
  const today = todayStr();
  const o = state.outlook;
  try {
    const [prices, weather] = await Promise.all([
      fetchDayAheadPrices(addDays(today, -42), addDays(today, 2)),
      fetchWeather(WEATHER_POINTS, { pastDays: 44, forecastDays: 8 }),
    ]);
    o.history = toHourly(prices.records);
    o.weather = buildWeatherTable(weather);
    o.historySource = prices.source;
    if (!o.weather.size) throw new Error("Vejrdata var tomme");
  } catch (e) {
    o.error = e.message;
  }
  o.loading = false;
  renderOutlook();
  // External comparison is optional and loads in the background.
  for (const area of ["DK1", "DK2"]) {
    fetchExternalForecast(area, localHourToEpoch).then((ext) => { o.external.set(area, ext); if (area === state.area) renderOutlook(); });
  }
}

function outlookFor(area) {
  const o = state.outlook;
  if (o.results.has(area)) return o.results.get(area);
  let res;
  try {
    res = trainAndForecast({ area, hourlyPrices: o.history.get(area) || [], weather: o.weather });
  } catch (e) {
    res = { error: e.message };
  }
  o.results.set(area, res);
  return res;
}

function renderOutlook() {
  const o = state.outlook;
  const el = $("outlook-notice");
  if (o.loading) return;
  if (o.error) { notice(el, "bad", `Udsigten kunne ikke beregnes: ${o.error}`); return; }
  const res = outlookFor(state.area);
  if (res.error) { notice(el, "bad", `Udsigten kunne ikke beregnes: ${res.error}`); return; }
  const ev = res.evaluation;
  const skill = ev.maePersist ? 1 - ev.maeModel / ev.maePersist : null;
  notice(el, "info", `Modellen er trænet på ${res.trainedDates.length} dage og rammer i testen ${skill != null ? `${nf0.format(skill * 100)} % bedre` : "–"} end "samme time som sidste kendte dag". Gæt ud over 5 dage er meget usikre.`);

  // Daily table
  const days = summariseByDay(res.forecast, res.terciles).filter((d) => d.hours >= 20);
  $("outlook-table").innerHTML = `<thead><tr><th>Dag</th><th class="num">Dage frem</th><th class="num">Gns.</th><th class="num">Min</th><th class="num">Max</th><th>Billigst</th><th>Dyrest</th><th class="num">Vind</th><th>Vurdering</th></tr></thead><tbody>${days.map((d) => `<tr>
      <td>${dayFmt.format(new Date(localHourToEpoch(d.date, 12)))}</td><td class="num">${d.leadDay}</td>
      <td class="num">${fmtOre(d.avg)}</td><td class="num">${fmtOre(d.min)}</td><td class="num">${fmtOre(d.max)}</td>
      <td>kl. ${String(d.cheapestHour).padStart(2, "0")}</td><td>kl. ${String(d.priciestHour).padStart(2, "0")}</td>
      <td class="num">${nf0.format(d.wind * 100)} %</td><td><span class="pill ${d.label}">${d.label}</span></td></tr>`).join("")}</tbody>
    <tfoot><tr><td colspan="9" class="muted">Spotpris i øre/kWh ekskl. tariffer og moms. "Vind" er den forventede kapacitetsfaktor for vindmøller i ${state.area} og Nordtyskland (100 % = alle møller på fuld kraft). Vurderingen er i forhold til de seneste 6 ugers dagsgennemsnit (laveste/højeste tredjedel).</td></tr></tfoot>`;

  // Evaluation text
  $("outlook-eval").innerHTML = `<p>Modellen blev trænet på ${ev.nTrainDays} dage og derefter bedt om at gætte priserne for de 7 dage ${dayFmt.format(new Date(localHourToEpoch(ev.testDates[0], 12)))} – ${dayFmt.format(new Date(localHourToEpoch(ev.testDates.at(-1), 12)))} uden at kende dem. Gennemsnitlig fejl pr. time (MAE), øre/kWh:</p>
    <table><tbody>
      <tr><td>Denne model</td><td class="num"><strong>${fmtOre(ev.maeModel)}</strong></td></tr>
      <tr><td>"Samme time som sidste kendte dag" (persistens)</td><td class="num">${fmtOre(ev.maePersist)}</td></tr>
      <tr><td>"Samme time, samme ugedag i sidste uge"</td><td class="num">${fmtOre(ev.maeWeekAgo)}</td></tr>
      <tr><td>Denne model, fejl på dagsgennemsnittet</td><td class="num">${fmtOre(ev.maeDailyMean)}</td></tr>
    </tbody></table>
    <p class="muted">Bemærk: testen bruger det vejr, der faktisk blev (Open-Meteos korte prognoser), ikke vejrudsigten 2–5 dage i forvejen. Den rigtige fejl på en udsigt flere dage frem er derfor større – hvor meget, måles med <code>analysis/backtest.py</code> i repoet.</p>`;

  // Chart
  if (!chartDefaults()) return;
  const hist = (o.history.get(state.area) || []);
  const holdByT = new Map(ev.holdout.map((h) => [h.t, h.pred]));
  const fcByT = new Map(res.forecast.map((f) => [f.t, f]));
  const extRaw = o.external.get(state.area);
  const extByT = new Map((extRaw || []).filter((x) => x.kind === "forecast" && x.t > res.lastKnown).map((x) => [x.t, x.dkk / 10]));
  const t0 = Math.min(...ev.holdout.map((h) => h.t)), t1 = Math.max(...res.forecast.map((f) => f.t));
  const ts = []; for (let t = t0; t <= t1; t += HOUR) ts.push(t);
  const histByT = new Map(hist.map((h) => [h.t, h.dkk / 10]));
  const nowT = currentHourEpoch();
  const color = areaColor(), accent = cssVar("--accent"), muted = cssVar("--muted");
  const ds = [
    { label: "Usikkerhed (øvre)", data: ts.map((t) => fcByT.get(t)?.hi ?? null), borderWidth: 0, pointRadius: 0, fill: "+1", backgroundColor: withAlpha(accent, 0.15), tension: 0.2 },
    { label: "Usikkerhed (nedre)", data: ts.map((t) => fcByT.get(t)?.lo ?? null), borderWidth: 0, pointRadius: 0, fill: false, tension: 0.2 },
    { label: "Faktisk day-ahead-pris", data: ts.map((t) => histByT.get(t) ?? null), borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, tension: 0.2 },
    { label: "Modellens gæt (test, seneste 7 dage)", data: ts.map((t) => holdByT.get(t) ?? null), borderColor: muted, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
    { label: "Modellens gæt (udsigt)", data: ts.map((t) => fcByT.get(t)?.pred ?? null), borderColor: accent, backgroundColor: accent, borderWidth: 2, pointRadius: 0, tension: 0.2 },
  ];
  if (extByT.size) ds.push({ label: "elpriser.org prognose", data: ts.map((t) => extByT.get(t) ?? null), borderColor: "#8e44ad", borderDash: [2, 3], borderWidth: 1.5, pointRadius: 0, tension: 0.2 });
  state.charts.outlook?.destroy();
  state.charts.outlook = new Chart($("outlook-chart"), {
    type: "line",
    data: { labels: ts, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, spanGaps: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { filter: (item) => !item.text.startsWith("Usikkerhed") } },
        tooltip: { callbacks: { title: (items) => { const t = ts[items[0].dataIndex]; const p = localParts(t); return `${dayFmt.format(new Date(t))} kl. ${String(p.hour).padStart(2, "0")}`; }, label: (item) => (item.parsed.y == null ? null : ` ${item.dataset.label}: ${fmtOre(item.parsed.y)} øre/kWh`) } },
      },
      scales: {
        x: { grid: { color: (ctx) => (ts[ctx.index] === nowT ? accent : localParts(ts[ctx.index] ?? 0).hour === 0 ? cssVar("--line") : "transparent") }, ticks: { autoSkip: false, maxRotation: 0, callback: (v, i) => (localParts(ts[i]).hour === 0 ? dayFmt.format(new Date(ts[i])) : "") } },
        y: { title: { display: true, text: "øre/kWh (spot)" }, grid: { color: cssVar("--line") } },
      },
    },
  });
}

// ---------- wiring ----------
function initControls() {
  const sel = $("grid-select");
  sel.innerHTML = `<option value="">– ikke valgt –</option>` + GRID_COMPANIES.map((c) => `<option value="${c.gln}">${c.name}</option>`).join("");
  sel.value = state.gln;
  $("incl-all").checked = state.inclAll;
  $("markup").value = String(state.markup);
  for (const b of $("area-seg").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.area === state.area));

  $("area-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-area]");
    if (!b) return;
    state.area = b.dataset.area;
    for (const x of $("area-seg").querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
    saveSettings(); renderPrices(); renderOutlook();
  });
  $("incl-all").addEventListener("change", async (e) => {
    state.inclAll = e.target.checked; saveSettings();
    await Promise.all([ensureEnerginetCharges(), ensureGridCharges(state.gln)]);
    renderPrices();
  });
  sel.addEventListener("change", async (e) => {
    state.gln = e.target.value; saveSettings();
    await ensureGridCharges(state.gln);
    renderPrices();
  });
  $("markup").addEventListener("input", (e) => { state.markup = Number(e.target.value) || 0; saveSettings(); renderPrices(); });
}

async function main() {
  loadSettings();
  initControls();
  if (!globalThis.Chart) notice($("prices-notice"), "warn", "Diagrambiblioteket (Chart.js) kunne ikke hentes – tal vises uden grafer.");
  $("clock").textContent = `Dansk tid ${timeFmt.format(new Date())}`;
  const chargesReady = state.inclAll ? Promise.all([ensureEnerginetCharges(), ensureGridCharges(state.gln)]) : Promise.resolve();
  await Promise.all([chargesReady.then(loadPrices), loadOutlook()]);
  // Refresh prices every 10 minutes (picks up tomorrow's prices after ~13:00) and the highlight every minute.
  setInterval(loadPrices, 10 * 60000);
  setInterval(() => { $("clock").textContent = `Dansk tid ${timeFmt.format(new Date())}`; if (state.prices) renderPrices(); }, 60000);
}

main().catch((e) => { console.error(e); notice($("prices-notice"), "bad", `Uventet fejl: ${e.message}`); });
