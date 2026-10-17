// UI for the static site. All data comes from the JSON files that scripts/sync.py writes
// into data/ (prices, tariffs, elpriser.org's forecast, forecast skill); no external API is
// called from the browser.
import { ENERGINET_CHARGES, FALLBACK_CHARGES_DKK_PER_KWH, VAT, localParts, hourlyTariff } from "./tariffs.js";

const $ = (id) => document.getElementById(id);
const HOUR = 3600000, DAY = 86400000;
const nf1 = new Intl.NumberFormat("da-DK", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 });
const dayFmt = new Intl.DateTimeFormat("da-DK", { timeZone: "Europe/Copenhagen", weekday: "short", day: "numeric", month: "numeric" });
const timeFmt = new Intl.DateTimeFormat("da-DK", { timeZone: "Europe/Copenhagen", hour: "2-digit", minute: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat("da-DK", { timeZone: "Europe/Copenhagen", weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

const state = {
  area: "DK1", inclAll: false, gln: "", markup: 0,
  companies: [], meta: null, prices: null, tariffs: null, forecast: null, skill: null,
  charts: {},
};

// ---------- helpers ----------
const fmtOre = (x) => (x == null || Number.isNaN(x) ? "–" : nf1.format(x));
const pad2 = (n) => String(n).padStart(2, "0");
function addDays(dateStr, n) { return new Date(Date.parse(dateStr + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10); }
/** Epoch (ms) of the start of a local hour in Europe/Copenhagen. */
function localHourToEpoch(dateStr, hour) {
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
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function notice(el, kind, html) { el.innerHTML = html ? `<div class="notice ${kind}">${html}</div>` : ""; }
function chartDefaults() {
  if (!globalThis.Chart) return false;
  Chart.defaults.color = cssVar("--muted");
  Chart.defaults.borderColor = cssVar("--line");
  Chart.defaults.font.family = cssVar("--font") || Chart.defaults.font.family;
  return true;
}
async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}
/** Rows of {t: epochMs, dkk} for an area from a data file. */
const areaRows = (doc, area) => (doc?.areas?.[area] || []).map((r) => ({ ...r, t: Date.parse(r.t) }));

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
/** Additions (øre/kWh, ex VAT) per local hour for a date. */
function chargesFor(dateStr) {
  const out = { grid: null, net: null, system: null, tax: null, total: new Array(24).fill(0), fallback: false, gridMissing: false };
  const codeHours = (code) => {
    const rows = state.tariffs?.energinet?.[code];
    const h = rows ? hourlyTariff(rows, dateStr) : null;
    if (h) return h.map((v) => v * 100);
    out.fallback = true;
    return new Array(24).fill(FALLBACK_CHARGES_DKK_PER_KWH[code] * 100);
  };
  out.net = codeHours("40000"); out.system = codeHours("41000"); out.tax = codeHours("EA-001");
  if (state.gln) {
    const rows = state.tariffs?.grid?.[state.gln];
    const h = rows?.length ? hourlyTariff(rows, dateStr) : null;
    if (h) out.grid = h.map((v) => v * 100); else out.gridMissing = true;
  }
  for (let h = 0; h < 24; h++) out.total[h] = out.net[h] + out.system[h] + out.tax[h] + (out.grid ? out.grid[h] : 0);
  return out;
}
function displayPrice(spotOre, dateStr, hour, cache) {
  if (!state.inclAll) return spotOre;
  const c = cache.get(dateStr) || cache.set(dateStr, chargesFor(dateStr)).get(dateStr);
  return (spotOre + c.total[hour]) * VAT + state.markup;
}

// ---------- status line ----------
function renderStatus() {
  const m = state.meta;
  const el = $("sync-status");
  if (!m) { el.textContent = "Ingen synkroniserede data endnu."; notice($("global-notice"), "warn", globalThis.Chart ? "" : "Diagrambiblioteket (Chart.js) kunne ikke hentes – tal vises uden grafer."); return; }
  const t = Date.parse(m.synced_at);
  const ageH = (Date.now() - t) / HOUR;
  let txt = `Data opdateret ${dateTimeFmt.format(new Date(t))}`;
  if (m.mock) txt += " (testdata)";
  el.textContent = txt;
  const problems = [];
  if (!globalThis.Chart) problems.push("Diagrambiblioteket (Chart.js) kunne ikke hentes – tal vises uden grafer.");
  if (ageH > 26) problems.push(`Der er ikke kommet nye data i ${nf0.format(ageH)} timer – synkroniseringen (GitHub Actions) ser ud til at have stået stille.`);
  if (m.errors?.length) problems.push(`Seneste synkronisering fejlede delvist: ${m.errors.map((e) => e.split(":")[0]).join(", ")}.`);
  notice($("global-notice"), "warn", problems.join("<br>"));
}

// ---------- today & tomorrow ----------
function renderPrices() {
  const today = todayStr(), tomorrow = addDays(today, 1);
  if (!state.prices) {
    $("prices-sub").textContent = "ingen data";
    notice($("prices-notice"), "bad", "Priserne er ikke hentet endnu. Kør synkroniseringen (GitHub Actions → “Sync data and deploy site”), så dukker de op her.");
    return;
  }
  const rows = areaRows(state.prices, state.area).map((r) => ({ ...r, ...localParts(r.t) })).filter((r) => r.date === today || r.date === tomorrow);
  const cache = new Map();
  for (const r of rows) { r.spot = r.dkk / 10; r.shown = displayPrice(r.spot, r.date, r.hour, cache); }
  const hasToday = rows.some((r) => r.date === today), hasTomorrow = rows.some((r) => r.date === tomorrow);
  const nowT = currentHourEpoch();
  const unit = state.inclAll ? "øre/kWh inkl. moms" : "øre/kWh ekskl. moms";
  $("prices-sub").textContent = `${state.area === "DK1" ? "Vestdanmark" : "Østdanmark"} · ${unit}`;

  const notes = [];
  if (!hasToday) notes.push("Dagens priser mangler i de synkroniserede data – synkroniseringen er bagud.");
  if (!hasTomorrow) {
    const h = localParts(Date.now()).hour;
    notes.push(h < 13
      ? "Morgendagens priser er ikke offentliggjort endnu. Day-ahead-auktionen på Nord Pool lukker kl. 12:00, resultatet kommer kl. ca. 12:45–13:00, og siden synkroniserer kort efter."
      : "Morgendagens priser er endnu ikke synkroniseret. De plejer at være klar kl. ca. 13:00; næste synkronisering henter dem.");
  }
  const cc = cache.get(today) || chargesFor(today);
  if (state.inclAll && cc.fallback) notes.push("Energinets tariffer og elafgiften mangler i de synkroniserede data – der bruges omtrentlige 2026-satser.");
  if (state.inclAll && cc.gridMissing) notes.push("Nettariffen for det valgte netselskab mangler – prisen vises uden nettarif.");
  if (state.inclAll && !state.gln) notes.push("Vælg dit netselskab for at få nettariffen med. Uden valg vises spotpris + Energinets tariffer + elafgift + moms.");
  notice($("prices-notice"), hasTomorrow && hasToday ? "info" : "warn", notes.join("<br>"));

  const stat = (k, v, s = "") => `<div class="stat"><div class="k">${k}</div><div class="v">${v}${s ? ` <small>${s}</small>` : ""}</div></div>`;
  const agg = (list) => (list.length ? { avg: mean(list.map((r) => r.shown)), min: Math.min(...list.map((r) => r.shown)), max: Math.max(...list.map((r) => r.shown)) } : null);
  const ta = agg(rows.filter((r) => r.date === today)), ma = agg(rows.filter((r) => r.date === tomorrow));
  const now = rows.find((r) => r.t === nowT);
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
    stat("Billigste 3 timer i træk", best ? `${dayFmt.format(new Date(best.from.t))} kl. ${pad2(best.from.hour)}–${pad2((best.from.hour + 3) % 24)}` : "–", best ? `gns. ${fmtOre(best.avg)} øre/kWh` : ""),
  ].join("");
  $("prices-source").textContent = `Kilde: ${state.prices.source}. Priser hentet ${dateTimeFmt.format(new Date(Date.parse(state.prices.updated)))}.`;

  if (now) {
    const c = cache.get(now.date) || chargesFor(now.date);
    const grid = c.grid ? c.grid[now.hour] : null;
    const exVat = now.spot + c.total[now.hour];
    const company = state.companies.find((g) => g.gln === state.gln);
    const line = (k, v, note = "") => `<tr><td>${k}</td><td class="num">${fmtOre(v)}</td><td class="muted">${note}</td></tr>`;
    $("composition-body").innerHTML = `<table><thead><tr><th>Komponent (kl. ${pad2(now.hour)}–${pad2((now.hour + 1) % 24)})</th><th class="num">øre/kWh</th><th></th></tr></thead><tbody>
      ${line("Spotpris (day-ahead)", now.spot, `Nord Pool, ${state.area}`)}
      ${line(`Nettarif${company ? " – " + company.name : ""}`, grid, company ? (grid == null ? "mangler" : "tidsdifferentieret, DataHub-prislisten") : "vælg netselskab")}
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

  if (!chartDefaults()) return;
  const color = areaColor();
  const bg = rows.map((r) => (r.t === nowT ? cssVar("--accent") : withAlpha(color, r.date === today ? 0.75 : 0.4)));
  state.charts.prices?.destroy();
  state.charts.prices = new Chart($("prices-chart"), {
    type: "bar",
    data: { labels: rows.map((r) => `${r.date === today ? "I dag" : "I morgen"} ${pad2(r.hour)}`), datasets: [{ label: unit, data: rows.map((r) => r.shown), backgroundColor: bg, borderWidth: 0, borderRadius: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: (items) => { const r = rows[items[0].dataIndex]; return `${dayFmt.format(new Date(r.t))} kl. ${pad2(r.hour)}–${pad2((r.hour + 1) % 24)}`; }, label: (item) => ` ${fmtOre(item.parsed.y)} ${unit}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, callback: (v, i) => { const r = rows[i]; return r.hour % 6 === 0 ? (r.hour === 0 ? dayFmt.format(new Date(r.t)) : pad2(r.hour)) : ""; } } },
        y: { title: { display: true, text: "øre/kWh" }, grid: { color: cssVar("--line") } },
      },
    },
  });
}

