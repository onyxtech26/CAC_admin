import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { addDays, parseIsoDate, today, toIsoDate } from "./dates.js";
import { amountToSql, formatAmount, isAmount, parseAmount, type Amount } from "./money.js";
import { postSourceJournal } from "./posting.js";
import { allocateDocumentNumber } from "./sequence.js";
import { findColumn, readDelimited } from "./delimited.js";

/**
 * The bank, and proving the ledger agrees with it.
 *
 * Every module before this one records what CAC believes happened. This one
 * brings in what the bank says happened and makes the two account for each
 * other. For a firm this size it is the highest-value control there is: it finds
 * the payment that never left, the receipt that never arrived, the charge nobody
 * knew about, and the entry somebody typed twice.
 *
 * Two conventions run through the whole file and are worth stating once.
 *
 * **Direction.** A statement line's `paidIn` and `paidOut` are from the *firm's*
 * point of view. Money in increases the firm's asset, so it is a ledger DEBIT on
 * the bank account. The bank's own statement usually shows the mirror image,
 * because to the bank your deposit is its liability. Every sign error in bank
 * reconciliation comes from losing track of that, so the column names here say
 * what they mean and the database CHECKs them one-directional.
 *
 * **Matching is a claim, not a calculation.** Saying a statement line and a
 * journal line are the same movement of money is a judgement, and it is audited
 * as one, individually. A reconciliation that balances is worth exactly as much
 * as the matches beneath it; "who decided these two were the same payment" is the
 * first question asked when one of them turns out to be wrong.
 */

export type StatementLineStatus = "unmatched" | "matched" | "ignored";
export type ReconciliationStatus = "draft" | "completed";

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

export interface BankAccountInput {
  accountId: string;
  bankName: string;
  accountNo?: string | null;
  accountLabel?: string | null;
  swiftCode?: string | null;
  notes?: string | null;
}

export interface BankAccountView {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  bankName: string;
  accountNo: string | null;
  accountLabel: string | null;
  swiftCode: string | null;
  currency: string;
  isActive: boolean;
  notes: string | null;
  /** From posted journals, so it is comparable with a statement balance. */
  ledgerBalance: Amount;
  lastStatementTo: string | null;
  lastReconciledOn: string | null;
  unmatchedLines: number;
  openReconciliationId: string | null;
}

export async function createBankAccount(
  db: Executor,
  principal: Principal,
  input: BankAccountInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.bank.manage");

  const bankName = input.bankName?.trim();
  if (!bankName) throw new ValidationError("Name the bank.", "bankName");
  if (!input.accountId) throw new ValidationError("Choose the ledger account.", "accountId");

  const existing = await db.execute<{ id: string }>(
    sql`SELECT id FROM accounting.bank_account WHERE account_id = ${input.accountId}`,
  );
  if (existing.rows?.[0]) {
    throw new ConflictError(
      "That ledger account already has a bank account against it. One ledger account holds " +
        "one real account, or its balance could never be reconciled.",
    );
  }

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.bank_account
      (account_id, bank_name, account_no, account_label, swift_code, notes, created_by)
    VALUES (${input.accountId}, ${bankName}, ${input.accountNo?.trim() || null},
            ${input.accountLabel?.trim() || null}, ${input.swiftCode?.trim() || null},
            ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.BANK_ACCOUNT_CREATED,
    entityType: "bank_account",
    entityId: id,
    // The number is masked: an audit log is read by more people than an invoice.
    newValues: { bankName, accountNo: mask(input.accountNo) },
  });

  return { id };
}

export async function updateBankAccount(
  db: Executor,
  principal: Principal,
  bankAccountId: string,
  input: Omit<BankAccountInput, "accountId"> & { isActive?: boolean },
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.bank.manage");

  const before = await db.execute<{ bank_name: string; account_no: string | null }>(
    sql`SELECT bank_name, account_no FROM accounting.bank_account WHERE id = ${bankAccountId}`,
  );
  const previous = before.rows?.[0];
  if (!previous) throw new NotFoundError("That bank account no longer exists.");

  const bankName = input.bankName?.trim();
  if (!bankName) throw new ValidationError("Name the bank.", "bankName");

  await db.execute(sql`
    UPDATE accounting.bank_account
       SET bank_name = ${bankName},
           account_no = ${input.accountNo?.trim() || null},
           account_label = ${input.accountLabel?.trim() || null},
           swift_code = ${input.swiftCode?.trim() || null},
           notes = ${input.notes?.trim() || null},
           is_active = ${input.isActive ?? true},
           updated_by = ${principal.userId}
     WHERE id = ${bankAccountId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.BANK_ACCOUNT_UPDATED,
    entityType: "bank_account",
    entityId: bankAccountId,
    oldValues: { bankName: previous.bank_name, accountNo: mask(previous.account_no) },
    newValues: { bankName, accountNo: mask(input.accountNo) },
  });
}

/** Last four digits only. Enough to recognise the account, useless to misuse. */
function mask(accountNo: string | null | undefined): string | null {
  const digits = (accountNo ?? "").replace(/\D/g, "");
  if (digits.length === 0) return null;
  return digits.length <= 4 ? "****" : `****${digits.slice(-4)}`;
}

export async function listBankAccounts(
  db: Executor,
  options: { includeInactive?: boolean } = {},
): Promise<BankAccountView[]> {
  const result = await db.execute<{
    id: string;
    account_id: string;
    account_code: string;
    account_name: string;
    bank_name: string;
    account_no: string | null;
    account_label: string | null;
    swift_code: string | null;
    currency: string;
    is_active: boolean;
    notes: string | null;
    debit: string;
    credit: string;
    last_statement_to: string | null;
    last_reconciled_on: string | null;
    unmatched_lines: number;
    open_reconciliation_id: string | null;
  }>(sql`
    SELECT ba.id, ba.account_id, a.code AS account_code, a.name AS account_name,
           ba.bank_name, ba.account_no, ba.account_label, ba.swift_code, ba.currency,
           ba.is_active, ba.notes,
           COALESCE(bal.debit, 0)::text AS debit,
           COALESCE(bal.credit, 0)::text AS credit,
           st.last_statement_to,
           rc.last_reconciled_on,
           COALESCE(um.unmatched_lines, 0)::int AS unmatched_lines,
           op.id AS open_reconciliation_id
      FROM accounting.bank_account ba
      JOIN accounting.account a ON a.id = ba.account_id
      LEFT JOIN (
        SELECT l.account_id,
               SUM(l.debit) AS debit,
               SUM(l.credit) AS credit
          FROM accounting.journal_line l
          JOIN accounting.journal j ON j.id = l.journal_id
         WHERE j.status IN ('posted', 'reversed')
         GROUP BY l.account_id
      ) bal ON bal.account_id = ba.account_id
      LEFT JOIN (
        SELECT bank_account_id, MAX(period_to) AS last_statement_to
          FROM accounting.bank_statement GROUP BY bank_account_id
      ) st ON st.bank_account_id = ba.id
      LEFT JOIN (
        SELECT bank_account_id, MAX(as_at) AS last_reconciled_on
          FROM accounting.reconciliation WHERE status = 'completed'
         GROUP BY bank_account_id
      ) rc ON rc.bank_account_id = ba.id
      LEFT JOIN (
        SELECT s.bank_account_id, count(*) AS unmatched_lines
          FROM accounting.bank_statement_line l
          JOIN accounting.bank_statement s ON s.id = l.statement_id
         WHERE l.status = 'unmatched'
         GROUP BY s.bank_account_id
      ) um ON um.bank_account_id = ba.id
      LEFT JOIN accounting.reconciliation op
        ON op.bank_account_id = ba.id AND op.status = 'draft'
     WHERE ${options.includeInactive ? sql`true` : sql`ba.is_active`}
     ORDER BY a.code
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    bankName: row.bank_name,
    accountNo: row.account_no,
    accountLabel: row.account_label,
    swiftCode: row.swift_code,
    currency: row.currency,
    isActive: row.is_active,
    notes: row.notes,
    ledgerBalance: parseAmount(row.debit) - parseAmount(row.credit),
    lastStatementTo: row.last_statement_to ? String(row.last_statement_to).slice(0, 10) : null,
    lastReconciledOn: row.last_reconciled_on ? String(row.last_reconciled_on).slice(0, 10) : null,
    unmatchedLines: row.unmatched_lines,
    openReconciliationId: row.open_reconciliation_id,
  }));
}

export async function getBankAccount(
  db: Executor,
  bankAccountId: string,
): Promise<BankAccountView | null> {
  const all = await listBankAccounts(db, { includeInactive: true });
  return all.find((account) => account.id === bankAccountId) ?? null;
}

// ---------------------------------------------------------------------------
// Parsing a statement
//
// Import is two steps on purpose: parse and show, then confirm and write. A
// month of misread transactions is expensive to unpick, and the cheapest place
// to catch a wrong column mapping is a preview the person can look at.
// ---------------------------------------------------------------------------

