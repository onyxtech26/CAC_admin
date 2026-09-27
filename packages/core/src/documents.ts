import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { ValidationError } from "./errors.js";
import {
  amountToSql,
  multiplyAmount,
  parseAmount,
  parseRate,
  roundToCents,
  sumAmounts,
  type Amount,
} from "./money.js";
import { taxFor } from "./tax.js";

/**
 * Document lines.
 *
 * Quotations and invoices share this arithmetic, and so will purchase orders and
 * vouchers. It lives here rather than in each document so there is one answer to
 * "what does this line come to", and one place to read it.
 *
 * The order of operations is fixed and matters:
 *
 *   subtotal = quantity x unit price          rounded to cents
 *   discount = subtotal x percent             rounded to cents, or the amount given
 *   taxable  = subtotal - discount
 *   tax      = taxable x rate                 rounded to cents
 *   total    = taxable + tax
 *
 * Tax is computed per line and summed, not computed once on the document total.
 * The two differ by a cent or two on multi-line documents, and per-line is what
 * an SST-registered business is expected to show. The database CHECK constraint
 * `invoice_line_adds_up` holds this identity independently.
 *
 * Every figure is computed here, on the server, from the quantity and the unit
 * price. Nothing the browser sends about a total is trusted or even read.
 */

export interface DocumentLineInput {
  description: string;
  quantity?: string | number | null;
  unit?: string | null;
  unitPrice?: string | number | null;
  /** Either a percentage ("0.1" for 10%) or a flat amount. Percentage wins. */
  discountPercent?: string | number | null;
  discountAmount?: string | number | null;
  taxCodeId?: string | null;
  /** The account this line posts to. Id or code. */
  accountId?: string | null;
  accountCode?: string | null;
  caseId?: string | null;
  costCentreId?: string | null;
  /** Expense claims only: when the money was actually spent. */
  spentOn?: string | null;
  /** Where the paper receipt is filed. */
  receiptRef?: string | null;
}

export interface ComputedLine {
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: Amount;
  discountPercent: string | null;
  discountAmount: Amount;
  taxCodeId: string | null;
  taxRateId: string | null;
  taxAmount: Amount;
  lineSubtotal: Amount;
  lineTotal: Amount;
  accountId: string;
  accountCode: string;
  accountName: string;
  caseId: string | null;
  costCentreId: string | null;
  spentOn: string | null;
  receiptRef: string | null;
}

export interface DocumentTotals {
  subtotal: Amount;
  discountTotal: Amount;
  taxTotal: Amount;
  total: Amount;
}

export interface ComputedDocument {
  lines: ComputedLine[];
  totals: DocumentTotals;
  /** Explanations for nil tax, deduplicated. Shown to the user, never swallowed. */
  taxNotes: string[];
}

/** A row the user has started and not filled in. The form always shows spares. */
function isBlank(line: DocumentLineInput): boolean {
  const empty = (v: unknown) => v === null || v === undefined || v === "";
  return (
    empty(line.description) &&
    empty(line.unitPrice) &&
    empty(line.accountId) &&
    empty(line.accountCode)
  );
}

/**
 * Validates and prices a set of lines.
 *
 * Hits the database for the account and the tax rate, so it is async; everything
 * else is arithmetic. Throws on the first problem with the line number in the
 * message, because a form that reports "something is wrong" is no help.
 */
