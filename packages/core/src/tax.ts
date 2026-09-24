import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, toIsoDate } from "./dates.js";
import { applyRate, parseRate, type Amount } from "./money.js";
import { getSetting } from "./settings.js";

/**
 * Tax.
 *
 * Two rules, and the second is the one that matters.
 *
 * **A rate is effective-dated.** An invoice raised in March 2026 keeps the rate
 * that applied in March 2026, for ever, even after the rate changes. That is why
 * every taxed line records the `tax_rate_id` it used rather than the code alone:
 * a document has to reprint identically years later, and a tax audit compares
 * what was charged with what should have been charged *at the time*.
 *
 * **No rate exists until somebody enters one, with a citation.** There is no
 * seeded 6%, no fallback, no "sensible default". `tax_rate.source_ref` is NOT
 * NULL, so a rate cannot reach the database without naming the instrument it came
 * from. Whether CAC is SST registered, from when, and which of its services are
 * taxable is a question for CAC and its tax agent — see docs/OPEN_QUESTIONS.md,
 * Q-FIN-1. Until it is answered, `taxFor` returns nil tax and says why, and
 * invoices show no tax line at all.
 *
 * A plausible-looking rate that nobody verified is worse than no rate: it appears
 * on real invoices, gets collected, and has to be unwound.
 */

export interface TaxCodeRow {
  id: string;
  code: string;
  name: string;
  kind: "output" | "input" | "exempt" | "none";
  isActive: boolean;
  /** The rate in force today, as a percentage string for display, or null. */
  currentRate: string | null;
  rateCount: number;
}

export interface EffectiveRate {
  taxCodeId: string;
  taxRateId: string;
  /** Scaled by 1e6: 60000 is 6%. */
  rate: bigint;
  code: string;
  sourceRef: string;
}

/**
 * The rate in force for a code on a given date.
 *
 * Null when the code has no rate covering that date — which is the normal state
 * of this system today, and is not an error.
 */
export async function resolveTaxRate(
  db: Executor,
  taxCodeId: string,
  on: string | Date,
): Promise<EffectiveRate | null> {
  const date = toIsoDate(parseIsoDate(on));
  const result = await db.execute<{
    id: string;
    rate: string;
    code: string;
    source_ref: string;
  }>(sql`
    SELECT r.id, r.rate, c.code, r.source_ref
      FROM accounting.tax_rate r
      JOIN accounting.tax_code c ON c.id = r.tax_code_id
     WHERE r.tax_code_id = ${taxCodeId}
       AND r.effective_from <= ${date}::date
       AND (r.effective_to IS NULL OR r.effective_to >= ${date}::date)
     ORDER BY r.effective_from DESC
     LIMIT 1
  `);
  const row = result.rows?.[0];
  if (!row) return null;

  return {
    taxCodeId,
    taxRateId: row.id,
    rate: parseRate(row.rate),
    code: row.code,
    sourceRef: row.source_ref,
  };
}

export interface TaxResult {
  taxRateId: string | null;
  amount: Amount;
  /** Why the amount is nil, when it is. Surfaced on the screen, not swallowed. */
  note: string | null;
}

/**
 * Tax on a taxable amount.
 *
 * Returns nil with an explanation in three cases, all of them legitimate: the
 * company is not SST registered, no tax code was chosen, or the chosen code has
 * no rate for that date. The caller shows the note rather than silently charging
 * nothing.
 */
export async function taxFor(
  db: Executor,
  taxableAmount: Amount,
  taxCodeId: string | null | undefined,
  on: string | Date,
): Promise<TaxResult> {
  if (!taxCodeId) return { taxRateId: null, amount: 0n, note: null };

  const registered = await getSetting<boolean>(db, "tax.sst_registered", false);
  if (!registered) {
    return {
      taxRateId: null,
      amount: 0n,
      note: "No tax charged: the company is not recorded as SST registered (setting tax.sst_registered).",
    };
  }

  const rate = await resolveTaxRate(db, taxCodeId, on);
  if (!rate) {
    return {
      taxRateId: null,
      amount: 0n,
      note: `No tax charged: no rate has been entered for that tax code covering ${toIsoDate(parseIsoDate(on))}.`,
    };
  }

  return { taxRateId: rate.taxRateId, amount: applyRate(taxableAmount, rate.rate), note: null };
}