export interface ColumnMapping {
  date: number;
  description: number;
  /** Either separate money-in and money-out columns… */
  paidIn?: number;
  paidOut?: number;
  /** …or one signed amount column, where a negative is money out. */
  amount?: number;
  reference?: number;
  balance?: number;
  valueDate?: number;
  /** How to read the date column. `auto` tries the unambiguous readings. */
  dateFormat?: "auto" | "dmy" | "mdy" | "ymd";
}

export interface ParsedStatementLine {
  lineNo: number;
  txnDate: string;
  valueDate: string | null;
  description: string;
  reference: string | null;
  paidIn: Amount;
  paidOut: Amount;
  runningBalance: Amount | null;
}

export interface ParsedStatement {
  header: string[];
  delimiter: string;
  mapping: ColumnMapping;
  lines: ParsedStatementLine[];
  /** Rows that could not be read, with the reason, rather than dropped silently. */
  rejected: Array<{ rowNo: number; reason: string; raw: string[] }>;
  earliest: string | null;
  latest: string | null;
  totalIn: Amount;
  totalOut: Amount;
  digest: string;
  blankRowsSkipped: number;
}

/**
 * Guesses the column mapping from the headings.
 *
 * A guess that is shown before it is used is helpful; a guess that is applied
 * silently is a liability. The preview screen shows what was guessed and lets it
 * be changed, and `parseStatement` accepts an explicit mapping when the guess is
 * wrong or the file has no usable headings at all.
 */
export function guessMapping(header: string[]): Partial<ColumnMapping> {
  const date = findColumn(header, ["transaction date", "txn date", "date", "posting date", "tarikh"]);
  const description = findColumn(header, [
    "description",
    "transaction description",
    "details",
    "narrative",
    "particulars",
    "keterangan",
  ]);
  const paidIn = findColumn(header, ["paid in", "credit", "deposit", "money in", "cr", "kredit"]);
  const paidOut = findColumn(header, [
    "paid out",
    "debit",
    "withdrawal",
    "money out",
    "dr",
    "debit amount",
    "debit",
  ]);
  const amount = findColumn(header, ["amount", "transaction amount", "value", "jumlah"]);
  const reference = findColumn(header, ["reference", "ref", "cheque no", "cheque", "transaction ref"]);
  const balance = findColumn(header, ["balance", "running balance", "ledger balance", "baki"]);
  const valueDate = findColumn(header, ["value date", "effective date"]);

  const mapping: Partial<ColumnMapping> = {};
  if (date !== -1) mapping.date = date;
  if (description !== -1) mapping.description = description;
  if (reference !== -1) mapping.reference = reference;
  if (balance !== -1) mapping.balance = balance;
  if (valueDate !== -1) mapping.valueDate = valueDate;

  // Separate columns are preferred when both are present: a bank that gives both
  // has already told us the direction, and inferring it from a sign is a guess.
  if (paidIn !== -1 && paidOut !== -1 && paidIn !== paidOut) {
    mapping.paidIn = paidIn;
    mapping.paidOut = paidOut;
  } else if (amount !== -1) {
    mapping.amount = amount;
  } else if (paidIn !== -1) {
    mapping.paidIn = paidIn;
  } else if (paidOut !== -1) {
    mapping.paidOut = paidOut;
  }

  return mapping;
}

/**
 * Reads a money cell.
 *
 * Handles thousands separators, a trailing or leading minus, brackets for
 * negatives, and a currency prefix, because all four turn up in real exports. It
 * refuses anything it cannot read rather than treating it as nil — a row silently
 * read as zero is the worst possible outcome, since the statement still imports
 * and the reconciliation is quietly wrong by that amount.
 */
function readMoney(raw: string, field: string): { amount: Amount; negative: boolean } {
  let text = raw.trim();
  if (text === "" || text === "-") return { amount: 0n, negative: false };

  let negative = false;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }

  text = text.replace(/^(RM|MYR|\$)\s*/i, "").trim();

  if (text.endsWith("-")) {
    negative = true;
    text = text.slice(0, -1).trim();
  }
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1).trim();
  }
  if (text.startsWith("+")) text = text.slice(1).trim();

  // Thousands separators only; a comma used as the decimal mark is ambiguous with
  // a thousands separator and is not guessed at.
  text = text.replace(/,(?=\d{3}\b)/g, "").replace(/\s/g, "");

  if (!isAmount(text)) {
    throw new ValidationError(`"${raw}" is not an amount this can read.`, field);
  }

  return { amount: parseAmount(text, field), negative };
}

/**
 * Reads a date cell.
 *
 * `auto` accepts ISO, and day-first or month-first only when the day is above
 * twelve so the reading is unambiguous. `03/04/2026` is refused under `auto`,
 * because guessing between 3 April and 4 March is choosing which month a
 * statement belongs to by coin flip. The importer asks instead.
 */
function readDate(raw: string, format: ColumnMapping["dateFormat"], field: string): string {
  const text = raw.trim();
  if (text === "") throw new ValidationError("The date is missing.", field);

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]), text, field);

  const parts = /^(\d{1,4})[/\-.\s](\d{1,2})[/\-.\s](\d{2,4})/.exec(text);
  if (parts) {
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    const c = Number(parts[3]);
    const year = c < 100 ? 2000 + c : c;

    if (format === "ymd") return build(a < 100 ? 2000 + a : a, b, c, text, field);
    if (format === "dmy") return build(year, b, a, text, field);
    if (format === "mdy") return build(year, a, b, text, field);

    if (a > 12 && b <= 12) return build(year, b, a, text, field);
    if (b > 12 && a <= 12) return build(year, a, b, text, field);

    throw new ValidationError(
      `"${text}" could be day-first or month-first and this will not guess. ` +
        "Say which the file uses.",
      "dateFormat",
    );
  }

  // "12 Jan 2026" and "12-JAN-26".
  const named = /^(\d{1,2})[\s\-]([A-Za-z]{3,})[\s\-](\d{2,4})$/.exec(text);
  if (named) {
    const months = [
      "jan", "feb", "mar", "apr", "may", "jun",
      "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    const month = months.indexOf(named[2]!.slice(0, 3).toLowerCase()) + 1;
    if (month === 0) throw new ValidationError(`"${text}" has no month this recognises.`, field);
    const year = Number(named[3]) < 100 ? 2000 + Number(named[3]) : Number(named[3]);
    return build(year, month, Number(named[1]), text, field);
  }

  throw new ValidationError(`"${text}" is not a date this can read.`, field);
}

function build(year: number, month: number, day: number, raw: string, field: string): string {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ValidationError(`"${raw}" is not a real date.`, field);
  }
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Round-trips through the date parser, which rejects 31 February.
  const parsed = parseIsoDate(iso, field);
  if (toIsoDate(parsed) !== iso) throw new ValidationError(`"${raw}" is not a real date.`, field);
  return iso;
}

