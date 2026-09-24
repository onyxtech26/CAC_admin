import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accountingSchema, account, journalLine } from "./accounting.js";
import { user } from "./auth.js";

/**
 * The bank, and proving the ledger agrees with it.
 *
 * Mirrors migrations 0009/0010, where the constraints and triggers live. Two
 * things in here are load-bearing and easy to miss when reading the types alone:
 *
 * `paidIn` and `paidOut` are stated from the *firm's* point of view, which is the
 * opposite of the bank's. Money in increases the firm's asset and is therefore a
 * ledger debit. Getting that backwards is the classic reconciliation bug.
 *
 * Both sides of a match are unique. A journal line cannot explain two statement
 * lines and a statement line cannot be explained twice — without which a
 * reconciliation can be made to balance by matching the same ledger entry over
 * and over, which is precisely the error the control exists to find.
 */

const money = (name: string) => numeric(name, { precision: 18, scale: 4 });

/**
 * The real-world account behind a ledger account.
 *
 * One row per ledger account. The ledger account already holds the balance; this
 * carries what it cannot — which bank, which number, and how that bank shapes its
 * exports.
 */
export const bankAccount = accountingSchema.table("bank_account", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .unique()
    .references(() => account.id),
  bankName: text("bank_name").notNull(),
  /** The firm's own number. Printed on invoices; masked in audit payloads. */
  accountNo: text("account_no"),
  accountLabel: text("account_label"),
  swiftCode: text("swift_code"),
  currency: char("currency", { length: 3 }).notNull().default("MYR"),
  /** Remembered column mapping, so nobody re-maps the same export every month. */
  importProfile: jsonb("import_profile"),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => user.id),
  updatedBy: uuid("updated_by").references(() => user.id),
});

/**
 * One imported statement.
 *
 * The opening and closing balances are the reason this table exists rather than
 * the lines standing alone: they are what makes an import provably complete. The
 * lines must account for the movement between them, and a truncated download
 * fails on import instead of six weeks later.
 */
export const bankStatement = accountingSchema.table(
  "bank_statement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccount.id),
    statementRef: text("statement_ref"),
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),
    openingBalance: money("opening_balance").notNull(),
    closingBalance: money("closing_balance").notNull(),
    lineCount: integer("line_count").notNull().default(0),
    sourceFilename: text("source_filename"),
    /** Of the uploaded file, so the same download is recognised on re-import. */
    sourceDigest: text("source_digest"),
    notes: text("notes"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    importedBy: uuid("imported_by")
      .notNull()
      .references(() => user.id),
  },
  (table) => ({
    accountPeriod: index("bank_statement_account_period_idx").on(
      table.bankAccountId,
      table.periodTo,
    ),
  }),
);

export const bankStatementLine = accountingSchema.table(
  "bank_statement_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    statementId: uuid("statement_id")
      .notNull()
      .references(() => bankStatement.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    txnDate: date("txn_date").notNull(),
    valueDate: date("value_date"),
    description: text("description").notNull(),
    reference: text("reference"),
    /** Money into the bank: a DEBIT in the ledger. */
    paidIn: money("paid_in").notNull().default("0"),
    /** Money out of the bank: a CREDIT in the ledger. */
    paidOut: money("paid_out").notNull().default("0"),
    runningBalance: money("running_balance"),
    /** unmatched | matched | ignored — maintained by trigger from the matches. */
    status: text("status").notNull().default("unmatched"),
    ignoreReason: text("ignore_reason"),
    ignoredAt: timestamp("ignored_at", { withTimezone: true }),
    ignoredBy: uuid("ignored_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statementLine: unique().on(table.statementId, table.lineNo),
    byStatement: index("bank_statement_line_statement_idx").on(table.statementId, table.lineNo),
    byDate: index("bank_statement_line_date_idx").on(table.txnDate),
  }),
);

/**
 * A dated claim that the ledger and the bank agree.
 *
 * The figures are stored, not recomputed on demand, because the claim is about
 * what was true when it was signed. A journal posted afterwards with an earlier
 * date must not quietly rewrite a completed reconciliation into agreement.
 */
export const reconciliation = accountingSchema.table(
  "reconciliation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reconciliationNo: text("reconciliation_no"),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccount.id),
    statementId: uuid("statement_id").references(() => bankStatement.id),
    asAt: date("as_at").notNull(),
    /** What the bank says. */
    statementBalance: money("statement_balance").notNull(),
    /** What the ledger says, from posted journals up to `asAt`. */
    ledgerBalance: money("ledger_balance").notNull(),
    /** On the statement, not yet in the ledger. */
    unmatchedStatement: money("unmatched_statement").notNull().default("0"),
    /** In the ledger, not yet on the statement. */
    unmatchedLedger: money("unmatched_ledger").notNull().default("0"),
    difference: money("difference").notNull().default("0"),
    /** draft | completed. Completing with a difference is refused by CHECK. */
    status: text("status").notNull().default("draft"),
    notes: text("notes"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    numberUnique: uniqueIndex("reconciliation_no_unique")
      .on(table.reconciliationNo)
      .where(sql`reconciliation_no IS NOT NULL`),
    // Two people reconciling one account at once would each match half the lines
    // and neither would balance.
    oneOpen: uniqueIndex("reconciliation_one_open_per_account")
      .on(table.bankAccountId)
      .where(sql`status = 'draft'`),
  }),
);

export const reconciliationMatch = accountingSchema.table(
  "reconciliation_match",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    statementLineId: uuid("statement_line_id")
      .notNull()
      .unique()
      .references(() => bankStatementLine.id, { onDelete: "cascade" }),
    journalLineId: uuid("journal_line_id")
      .notNull()
      .unique()
      .references(() => journalLine.id),
    reconciliationId: uuid("reconciliation_id").references(() => reconciliation.id, {
      onDelete: "set null",
    }),
    /** manual | suggested | posted_from_statement */
    method: text("method").notNull().default("manual"),
    note: text("note"),
    matchedAt: timestamp("matched_at", { withTimezone: true }).notNull().defaultNow(),
    matchedBy: uuid("matched_by")
      .notNull()
      .references(() => user.id),
  },
  (table) => ({
    byReconciliation: index("reconciliation_match_reconciliation_idx").on(table.reconciliationId),
    byJournalLine: index("reconciliation_match_journal_line_idx").on(table.journalLineId),
  }),
);
