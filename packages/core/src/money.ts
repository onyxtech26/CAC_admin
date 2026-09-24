import { ValidationError } from "./errors.js";

/**
 * Money.
 *
 * Every amount in this system is a `bigint` counting ten-thousandths of a
 * ringgit, matching the `numeric(18,4)` columns it is stored in. There is no
 * floating point anywhere in the chain.
 *
 * This is not fussiness. `0.1 + 0.2` is `0.30000000000000004` in IEEE 754, and a
 * ledger that is out by 4e-17 fails its balance check for reasons nobody can
 * see. Four decimal places rather than two because unit rates, apportionments
 * and statutory percentages need the headroom; presentation rounds to cents at
 * the edge, and the rounding is explicit where it happens.
 *
 * `Amount` is a plain bigint rather than a branded class so it can cross the
 * server/client boundary and be compared with `===`, `<` and `+` without
 * ceremony. The discipline is that raw numbers never become amounts except
 * through `parseAmount`.
 */

export type Amount = bigint;

/** Decimal places held internally and in the database. */
export const MONEY_SCALE = 4;
const SCALE_FACTOR = 10_000n;
/** One cent, in internal units. */
const CENT = 100n;
/** Decimal places a rate may carry: matches numeric(9,6). */
const RATE_SCALE = 6;
const RATE_FACTOR = 1_000_000n;

export const ZERO: Amount = 0n;

const AMOUNT_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Parses a user or database value into an Amount.
 *
 * Accepts "1234.56", "1,234.56", "(1,234.56)" for negatives as typed on
 * statements, and bare integers. Rejects anything else rather than coercing:
 * `Number("12ab")` is NaN and NaN in a ledger is a silent zero.
 *
 * A `number` is accepted because JSON produces them, but it has already lost
 * exactness by the time it arrives. Prefer strings in new code.
 */
export function parseAmount(input: string | number | bigint, field?: string): Amount {
  if (typeof input === "bigint") return input;

  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new ValidationError("That is not a valid amount.", field);
    }
    return parseAmount(input.toFixed(MONEY_SCALE), field);
  }

  let text = input.trim().replace(/,/g, "").replace(/\s/g, "");
  if (text === "") throw new ValidationError("Enter an amount.", field);

  // Accounting notation: (1,234.56) is negative.
  if (text.startsWith("(") && text.endsWith(")")) {
    text = `-${text.slice(1, -1)}`;
  }
  if (text.startsWith("+")) text = text.slice(1);
  if (text.startsWith(".")) text = `0${text}`;
  if (text.startsWith("-.")) text = `-0${text.slice(1)}`;

  if (!AMOUNT_PATTERN.test(text)) {
    throw new ValidationError(`"${input}" is not a valid amount.`, field);
  }

  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  const [whole = "0", fraction = ""] = digits.split(".");

  if (fraction.length > MONEY_SCALE) {
    // Silently truncating here is how a cent goes missing and nobody can say
    // where. Refuse instead.
    throw new ValidationError(
      `Amounts carry at most ${MONEY_SCALE} decimal places; "${input}" has ${fraction.length}.`,
      field,
    );
  }

  const padded = fraction.padEnd(MONEY_SCALE, "0");
  const value = BigInt(whole) * SCALE_FACTOR + BigInt(padded === "" ? "0" : padded);
  return negative ? -value : value;
}