export function parseStatement(
  text: string,
  options: { mapping?: Partial<ColumnMapping>; skipRows?: number; delimiter?: string } = {},
): ParsedStatement {
  const table = readDelimited(text, {
    skipRows: options.skipRows,
    delimiter: options.delimiter,
    maxRows: 20000,
  });

  const guessed = guessMapping(table.header);
  const merged = { ...guessed, ...options.mapping } as Partial<ColumnMapping>;

  if (merged.date === undefined) {
    throw new ValidationError(
      "No date column was recognised. Say which column holds the transaction date.",
      "mapping.date",
    );
  }
  if (merged.description === undefined) {
    throw new ValidationError(
      "No description column was recognised. Say which column holds the description.",
      "mapping.description",
    );
  }
  if (merged.amount === undefined && merged.paidIn === undefined && merged.paidOut === undefined) {
    throw new ValidationError(
      "No amount column was recognised. Say which columns hold the money in and out, " +
        "or the single signed amount column.",
      "mapping.amount",
    );
  }

  const mapping = { dateFormat: "auto" as const, ...merged } as ColumnMapping;

  const lines: ParsedStatementLine[] = [];
  const rejected: ParsedStatement["rejected"] = [];
  let totalIn = 0n;
  let totalOut = 0n;

  const cell = (row: string[], index: number | undefined) =>
    index === undefined || index < 0 ? "" : (row[index] ?? "");

  table.rows.forEach((row, index) => {
    const rowNo = index + 1;
    try {
      const txnDate = readDate(cell(row, mapping.date), mapping.dateFormat, "date");
      const description = cell(row, mapping.description).trim();
      if (description === "") throw new ValidationError("The description is empty.", "description");

      let paidIn = 0n;
      let paidOut = 0n;

      if (mapping.amount !== undefined) {
        const { amount, negative } = readMoney(cell(row, mapping.amount), "amount");
        if (negative) paidOut = amount;
        else paidIn = amount;
      } else {
        if (mapping.paidIn !== undefined) {
          paidIn = readMoney(cell(row, mapping.paidIn), "paidIn").amount;
        }
        if (mapping.paidOut !== undefined) {
          paidOut = readMoney(cell(row, mapping.paidOut), "paidOut").amount;
        }
      }

      if (paidIn > 0n && paidOut > 0n) {
        throw new ValidationError(
          "This row has money in and money out at once. The two columns are probably the " +
            "wrong way round, or one of them is the balance.",
          "mapping",
        );
      }
      if (paidIn === 0n && paidOut === 0n) {
        throw new ValidationError("This row moves no money.", "amount");
      }

      const valueDateRaw = cell(row, mapping.valueDate).trim();
      const balanceRaw = cell(row, mapping.balance).trim();

      lines.push({
        lineNo: lines.length + 1,
        txnDate,
        valueDate: valueDateRaw === "" ? null : readDate(valueDateRaw, mapping.dateFormat, "valueDate"),
        description,
        reference: cell(row, mapping.reference).trim() || null,
        paidIn,
        paidOut,
        runningBalance:
          balanceRaw === ""
            ? null
            : (() => {
                const { amount, negative } = readMoney(balanceRaw, "balance");
                return negative ? -amount : amount;
              })(),
      });

      totalIn += paidIn;
      totalOut += paidOut;
    } catch (error) {
      rejected.push({
        rowNo,
        reason: error instanceof Error ? error.message : "This row could not be read.",
        raw: row,
      });
    }
  });

  const dates = lines.map((line) => line.txnDate).sort();

  return {
    header: table.header,
    delimiter: table.delimiter,
    mapping,
    lines,
    rejected,
    earliest: dates[0] ?? null,
    latest: dates[dates.length - 1] ?? null,
    totalIn,
    totalOut,
    digest: createHash("sha256").update(text).digest("hex"),
    blankRowsSkipped: table.blankRowsSkipped,
  };
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

export interface ImportStatementInput {
  bankAccountId: string;
  statementRef?: string | null;
  periodFrom?: string;
  periodTo?: string;
  openingBalance: string;
  closingBalance: string;
  sourceFilename?: string | null;
  notes?: string | null;
  /** Accepts an import whose digest matches one already held. */
  allowDuplicate?: boolean;
  /** Accepts an import whose lines do not account for the balance movement. */
  acceptIncomplete?: boolean;
}

export interface ImportResult {
  statementId: string;
  lineCount: number;
  rejected: ParsedStatement["rejected"];
  /** closing − opening − (in − out). Nil unless the import is incomplete. */
  balanceDiscrepancy: Amount;
}

/**
 * Writes a parsed statement.
 *
 * Two refusals here are the whole value of the step. The **digest** catches the
 * same download being imported twice, which is the commonest import error and
 * produces a duplicate of every transaction. The **balance check** catches a
 * truncated or filtered download: if the lines do not account for the movement
 * from the opening balance to the closing balance, something is missing, and
 * finding that out now is worth a great deal more than finding it out when the
 * reconciliation will not balance for a reason nobody can locate.
 *
 * Both can be overridden, and both record that they were.
 */
export async function importStatement(
  db: Executor,
  principal: Principal,
  parsed: ParsedStatement,
  input: ImportStatementInput,
  context?: AuditContext,
): Promise<ImportResult> {
  requireCapability(principal, "accounting.bank.import");

  if (parsed.lines.length === 0) {
    throw new ValidationError(
      "No rows could be read from that file, so there is nothing to import.",
      "file",
    );
  }

  const account = await db.execute<{ id: string; account_id: string; is_active: boolean }>(
    sql`SELECT id, account_id, is_active FROM accounting.bank_account WHERE id = ${input.bankAccountId}`,
  );
  const bank = account.rows?.[0];
  if (!bank) throw new NotFoundError("That bank account no longer exists.");
  if (!bank.is_active) {
    throw new ConflictError("That bank account is no longer in use.");
  }

  const periodFrom = toIsoDate(
    parseIsoDate(input.periodFrom ?? parsed.earliest ?? toIsoDate(today()), "periodFrom"),
  );
  const periodTo = toIsoDate(
    parseIsoDate(input.periodTo ?? parsed.latest ?? toIsoDate(today()), "periodTo"),
  );
  if (periodTo < periodFrom) {
    throw new ValidationError("The statement ends before it begins.", "periodTo");
  }

  // Lines outside the stated period mean the period or the file is wrong, and
  // importing anyway would put transactions under a statement that does not
  // claim to cover them.
  const outside = parsed.lines.filter(
    (line) => line.txnDate < periodFrom || line.txnDate > periodTo,
  );
  if (outside.length > 0) {
    throw new ValidationError(
      `${outside.length} row${outside.length === 1 ? "" : "s"} fall outside ${periodFrom} to ` +
        `${periodTo} — the first is dated ${outside[0]!.txnDate}. Correct the period, or the file.`,
      "periodFrom",
    );
  }

  const opening = parseAmount(input.openingBalance, "openingBalance");
  const closing = parseAmount(input.closingBalance, "closingBalance");
  const movement = parsed.totalIn - parsed.totalOut;
  const discrepancy = closing - opening - movement;

  if (discrepancy !== 0n && !input.acceptIncomplete) {
    throw new ValidationError(
      `The rows account for ${formatAmount(movement, { currency: "RM" })} but the balance moves ` +
        `from ${formatAmount(opening, { currency: "RM" })} to ${formatAmount(closing, { currency: "RM" })}, ` +
        `a difference of ${formatAmount(discrepancy, { currency: "RM" })}. That usually means the ` +
        "download is incomplete or filtered. Check it before importing.",
      "closingBalance",
    );
  }

  if (!input.allowDuplicate) {
    const seen = await db.execute<{ id: string; imported_at: string; period_to: string }>(sql`
      SELECT id, imported_at, period_to FROM accounting.bank_statement
       WHERE bank_account_id = ${input.bankAccountId} AND source_digest = ${parsed.digest}
       LIMIT 1
    `);
    const duplicate = seen.rows?.[0];
    if (duplicate) {
      throw new ConflictError(
        "This exact file has already been imported for this account " +
          `(statement to ${String(duplicate.period_to).slice(0, 10)}). Importing it again would ` +
          "duplicate every transaction on it.",
      );
    }
  }

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.bank_statement
      (bank_account_id, statement_ref, period_from, period_to, opening_balance, closing_balance,
       source_filename, source_digest, notes, imported_by)
    VALUES (${input.bankAccountId}, ${input.statementRef?.trim() || null}, ${periodFrom}, ${periodTo},
            ${amountToSql(opening)}, ${amountToSql(closing)},
            ${input.sourceFilename?.trim() || null}, ${parsed.digest},
            ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const statementId = created.rows![0]!.id;

  for (const line of parsed.lines) {
    await db.execute(sql`
      INSERT INTO accounting.bank_statement_line
        (statement_id, line_no, txn_date, value_date, description, reference,
         paid_in, paid_out, running_balance)
      VALUES (${statementId}, ${line.lineNo}, ${line.txnDate}, ${line.valueDate},
              ${line.description}, ${line.reference},
              ${amountToSql(line.paidIn)}, ${amountToSql(line.paidOut)},
              ${line.runningBalance === null ? null : amountToSql(line.runningBalance)})
    `);
  }

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.STATEMENT_IMPORTED,
    entityType: "bank_statement",
    entityId: statementId,
    newValues: {
      periodFrom,
      periodTo,
      lines: parsed.lines.length,
      rejected: parsed.rejected.length,
      totalIn: amountToSql(parsed.totalIn),
      totalOut: amountToSql(parsed.totalOut),
      filename: input.sourceFilename ?? null,
      // Recorded because an override is a decision somebody made, and the reason
      // the reconciliation later fails may be exactly this.
      acceptedIncomplete: discrepancy !== 0n ? amountToSql(discrepancy) : undefined,
      acceptedDuplicate: input.allowDuplicate ? true : undefined,
    },
  });

  return {
    statementId,
    lineCount: parsed.lines.length,
    rejected: parsed.rejected,
    balanceDiscrepancy: discrepancy,
  };
}

