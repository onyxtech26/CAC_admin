import { ValidationError } from "./errors.js";

/**
 * Calendar dates.
 *
 * Accounting, payroll and leave all work in calendar dates, not instants. "31
 * January 2026" is the same day in Johor Bahru and on a build server in
 * Virginia, and the moment a date is stored as a timestamp with a timezone,
 * someone's period-end entry lands in the previous month.
 *
 * So: `date` columns in the database, ISO `YYYY-MM-DD` strings in the
 * application, and every Date object here pinned to UTC midnight. The only
 * timezone that appears anywhere is `company.timezone`, used for "what is today"
 * and nothing else.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses YYYY-MM-DD into a UTC-midnight Date. Rejects anything else. */
export function parseIsoDate(input: string | Date, field?: string): Date {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw new ValidationError("That is not a valid date.", field);
    return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  }

  const match = ISO_DATE.exec(input.trim());
  if (!match) {
    throw new ValidationError("Enter a date as YYYY-MM-DD.", field);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  // Catches 2026-02-30, which Date would silently roll into March.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ValidationError(`${input} is not a real date.`, field);
  }
  return date;
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Today in the company's timezone, as a UTC-midnight Date. */
export function today(timeZone = "Asia/Kuala_Lumpur"): Date {
  // en-CA formats as YYYY-MM-DD, which saves reassembling parts by hand.
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parseIsoDate(local);
}

export function addDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

/**
 * Adds whole months, clamping to the end of the target month.
 *
 * 31 January + 1 month is 28 or 29 February, not 2 or 3 March. Date's own
 * arithmetic overflows, which turns a monthly payment schedule into a drifting
 * one.
 */
export function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();
  const lastDay = daysInMonth(year + Math.floor(month / 12), ((month % 12) + 12) % 12);
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function endOfMonth(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), daysInMonth(date.getUTCFullYear(), date.getUTCMonth())),
  );
}

export function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** Inclusive on both ends, which is how an accounting period is quoted. */
export function isWithin(date: Date, from: Date, to: Date): boolean {
  return date.getTime() >= from.getTime() && date.getTime() <= to.getTime();
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthName(monthIndex: number): string {
  return MONTHS[((monthIndex % 12) + 12) % 12]!;
}

/** "31 Jan 2026" — unambiguous, and shorter than the numeric forms people misread. */
export function formatDate(input: string | Date | null | undefined): string {
  if (!input) return "";
  const date = typeof input === "string" ? parseIsoDate(input.slice(0, 10)) : input;
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${day} ${monthName(date.getUTCMonth()).slice(0, 3)} ${date.getUTCFullYear()}`;
}