export async function computeDocumentLines(
  db: Executor,
  rawLines: DocumentLineInput[],
  on: string,
): Promise<ComputedDocument> {
  const usable = rawLines.filter((line) => !isBlank(line));

  if (usable.length === 0) {
    throw new ValidationError("Add at least one line.", "lines");
  }

  const lines: ComputedLine[] = [];
  const notes = new Set<string>();

  for (const [index, raw] of usable.entries()) {
    const position = index + 1;
    const field = (suffix: string) => `lines.${index}.${suffix}`;

    const description = String(raw.description ?? "").trim();
    if (description.length === 0) {
      throw new ValidationError(`Line ${position}: describe what is being charged.`, field("description"));
    }

    const quantityText = String(raw.quantity ?? "1").trim() || "1";
    let quantity: bigint;
    try {
      quantity = parseRate(quantityText, field("quantity"));
    } catch {
      throw new ValidationError(`Line ${position}: "${quantityText}" is not a valid quantity.`, field("quantity"));
    }
    if (quantity <= 0n) {
      throw new ValidationError(`Line ${position}: the quantity must be more than nothing.`, field("quantity"));
    }

    const unitPrice = parseAmount(raw.unitPrice ?? "0", field("unitPrice"));
    if (unitPrice < 0n) {
      throw new ValidationError(
        `Line ${position}: a negative price is not a discount. Use the discount column, or raise a credit note.`,
        field("unitPrice"),
      );
    }

    const lineSubtotal = multiplyAmount(unitPrice, quantity);

    let discountPercent: string | null = null;
    let discountAmount: Amount;
    if (raw.discountPercent !== null && raw.discountPercent !== undefined && raw.discountPercent !== "") {
      const percent = parseRate(String(raw.discountPercent), field("discountPercent"));
      if (percent < 0n || percent > 1_000_000n) {
        throw new ValidationError(`Line ${position}: a discount is between 0% and 100%.`, field("discountPercent"));
      }
      discountPercent = String(raw.discountPercent);
      // The percentage is what was agreed; the amount is what it came to. Both
      // are stored so the document can show either.
      discountAmount = roundToCents((lineSubtotal * percent) / 1_000_000n);
    } else {
      discountAmount = parseAmount(raw.discountAmount ?? "0", field("discountAmount"));
    }

    if (discountAmount < 0n) {
      throw new ValidationError(`Line ${position}: a discount cannot be negative.`, field("discountAmount"));
    }
    if (discountAmount > lineSubtotal) {
      throw new ValidationError(
        `Line ${position}: the discount is more than the line is worth.`,
        field("discountAmount"),
      );
    }

    const taxable = lineSubtotal - discountAmount;
    const tax = await taxFor(db, taxable, raw.taxCodeId, on);
    if (tax.note) notes.add(tax.note);

    const account = await resolveAccount(db, raw, position, field("account"));

    lines.push({
      description,
      quantity: quantityText,
      unit: raw.unit?.trim() || null,
      unitPrice,
      discountPercent,
      discountAmount,
      taxCodeId: raw.taxCodeId || null,
      taxRateId: tax.taxRateId,
      taxAmount: tax.amount,
      lineSubtotal,
      lineTotal: taxable + tax.amount,
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      caseId: raw.caseId || null,
      costCentreId: raw.costCentreId || null,
      spentOn: raw.spentOn || null,
      receiptRef: raw.receiptRef?.trim() || null,
    });
  }

  const subtotal = sumAmounts(lines.map((line) => line.lineSubtotal));
  const discountTotal = sumAmounts(lines.map((line) => line.discountAmount));
  const taxTotal = sumAmounts(lines.map((line) => line.taxAmount));

  return {
    lines,
    totals: { subtotal, discountTotal, taxTotal, total: subtotal - discountTotal + taxTotal },
    taxNotes: [...notes],
  };
}

async function resolveAccount(
  db: Executor,
  raw: DocumentLineInput,
  position: number,
  field: string,
): Promise<{ id: string; code: string; name: string }> {
  if (!raw.accountId && !raw.accountCode) {
    throw new ValidationError(`Line ${position}: choose the account this is earned in.`, field);
  }

  const result = await db.execute<{
    id: string;
    code: string;
    name: string;
    is_postable: boolean;
    is_active: boolean;
  }>(
    raw.accountId
      ? sql`SELECT id, code, name, is_postable, is_active FROM accounting.account WHERE id = ${raw.accountId}`
      : sql`SELECT id, code, name, is_postable, is_active FROM accounting.account WHERE code = ${raw.accountCode}`,
  );
  const found = result.rows?.[0];

  if (!found) {
    throw new ValidationError(
      `Line ${position}: there is no account "${raw.accountCode ?? raw.accountId}".`,
      field,
    );
  }
  if (!found.is_postable) {
    throw new ValidationError(
      `Line ${position}: ${found.code} ${found.name} is a heading. Choose one of the accounts under it.`,
      field,
    );
  }
  if (!found.is_active) {
    throw new ValidationError(`Line ${position}: ${found.code} ${found.name} is no longer in use.`, field);
  }

  return { id: found.id, code: found.code, name: found.name };
}