export async function listTaxCodes(db: Executor, on?: string): Promise<TaxCodeRow[]> {
  const date = toIsoDate(on ? parseIsoDate(on) : new Date());
  const result = await db.execute<{
    id: string;
    code: string;
    name: string;
    kind: TaxCodeRow["kind"];
    is_active: boolean;
    current_rate: string | null;
    rate_count: number;
  }>(sql`
    SELECT c.id, c.code, c.name, c.kind, c.is_active,
           (SELECT r.rate::text FROM accounting.tax_rate r
             WHERE r.tax_code_id = c.id
               AND r.effective_from <= ${date}::date
               AND (r.effective_to IS NULL OR r.effective_to >= ${date}::date)
             ORDER BY r.effective_from DESC LIMIT 1) AS current_rate,
           (SELECT count(*) FROM accounting.tax_rate r WHERE r.tax_code_id = c.id)::int AS rate_count
      FROM accounting.tax_code c
     ORDER BY c.code
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    isActive: row.is_active,
    currentRate: row.current_rate,
    rateCount: row.rate_count,
  }));
}

export interface TaxRateRow {
  id: string;
  taxCodeId: string;
  code: string;
  rate: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceRef: string;
  createdAt: Date | string;
}

export async function listTaxRates(db: Executor, taxCodeId?: string): Promise<TaxRateRow[]> {
  const result = await db.execute<{
    id: string;
    tax_code_id: string;
    code: string;
    rate: string;
    effective_from: string;
    effective_to: string | null;
    source_ref: string;
    created_at: Date | string;
  }>(sql`
    SELECT r.id, r.tax_code_id, c.code, r.rate, r.effective_from, r.effective_to,
           r.source_ref, r.created_at
      FROM accounting.tax_rate r
      JOIN accounting.tax_code c ON c.id = r.tax_code_id
     WHERE ${taxCodeId ? sql`r.tax_code_id = ${taxCodeId}` : sql`true`}
     ORDER BY c.code, r.effective_from DESC
  `);
  return (result.rows ?? []).map((row) => ({
    id: row.id,
    taxCodeId: row.tax_code_id,
    code: row.code,
    rate: row.rate,
    effectiveFrom: String(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? String(row.effective_to).slice(0, 10) : null,
    sourceRef: row.source_ref,
    createdAt: row.created_at,
  }));
}

export interface NewTaxRate {
  taxCodeId: string;
  /** A fraction: "0.06" for 6%, or "6%" which is converted. */
  rate: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  /** The instrument this comes from. Mandatory, and it is checked for substance. */
  sourceRef: string;
}

/**
 * Records a tax rate.
 *
 * The citation is required and is checked for being more than a word: "SST" is
 * not a source, "Service Tax (Rate of Tax) Order 2018, as amended, per our tax
 * agent's advice of 12 March 2026" is. Whoever enters this is asserting a
 * statutory fact that will appear on invoices, and the audit trail records who.
 *
 * Adding a rate also closes off the previous open-ended one, so two rates can
 * never both be in force on the same day.
 */
export async function addTaxRate(
  db: Executor,
  principal: Principal,
  input: NewTaxRate,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.tax.manage");

  const code = await db.execute<{ code: string }>(
    sql`SELECT code FROM accounting.tax_code WHERE id = ${input.taxCodeId}`,
  );
  if (!code.rows?.[0]) throw new NotFoundError("That tax code no longer exists.");

  // "6%" is what a person types; store the fraction.
  const text = input.rate.trim().endsWith("%")
    ? (Number.parseFloat(input.rate) / 100).toFixed(6)
    : input.rate.trim();
  const rate = parseRate(text, "rate");
  if (rate < 0n || rate > 1_000_000n) {
    throw new ValidationError("A tax rate is between 0% and 100%.", "rate");
  }

  const sourceRef = input.sourceRef?.trim() ?? "";
  if (sourceRef.length < 12 || sourceRef.split(/\s+/).length < 3) {
    throw new ValidationError(
      "Name the instrument this rate comes from — the order, guide or written advice, with its date. " +
        "A rate without a citation cannot be checked by anyone later.",
      "sourceRef",
    );
  }

  const from = toIsoDate(parseIsoDate(input.effectiveFrom, "effectiveFrom"));
  const to = input.effectiveTo ? toIsoDate(parseIsoDate(input.effectiveTo, "effectiveTo")) : null;
  if (to && to <= from) {
    throw new ValidationError("The end date must be after the start date.", "effectiveTo");
  }

  const overlapping = await db.execute<{ id: string; effective_from: string }>(sql`
    SELECT id, effective_from FROM accounting.tax_rate
     WHERE tax_code_id = ${input.taxCodeId}
       AND (effective_to IS NULL OR effective_to >= ${from}::date)
       AND effective_from <= ${to ?? "9999-12-31"}::date
     ORDER BY effective_from DESC
  `);

  for (const row of overlapping.rows ?? []) {
    const existingFrom = String(row.effective_from).slice(0, 10);
    if (existingFrom >= from) {
      throw new ConflictError(
        `A rate for this code already starts on ${existingFrom}. Remove or end that one first.`,
      );
    }
    // The earlier open-ended rate now ends the day before this one starts.
    await db.execute(sql`
      UPDATE accounting.tax_rate SET effective_to = (${from}::date - INTERVAL '1 day')::date
       WHERE id = ${row.id} AND (effective_to IS NULL OR effective_to >= ${from}::date)
    `);
  }

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.tax_rate (tax_code_id, rate, effective_from, effective_to, source_ref, created_by)
    VALUES (${input.taxCodeId}, ${text}, ${from}, ${to}, ${sourceRef}, ${principal.userId})
    RETURNING id
  `);

  // Entering a rate is what makes a tax code usable.
  await db.execute(sql`
    UPDATE accounting.tax_code SET is_active = true WHERE id = ${input.taxCodeId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.TAX_RATE_ADDED,
    entityType: "tax_rate",
    entityId: created.rows![0]!.id,
    newValues: {
      taxCode: code.rows[0].code,
      rate: text,
      effectiveFrom: from,
      effectiveTo: to,
      sourceRef,
    },
    reason: sourceRef,
  });

  return { id: created.rows![0]!.id };
}

/** "0.060000" reads as "6%". */
export function formatRate(rate: string | null): string {
  if (rate === null) return "—";
  const asPercent = Number.parseFloat(rate) * 100;
  return `${Number.isInteger(asPercent) ? asPercent : asPercent.toFixed(2)}%`;
}
