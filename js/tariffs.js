// Tariffs, taxes and the Danish calendar.
//
// Everything that turns a raw day-ahead ("spot") price into what a household
// actually pays per kWh lives here:
//
//   total = (spot + grid tariff + Energinet tariffs + elafgift) * 1.25 (VAT) + supplier markup
//
// Grid tariffs and Energinet charges are fetched live from Energi Data Service's
// "DatahubPricelist" dataset. The table below maps each Danish grid company
// (netselskab) to its GLN number and the charge-type codes used for ordinary
// household ("C-kunde") tariffs. The table is adapted from the MTrab/energidataservice
// Home Assistant integration and may need updating when companies rename codes.

export const GRID_COMPANIES = [
  { name: "Radius Elnet A/S", gln: "5790000705689", codes: ["DT_C_01"] },
  { name: "RAH Net A/S", gln: "5790000681327", codes: ["RAH-C"] },
  { name: "Konstant Net A/S", gln: "5790000704842", codes: ["C_FBTNTR_B", "C_FBTNTR_R"] },
  { name: "Cerius A/S", gln: "5790000705184", codes: ["30TR_C_ET"] },
  { name: "N1 A/S", gln: "5790001089030", codes: ["CD", "CD R"] },
  // Dinel has two customer classes; "<100" is consumption below 100,000 kWh/year (households).
  { name: "Dinel A/S", gln: "5790000610099", codes: ["TCL<100_52"] },
  { name: "TREFOR El-net A/S", gln: "5790000392261", codes: ["C"] },
  { name: "TREFOR El-net Øst A/S", gln: "5790000706686", codes: ["46"] },
  { name: "Elektrus A/S", gln: "5790000836239", codes: ["6000091"] },
  { name: "Elnet Midt A/S", gln: "5790001100520", codes: ["T3001"] },
  { name: "Hurup Elværk Net A/S", gln: "5790000610839", codes: ["HEV-NT-01T"] },
  { name: "Veksel A/S", gln: "5790001088217", codes: ["NT-10"] },
  { name: "Vores Elnet A/S", gln: "5790000610976", codes: ["TNT1009"] },
  { name: "Netselskabet Elværk A/S", gln: "5790000681358", codes: ["5NCFF"] },
  { name: "Nord Energi Net A/S", gln: "5790000610877", codes: ["TAC"] },
  { name: "NOE Net A/S", gln: "5790000395620", codes: ["30030"] },
  { name: "Ikast El Net A/S", gln: "5790000682102", codes: ["IEV-NT-01"] },
  { name: "FLOW Elnet A/S", gln: "5790000392551", codes: ["FE1 NT-01"] },
  { name: "Elinord A/S", gln: "5790001095277", codes: ["43300"] },
  { name: "Hammel Elforsyning Net A/S", gln: "5790001090166", codes: ["C-Tarif"] },
  { name: "El-net Kongerslev A/S", gln: "5790002502699", codes: ["C-Tarif"] },
  { name: "Ravdex A/S", gln: "5790000836727", codes: ["NT-C"] },
  { name: "Tarm Elværk Net A/S", gln: "5790000706419", codes: ["TEV-NT-01T", "TEV-NT-01R"] },
  { name: "Zeanet A/S", gln: "5790001089375", codes: ["43110"] },
  { name: "L-Net A/S", gln: "5790001090111", codes: ["3000"] },
  { name: "Midtfyns Elforsyning A.m.b.A", gln: "5790001089023", codes: ["TNT15000"] },
  { name: "Sunds Net A.m.b.A", gln: "5790001095444", codes: ["SEF-NT-05", "SEF-NT-05R"] },
  { name: "Aal El-Net A.m.b.A", gln: "5790001095451", codes: ["AAL-NT-05", "AAL-NTR05"] },
  { name: "Forsyning Elnet A/S", gln: "5790001088309", codes: ["STR-NT-03"] },
];

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