export async function deleteStatement(
  db: Executor,
  principal: Principal,
  statementId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "accounting.bank.import");

  const found = await db.execute<{ period_from: string; period_to: string; line_count: number }>(
    sql`SELECT period_from, period_to, line_count FROM accounting.bank_statement WHERE id = ${statementId}`,
  );
  const statement = found.rows?.[0];
  if (!statement) throw new NotFoundError("That statement no longer exists.");

  // The database refuses this too, once any of it has been reconciled. Checking
  // here as well means the person gets a sentence rather than a trigger message.
  const reconciled = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count
      FROM accounting.bank_statement_line l
      JOIN accounting.reconciliation_match m ON m.statement_line_id = l.id
      JOIN accounting.reconciliation r ON r.id = m.reconciliation_id
     WHERE l.statement_id = ${statementId} AND r.status = 'completed'
  `);
  if ((reconciled.rows?.[0]?.count ?? 0) > 0) {
    throw new ConflictError(
      "Part of this statement belongs to a completed reconciliation, which would be left " +
        "referring to evidence that no longer exists. It cannot be deleted.",
    );
  }

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.STATEMENT_DELETED,
    entityType: "bank_statement",
    entityId: statementId,
    oldValues: {
      periodFrom: String(statement.period_from).slice(0, 10),
      periodTo: String(statement.period_to).slice(0, 10),
      lines: statement.line_count,
    },
    reason: options.reason ?? null,
  });

  await db.execute(sql`DELETE FROM accounting.bank_statement WHERE id = ${statementId}`);
}

// ---------------------------------------------------------------------------
// Reading statements and lines
// ---------------------------------------------------------------------------

export interface StatementSummary {
  id: string;
  bankAccountId: string;
  statementRef: string | null;
  periodFrom: string;
  periodTo: string;
  openingBalance: Amount;
  closingBalance: Amount;
  lineCount: number;
  unmatchedCount: number;
  sourceFilename: string | null;
  importedAt: Date | string;
  importedByName: string | null;
}

export async function listStatements(
  db: Executor,
  filters: { bankAccountId?: string; limit?: number } = {},
): Promise<StatementSummary[]> {
  const result = await db.execute<{
    id: string;
    bank_account_id: string;
    statement_ref: string | null;
    period_from: string;
    period_to: string;
    opening_balance: string;
    closing_balance: string;
    line_count: number;
    unmatched_count: number;
    source_filename: string | null;
    imported_at: Date | string;
    imported_by_name: string | null;
  }>(sql`
    SELECT s.id, s.bank_account_id, s.statement_ref, s.period_from, s.period_to,
           s.opening_balance, s.closing_balance, s.line_count,
           COALESCE(u.count, 0)::int AS unmatched_count,
           s.source_filename, s.imported_at, usr.full_name AS imported_by_name
      FROM accounting.bank_statement s
      LEFT JOIN (
        SELECT statement_id, count(*) AS count FROM accounting.bank_statement_line
         WHERE status = 'unmatched' GROUP BY statement_id
      ) u ON u.statement_id = s.id
      LEFT JOIN auth."user" usr ON usr.id = s.imported_by
     WHERE ${filters.bankAccountId ? sql`s.bank_account_id = ${filters.bankAccountId}` : sql`true`}
     ORDER BY s.period_to DESC, s.imported_at DESC
     LIMIT ${Math.min(Math.max(filters.limit ?? 50, 1), 200)}
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    bankAccountId: row.bank_account_id,
    statementRef: row.statement_ref,
    periodFrom: String(row.period_from).slice(0, 10),
    periodTo: String(row.period_to).slice(0, 10),
    openingBalance: parseAmount(row.opening_balance),
    closingBalance: parseAmount(row.closing_balance),
    lineCount: row.line_count,
    unmatchedCount: row.unmatched_count,
    sourceFilename: row.source_filename,
    importedAt: row.imported_at,
    importedByName: row.imported_by_name,
  }));
}

export interface StatementLineView {
  id: string;
  statementId: string;
  lineNo: number;
  txnDate: string;
  valueDate: string | null;
  description: string;
  reference: string | null;
  paidIn: Amount;
  paidOut: Amount;
  runningBalance: Amount | null;
  status: StatementLineStatus;
  ignoreReason: string | null;
  /** Present when matched: which ledger entry explains it. */
  journalLineId: string | null;
  journalId: string | null;
  journalNo: string | null;
  matchMethod: string | null;
  matchedByName: string | null;
}

