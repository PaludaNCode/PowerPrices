// Offline browser test of the site: serves the repo statically and mocks every external API
// with synthetic data via Playwright route interception.
//   npm install --no-save playwright chart.js   (and `npx playwright install chromium`, or set PW_CHROME)
//   node test/page_test.mjs [ok|eds-down|all-down]
// Screenshots (shot_*.png) are written to the current directory.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const scenario = process.argv[2] || "ok";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, req.url === "/" ? "index.html" : req.url.split("?")[0]);
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end("nope"); }
  res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(8787, r));

// ---- synthetic world (deterministic functions of time) ----
const HOUR = 3600000, DAY = 86400000;
const fmtParts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
function local(t) { const o = {}; for (const p of fmtParts.formatToParts(new Date(t))) o[p.type] = p.value; return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24 }; }
const T0 = Date.UTC(2026, 0, 1);
function wind(t, group) { const d = (t - T0) / DAY; const off = group === "de" ? 1.1 : group === "dk2" ? 0.4 : 0; return Math.max(0, 9 + 6 * Math.sin(d / 1.7 + off) + 3 * Math.sin(d * 2.3 + off * 2)); }
function cf(v) { const c = [[0,0],[3,0],[4,.03],[5,.08],[6,.16],[7,.27],[8,.4],[9,.54],[10,.67],[11,.78],[12,.87],[13,.93],[14,.97],[15,1],[30,1]]; for (let i=1;i<c.length;i++) if (v<=c[i][0]) { const [x0,y0]=c[i-1],[x1,y1]=c[i]; return y0+((v-x0)/(x1-x0))*(y1-y0);} return 1; }
function ghi(t) { const h = local(t).hour; return h >= 6 && h <= 19 ? Math.max(0, 600 * Math.sin(Math.PI * (h - 6) / 13)) : 0; }
function price(t, area) { // DKK/MWh
  const h = local(t).hour, dow = new Date(t).getUTCDay();
  const demand = 1 + 0.35 * Math.sin((h - 9) / 24 * 2 * Math.PI) + (dow === 0 || dow === 6 ? -0.15 : 0);
  const residual = demand - 0.6 * cf(wind(t, area === "DK2" ? "dk2" : "dk1")) - 0.5 * cf(wind(t, "de")) - 0.4 * ghi(t) / 1000;
  return 200 + 900 * Math.max(0, residual) ** 1.5 - 150 * Math.max(0, -residual) + 20 * Math.sin(t / 1e7);
}
const now = Date.now();
const today = local(now).date;
function edsIso(t) { return new Date(t).toISOString().slice(0, 19); }
function dayAheadRecords(startDate, endDate, areas) {
  const out = [];
  for (let t = Date.parse(startDate + "T00:00:00Z") - 2 * HOUR; t < Date.parse(endDate + "T00:00:00Z") + 2 * HOUR; t += 15 * 60000) {
    const d = local(t).date;
    if (d < startDate || d >= endDate) continue;
    for (const a of areas) out.push({ TimeUTC: edsIso(t), PriceArea: a, DayAheadPriceDKK: +price(t, a).toFixed(2), DayAheadPriceEUR: +(price(t, a) / 7.46).toFixed(2) });
  }
  return out;
}
function pricelist(filter) {
  const codes = filter.ChargeTypeCode || [];
  const row = (code, p, extra = {}) => ({ ChargeOwner: "x", GLN_Number: (filter.GLN_Number || ["?"])[0], ChargeType: "D03", ChargeTypeCode: code, Note: code, ValidFrom: "2026-01-01T00:00:00", ValidTo: null, ResolutionDuration: "PT1H", ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`Price${i + 1}`, p])), ...extra });
  const recs = [];
  for (const c of codes) {
    if (c === "40000") recs.push(row(c, 0.043)); else if (c === "41000") recs.push(row(c, 0.072)); else if (c === "EA-001") recs.push(row(c, 0.008));
    else if (c.endsWith(" R") || c.endsWith("_R")) recs.push(row(c, -0.05));
    else recs.push(row(c, 0.2, { Price18: 0.9, Price19: 0.9, Price20: 0.9, Price21: 0.9 }));
  }
  return { total: recs.length, records: recs };
}
function openMeteo(url) {
  const q = url.searchParams;
  const lats = q.get("latitude").split(","), lons = q.get("longitude").split(",");
  const past = Number(q.get("past_days")), fwd = Number(q.get("forecast_days"));
  const start = Math.floor(now / DAY) * DAY - past * DAY, end = Math.floor(now / DAY) * DAY + fwd * DAY;
  const time = []; for (let t = start; t < end; t += HOUR) time.push(t / 1000);
  return lats.map((lat, i) => {
    const group = Number(lat) < 55 ? "de" : Number(lons[i]) > 10.5 ? "dk2" : "dk1";
    return { latitude: Number(lat), longitude: Number(lons[i]), hourly: { time, wind_speed_100m: time.map((s) => +(wind(s * 1000, group) + 0.3 * Math.sin(i)).toFixed(2)), shortwave_radiation: time.map((s) => ghi(s * 1000)), temperature_2m: time.map((s) => 10 + 4 * Math.sin((local(s * 1000).hour - 8) / 24 * 2 * Math.PI)) } };
  });
}
function elpriserForecast(area) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.parse(today + "T00:00:00Z") + i * DAY).toISOString().slice(0, 10);
    days.push({ date: d, type: i < 2 ? "actual" : "forecast", prices: Array.from({ length: 24 }, (_, h) => ({ hour: h, price: +(price(Date.parse(d + "T12:00:00Z") + (h - 12) * HOUR, area) / 1000 * 1.05).toFixed(4) })) });
  }
  return { area, mode: "spot_ex", days };
}

