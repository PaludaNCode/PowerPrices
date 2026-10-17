// Tariffs, taxes and the Danish calendar.
//
// Everything that turns a raw day-ahead ("spot") price into what a household
// actually pays per kWh lives here:
//
//   total = (spot + grid tariff + Energinet tariffs + elafgift) * 1.25 (VAT) + supplier markup
//
// Grid tariffs and Energinet charges come from Energi Data Service's "DatahubPricelist"
// dataset via data/tariffs.json (written by scripts/sync.py). The grid-company table
// (GLN + charge codes) lives in config/grid-companies.json.

// Energinet's charges as they appear in DatahubPricelist.
//   40000  Transmissions nettarif   (Energinet Systemansvar A/S, GLN 5790000432752)
//   41000  Systemtarif              (Energinet Systemansvar A/S, GLN 5790000432752)
//   EA-001 Elafgift                 (Energinet DataHub A/S,      GLN 5790001330552)
export const ENERGINET_CHARGES = {
  codes: ["40000", "41000", "EA-001"],
  glns: ["5790000432752", "5790001330552"],
};

// Fallback values in DKK/kWh (ex. VAT) used only if DatahubPricelist cannot be reached.
// 2026: Energinet's consumer tariffs (system + net) total ~11.5 øre/kWh after the tariff cap;
// elafgift is temporarily 0.8 øre/kWh in 2026-2027 (normally ~72.7 øre/kWh).
export const FALLBACK_CHARGES_DKK_PER_KWH = {
  "40000": 0.043, // transmissions nettarif (approx.)
  "41000": 0.072, // systemtarif (approx.)
  "EA-001": 0.008, // elafgift 2026-2027
};

export const VAT = 1.25;

/** Local date parts for a UTC epoch (ms) in the Europe/Copenhagen time zone. */
const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Copenhagen",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const partsCache = new Map();

export function localParts(epochMs) {
  const key = Math.floor(epochMs / 60000);
  let p = partsCache.get(key);
  if (p) return p;
  const o = {};
  for (const part of fmt.formatToParts(new Date(epochMs))) o[part.type] = part.value;
  const hour = Number(o.hour) % 24; // "24" can appear in some engines at midnight
  p = {
    date: `${o.year}-${o.month}-${o.day}`,
    hour,
    minute: Number(o.minute),
    dow: DOW[o.weekday],
  };
  partsCache.set(key, p);
  return p;
}

/** Anonymous Gregorian algorithm for Easter Sunday (returns YYYY-MM-DD). */
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day);
}

function isoDate(utcMs) {
  return new Date(utcMs).toISOString().slice(0, 10);
}

const holidayCache = new Map();
/** Danish public holidays (Store Bededag was abolished in 2024). Grundlovsdag and
 *  Christmas Eve are included because demand behaves like a holiday. */
export function danishHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const easter = easterSunday(year);
  const day = 86400000;
  const set = new Set([
    `${year}-01-01`, `${year}-06-05`, `${year}-12-24`, `${year}-12-25`, `${year}-12-26`, `${year}-12-31`,
    isoDate(easter - 3 * day), // Skærtorsdag
    isoDate(easter - 2 * day), // Langfredag
    isoDate(easter),           // Påskedag
    isoDate(easter + 1 * day), // 2. påskedag
    isoDate(easter + 39 * day), // Kristi himmelfartsdag
    isoDate(easter + 49 * day), // Pinsedag
    isoDate(easter + 50 * day), // 2. pinsedag
  ]);
  holidayCache.set(year, set);
  return set;
}

/** True for Saturdays, Sundays and public holidays. */
export function isOffDay(dateStr, dow) {
  if (dow === 0 || dow === 6) return true;
  return danishHolidays(Number(dateStr.slice(0, 4))).has(dateStr);
}

/** Is a DatahubPricelist row valid on the given local date (YYYY-MM-DD)? ValidTo is exclusive. */
export function rowValidOn(row, dateStr) {
  const from = (row.ValidFrom || "").slice(0, 10);
  const to = row.ValidTo ? row.ValidTo.slice(0, 10) : null;
  return from <= dateStr && (!to || dateStr < to);
}

/**
 * Hourly tariff (DKK/kWh) for a local date from a list of DatahubPricelist rows.
 * Several valid rows (e.g. a tariff plus a discount row) are summed hour by hour.
 * Rows with daily resolution only carry Price1.
 */
export function hourlyTariff(rows, dateStr) {
  const valid = rows.filter((r) => rowValidOn(r, dateStr));
  if (!valid.length) return null;
  // If the same charge code has several valid rows, keep the newest ValidFrom only.
  const newest = new Map();
  for (const r of valid) {
    const k = r.ChargeTypeCode;
    if (!newest.has(k) || (newest.get(k).ValidFrom || "") < (r.ValidFrom || "")) newest.set(k, r);
  }
  const hours = new Array(24).fill(0);
  for (const r of newest.values()) {
    for (let h = 0; h < 24; h++) {
      const v = r[`Price${h + 1}`];
      hours[h] += v == null ? (r.Price1 ?? 0) : v;
    }
  }
  return hours;
}