export async function listStatementLines(
  db: Executor,
  filters: {
    statementId?: string;
    bankAccountId?: string;
    status?: StatementLineStatus;
    upTo?: string;
    limit?: number;
  } = {},
): Promise<StatementLineView[]> {
  const where = [sql`true`];
  if (filters.statementId) where.push(sql`l.statement_id = ${filters.statementId}`);
  if (filters.bankAccountId) where.push(sql`s.bank_account_id = ${filters.bankAccountId}`);
  if (filters.status) where.push(sql`l.status = ${filters.status}`);
  if (filters.upTo) where.push(sql`l.txn_date <= ${filters.upTo}::date`);

  const result = await db.execute<{
    id: string;
    statement_id: string;
    line_no: number;
    txn_date: string;
    value_date: string | null;
    description: string;
    reference: string | null;
    paid_in: string;
    paid_out: string;
    running_balance: string | null;
    status: StatementLineStatus;
    ignore_reason: string | null;
    journal_line_id: string | null;
    journal_id: string | null;
    journal_no: string | null;
    method: string | null;
    matched_by_name: string | null;
  }>(sql`
    SELECT l.id, l.statement_id, l.line_no, l.txn_date, l.value_date, l.description, l.reference,
           l.paid_in, l.paid_out, l.running_balance, l.status, l.ignore_reason,
           m.journal_line_id, jl.journal_id, j.journal_no, m.method, u.full_name AS matched_by_name
      FROM accounting.bank_statement_line l
      JOIN accounting.bank_statement s ON s.id = l.statement_id
      LEFT JOIN accounting.reconciliation_match m ON m.statement_line_id = l.id
      LEFT JOIN accounting.journal_line jl ON jl.id = m.journal_line_id
      LEFT JOIN accounting.journal j ON j.id = jl.journal_id
      LEFT JOIN auth."user" u ON u.id = m.matched_by
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY l.txn_date, l.line_no
     LIMIT ${Math.min(Math.max(filters.limit ?? 500, 1), 2000)}
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    statementId: row.statement_id,
    lineNo: row.line_no,
    txnDate: String(row.txn_date).slice(0, 10),
    valueDate: row.value_date ? String(row.value_date).slice(0, 10) : null,
    description: row.description,
    reference: row.reference,
    paidIn: parseAmount(row.paid_in),
    paidOut: parseAmount(row.paid_out),
    runningBalance: row.running_balance === null ? null : parseAmount(row.running_balance),
    status: row.status,
    ignoreReason: row.ignore_reason,
    journalLineId: row.journal_line_id,
    journalId: row.journal_id,
    journalNo: row.journal_no,
    matchMethod: row.method,
    matchedByName: row.matched_by_name,
  }));
}

// ---------------------------------------------------------------------------
// Candidates and matching
// ---------------------------------------------------------------------------

export interface LedgerCandidate {
  journalLineId: string;
  journalId: string;
  journalNo: string | null;
  entryDate: string;
  memo: string | null;
  lineDescription: string | null;
  debit: Amount;
  credit: Amount;
  sourceType: string;
  /** Higher is a better fit. Ordering only; it decides nothing. */
  score: number;
  reasons: string[];
}

/**
 * Unexplained ledger entries on the bank account that could be this statement
 * line.
 *
 * Only ever *candidates*. The amount and direction have to agree exactly — those
 * are facts, and the database enforces them on the match anyway — and everything
 * else is ordering: how close the dates are, and whether the reference or a word
 * from the description appears on both sides. Nothing is matched automatically.
 * An automatic match that is wrong is worse than no match at all, because nobody
 * looks at it again.
 */
export async function suggestMatches(
  db: Executor,
  statementLineId: string,
  options: { windowDays?: number; limit?: number } = {},
): Promise<LedgerCandidate[]> {
  const window = Math.min(Math.max(options.windowDays ?? 10, 0), 120);

  const lineResult = await db.execute<{
    txn_date: string;
    description: string;
    reference: string | null;
    paid_in: string;
    paid_out: string;
    account_id: string;
  }>(sql`
    SELECT l.txn_date, l.description, l.reference, l.paid_in, l.paid_out, ba.account_id
      FROM accounting.bank_statement_line l
      JOIN accounting.bank_statement s ON s.id = l.statement_id
      JOIN accounting.bank_account ba ON ba.id = s.bank_account_id
     WHERE l.id = ${statementLineId}
  `);
  const line = lineResult.rows?.[0];
  if (!line) throw new NotFoundError("That statement line no longer exists.");

  const paidIn = parseAmount(line.paid_in);
  const paidOut = parseAmount(line.paid_out);
  const wantsDebit = paidIn > 0n;
  const amount = wantsDebit ? paidIn : paidOut;

  // The window is computed here rather than as `date - $n` in SQL: the parameter
  // arrives untyped and PostgreSQL has no `date - unknown` to resolve it to.
  const lineDate = String(line.txn_date).slice(0, 10);
  const from = toIsoDate(addDays(parseIsoDate(lineDate), -window));
  const until = toIsoDate(addDays(parseIsoDate(lineDate), window));

  const result = await db.execute<{
    id: string;
    journal_id: string;
    journal_no: string | null;
    entry_date: string;
    memo: string | null;
    description: string | null;
    debit: string;
    credit: string;
    source_type: string;
  }>(sql`
    SELECT jl.id, jl.journal_id, j.journal_no, j.entry_date, j.memo, jl.description,
           jl.debit, jl.credit, j.source_type
      FROM accounting.journal_line jl
      JOIN accounting.journal j ON j.id = jl.journal_id
     WHERE jl.account_id = ${line.account_id}
       AND j.status = 'posted'
       AND ${wantsDebit ? sql`jl.debit = ${amountToSql(amount)}` : sql`jl.credit = ${amountToSql(amount)}`}
       AND ${wantsDebit ? sql`jl.credit = 0` : sql`jl.debit = 0`}
       AND NOT EXISTS (
         SELECT 1 FROM accounting.reconciliation_match m WHERE m.journal_line_id = jl.id
       )
       AND j.entry_date BETWEEN ${from}::date AND ${until}::date
     ORDER BY abs(j.entry_date - ${lineDate}::date), j.entry_date DESC
     LIMIT ${Math.min(Math.max(options.limit ?? 10, 1), 50)}
  `);

  const words = tokenise(line.description);
  const reference = (line.reference ?? "").trim().toLowerCase();

  return (result.rows ?? []).map((row) => {
    const entryDate = String(row.entry_date).slice(0, 10);
    const dayGap = Math.abs(
      Math.round((parseIsoDate(entryDate).getTime() - parseIsoDate(lineDate).getTime()) / 86_400_000),
    );

    const haystack = `${row.memo ?? ""} ${row.description ?? ""}`.toLowerCase();
    const reasons: string[] = [`amount agrees exactly`];
    let score = 50;

    if (dayGap === 0) {
      score += 30;
      reasons.push("same date");
    } else {
      score += Math.max(0, 20 - dayGap * 2);
      reasons.push(`${dayGap} day${dayGap === 1 ? "" : "s"} apart`);
    }

    if (reference !== "" && haystack.includes(reference)) {
      score += 25;
      reasons.push("the reference appears in the ledger entry");
    }

    const shared = words.filter((word) => haystack.includes(word));
    if (shared.length > 0) {
      score += Math.min(20, shared.length * 7);
      reasons.push(`wording in common: ${shared.slice(0, 3).join(", ")}`);
    }

    return {
      journalLineId: row.id,
      journalId: row.journal_id,
      journalNo: row.journal_no,
      entryDate,
      memo: row.memo,
      lineDescription: row.description,
      debit: parseAmount(row.debit),
      credit: parseAmount(row.credit),
      sourceType: row.source_type,
      score,
      reasons,
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Words worth comparing.
 *
 * Bank descriptions are largely boilerplate — "TRANSFER", "PAYMENT", "FPX" — and
 * a word shared with every other row is evidence of nothing. Short tokens and
 * the common noise words are dropped so that a name or an invoice number is what
 * actually scores.
 */
const NOISE = new Set([
  "transfer", "payment", "paid", "debit", "credit", "fpx", "ibg", "duitnow",
  "online", "cash", "cheque", "chq", "deposit", "withdrawal", "atm", "bank",
  "transaction", "txn", "ref", "to", "from", "the", "and", "for", "via", "sdn", "bhd",
]);

function tokenise(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4 && !NOISE.has(word)),
    ),
  );
}

export async function matchStatementLine(
  db: Executor,
  principal: Principal,
  input: {
    statementLineId: string;
    journalLineId: string;
    method?: "manual" | "suggested";
    note?: string | null;
  },
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.bank.match");

  const line = await lockStatementLine(db, input.statementLineId);
  if (line.status === "ignored") {
    throw new ConflictError(
      `Line ${line.line_no} was set aside as "${line.ignore_reason}". Clear that before matching it.`,
    );
  }
  if (line.status === "matched") {
    throw new ConflictError(`Line ${line.line_no} is already matched.`);
  }

  const already = await db.execute<{ id: string }>(
    sql`SELECT id FROM accounting.reconciliation_match WHERE journal_line_id = ${input.journalLineId}`,
  );
  if (already.rows?.[0]) {
    throw new ConflictError(
      "That ledger entry already explains another statement line. One movement of money " +
        "cannot explain two, and allowing it is how a reconciliation is made to balance wrongly.",
    );
  }

  // Attach to the open reconciliation if there is one, so completing it knows
  // which matches it is standing on.
  const open = await currentReconciliationId(db, line.bank_account_id);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.reconciliation_match
      (statement_line_id, journal_line_id, reconciliation_id, method, note, matched_by)
    VALUES (${input.statementLineId}, ${input.journalLineId}, ${open},
            ${input.method ?? "manual"}, ${input.note?.trim() || null}, ${principal.userId})
    RETURNING id
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.STATEMENT_LINE_MATCHED,
    entityType: "bank_statement_line",
    entityId: input.statementLineId,
    newValues: {
      journalLineId: input.journalLineId,
      method: input.method ?? "manual",
      lineNo: line.line_no,
      date: String(line.txn_date).slice(0, 10),
      paidIn: line.paid_in,
      paidOut: line.paid_out,
    },
  });

  return { id: created.rows![0]!.id };
}

export async function unmatchStatementLine(
  db: Executor,
  principal: Principal,
  statementLineId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "accounting.bank.match");

  const match = await db.execute<{
    id: string;
    journal_line_id: string;
    reconciliation_id: string | null;
    status: string | null;
  }>(sql`
    SELECT m.id, m.journal_line_id, m.reconciliation_id, r.status
      FROM accounting.reconciliation_match m
      LEFT JOIN accounting.reconciliation r ON r.id = m.reconciliation_id
     WHERE m.statement_line_id = ${statementLineId}
  `);
  const found = match.rows?.[0];
  if (!found) throw new NotFoundError("That line is not matched.");

  if (found.status === "completed") {
    throw new ConflictError(
      "That match is part of a completed reconciliation. Undoing it would change what the " +
        "signed-off figures were computed from. Reconcile again at a later date instead.",
    );
  }

  await db.execute(sql`DELETE FROM accounting.reconciliation_match WHERE id = ${found.id}`);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.STATEMENT_LINE_UNMATCHED,
    entityType: "bank_statement_line",
    entityId: statementLineId,
    oldValues: { journalLineId: found.journal_line_id },
    reason: options.reason ?? null,
  });
}

/**
 * Sets a line aside.
 *
 * For a row that is genuinely not a transaction of the firm's — an interest
 * advice line, a duplicate the bank itself reversed on the next row. It needs a
 * reason, because "ignored" with no reason is indistinguishable from "could not
 * be bothered", and an ignored line still counts as unexplained when the
 * reconciliation is drawn: setting something aside does not make the difference
 * go away.
 */
export async function ignoreStatementLine(
  db: Executor,
  principal: Principal,
  statementLineId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.bank.match");

  if (!reason?.trim()) {
    throw new ValidationError("Say why this line is being set aside.", "reason");
  }

  const line = await lockStatementLine(db, statementLineId);
  if (line.status === "matched") {
    throw new ConflictError("That line is matched. Unmatch it first if it should be set aside.");
  }

  await db.execute(sql`
    UPDATE accounting.bank_statement_line
       SET status = 'ignored', ignore_reason = ${reason.trim()}, ignored_at = now(),
           ignored_by = ${principal.userId}
     WHERE id = ${statementLineId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.STATEMENT_LINE_IGNORED,
    entityType: "bank_statement_line",
    entityId: statementLineId,
    newValues: { lineNo: line.line_no, description: line.description },
    reason: reason.trim(),
  });
}