/** True when the text parses as an amount. Does not throw. */
export function isAmount(input: string): boolean {
  try {
    parseAmount(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Renders an Amount for a numeric(18,4) parameter.
 *
 * Always the full four decimal places, so PostgreSQL never has to infer scale.
 */
export function amountToSql(value: Amount): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE_FACTOR;
  const fraction = (abs % SCALE_FACTOR).toString().padStart(MONEY_SCALE, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export interface FormatOptions {
  /** Decimal places to show. Two by default: money is read in cents. */
  decimals?: number;
  /** Thousands separators. On by default; off for CSV and form fields. */
  grouped?: boolean;
  /** Prefix such as "RM". Omitted by default; column headers usually say it. */
  currency?: string;
  /** Render negatives as (1,234.56) the way statements do. */
  accounting?: boolean;
  /** Render exact zero as this instead of "0.00". */
  zeroAs?: string;
}

/** Human-readable form. Rounds for display only; the stored value is untouched. */
export function formatAmount(value: Amount, options: FormatOptions = {}): string {
  const { decimals = 2, grouped = true, currency, accounting = false, zeroAs } = options;

  if (value === 0n && zeroAs !== undefined) return zeroAs;

  const negative = value < 0n;
  const rounded = roundTo(negative ? -value : value, decimals);
  const divisor = 10n ** BigInt(MONEY_SCALE - decimals);
  const units = rounded / divisor;
  const whole = (units / 10n ** BigInt(decimals)).toString();
  const fraction =
    decimals > 0 ? (units % 10n ** BigInt(decimals)).toString().padStart(decimals, "0") : "";

  const wholeText = grouped ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
  const body = `${currency ? `${currency} ` : ""}${wholeText}${fraction ? `.${fraction}` : ""}`;

  if (!negative) return body;
  return accounting ? `(${body})` : `-${body}`;
}

export function sumAmounts(values: Iterable<Amount>): Amount {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

export function negate(value: Amount): Amount {
  return -value;
}

export function absolute(value: Amount): Amount {
  return value < 0n ? -value : value;
}

/**
 * Commercial rounding: half away from zero.
 *
 * Banker's rounding (half to even) is better for long unbiased series, but
 * invoices, receipts and statutory schedules in Malaysia are read and checked by
 * people who round 0.005 up. Matching what the reader expects matters more here
 * than statistical elegance, and the choice is deliberate rather than inherited
 * from whatever `toFixed` happens to do.
 */
export function roundTo(value: Amount, decimals: number): Amount {
  if (decimals >= MONEY_SCALE) return value;
  const divisor = 10n ** BigInt(MONEY_SCALE - decimals);
  return divideRoundHalfUp(value, divisor) * divisor;
}

/** Rounds to whole cents. The form every amount takes before it is presented. */
export function roundToCents(value: Amount): Amount {
  return divideRoundHalfUp(value, CENT) * CENT;
}

/** True when the amount is an exact number of cents. */
export function isWholeCents(value: Amount): boolean {
  return value % CENT === 0n;
}

/**
 * n / d, rounded half away from zero. Integer arithmetic throughout, so there
 * is no intermediate float to lose a bit in.
 */
export function divideRoundHalfUp(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError("Division by zero");
  const negative = n < 0n !== d < 0n;
  const absN = n < 0n ? -n : n;
  const absD = d < 0n ? -d : d;
  const quotient = absN / absD;
  const remainder = absN % absD;
  const rounded = remainder * 2n >= absD ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Parses a rate such as "0.06" (6%) held as numeric(9,6).
 *
 * Rates are fractions, not percentages: storing 6 and remembering to divide is
 * how a tax line comes out a hundred times too big.
 */
export function parseRate(input: string | number, field?: string): bigint {
  const text = typeof input === "number" ? input.toFixed(RATE_SCALE) : input.trim();
  if (!AMOUNT_PATTERN.test(text)) {
    throw new ValidationError(`"${input}" is not a valid rate.`, field);
  }
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? text.slice(1) : text).split(".");
  if (fraction.length > RATE_SCALE) {
    throw new ValidationError(`Rates carry at most ${RATE_SCALE} decimal places.`, field);
  }
  const value =
    BigInt(whole) * RATE_FACTOR + BigInt(fraction.padEnd(RATE_SCALE, "0") || "0");
  return negative ? -value : value;
}

/**
 * base x rate, rounded to cents.
 *
 * One rounding, at the end, from a single exact integer product. Rounding twice
 * — once to four places and again to cents — shifts results by a cent on
 * awkward numbers, and those cents are what a reconciliation spends an
 * afternoon chasing.
 */
export function applyRate(base: Amount, rate: string | number | bigint): Amount {
  const scaled = typeof rate === "bigint" ? rate : parseRate(rate);
  return divideRoundHalfUp(base * scaled, RATE_FACTOR * CENT) * CENT;
}

/** unit x quantity, rounded to cents. Quantity may carry up to six decimals. */
export function multiplyAmount(unit: Amount, quantity: string | number | bigint): Amount {
  const scaled = typeof quantity === "bigint" ? quantity : parseRate(quantity);
  return divideRoundHalfUp(unit * scaled, RATE_FACTOR * CENT) * CENT;
}

/**
 * Splits `total` across `weights` so the parts add back to exactly `total`.
 *
 * Largest-remainder allocation: each part is rounded down to cents, then the
 * leftover cents go one each to the parts with the largest discarded fraction.
 * Rounding each part independently is the usual approach and it does not add up
 * — which matters when the parts are an allocation of one receipt across four
 * invoices, or one deduction across a payroll.
 */
export function allocateProportionally(total: Amount, weights: Amount[]): Amount[] {
  if (weights.length === 0) return [];
  const weightTotal = sumAmounts(weights);
  if (weightTotal === 0n) {
    // Nothing to weight by. Put it all on the first part rather than inventing
    // an even split the caller did not ask for.
    return weights.map((_, index) => (index === 0 ? total : 0n));
  }

  const parts: Amount[] = [];
  const remainders: Array<{ index: number; remainder: bigint }> = [];

  for (const [index, weight] of weights.entries()) {
    const exact = total * weight;
    const whole = exact / weightTotal;
    const floored = (whole / CENT) * CENT;
    parts.push(floored);
    remainders.push({ index, remainder: exact - floored * weightTotal });
  }

  let shortfall = total - sumAmounts(parts);
  remainders.sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index));

  let cursor = 0;
  while (shortfall !== 0n && remainders.length > 0) {
    const step = shortfall > 0n ? CENT : -CENT;
    const target = remainders[cursor % remainders.length]!.index;
    parts[target] = parts[target]! + step;
    shortfall -= step;
    cursor += 1;
  }

  return parts;
}
