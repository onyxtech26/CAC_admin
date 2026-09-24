import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { ConflictError } from "./errors.js";
import { parseIsoDate, today } from "./dates.js";

/**
 * Gapless document numbering.
 *
 * Invoices, receipts, vouchers and journals are numbered from
 * `org.document_sequence` rather than a PostgreSQL sequence, for one reason:
 * PostgreSQL sequences are deliberately *not* transactional. Roll back an insert
 * that consumed nextval and the number is gone for good. For an invoice book
 * that has to be produced to an auditor, a missing number is a question you
 * cannot answer — "we deleted it" and "someone removed it" look identical.
 *
 * So the counter is an ordinary row, taken with `FOR UPDATE`. Concurrent callers
 * queue behind the lock, and a rolled-back transaction returns its number to the
 * pool. The cost is that two simultaneous invoices serialise for the duration of
 * one transaction, which for this volume of work is not a cost at all.
 *
 * Allocation must therefore happen *inside* the transaction that writes the
 * document, and as late as possible. Passing a plain connection here would
 * quietly reintroduce the gap it exists to prevent.
 */

export interface AllocateOptions {
  /**
   * Date the number is dated by, for formats that reset yearly or monthly.
   * Defaults to today. Always pass the document's own date: a January invoice
   * entered in February belongs in the January run.
   */
  on?: Date | string;
}

/**
 * Takes the next number for `key` and advances the counter.
 *
 * @param db MUST be the transaction handle writing the document.
 */
export async function allocateDocumentNumber(
  db: Executor,
  key: string,
  options: AllocateOptions = {},
): Promise<string> {
  const date = normaliseDate(options.on);

  const locked = await db.execute<{
    prefix: string;
    format: string;
    padding: string;
    next_value: string;
    period_key: string | null;
  }>(sql`
    SELECT prefix, format, padding, next_value, period_key
      FROM org.document_sequence
     WHERE key = ${key}
       FOR UPDATE
  `);

  const row = locked.rows?.[0];
  if (!row) {
    // A missing sequence is a deployment fault, not a user error: some module
    // asked for a number nobody configured.
    throw new ConflictError(
      `No document sequence is configured for "${key}". An administrator must add one before this document can be numbered.`,
    );
  }

  const periodKey = periodKeyFor(row.format, date);
  const padding = Number.parseInt(row.padding, 10);
  const width = Number.isFinite(padding) && padding > 0 ? padding : 5;

  // A format that carries the year or month restarts at 1 each time that
  // component changes. The stored period_key is what tells us it has.
  const restarting = periodKey !== null && row.period_key !== periodKey;
  const next = restarting ? 1n : BigInt(row.next_value);

  await db.execute(sql`
    UPDATE org.document_sequence
       SET next_value = ${(next + 1n).toString()},
           period_key = ${periodKey}
     WHERE key = ${key}
  `);

  return render(row.format, {
    prefix: row.prefix,
    date,
    sequence: next,
    width,
  });
}

/**
 * What the next number would be, without taking it.
 *
 * For previews only. Never use it to write a document: between reading and
 * writing, someone else's transaction may have taken it.
 */
export async function peekDocumentNumber(
  db: Executor,
  key: string,
  options: AllocateOptions = {},
): Promise<string | null> {
  const date = normaliseDate(options.on);
  const result = await db.execute<{
    prefix: string;
    format: string;
    padding: string;
    next_value: string;
    period_key: string | null;
  }>(sql`
    SELECT prefix, format, padding, next_value, period_key
      FROM org.document_sequence WHERE key = ${key}
  `);
  const row = result.rows?.[0];
  if (!row) return null;

  const periodKey = periodKeyFor(row.format, date);
  const padding = Number.parseInt(row.padding, 10);
  return render(row.format, {
    prefix: row.prefix,
    date,
    sequence: row.period_key !== periodKey && periodKey !== null ? 1n : BigInt(row.next_value),
    width: Number.isFinite(padding) && padding > 0 ? padding : 5,
  });
}

function render(
  format: string,
  values: { prefix: string; date: Date; sequence: bigint; width: number },
): string {
  const year = values.date.getUTCFullYear().toString();
  const month = (values.date.getUTCMonth() + 1).toString().padStart(2, "0");

  return format
    .replace(/\{PREFIX\}/g, values.prefix)
    .replace(/\{YYYY\}/g, year)
    .replace(/\{YY\}/g, year.slice(-2))
    .replace(/\{MM\}/g, month)
    .replace(/\{SEQ\}/g, values.sequence.toString().padStart(values.width, "0"));
}

/**
 * The reset boundary implied by a format.
 *
 * `{MM}` implies monthly, `{YYYY}`/`{YY}` yearly, and a format with neither
 * counts on for ever. Derived from the format rather than configured separately,
 * so a format cannot disagree with its own reset rule and produce duplicates.
 */
function periodKeyFor(format: string, date: Date): string | null {
  const year = date.getUTCFullYear().toString();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  if (/\{MM\}/.test(format)) return `${year}-${month}`;
  if (/\{YYYY\}|\{YY\}/.test(format)) return year;
  return null;
}

/** Missing means today in the company's timezone; see dates.ts. */
function normaliseDate(input?: Date | string): Date {
  return input === undefined ? today() : parseIsoDate(input);
}