// ---- browser ----
const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [], logs = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`); });
const calls = [];
await page.route(/cdnjs\.cloudflare\.com\/.*chart\.umd\.min\.js/, (route) => route.fulfill({ path: path.join(ROOT, "node_modules/chart.js/dist/chart.umd.js"), contentType: "text/javascript" }));
await page.route(/api\.energidataservice\.dk\/dataset\/(\w+)/, (route) => {
  const url = new URL(route.request().url());
  calls.push("eds " + url.pathname);
  if (scenario !== "ok") return route.abort("failed");
  const ds = url.pathname.split("/").pop();
  if (ds === "DayAheadPrices") { const f = JSON.parse(url.searchParams.get("filter")); const recs = dayAheadRecords(url.searchParams.get("start"), url.searchParams.get("end"), f.PriceArea); return route.fulfill({ json: { total: recs.length, records: recs } }); }
  if (ds === "DatahubPricelist") return route.fulfill({ json: pricelist(JSON.parse(url.searchParams.get("filter"))) });
  return route.fulfill({ status: 404, body: "?" });
});
await page.route(/elpriser\.org\/api\/(.+)/, (route) => {
  const url = new URL(route.request().url());
  calls.push("elpriser " + url.pathname);
  if (scenario === "all-down") return route.abort("failed");
  if (url.pathname.endsWith("/raw/prices")) { const recs = dayAheadRecords(url.searchParams.get("start"), url.searchParams.get("end"), [url.searchParams.get("area")]); return route.fulfill({ json: { records: recs } }); }
  if (url.pathname.endsWith("/forecast")) return route.fulfill({ json: elpriserForecast(url.searchParams.get("area")) });
  if (url.pathname.endsWith("/raw/encharges")) return route.fulfill({ json: pricelist({ ChargeTypeCode: ["40000", "41000", "EA-001"], GLN_Number: ["5790000432752"] }) });
  if (url.pathname.endsWith("/raw/tariff")) return route.fulfill({ json: pricelist({ ChargeTypeCode: ["CD", "CD R", "X"], GLN_Number: [url.searchParams.get("gln")] }) });
  return route.fulfill({ status: 404, body: "?" });
});
await page.route(/api\.open-meteo\.com\/v1\/forecast/, (route) => {
  const url = new URL(route.request().url());
  calls.push("open-meteo " + url.searchParams.get("past_days") + "/" + url.searchParams.get("forecast_days"));
  if (scenario === "all-down") return route.abort("failed");
  return route.fulfill({ json: openMeteo(url) });
});

const t0 = Date.now();
await page.goto("http://localhost:8787/", { waitUntil: "networkidle" });
await page.waitForFunction(() => !document.querySelector("#outlook-notice .skeleton"), null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(500);
console.log(`[${scenario}] loaded in ${Date.now() - t0} ms; calls:`, calls);
const text = async (sel) => (await page.locator(sel).innerText()).replace(/\s+/g, " ").trim();
console.log("prices-sub:", await text("#prices-sub"));
console.log("prices-notice:", await text("#prices-notice"));
console.log("stats:", await text("#prices-stats"));
console.log("source:", await text("#prices-source"));
console.log("outlook-notice:", await text("#outlook-notice"));
console.log("outlook rows:", await page.locator("#outlook-table tbody tr").count());
console.log("outlook table:", (await text("#outlook-table")).slice(0, 400));
await page.locator("#outlook-card details").first().locator("summary").click();
console.log("eval:", (await text("#outlook-eval")).slice(0, 500));

if (scenario !== "all-down") {
  await page.check("#incl-all");
  await page.selectOption("#grid-select", "5790001089030");
  await page.fill("#markup", "5");
  await page.waitForTimeout(800);
  await page.locator("#composition summary").click();
  console.log("composition:", await text("#composition-body"));
  console.log("stats incl:", await text("#prices-stats"));
  await page.click('#area-seg button[data-area="DK2"]');
  await page.waitForTimeout(800);
  console.log("DK2 sub:", await text("#prices-sub"), "| rows:", await page.locator("#outlook-table tbody tr").count());
  console.log("localStorage:", await page.evaluate(() => localStorage.getItem("powerprices")));
  await page.screenshot({ path: `shot_${scenario}.png`, fullPage: true });
  if (scenario !== "ok") { console.log("page errors:", errors); await browser.close(); server.close(); process.exit(0); }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "shot_dark.png", fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  console.log("mobile horizontal overflow:", await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth));
  await page.screenshot({ path: "shot_mobile.png", fullPage: true });
} else {
  await page.screenshot({ path: `shot_${scenario}.png`, fullPage: true });
}
console.log("page errors:", errors);
console.log("console warnings/errors:", logs.slice(0, 10));
await browser.close();
server.close();
