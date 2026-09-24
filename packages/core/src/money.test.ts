import { describe, expect, it } from "vitest";
import {
  allocateProportionally,
  amountToSql,
  applyRate,
  divideRoundHalfUp,
  formatAmount,
  isWholeCents,
  multiplyAmount,
  parseAmount,
  parseRate,
  roundTo,
  roundToCents,
  sumAmounts,
} from "./money.js";
import { ValidationError } from "./errors.js";

describe("parseAmount", () => {
  it("reads plain decimals exactly", () => {
    expect(parseAmount("0")).toBe(0n);
    expect(parseAmount("1")).toBe(10_000n);
    expect(parseAmount("1234.56")).toBe(12_345_600n);
    expect(parseAmount("0.0001")).toBe(1n);
    expect(parseAmount("-42.50")).toBe(-425_000n);
  });

  it("accepts what people actually type", () => {
    expect(parseAmount("1,234.56")).toBe(12_345_600n);
    expect(parseAmount("  12.30  ")).toBe(123_000n);
    expect(parseAmount(".5")).toBe(5_000n);
    expect(parseAmount("+7")).toBe(70_000n);
    // Accounting notation for a negative, as it appears on statements.
    expect(parseAmount("(1,234.56)")).toBe(-12_345_600n);
  });

  it("refuses anything it cannot read exactly", () => {
    for (const bad of ["", "abc", "12ab", "1.2.3", "--5", "1e5", "RM5"]) {
      expect(() => parseAmount(bad), bad).toThrow(ValidationError);
    }
  });

  it("refuses more precision than it can store, rather than truncating", () => {
    // Silently dropping the fifth decimal is how a cent vanishes with nobody
    // able to say where.
    expect(() => parseAmount("1.00005")).toThrow(/at most 4 decimal places/);
  });

  it("round-trips through SQL form", () => {
    expect(amountToSql(parseAmount("1234.56"))).toBe("1234.5600");
    expect(amountToSql(parseAmount("-0.0001"))).toBe("-0.0001");
    expect(amountToSql(0n)).toBe("0.0000");
  });
});

describe("arithmetic is exact", () => {
  it("adds tenths without floating point error", () => {
    // The whole reason money is not a number: 0.1 + 0.2 === 0.30000000000000004.
    const total = parseAmount("0.1") + parseAmount("0.2");
    expect(total).toBe(parseAmount("0.3"));
    expect(amountToSql(total)).toBe("0.3000");
  });

  it("sums a long series without drift", () => {
    const cent = parseAmount("0.01");
    const hundred = Array.from({ length: 100 }, () => cent);
    expect(sumAmounts(hundred)).toBe(parseAmount("1.00"));

    const awkward = Array.from({ length: 1000 }, () => parseAmount("0.07"));
    expect(sumAmounts(awkward)).toBe(parseAmount("70.00"));
  });
});

describe("rounding", () => {
  it("rounds half away from zero", () => {
    expect(roundToCents(parseAmount("1.005"))).toBe(parseAmount("1.01"));
    expect(roundToCents(parseAmount("1.004"))).toBe(parseAmount("1.00"));
    expect(roundToCents(parseAmount("-1.005"))).toBe(parseAmount("-1.01"));
    expect(roundToCents(parseAmount("2.675"))).toBe(parseAmount("2.68"));
  });

  it("is a no-op on values already at that precision", () => {
    expect(roundToCents(parseAmount("12.34"))).toBe(parseAmount("12.34"));
    expect(roundTo(parseAmount("12.3456"), 4)).toBe(parseAmount("12.3456"));
    expect(isWholeCents(parseAmount("12.34"))).toBe(true);
    expect(isWholeCents(parseAmount("12.3456"))).toBe(false);
  });

  it("divides with half-up rounding in both signs", () => {
    expect(divideRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divideRoundHalfUp(-5n, 2n)).toBe(-3n);
    expect(divideRoundHalfUp(4n, 2n)).toBe(2n);
    expect(divideRoundHalfUp(1n, 3n)).toBe(0n);
    expect(divideRoundHalfUp(2n, 3n)).toBe(1n);
    expect(() => divideRoundHalfUp(1n, 0n)).toThrow(RangeError);
  });
});

