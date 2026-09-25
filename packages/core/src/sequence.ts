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

  let next: bigint;

  if (periodKey === null) {
    // No year or month in the format, so one counter for all time.
    next = BigInt(row.next_value);
    await db.execute(sql`
      UPDATE org.document_sequence
         SET next_value = ${(next + 1n).toString()}, updated_at = now()
       WHERE key = ${key}
    `);
  } else {
    // A counter per period, in its own row.
    //
    // One counter plus "the last period seen" only works while documents are numbered in
    // date order, and they are not: number a case dated May 2026, then one dated December
    // 2025, then another dated June 2026, and a single counter restarts each time the
    // period changes and reissues CASE-2026-00001. Backdating across a year boundary is
    // ordinary work, so the counter belongs to the period rather than to the sequence.
    //
    // The parent row is already locked FOR UPDATE above, which serialises every allocation
    // for this key — so the upsert below cannot race, and a rolled-back transaction still
    // returns its number to the pool.
    await db.execute(sql`
      INSERT INTO org.document_sequence_period (key, period_key, next_value)
      VALUES (${key}, ${periodKey}, 1)
      ON CONFLICT (key, period_key) DO NOTHING
    `);

    const current = await db.execute<{ next_value: string }>(sql`
      SELECT next_value FROM org.document_sequence_period
       WHERE key = ${key} AND period_key = ${periodKey}
    `);
    next = BigInt(current.rows![0]!.next_value);

    await db.execute(sql`
      UPDATE org.document_sequence_period
         SET next_value = ${(next + 1n).toString()}, updated_at = now()
       WHERE key = ${key} AND period_key = ${periodKey}
    `);

    // Kept up to date for the admin screen, which shows where a sequence has reached.
    // Nothing decides anything from it any more.
    await db.execute(sql`
      UPDATE org.document_sequence
         SET period_key = ${periodKey}, updated_at = now()
       WHERE key = ${key}
    `);
  }

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

  // The counter for the period the date falls in, which is the one an allocation would
  // take. A period nobody has numbered in yet starts at 1.
  let sequence = BigInt(row.next_value);
  if (periodKey !== null) {
    const period = await db.execute<{ next_value: string }>(sql`
      SELECT next_value FROM org.document_sequence_period
       WHERE key = ${key} AND period_key = ${periodKey}
    `);
    sequence = period.rows?.[0] ? BigInt(period.rows[0].next_value) : 1n;
  }

  return render(row.format, {
    prefix: row.prefix,
    date,
    sequence,
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
