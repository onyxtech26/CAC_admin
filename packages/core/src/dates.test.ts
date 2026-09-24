import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  daysInMonth,
  endOfMonth,
  formatDate,
  isWithin,
  parseIsoDate,
  startOfMonth,
  toIsoDate,
} from "./dates.js";
import { ValidationError } from "./errors.js";

describe("parseIsoDate", () => {
  it("reads a calendar date as UTC midnight", () => {
    const date = parseIsoDate("2026-01-31");
    expect(date.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(toIsoDate(date)).toBe("2026-01-31");
  });

  it("refuses dates that do not exist", () => {
    // Date would roll this into 2 March without complaint, which turns a typo
    // into a posting in the wrong period.
    expect(() => parseIsoDate("2026-02-30")).toThrow(/not a real date/);
    expect(() => parseIsoDate("2026-13-01")).toThrow(ValidationError);
    expect(() => parseIsoDate("31/01/2026")).toThrow(/YYYY-MM-DD/);
    expect(() => parseIsoDate("2026-1-1")).toThrow(ValidationError);
  });

  it("accepts a leap day in a leap year and not otherwise", () => {
    expect(toIsoDate(parseIsoDate("2028-02-29"))).toBe("2028-02-29");
    expect(() => parseIsoDate("2026-02-29")).toThrow(/not a real date/);
  });
});

describe("month arithmetic", () => {
  it("clamps to the end of the target month instead of overflowing", () => {
    // 31 January + 1 month is end of February, not 2 or 3 March.
    expect(toIsoDate(addMonths(parseIsoDate("2026-01-31"), 1))).toBe("2026-02-28");
    expect(toIsoDate(addMonths(parseIsoDate("2028-01-31"), 1))).toBe("2028-02-29");
    expect(toIsoDate(addMonths(parseIsoDate("2026-05-31"), 1))).toBe("2026-06-30");
  });

  it("crosses year boundaries in both directions", () => {
    expect(toIsoDate(addMonths(parseIsoDate("2026-11-15"), 3))).toBe("2027-02-15");
    expect(toIsoDate(addMonths(parseIsoDate("2026-02-15"), -3))).toBe("2025-11-15");
    expect(toIsoDate(addMonths(parseIsoDate("2026-01-01"), 11))).toBe("2026-12-01");
  });

  it("finds month boundaries and lengths", () => {
    expect(toIsoDate(endOfMonth(parseIsoDate("2026-02-10")))).toBe("2026-02-28");
    expect(toIsoDate(startOfMonth(parseIsoDate("2026-02-10")))).toBe("2026-02-01");
    expect(daysInMonth(2026, 1)).toBe(28);
    expect(daysInMonth(2028, 1)).toBe(29);
    expect(daysInMonth(2026, 11)).toBe(31);
  });

  it("adds days across a month end", () => {
    expect(toIsoDate(addDays(parseIsoDate("2026-01-30"), 3))).toBe("2026-02-02");
    expect(toIsoDate(addDays(parseIsoDate("2026-01-01"), -1))).toBe("2025-12-31");
  });
});

describe("isWithin", () => {
  it("includes both ends, the way a period is quoted", () => {
    const from = parseIsoDate("2026-01-01");
    const to = parseIsoDate("2026-01-31");
    expect(isWithin(parseIsoDate("2026-01-01"), from, to)).toBe(true);
    expect(isWithin(parseIsoDate("2026-01-31"), from, to)).toBe(true);
    expect(isWithin(parseIsoDate("2026-02-01"), from, to)).toBe(false);
    expect(isWithin(parseIsoDate("2025-12-31"), from, to)).toBe(false);
  });
});

describe("formatDate", () => {
  it("renders unambiguously", () => {
    expect(formatDate("2026-01-05")).toBe("05 Jan 2026");
    expect(formatDate("2026-12-31")).toBe("31 Dec 2026");
    // Timestamps from the database arrive with a time part attached.
    expect(formatDate("2026-03-09T16:20:00.000Z")).toBe("09 Mar 2026");
    expect(formatDate(null)).toBe("");
  });
});