describe("rates", () => {
  it("reads a rate as a fraction, not a percentage", () => {
    expect(parseRate("0.06")).toBe(60_000n);
    expect(parseRate("0.115")).toBe(115_000n);
    expect(parseRate("1")).toBe(1_000_000n);
    expect(() => parseRate("0.0000001")).toThrow(/at most 6 decimal places/);
  });

  it("applies a rate with a single rounding step", () => {
    expect(applyRate(parseAmount("100.00"), "0.06")).toBe(parseAmount("6.00"));
    expect(applyRate(parseAmount("1000.00"), "0.06")).toBe(parseAmount("60.00"));
    // 99.99 x 6% = 5.9994 -> 5.9994 rounds to 6.00 at cents.
    expect(applyRate(parseAmount("99.99"), "0.06")).toBe(parseAmount("6.00"));
    // 0.08 x 6% = 0.0048, which is half a cent rounded up.
    expect(applyRate(parseAmount("0.08"), "0.06")).toBe(parseAmount("0.00"));
    expect(applyRate(parseAmount("0.09"), "0.06")).toBe(parseAmount("0.01"));
  });

  it("multiplies by a quantity", () => {
    expect(multiplyAmount(parseAmount("150.00"), "3")).toBe(parseAmount("450.00"));
    expect(multiplyAmount(parseAmount("33.33"), "1.5")).toBe(parseAmount("50.00"));
    expect(multiplyAmount(parseAmount("100.00"), "0.333333")).toBe(parseAmount("33.33"));
  });
});

describe("formatAmount", () => {
  it("presents money the way it is read", () => {
    expect(formatAmount(parseAmount("1234567.891"))).toBe("1,234,567.89");
    expect(formatAmount(parseAmount("0"))).toBe("0.00");
    expect(formatAmount(parseAmount("-45.5"))).toBe("-45.50");
    expect(formatAmount(parseAmount("-45.5"), { accounting: true })).toBe("(45.50)");
    expect(formatAmount(parseAmount("1234.5"), { currency: "RM" })).toBe("RM 1,234.50");
    expect(formatAmount(parseAmount("1234.5"), { grouped: false })).toBe("1234.50");
    expect(formatAmount(parseAmount("1234.5678"), { decimals: 4 })).toBe("1,234.5678");
    expect(formatAmount(0n, { zeroAs: "-" })).toBe("-");
  });

  it("rounds for display without changing the value", () => {
    const value = parseAmount("10.005");
    expect(formatAmount(value)).toBe("10.01");
    expect(amountToSql(value)).toBe("10.0050");
  });
});

describe("allocateProportionally", () => {
  it("splits so the parts add back to the total exactly", () => {
    // The classic case: 100 into three parts. 33.33 x 3 is 99.99, so one part
    // has to carry the stray cent.
    const parts = allocateProportionally(parseAmount("100.00"), [1n, 1n, 1n]);
    expect(sumAmounts(parts)).toBe(parseAmount("100.00"));
    expect(parts.map((p) => formatAmount(p)).sort()).toEqual(["33.33", "33.33", "33.34"]);
  });

  it("weights by the values given", () => {
    const parts = allocateProportionally(parseAmount("1000.00"), [
      parseAmount("250.00"),
      parseAmount("750.00"),
    ]);
    expect(parts).toEqual([parseAmount("250.00"), parseAmount("750.00")]);
  });

  it("still adds up on awkward weights", () => {
    const weights = [parseAmount("17.33"), parseAmount("4.01"), parseAmount("99.99")];
    const parts = allocateProportionally(parseAmount("51.77"), weights);
    expect(sumAmounts(parts)).toBe(parseAmount("51.77"));
    expect(parts.every(isWholeCents)).toBe(true);
  });

  it("does not invent a split when there is nothing to weight by", () => {
    const parts = allocateProportionally(parseAmount("10.00"), [0n, 0n]);
    expect(parts).toEqual([parseAmount("10.00"), 0n]);
    expect(allocateProportionally(parseAmount("10.00"), [])).toEqual([]);
  });
});
