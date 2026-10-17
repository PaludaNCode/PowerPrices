// Offline browser test of the site. Generates synthetic data with `scripts/sync.py --mock`,
// serves the repo with that data, and checks the page in Chromium (Playwright).
//   npm install --no-save playwright chart.js && npx playwright install chromium   (or set PW_CHROME)
//   node test/page_test.mjs [ok|real|no-data]
// Screenshots (shot_*.png) are written to the current directory.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const scenario = process.argv[2] || "ok";
// "real" serves the repository's own data/ (as synced by GitHub Actions) instead of synthetic data.
const dataDir = scenario === "real" ? path.join(ROOT, "data") : fs.mkdtempSync(path.join(os.tmpdir(), "powerprices-data-"));
if (scenario === "ok") {
  // Seed an archived forecast from 6 days ago so the skill table has something to show.
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" });
  const dayStr = (offset) => fmt.format(new Date(Date.now() + offset * 86400000));
  const snap = dayStr(-6), areas = {};
  for (const area of ["DK1", "DK2"]) {
    areas[area] = [];
    for (let d = 2; d <= 4; d++) for (let h = 0; h < 24; h++) {
      areas[area].push({ t: new Date(Date.parse(dayStr(-6 + d) + "T00:00:00Z") + (h - 2) * 3600000).toISOString().replace(".000", ""), dkk: 300 + 10 * h + 50 * d, kind: "forecast" });
    }
  }
  fs.mkdirSync(path.join(dataDir, "history/forecasts"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "history/forecasts", `${snap}.json`), JSON.stringify({ date: snap, areas }));
  execFileSync("python3", [path.join(ROOT, "scripts/sync.py"), "--mock", "--out", dataDir], { stdio: "inherit" });
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const rel = req.url.split("?")[0];
  const p = rel.startsWith("/data/") ? path.join(dataDir, rel.slice(6)) : path.join(ROOT, rel === "/" ? "index.html" : rel);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(8787, r));

const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [], logs = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`); });
// Routes are matched last-registered-first: block everything external, then allow Chart.js from a local copy.
await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort("failed"));
await page.route(/cdnjs\.cloudflare\.com\/.*chart\.umd\.min\.js/, (route) => route.fulfill({ path: path.join(ROOT, "node_modules/chart.js/dist/chart.umd.js"), contentType: "text/javascript" }));

const t0 = Date.now();
await page.goto("http://localhost:8787/", { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const text = async (sel) => (await page.locator(sel).innerText()).replace(/\s+/g, " ").trim();
console.log(`[${scenario}] loaded in ${Date.now() - t0} ms`);
console.log("sync-status:", await text("#sync-status"));
console.log("global-notice:", await text("#global-notice"));
console.log("prices-sub:", await text("#prices-sub"));
console.log("prices-notice:", await text("#prices-notice"));
console.log("stats:", await text("#prices-stats"));
console.log("outlook-notice:", await text("#outlook-notice"));
console.log("outlook rows:", await page.locator("#outlook-table tbody tr").count());
console.log("outlook table:", (await text("#outlook-table")).slice(0, 300));
console.log("skill:", (await text("#outlook-skill")).slice(0, 400));

if (scenario === "ok") {
  await page.check("#incl-all");
  await page.selectOption("#grid-select", "5790001089030");
  await page.fill("#markup", "5");
  await page.waitForTimeout(500);
  await page.locator("#composition summary").click();
  console.log("composition:", await text("#composition-body"));
  console.log("stats incl:", await text("#prices-stats"));
  await page.click('#area-seg button[data-area="DK2"]');
  await page.waitForTimeout(500);
  console.log("DK2 sub:", await text("#prices-sub"), "| rows:", await page.locator("#outlook-table tbody tr").count());
  console.log("localStorage:", await page.evaluate(() => localStorage.getItem("powerprices")));
  await page.screenshot({ path: "shot_ok.png", fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  console.log("mobile horizontal overflow:", await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth));
  await page.screenshot({ path: "shot_mobile_dark.png", fullPage: true });
} else {
  await page.screenshot({ path: `shot_${scenario}.png`, fullPage: true });
}
console.log("page errors:", errors);
console.log("console warnings/errors:", logs.slice(0, 8));
await browser.close();
server.close();
if (scenario !== "real") fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(errors.length ? 1 : 0);