/**
 * Writes computed lines to a document's line table.
 *
 * `table` is a fixed identifier chosen by the caller from a closed set, never
 * user input — `sql.raw` on anything else here would be an injection.
 */
export async function writeDocumentLines(
  db: Executor,
  table: "quotation_line" | "invoice_line" | "supplier_invoice_line",
  parentColumn: "quotation_id" | "invoice_id" | "supplier_invoice_id",
  parentId: string,
  lines: ComputedLine[],
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    await db.execute(sql`
      INSERT INTO ${sql.raw(`accounting.${table}`)}
        (${sql.raw(parentColumn)}, line_no, description, quantity, unit, unit_price,
         discount_percent, discount_amount, tax_code_id, tax_rate_id, tax_amount,
         line_subtotal, line_total, account_id, case_id)
      VALUES (
        ${parentId}, ${index + 1}, ${line.description}, ${line.quantity}, ${line.unit},
        ${amountToSql(line.unitPrice)}, ${line.discountPercent}, ${amountToSql(line.discountAmount)},
        ${line.taxCodeId}, ${line.taxRateId}, ${amountToSql(line.taxAmount)},
        ${amountToSql(line.lineSubtotal)}, ${amountToSql(line.lineTotal)},
        ${line.accountId}, ${line.caseId}
      )
    `);
  }
}

export interface StoredLine
  extends Omit<ComputedLine, "accountCode" | "accountName" | "costCentreId" | "spentOn" | "receiptRef"> {
  id: string;
  lineNo: number;
  accountCode: string;
  accountName: string;
}