export async function restoreStatementLine(
  db: Executor,
  principal: Principal,
  statementLineId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.bank.match");

  const line = await lockStatementLine(db, statementLineId);
  if (line.status !== "ignored") {
    throw new ConflictError("That line has not been set aside.");
  }

  await db.execute(sql`
    UPDATE accounting.bank_statement_line
       SET status = 'unmatched', ignore_reason = NULL, ignored_at = NULL, ignored_by = NULL
     WHERE id = ${statementLineId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.STATEMENT_LINE_UNMATCHED,
    entityType: "bank_statement_line",
    entityId: statementLineId,
    newValues: { restored: true, lineNo: line.line_no },
  });
}

/**
 * Posts a statement line the ledger has never heard of, and matches it.
 *
 * This is the other half of reconciliation, and the half people forget exists.
 * Bank charges, interest received, a standing order nobody recorded: the bank is
 * right and the ledger is incomplete. Rather than leaving it unexplained forever,
 * the line becomes a journal — money in debits the bank, money out credits it,
 * with the other side to whichever account the person chooses — and the new
 * ledger line is matched to it in the same transaction, so the entry cannot be
 * created and then left unmatched.
 */
export async function postStatementLine(
  db: Executor,
  principal: Principal,
  input: { statementLineId: string; accountId: string; memo?: string | null },
  context?: AuditContext,
): Promise<{ journalId: string; journalNo: string }> {
  requireCapability(principal, "accounting.bank.match");

  const line = await lockStatementLine(db, input.statementLineId);
  if (line.status === "matched") {
    throw new ConflictError("That line is already explained by a ledger entry.");
  }
  if (line.status === "ignored") {
    throw new ConflictError("That line was set aside. Restore it first.");
  }
  if (!input.accountId) {
    throw new ValidationError("Choose the account this belongs to.", "accountId");
  }
  if (input.accountId === line.bank_ledger_account_id) {
    throw new ValidationError(
      "The other side of the entry cannot be the bank account itself.",
      "accountId",
    );
  }

  const paidIn = parseAmount(line.paid_in);
  const paidOut = parseAmount(line.paid_out);
  const date = String(line.txn_date).slice(0, 10);
  const memo = input.memo?.trim() || line.description;

  const journal = await postSourceJournal(
    db,
    principal,
    {
      entryDate: date,
      memo,
      sourceType: "bank",
      sourceId: input.statementLineId,
      // Posting from the bank is authorised by the matching capability. It is not a
      // way around who may post a journal: the entry is fixed by the statement
      // line — its date, its amount and its direction are the bank's, not ours —
      // and only the account on the other side is a choice.
      authorisedBy: "accounting.bank.match",
      lines:
        paidIn > 0n
          ? [
              { accountId: line.bank_ledger_account_id, debit: amountToSql(paidIn), description: memo },
              { accountId: input.accountId, credit: amountToSql(paidIn), description: memo },
            ]
          : [
              { accountId: input.accountId, debit: amountToSql(paidOut), description: memo },
              { accountId: line.bank_ledger_account_id, credit: amountToSql(paidOut), description: memo },
            ],
    },
    context,
  );

  // The bank side of the entry we just wrote is what explains the statement line.
  const bankLine = await db.execute<{ id: string }>(sql`
    SELECT id FROM accounting.journal_line
     WHERE journal_id = ${journal.id} AND account_id = ${line.bank_ledger_account_id}
     LIMIT 1
  `);
  const bankLineId = bankLine.rows?.[0]?.id;
  if (!bankLineId) {
    // Unreachable unless the posting engine changed shape; failing loudly beats
    // leaving an unmatched entry behind.
    throw new ConflictError("The journal was posted but its bank line could not be found.");
  }

  const open = await currentReconciliationId(db, line.bank_account_id);

  await db.execute(sql`
    INSERT INTO accounting.reconciliation_match
      (statement_line_id, journal_line_id, reconciliation_id, method, note, matched_by)
    VALUES (${input.statementLineId}, ${bankLineId}, ${open}, 'posted_from_statement',
            ${"posted from the statement"}, ${principal.userId})
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.STATEMENT_LINE_POSTED,
    entityType: "bank_statement_line",
    entityId: input.statementLineId,
    newValues: {
      journalNo: journal.journalNo,
      account: input.accountId,
      date,
      paidIn: line.paid_in,
      paidOut: line.paid_out,
    },
  });

  return { journalId: journal.id, journalNo: journal.journalNo };
}

// ---------------------------------------------------------------------------
// The reconciliation itself
// ---------------------------------------------------------------------------

export interface ReconciliationPosition {
  bankAccountId: string;
  accountCode: string;
  asAt: string;
  /** What the bank says, from the latest statement covering `asAt`. */
  statementBalance: Amount;
  statementId: string | null;
  /** What the ledger says, from posted journals dated on or before `asAt`. */
  ledgerBalance: Amount;
  /** On the statement and not in the ledger, as an effect on the balance. */
  unmatchedStatement: Amount;
  /** In the ledger and not on the statement, as an effect on the balance. */
  unmatchedLedger: Amount;
  difference: Amount;
  unmatchedStatementCount: number;
  unmatchedLedgerCount: number;
  ignoredCount: number;
}

/**
 * Draws the reconciliation.
 *
 * The identity being tested, in the form an accountant would write it:
 *
 *     statement balance  +  items in the ledger not on the statement
 *   = ledger balance     +  items on the statement not in the ledger
 *
 * Both sides are the same money once each has been adjusted for what the other
 * already knows. `difference` is the left minus the right, and completing a
 * reconciliation requires it to be nil — enforced by a CHECK constraint, not only
 * here.
 *
 * `unmatchedStatement` and `unmatchedLedger` are signed as their effect on the
 * bank balance: money in is positive, money out negative. An ignored line still
 * counts as unexplained; setting something aside does not make it reconcile.
 *
 * Ledger entries dated before the first imported statement are excluded from the
 * in-transit figure — see the comment on `coveredFrom` below, which is the one
 * piece of arithmetic here that is not obvious.
 */
export async function reconciliationPosition(
  db: Executor,
  bankAccountId: string,
  asAt: string,
): Promise<ReconciliationPosition> {
  const date = toIsoDate(parseIsoDate(asAt, "asAt"));

  const account = await db.execute<{ account_id: string; code: string }>(sql`
    SELECT ba.account_id, a.code
      FROM accounting.bank_account ba
      JOIN accounting.account a ON a.id = ba.account_id
     WHERE ba.id = ${bankAccountId}
  `);
  const bank = account.rows?.[0];
  if (!bank) throw new NotFoundError("That bank account no longer exists.");

  // The statement whose period contains or most recently precedes the date. Using
  // the closing balance of a statement that ends after `asAt` would be comparing
  // the bank at one date with the ledger at another.
  const statement = await db.execute<{ id: string; closing_balance: string; period_to: string }>(sql`
    SELECT id, closing_balance, period_to
      FROM accounting.bank_statement
     WHERE bank_account_id = ${bankAccountId} AND period_to <= ${date}::date
     ORDER BY period_to DESC LIMIT 1
  `);
  const latest = statement.rows?.[0];

  // Where the imported record of this account begins.
  //
  // This bound matters, and getting it wrong is the subtlest error in the whole
  // module. A ledger entry dated before the first statement CAC ever imported is
  // not an item in transit: whatever it was, the bank had already accounted for
  // it, and it sits inside that statement's *opening* balance. Counting such an
  // entry as outstanding would report a difference equal to the opening balance
  // and never resolve, because there is no statement line that could ever match
  // it. Importing an earlier statement moves the boundary back and brings those
  // entries into scope properly.
  const earliest = await db.execute<{ period_from: string }>(sql`
    SELECT MIN(period_from) AS period_from FROM accounting.bank_statement
     WHERE bank_account_id = ${bankAccountId}
  `);
  const coveredFrom = earliest.rows?.[0]?.period_from
    ? String(earliest.rows[0]!.period_from).slice(0, 10)
    : null;

  const ledger = await db.execute<{ debit: string; credit: string }>(sql`
    SELECT COALESCE(SUM(l.debit), 0)::text AS debit, COALESCE(SUM(l.credit), 0)::text AS credit
      FROM accounting.journal_line l
      JOIN accounting.journal j ON j.id = l.journal_id
     WHERE l.account_id = ${bank.account_id}
       AND j.status IN ('posted', 'reversed')
       AND j.entry_date <= ${date}::date
  `);
  const ledgerRow = ledger.rows?.[0];
  const ledgerBalance = parseAmount(ledgerRow?.debit ?? "0") - parseAmount(ledgerRow?.credit ?? "0");

  // An ignored line still moved money at the bank, so it stays in the figure; it
  // is only excluded from the *count* of lines still needing a decision, because
  // somebody has given a reason for it.
  const statementSide = await db.execute<{ paid_in: string; paid_out: string; count: number; ignored: number }>(sql`
    SELECT COALESCE(SUM(l.paid_in), 0)::text AS paid_in,
           COALESCE(SUM(l.paid_out), 0)::text AS paid_out,
           COALESCE(SUM(CASE WHEN l.status = 'unmatched' THEN 1 ELSE 0 END), 0)::int AS count,
           COALESCE(SUM(CASE WHEN l.status = 'ignored' THEN 1 ELSE 0 END), 0)::int AS ignored
      FROM accounting.bank_statement_line l
      JOIN accounting.bank_statement s ON s.id = l.statement_id
     WHERE s.bank_account_id = ${bankAccountId}
       AND l.txn_date <= ${date}::date
       AND l.status <> 'matched'
  `);
  const statementUnmatched = statementSide.rows?.[0];
  const unmatchedStatement =
    parseAmount(statementUnmatched?.paid_in ?? "0") - parseAmount(statementUnmatched?.paid_out ?? "0");

  const ledgerSide = await db.execute<{ debit: string; credit: string; count: number }>(sql`
    SELECT COALESCE(SUM(l.debit), 0)::text AS debit,
           COALESCE(SUM(l.credit), 0)::text AS credit,
           count(*)::int AS count
      FROM accounting.journal_line l
      JOIN accounting.journal j ON j.id = l.journal_id
     WHERE l.account_id = ${bank.account_id}
       AND j.status IN ('posted', 'reversed')
       AND j.entry_date <= ${date}::date
       AND ${coveredFrom ? sql`j.entry_date >= ${coveredFrom}::date` : sql`true`}
       AND NOT EXISTS (
         SELECT 1 FROM accounting.reconciliation_match m WHERE m.journal_line_id = l.id
       )
  `);
  const ledgerUnmatched = ledgerSide.rows?.[0];
  const unmatchedLedger =
    parseAmount(ledgerUnmatched?.debit ?? "0") - parseAmount(ledgerUnmatched?.credit ?? "0");

  const statementBalance = latest ? parseAmount(latest.closing_balance) : 0n;

  return {
    bankAccountId,
    accountCode: bank.code,
    asAt: date,
    statementBalance,
    statementId: latest?.id ?? null,
    ledgerBalance,
    unmatchedStatement,
    unmatchedLedger,
    difference: statementBalance - unmatchedStatement - (ledgerBalance - unmatchedLedger),
    unmatchedStatementCount: statementUnmatched?.count ?? 0,
    unmatchedLedgerCount: ledgerUnmatched?.count ?? 0,
    ignoredCount: statementUnmatched?.ignored ?? 0,
  };
}