// ---------- outlook (public forecast + its track record) ----------
function renderOutlook() {
  const el = $("outlook-notice");
  const today = todayStr();
  const actual = areaRows(state.prices, state.area);
  const lastKnown = actual.length ? Math.max(...actual.map((r) => r.t)) : 0;
  const fc = areaRows(state.forecast, state.area).filter((r) => r.kind === "forecast" && r.t > lastKnown);
  if (!state.forecast || !fc.length) {
    notice(el, "warn", state.forecast ? "Prognosen indeholder ingen timer ud over de kendte priser." : "Prognosen fra elpriser.org er ikke hentet endnu (kommer med næste synkronisering).");
  } else {
    notice(el, "info", `Prognose fra ${state.forecast.source}, hentet ${dateTimeFmt.format(new Date(Date.parse(state.forecast.updated)))}. Jo længere frem, jo mere usikkert – se “Hvor godt rammer prognosen?” nedenfor.`);
  }

  // Daily summary with cheap/normal/expensive relative to the last 14 days of actual daily means.
  const byDate = new Map();
  for (const r of actual) { const p = localParts(r.t); if (p.date < today) { if (!byDate.has(p.date)) byDate.set(p.date, []); byDate.get(p.date).push(r.dkk / 10); } }
  const dailyMeans = [...byDate.values()].map(mean).sort((a, b) => a - b);
  const q = (f) => (dailyMeans.length ? dailyMeans[Math.min(dailyMeans.length - 1, Math.floor(f * dailyMeans.length))] : null);
  const terc = { low: q(1 / 3), high: q(2 / 3) };
  const days = new Map();
  for (const r of fc) { const p = localParts(r.t); if (!days.has(p.date)) days.set(p.date, []); days.get(p.date).push({ ...r, hour: p.hour, ore: r.dkk / 10 }); }
  const rows = [...days.entries()].filter(([, v]) => v.length >= 20).map(([date, v]) => {
    const avg = mean(v.map((x) => x.ore));
    return { date, lead: Math.round((Date.parse(date) - Date.parse(today)) / DAY), avg, min: Math.min(...v.map((x) => x.ore)), max: Math.max(...v.map((x) => x.ore)),
      cheapest: v.reduce((a, b) => (b.ore < a.ore ? b : a)).hour, priciest: v.reduce((a, b) => (b.ore > a.ore ? b : a)).hour,
      label: terc.low == null ? "normal" : avg < terc.low ? "billig" : avg > terc.high ? "dyr" : "normal" };
  });
  $("outlook-table").innerHTML = rows.length ? `<thead><tr><th>Dag</th><th class="num">Dage frem</th><th class="num">Gns.</th><th class="num">Min</th><th class="num">Max</th><th>Billigst</th><th>Dyrest</th><th>Vurdering</th></tr></thead><tbody>${rows.map((d) => `<tr>
      <td>${dayFmt.format(new Date(localHourToEpoch(d.date, 12)))}</td><td class="num">${d.lead}</td>
      <td class="num">${fmtOre(d.avg)}</td><td class="num">${fmtOre(d.min)}</td><td class="num">${fmtOre(d.max)}</td>
      <td>kl. ${pad2(d.cheapest)}</td><td>kl. ${pad2(d.priciest)}</td><td><span class="pill ${d.label}">${d.label}</span></td></tr>`).join("")}</tbody>
    <tfoot><tr><td colspan="8" class="muted">Spotpris i øre/kWh ekskl. tariffer og moms. Vurderingen er i forhold til de seneste 14 dages dagsgennemsnit (laveste/højeste tredjedel).</td></tr></tfoot>` : "";

  // Track record
  const skill = (state.skill?.summary || []).filter((s) => s.area === state.area).sort((a, b) => a.lead - b.lead);
  $("outlook-skill").innerHTML = skill.length ? `<p>Hver dag gemmer siden prognosen, og når de rigtige priser kendes, sammenlignes de. Fejl i øre/kWh (spot), opgjort pr. dage frem fra prognosedagen:</p>
    <div class="table-scroll"><table><thead><tr><th class="num">Dage frem</th><th class="num">Dage målt</th><th class="num">Fejl pr. time (MAE)</th><th class="num">Fejl på dagsgennemsnit</th><th class="num">Skævhed</th><th class="num">Rammer niveau</th></tr></thead><tbody>
    ${skill.map((s) => `<tr><td class="num">${s.lead}</td><td class="num">${s.n_days}</td><td class="num">${fmtOre(s.mae_hourly_ore)}</td><td class="num">${fmtOre(s.mae_daily_mean_ore)}</td><td class="num">${s.bias_ore > 0 ? "+" : ""}${fmtOre(s.bias_ore)}</td><td class="num">${s.level_hit_rate == null ? "–" : nf0.format(s.level_hit_rate * 100) + " %"}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="muted">“Skævhed” = gennemsnitlig (prognose − faktisk); positiv betyder at prognosen typisk ligger for højt. “Rammer niveau” = hvor ofte prognosen korrekt forudså, om dagen blev dyrere eller billigere end ugen før. Opgjort til og med ${state.skill.evaluated_until}.</p>`
    : `<p class="muted">Evalueringen bygger sig op dag for dag: første tal kommer, når de første prognosedage er blevet til faktiske priser (ca. 3 dage efter første synkronisering).</p>`;

  if (!chartDefaults() || !actual.length) return;
  const t0 = localHourToEpoch(addDays(today, -7), 0);
  const t1 = fc.length ? Math.max(...fc.map((r) => r.t)) : lastKnown;
  const ts = []; for (let t = t0; t <= t1; t += HOUR) ts.push(t);
  const actByT = new Map(actual.map((r) => [r.t, r.dkk / 10])), fcByT = new Map(fc.map((r) => [r.t, r.dkk / 10]));
  const nowT = currentHourEpoch(), color = areaColor(), accent = cssVar("--accent");
  state.charts.outlook?.destroy();
  state.charts.outlook = new Chart($("outlook-chart"), {
    type: "line",
    data: { labels: ts, datasets: [
      { label: "Faktisk day-ahead-pris", data: ts.map((t) => actByT.get(t) ?? null), borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, tension: 0.2 },
      { label: "Prognose (elpriser.org)", data: ts.map((t) => fcByT.get(t) ?? null), borderColor: accent, backgroundColor: accent, borderDash: [6, 4], borderWidth: 2, pointRadius: 0, tension: 0.2 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, spanGaps: false,
      interaction: { mode: "index", intersect: false },
      plugins: { tooltip: { callbacks: { title: (items) => { const t = ts[items[0].dataIndex]; return `${dayFmt.format(new Date(t))} kl. ${pad2(localParts(t).hour)}`; }, label: (item) => (item.parsed.y == null ? null : ` ${item.dataset.label}: ${fmtOre(item.parsed.y)} øre/kWh`) } } },
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
  sel.innerHTML = `<option value="">– ikke valgt –</option>` + state.companies.map((c) => `<option value="${c.gln}">${c.name}</option>`).join("");
  sel.value = state.companies.some((c) => c.gln === state.gln) ? state.gln : "";
  state.gln = sel.value;
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
  $("incl-all").addEventListener("change", (e) => { state.inclAll = e.target.checked; saveSettings(); renderPrices(); });
  sel.addEventListener("change", (e) => { state.gln = e.target.value; saveSettings(); renderPrices(); });
  $("markup").addEventListener("input", (e) => { state.markup = Number(e.target.value) || 0; saveSettings(); renderPrices(); });
}

async function loadData() {
  const [meta, companies, prices, tariffs, forecast, skill] = await Promise.allSettled([
    loadJSON("data/meta.json"), loadJSON("config/grid-companies.json"), loadJSON("data/prices.json"),
    loadJSON("data/tariffs.json"), loadJSON("data/forecast.json"), loadJSON("data/skill.json"),
  ]);
  const val = (r) => (r.status === "fulfilled" ? r.value : null);
  state.meta = val(meta); state.companies = val(companies)?.companies || []; state.prices = val(prices);
  state.tariffs = val(tariffs); state.forecast = val(forecast); state.skill = val(skill);
  for (const r of [meta, companies, prices, tariffs, forecast, skill]) if (r.status === "rejected") console.warn(r.reason?.message || r.reason);
}

function renderAll() { renderStatus(); renderPrices(); renderOutlook(); }

async function main() {
  loadSettings();
  await loadData();
  initControls();
  renderAll();
  setInterval(renderPrices, 60000);                         // move the "now" highlight
  setInterval(() => loadData().then(renderAll), 15 * 60000); // pick up new syncs
}

main().catch((e) => { console.error(e); notice($("global-notice"), "bad", `Uventet fejl: ${e.message}`); });