export async function readDocumentLines(
  db: Executor,
  table: "quotation_line" | "invoice_line" | "supplier_invoice_line",
  parentColumn: "quotation_id" | "invoice_id" | "supplier_invoice_id",
  parentId: string,
): Promise<StoredLine[]> {
  const result = await db.execute<{
    id: string;
    line_no: number;
    description: string;
    quantity: string;
    unit: string | null;
    unit_price: string;
    discount_percent: string | null;
    discount_amount: string;
    tax_code_id: string | null;
    tax_rate_id: string | null;
    tax_amount: string;
    line_subtotal: string;
    line_total: string;
    account_id: string;
    account_code: string;
    account_name: string;
    case_id: string | null;
  }>(sql`
    SELECT l.*, a.code AS account_code, a.name AS account_name
      FROM ${sql.raw(`accounting.${table}`)} l
      JOIN accounting.account a ON a.id = l.account_id
     WHERE l.${sql.raw(parentColumn)} = ${parentId}
     ORDER BY l.line_no
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    lineNo: row.line_no,
    description: row.description,
    quantity: row.quantity,
    unit: row.unit,
    unitPrice: parseAmount(row.unit_price),
    discountPercent: row.discount_percent,
    discountAmount: parseAmount(row.discount_amount),
    taxCodeId: row.tax_code_id,
    taxRateId: row.tax_rate_id,
    taxAmount: parseAmount(row.tax_amount),
    lineSubtotal: parseAmount(row.line_subtotal),
    lineTotal: parseAmount(row.line_total),
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    caseId: row.case_id,
  }));
}

/**
 * The money-out line tables.
 *
 * Purchase orders, vouchers and claims have no discount columns: a supplier's
 * discount is already in the price they quoted, and inventing a discount field
 * for it would be a second place to record the same thing. They do carry a cost
 * centre, which the sales documents do not, and claims additionally record when
 * the money was actually spent.
 */
export type PurchaseLineTable =
  | "purchase_order_line"
  | "payment_voucher_line"
  | "expense_claim_line";

export async function writePurchaseLines(
  db: Executor,
  table: PurchaseLineTable,
  parentColumn: "order_id" | "voucher_id" | "claim_id",
  parentId: string,
  lines: ComputedLine[],
  /** Claims need a spend date per line; it falls back to the document date. */
  defaultSpentOn?: string,
): Promise<void> {
  const isClaim = table === "expense_claim_line";

  for (const [index, line] of lines.entries()) {
    const columns = [
      sql.raw(parentColumn),
      sql.raw("line_no"),
      sql.raw("description"),
      sql.raw("quantity"),
      sql.raw("unit"),
      sql.raw("unit_price"),
      sql.raw("tax_code_id"),
      sql.raw("tax_rate_id"),
      sql.raw("tax_amount"),
      sql.raw("line_subtotal"),
      sql.raw("line_total"),
      sql.raw("account_id"),
      sql.raw("cost_centre_id"),
      sql.raw("case_id"),
      ...(isClaim ? [sql.raw("spent_on"), sql.raw("receipt_ref")] : []),
    ];

    const values = [
      sql`${parentId}`,
      sql`${index + 1}`,
      sql`${line.description}`,
      sql`${line.quantity}`,
      sql`${line.unit}`,
      sql`${amountToSql(line.unitPrice)}`,
      sql`${line.taxCodeId}`,
      sql`${line.taxRateId}`,
      sql`${amountToSql(line.taxAmount)}`,
      // The purchase-side tables have no discount column, so anything discounted
      // is folded into the price before it gets here.
      sql`${amountToSql(line.lineSubtotal - line.discountAmount)}`,
      sql`${amountToSql(line.lineTotal)}`,
      sql`${line.accountId}`,
      sql`${line.costCentreId}`,
      sql`${line.caseId}`,
      ...(isClaim
        ? [sql`${line.spentOn ?? defaultSpentOn ?? null}`, sql`${line.receiptRef}`]
        : []),
    ];

    await db.execute(sql`
      INSERT INTO ${sql.raw(`accounting.${table}`)} (${sql.join(columns, sql`, `)})
      VALUES (${sql.join(values, sql`, `)})
    `);
  }
}

export interface PurchaseLine {
  id: string;
  lineNo: number;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: Amount;
  taxCodeId: string | null;
  taxRateId: string | null;
  taxAmount: Amount;
  lineSubtotal: Amount;
  lineTotal: Amount;
  accountId: string;
  accountCode: string;
  accountName: string;
  costCentreId: string | null;
  costCentreCode: string | null;
  caseId: string | null;
  /** Purchase orders only. */
  quantityReceived: string | null;
  /** Claims only. */
  spentOn: string | null;
  receiptRef: string | null;
}

export async function readPurchaseLines(
  db: Executor,
  table: PurchaseLineTable,
  parentColumn: "order_id" | "voucher_id" | "claim_id",
  parentId: string,
): Promise<PurchaseLine[]> {
  const result = await db.execute<Record<string, never>>(sql`
    SELECT l.*, a.code AS account_code, a.name AS account_name, cc.code AS cost_centre_code
      FROM ${sql.raw(`accounting.${table}`)} l
      JOIN accounting.account a ON a.id = l.account_id
      LEFT JOIN org.cost_centre cc ON cc.id = l.cost_centre_id
     WHERE l.${sql.raw(parentColumn)} = ${parentId}
     ORDER BY l.line_no
  `);

  return (result.rows ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      lineNo: Number(row.line_no),
      description: String(row.description),
      quantity: String(row.quantity),
      unit: (row.unit as string) ?? null,
      unitPrice: parseAmount(String(row.unit_price)),
      taxCodeId: (row.tax_code_id as string) ?? null,
      taxRateId: (row.tax_rate_id as string) ?? null,
      taxAmount: parseAmount(String(row.tax_amount)),
      lineSubtotal: parseAmount(String(row.line_subtotal)),
      lineTotal: parseAmount(String(row.line_total)),
      accountId: String(row.account_id),
      accountCode: String(row.account_code),
      accountName: String(row.account_name),
      costCentreId: (row.cost_centre_id as string) ?? null,
      costCentreCode: (row.cost_centre_code as string) ?? null,
      caseId: (row.case_id as string) ?? null,
      quantityReceived: row.quantity_received === undefined ? null : String(row.quantity_received),
      spentOn: row.spent_on ? String(row.spent_on).slice(0, 10) : null,
      receiptRef: (row.receipt_ref as string) ?? null,
    };
  });
}