export interface ReconciliationView extends ReconciliationPosition {
  id: string;
  reconciliationNo: string | null;
  status: ReconciliationStatus;
  notes: string | null;
  completedAt: Date | string | null;
  completedByName: string | null;
  createdByName: string | null;
  bankName: string;
  accountName: string;
}

export async function openReconciliation(
  db: Executor,
  principal: Principal,
  input: { bankAccountId: string; asAt?: string; notes?: string | null },
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.bank.reconcile");

  const asAt = toIsoDate(input.asAt ? parseIsoDate(input.asAt, "asAt") : today());

  const existing = await db.execute<{ id: string; as_at: string }>(sql`
    SELECT id, as_at FROM accounting.reconciliation
     WHERE bank_account_id = ${input.bankAccountId} AND status = 'draft'
  `);
  if (existing.rows?.[0]) {
    throw new ConflictError(
      "There is already a reconciliation open on this account. Finish or abandon that one " +
        "first — two people matching the same lines at once would leave neither balancing.",
    );
  }

  const last = await db.execute<{ as_at: string; reconciliation_no: string }>(sql`
    SELECT as_at, reconciliation_no FROM accounting.reconciliation
     WHERE bank_account_id = ${input.bankAccountId} AND status = 'completed'
     ORDER BY as_at DESC LIMIT 1
  `);
  const previous = last.rows?.[0];
  if (previous && String(previous.as_at).slice(0, 10) >= asAt) {
    throw new ValidationError(
      `${previous.reconciliation_no} already reconciled this account to ` +
        `${String(previous.as_at).slice(0, 10)}. A new one has to be at a later date.`,
      "asAt",
    );
  }

  const position = await reconciliationPosition(db, input.bankAccountId, asAt);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.reconciliation
      (bank_account_id, statement_id, as_at, statement_balance, ledger_balance,
       unmatched_statement, unmatched_ledger, difference, notes, created_by)
    VALUES (${input.bankAccountId}, ${position.statementId}, ${asAt},
            ${amountToSql(position.statementBalance)}, ${amountToSql(position.ledgerBalance)},
            ${amountToSql(position.unmatchedStatement)}, ${amountToSql(position.unmatchedLedger)},
            ${amountToSql(position.difference)}, ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  // Matches made before this reconciliation existed belong to it: they are what
  // it stands on, and without this they would be attached to nothing.
  await db.execute(sql`
    UPDATE accounting.reconciliation_match m
       SET reconciliation_id = ${id}
      FROM accounting.bank_statement_line l
      JOIN accounting.bank_statement s ON s.id = l.statement_id
     WHERE m.statement_line_id = l.id
       AND s.bank_account_id = ${input.bankAccountId}
       AND m.reconciliation_id IS NULL
       AND l.txn_date <= ${asAt}::date
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.RECONCILIATION_OPENED,
    entityType: "reconciliation",
    entityId: id,
    newValues: {
      asAt,
      statementBalance: amountToSql(position.statementBalance),
      ledgerBalance: amountToSql(position.ledgerBalance),
      difference: amountToSql(position.difference),
    },
  });

  return { id };
}

/**
 * Refreshes a draft reconciliation's stored figures.
 *
 * Called as matching proceeds. A draft's figures are working numbers; only
 * completion fixes them, which is why the guard trigger lets a draft change and a
 * completed one not.
 */
export async function refreshReconciliation(
  db: Executor,
  reconciliationId: string,
): Promise<ReconciliationPosition> {
  const found = await db.execute<{ bank_account_id: string; as_at: string; status: string }>(
    sql`SELECT bank_account_id, as_at, status FROM accounting.reconciliation WHERE id = ${reconciliationId}`,
  );
  const row = found.rows?.[0];
  if (!row) throw new NotFoundError("That reconciliation no longer exists.");

  const position = await reconciliationPosition(
    db,
    row.bank_account_id,
    String(row.as_at).slice(0, 10),
  );

  if (row.status === "draft") {
    await db.execute(sql`
      UPDATE accounting.reconciliation
         SET statement_id = ${position.statementId},
             statement_balance = ${amountToSql(position.statementBalance)},
             ledger_balance = ${amountToSql(position.ledgerBalance)},
             unmatched_statement = ${amountToSql(position.unmatchedStatement)},
             unmatched_ledger = ${amountToSql(position.unmatchedLedger)},
             difference = ${amountToSql(position.difference)}
       WHERE id = ${reconciliationId}
    `);
  }

  return position;
}

export async function completeReconciliation(
  db: Executor,
  principal: Principal,
  reconciliationId: string,
  options: { notes?: string | null; context?: AuditContext } = {},
): Promise<{ reconciliationNo: string }> {
  requireCapability(principal, "accounting.bank.reconcile");

  const found = await db.execute<{
    bank_account_id: string;
    as_at: string;
    status: string;
  }>(sql`
    SELECT bank_account_id, as_at, status FROM accounting.reconciliation
     WHERE id = ${reconciliationId} FOR UPDATE
  `);
  const row = found.rows?.[0];
  if (!row) throw new NotFoundError("That reconciliation no longer exists.");
  if (row.status !== "draft") {
    throw new ConflictError("That reconciliation is already complete.");
  }

  const position = await refreshReconciliation(db, reconciliationId);

  // Two conditions, and they catch different things. Requiring only one of them
  // would let a reconciliation be signed off that proves nothing.
  //
  // The **difference** is an arithmetic check on where the two records start
  // from. Once the ledger and the first statement agree at the beginning, it
  // falls out as an identity — which is exactly why it cannot be the only gate.
  // What it does catch is the case that matters: a ledger whose opening balance
  // was never right, or a statement imported over a gap where the previous one
  // ended, so the two accounts of the same money never started in the same place.
  //
  // The **unmatched line count** is the human part. Every line the bank reported
  // has to have been looked at and either matched to a ledger entry, posted as
  // one, or set aside with a reason. That is the work of reconciling, and no
  // arithmetic can stand in for it.
  //
  // Ledger entries with no statement line are *not* an obstacle: an unpresented
  // cheque is the normal state of affairs, and they are listed on the
  // reconciliation as outstanding rather than blocking it.
  if (position.difference !== 0n) {
    throw new ValidationError(
      `This does not balance: ${formatAmount(position.difference, { currency: "RM" })} is ` +
        "unaccounted for. The ledger and the statement do not start from the same balance — " +
        "either the opening position was never recorded, or a statement is missing between " +
        "this one and the last.",
      "difference",
    );
  }

  if (position.unmatchedStatementCount > 0) {
    throw new ValidationError(
      `${position.unmatchedStatementCount} line${position.unmatchedStatementCount === 1 ? "" : "s"} ` +
        "on the statement " +
        `${position.unmatchedStatementCount === 1 ? "has" : "have"} not been accounted for. ` +
        "Match each one to a ledger entry, post it, or set it aside with a reason — an account " +
        "is not reconciled while the bank has reported something nobody has looked at.",
      "unmatched",
    );
  }

  const asAt = String(row.as_at).slice(0, 10);
  const reconciliationNo = await allocateDocumentNumber(db, "reconciliation", { on: asAt });

  await db.execute(sql`
    UPDATE accounting.reconciliation
       SET status = 'completed', reconciliation_no = ${reconciliationNo},
           completed_at = now(), completed_by = ${principal.userId},
           notes = COALESCE(${options.notes?.trim() || null}, notes),
           updated_by = ${principal.userId}
     WHERE id = ${reconciliationId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.RECONCILIATION_COMPLETED,
    entityType: "reconciliation",
    entityId: reconciliationId,
    newValues: {
      reconciliationNo,
      asAt,
      statementBalance: amountToSql(position.statementBalance),
      ledgerBalance: amountToSql(position.ledgerBalance),
      unmatchedStatement: amountToSql(position.unmatchedStatement),
      unmatchedLedger: amountToSql(position.unmatchedLedger),
      itemsInTransit: position.unmatchedStatementCount + position.unmatchedLedgerCount,
    },
  });

  return { reconciliationNo };
}

export async function abandonReconciliation(
  db: Executor,
  principal: Principal,
  reconciliationId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "accounting.bank.reconcile");

  const found = await db.execute<{ status: string; as_at: string }>(
    sql`SELECT status, as_at FROM accounting.reconciliation WHERE id = ${reconciliationId}`,
  );
  const row = found.rows?.[0];
  if (!row) throw new NotFoundError("That reconciliation no longer exists.");
  if (row.status !== "draft") {
    throw new ConflictError("A completed reconciliation is part of the record and stays.");
  }

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.RECONCILIATION_ABANDONED,
    entityType: "reconciliation",
    entityId: reconciliationId,
    oldValues: { asAt: String(row.as_at).slice(0, 10) },
    reason: options.reason ?? null,
  });

  // The matches survive; they were judgements about the same money and are still
  // true. Only the attempt to sign off is abandoned.
  await db.execute(
    sql`UPDATE accounting.reconciliation_match SET reconciliation_id = NULL WHERE reconciliation_id = ${reconciliationId}`,
  );
  await db.execute(sql`DELETE FROM accounting.reconciliation WHERE id = ${reconciliationId}`);
}

