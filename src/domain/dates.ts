import { isLocalFixtureMode } from "@/lib/offline";
/**
 * The tracker stores dates as Indonesian text (`14 Okt 2026`), not as date values.
 * Internally we work in ISO `YYYY-MM-DD` — which sorts chronologically as a string —
 * and write back in the sheet's original text format so nothing else that reads the
 * spreadsheet notices a change.
 */

export const JAKARTA_TIME_ZONE = "Asia/Jakarta";

/** Month abbreviations as written in the sheet. Mei/Agu/Okt/Des differ from English. */
export const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Mei",
  "Jun",
  "Jul",
  "Agu",
  "Sep",
  "Okt",
  "Nov",
  "Des",
] as const;

export const MONTHS_LONG = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
] as const;

/** Accepted spellings → 1-based month number. English is accepted on read only. */
const MONTH_LOOKUP: ReadonlyMap<string, number> = new Map([
  ...MONTHS_SHORT.map((m, i) => [m.toLowerCase(), i + 1] as const),
  ...MONTHS_LONG.map((m, i) => [m.toLowerCase(), i + 1] as const),
  ["may", 5],
  ["aug", 8],
  ["august", 8],
  ["oct", 10],
  ["october", 10],
  ["dec", 12],
  ["december", 12],
  ["january", 1],
  ["february", 2],
  ["march", 3],
  ["june", 6],
  ["july", 7],
]);

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const INDONESIAN_PATTERN = /^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/;

const pad2 = (n: number) => String(n).padStart(2, "0");

function isRealDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/**
 * Parse a tracker date cell into `YYYY-MM-DD`.
 * Accepts `14 Okt 2026`, `14 Oktober 2026` and `2026-10-14`; returns null for
 * anything blank or unrecognised rather than guessing.
 */
export function parseTrackerDate(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  const iso = ISO_PATTERN.exec(text);
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return isRealDate(year, month, day) ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
  }

  const parts = INDONESIAN_PATTERN.exec(text);
  if (!parts) return null;
  const day = Number(parts[1]);
  const month = MONTH_LOOKUP.get(String(parts[2]).toLowerCase());
  const year = Number(parts[3]);
  if (!month || !isRealDate(year, month, day)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Format `YYYY-MM-DD` back into the sheet's `d Mmm yyyy` text. Blank input stays blank. */
export function formatTrackerDate(iso: string | null | undefined): string {
  const parsed = parseTrackerDate(iso);
  if (!parsed) return "";
  const [year, month, day] = parsed.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return `${day} ${MONTHS_SHORT[month - 1]} ${year}`;
}

/** Long form for headings, e.g. `10 Agustus 2026`. */
export function formatTrackerDateLong(iso: string | null | undefined): string {
  const parsed = parseTrackerDate(iso);
  if (!parsed) return "";
  const [year, month, day] = parsed.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return `${day} ${MONTHS_LONG[month - 1]} ${year}`;
}

/**
 * Today's date in Asia/Jakarta as `YYYY-MM-DD`.
 *
 * The spreadsheet's own timezone is America/Los_Angeles, which would flip overdue
 * status around eight hours early, so the zone is always stated explicitly here and
 * never inherited from the host.
 *
 * `IAP_NOW` pins the instant the clock is read at — an ISO timestamp, not a date, so
 * the end-to-end suite can pin the clock without stepping over the zone conversion.
 * It is honoured only where `SHEETS_TRANSPORT` states the binding explicitly, which
 * development and the test servers do and the production deployment does not; a
 * stray `IAP_NOW` there would freeze "today" and write wrong values into column N.
 */
export function todayInJakarta(now: Date = pinnedNow() ?? new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: JAKARTA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function pinnedNow(): Date | null {
  const raw = process.env.IAP_NOW?.trim();
  // Development and the test servers state SHEETS_TRANSPORT explicitly; the
  // production deployment leaves it unset, so a stray IAP_NOW there does nothing.
  if (!raw || !isLocalFixtureMode()) return null;
  const instant = new Date(raw);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/** Whole days from `fromIso` to `toIso`. Negative when `toIso` is in the past. */
export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}