export async function getReconciliation(
  db: Executor,
  reconciliationId: string,
): Promise<ReconciliationView | null> {
  const found = await db.execute<{
    id: string;
    reconciliation_no: string | null;
    bank_account_id: string;
    statement_id: string | null;
    as_at: string;
    statement_balance: string;
    ledger_balance: string;
    unmatched_statement: string;
    unmatched_ledger: string;
    difference: string;
    status: ReconciliationStatus;
    notes: string | null;
    completed_at: Date | string | null;
    completed_by_name: string | null;
    created_by_name: string | null;
    bank_name: string;
    account_code: string;
    account_name: string;
  }>(sql`
    SELECT r.id, r.reconciliation_no, r.bank_account_id, r.statement_id, r.as_at,
           r.statement_balance, r.ledger_balance, r.unmatched_statement, r.unmatched_ledger,
           r.difference, r.status, r.notes, r.completed_at,
           cb.full_name AS completed_by_name, crb.full_name AS created_by_name,
           ba.bank_name, a.code AS account_code, a.name AS account_name
      FROM accounting.reconciliation r
      JOIN accounting.bank_account ba ON ba.id = r.bank_account_id
      JOIN accounting.account a ON a.id = ba.account_id
      LEFT JOIN auth."user" cb ON cb.id = r.completed_by
      LEFT JOIN auth."user" crb ON crb.id = r.created_by
     WHERE r.id = ${reconciliationId}
  `);
  const row = found.rows?.[0];
  if (!row) return null;

  const asAt = String(row.as_at).slice(0, 10);

  // A completed reconciliation reports the figures it was signed off with, not
  // today's recomputation. That is the whole point of storing them.
  const counts =
    row.status === "draft"
      ? await reconciliationPosition(db, row.bank_account_id, asAt)
      : null;

  return {
    id: row.id,
    reconciliationNo: row.reconciliation_no,
    bankAccountId: row.bank_account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    bankName: row.bank_name,
    asAt,
    statementId: row.statement_id,
    statementBalance: parseAmount(row.statement_balance),
    ledgerBalance: parseAmount(row.ledger_balance),
    unmatchedStatement: parseAmount(row.unmatched_statement),
    unmatchedLedger: parseAmount(row.unmatched_ledger),
    difference: parseAmount(row.difference),
    status: row.status,
    notes: row.notes,
    completedAt: row.completed_at,
    completedByName: row.completed_by_name,
    createdByName: row.created_by_name,
    unmatchedStatementCount: counts?.unmatchedStatementCount ?? 0,
    unmatchedLedgerCount: counts?.unmatchedLedgerCount ?? 0,
    ignoredCount: counts?.ignoredCount ?? 0,
  };
}

export interface ReconciliationSummary {
  id: string;
  reconciliationNo: string | null;
  bankAccountId: string;
  accountCode: string;
  bankName: string;
  asAt: string;
  statementBalance: Amount;
  ledgerBalance: Amount;
  difference: Amount;
  status: ReconciliationStatus;
  completedByName: string | null;
}

export async function listReconciliations(
  db: Executor,
  filters: { bankAccountId?: string; status?: ReconciliationStatus; limit?: number } = {},
): Promise<ReconciliationSummary[]> {
  const result = await db.execute<{
    id: string;
    reconciliation_no: string | null;
    bank_account_id: string;
    account_code: string;
    bank_name: string;
    as_at: string;
    statement_balance: string;
    ledger_balance: string;
    difference: string;
    status: ReconciliationStatus;
    completed_by_name: string | null;
  }>(sql`
    SELECT r.id, r.reconciliation_no, r.bank_account_id, a.code AS account_code, ba.bank_name,
           r.as_at, r.statement_balance, r.ledger_balance, r.difference, r.status,
           u.full_name AS completed_by_name
      FROM accounting.reconciliation r
      JOIN accounting.bank_account ba ON ba.id = r.bank_account_id
      JOIN accounting.account a ON a.id = ba.account_id
      LEFT JOIN auth."user" u ON u.id = r.completed_by
     WHERE ${filters.bankAccountId ? sql`r.bank_account_id = ${filters.bankAccountId}` : sql`true`}
       AND ${filters.status ? sql`r.status = ${filters.status}` : sql`true`}
     ORDER BY r.as_at DESC, r.created_at DESC
     LIMIT ${Math.min(Math.max(filters.limit ?? 50, 1), 200)}
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    reconciliationNo: row.reconciliation_no,
    bankAccountId: row.bank_account_id,
    accountCode: row.account_code,
    bankName: row.bank_name,
    asAt: String(row.as_at).slice(0, 10),
    statementBalance: parseAmount(row.statement_balance),
    ledgerBalance: parseAmount(row.ledger_balance),
    difference: parseAmount(row.difference),
    status: row.status,
    completedByName: row.completed_by_name,
  }));
}

/** Ledger entries on the bank account that nothing on the statement explains. */
export interface UnexplainedLedgerLine {
  journalLineId: string;
  journalId: string;
  journalNo: string | null;
  entryDate: string;
  memo: string | null;
  description: string | null;
  debit: Amount;
  credit: Amount;
  sourceType: string;
}

export async function listUnexplainedLedgerLines(
  db: Executor,
  bankAccountId: string,
  asAt: string,
  limit = 200,
): Promise<UnexplainedLedgerLine[]> {
  const date = toIsoDate(parseIsoDate(asAt, "asAt"));

  const result = await db.execute<{
    id: string;
    journal_id: string;
    journal_no: string | null;
    entry_date: string;
    memo: string | null;
    description: string | null;
    debit: string;
    credit: string;
    source_type: string;
  }>(sql`
    SELECT jl.id, jl.journal_id, j.journal_no, j.entry_date, j.memo, jl.description,
           jl.debit, jl.credit, j.source_type
      FROM accounting.journal_line jl
      JOIN accounting.journal j ON j.id = jl.journal_id
      JOIN accounting.bank_account ba ON ba.account_id = jl.account_id
     WHERE ba.id = ${bankAccountId}
       AND j.status IN ('posted', 'reversed')
       AND j.entry_date <= ${date}::date
       AND NOT EXISTS (
         SELECT 1 FROM accounting.reconciliation_match m WHERE m.journal_line_id = jl.id
       )
     ORDER BY j.entry_date DESC, j.journal_no DESC
     LIMIT ${Math.min(Math.max(limit, 1), 1000)}
  `);

  return (result.rows ?? []).map((row) => ({
    journalLineId: row.id,
    journalId: row.journal_id,
    journalNo: row.journal_no,
    entryDate: String(row.entry_date).slice(0, 10),
    memo: row.memo,
    description: row.description,
    debit: parseAmount(row.debit),
    credit: parseAmount(row.credit),
    sourceType: row.source_type,
  }));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface LockedStatementLine extends Record<string, unknown> {
  id: string;
  line_no: number;
  status: StatementLineStatus;
  txn_date: string;
  description: string;
  reference: string | null;
  paid_in: string;
  paid_out: string;
  ignore_reason: string | null;
  bank_account_id: string;
  bank_ledger_account_id: string;
}

/**
 * Locks a statement line and brings its bank account with it.
 *
 * `FOR UPDATE OF l` rather than a bare `FOR UPDATE`: the joined statement and
 * bank account rows are read, not changed, and locking them would serialise
 * every match on the account against every other.
 */
async function lockStatementLine(
  db: Executor,
  statementLineId: string,
): Promise<LockedStatementLine> {
  const result = await db.execute<LockedStatementLine>(sql`
    SELECT l.id, l.line_no, l.status, l.txn_date, l.description, l.reference,
           l.paid_in, l.paid_out, l.ignore_reason,
           s.bank_account_id, ba.account_id AS bank_ledger_account_id
      FROM accounting.bank_statement_line l
      JOIN accounting.bank_statement s ON s.id = l.statement_id
      JOIN accounting.bank_account ba ON ba.id = s.bank_account_id
     WHERE l.id = ${statementLineId}
     FOR UPDATE OF l
  `);
  const row = result.rows?.[0];
  if (!row) throw new NotFoundError("That statement line no longer exists.");
  return row;
}

async function currentReconciliationId(
  db: Executor,
  bankAccountId: string,
): Promise<string | null> {
  const open = await db.execute<{ id: string }>(sql`
    SELECT id FROM accounting.reconciliation
     WHERE bank_account_id = ${bankAccountId} AND status = 'draft'
     LIMIT 1
  `);
  return open.rows?.[0]?.id ?? null;
}
