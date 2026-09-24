import {
  boolean,
  char,
  date,
  index,
  integer,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { costCentre } from "./org.js";

export const accountingSchema = pgSchema("accounting");

/**
 * The double-entry core.
 *
 * These definitions mirror migrations 0002/0003 and exist for typed queries.
 * They deliberately do *not* carry the CHECK constraints and triggers — those
 * live in the migrations, where they are enforced by the database rather than
 * by whichever process happens to be writing. Read
 * docs/DATABASE_DESIGN.md alongside this file.
 *
 * Money is `numeric(18,4)` and surfaces in TypeScript as a string. That is on
 * purpose: parsing it into a JavaScript number would quietly reintroduce the
 * binary-float rounding this schema exists to avoid. Use the helpers in
 * @cac/core (`parseAmount`, `formatAmount`) rather than `Number()`.
 */

const money = (name: string) => numeric(name, { precision: 18, scale: 4 });

export const taxCode = accountingSchema.table("tax_code", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  /** output | input | exempt | none */
  kind: text("kind").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Effective-dated rates. `sourceRef` is NOT NULL so a rate cannot enter the
 * system without a citation to the instrument it came from.
 */
export const taxRate = accountingSchema.table(
  "tax_rate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taxCodeId: uuid("tax_code_id")
      .notNull()
      .references(() => taxCode.id),
    /** A fraction, not a percentage: 0.060000 is 6%. */
    rate: numeric("rate", { precision: 9, scale: 6 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    sourceRef: text("source_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => user.id),
  },
  (t) => [index("tax_rate_lookup_idx").on(t.taxCodeId, t.effectiveFrom)],
);

export const account = accountingSchema.table(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    /** ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE */
    type: text("type").notNull(),
    subtype: text("subtype"),
    parentId: uuid("parent_id"),
    /** debit | credit — constrained against `type` and `isContra`. */
    normalSide: text("normal_side").notNull(),
    /** Headings group; only postable accounts carry journal lines. */
    isPostable: boolean("is_postable").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    /** Resolved by code from other modules; cannot be deactivated or renumbered. */
    isSystem: boolean("is_system").notNull().default(false),
    isContra: boolean("is_contra").notNull().default(false),
    defaultTaxCodeId: uuid("default_tax_code_id").references(() => taxCode.id),
    currency: char("currency", { length: 3 }).notNull().default("MYR"),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (t) => [index("account_parent_idx").on(t.parentId), index("account_type_idx").on(t.type, t.code)],
);

export const fiscalYear = accountingSchema.table("fiscal_year", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  /** open | closed */
  status: text("status").notNull().default("open"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedBy: uuid("closed_by").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => user.id),
});

export const period = accountingSchema.table(
  "period",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fiscalYearId: uuid("fiscal_year_id")
      .notNull()
      .references(() => fiscalYear.id),
    /** Stable handle such as 2026-03. */
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    /** open | locked | closed */
    status: text("status").notNull().default("open"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: uuid("locked_by").references(() => user.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("period_year_idx").on(t.fiscalYearId, t.startsOn)],
);

export const customer = accountingSchema.table("customer", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  registrationNo: text("registration_no"),
  taxIdentifier: text("tax_identifier"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  contactPerson: text("contact_person"),
  paymentTermsDays: integer("payment_terms_days").notNull().default(30),
  creditLimit: money("credit_limit"),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => user.id),
  updatedBy: uuid("updated_by").references(() => user.id),
});

export const supplier = accountingSchema.table("supplier", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  registrationNo: text("registration_no"),
  taxIdentifier: text("tax_identifier"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  contactPerson: text("contact_person"),
  paymentTermsDays: integer("payment_terms_days").notNull().default(30),
  bankName: text("bank_name"),
  bankAccountNo: text("bank_account_no"),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => user.id),
  updatedBy: uuid("updated_by").references(() => user.id),
});

/**
 * A journal is the only thing that changes the ledger.
 *
 * `totalDebit` / `totalCredit` are maintained by a trigger from the lines, so
 * they are never something application code asserts. `journalNo` is null while
 * the entry is a draft and is allocated once, gaplessly, at posting.
 */
export const journal = accountingSchema.table(
  "journal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    journalNo: text("journal_no"),
    periodId: uuid("period_id")
      .notNull()
      .references(() => period.id),
    entryDate: date("entry_date").notNull(),
    memo: text("memo"),
    /** manual | opening | invoice | receipt | voucher | petty_cash | claim | payroll */
    sourceType: text("source_type").notNull().default("manual"),
    sourceId: uuid("source_id"),
    /** draft | posted | reversed */
    status: text("status").notNull().default("draft"),
    totalDebit: money("total_debit").notNull().default("0"),
    totalCredit: money("total_credit").notNull().default("0"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by").references(() => user.id),
    /** Set on the reversing journal, pointing at what it reverses. */
    reversesId: uuid("reverses_id"),
    /** Set on the original, pointing at its reversal. */
    reversedById: uuid("reversed_by_id"),
    reversalReason: text("reversal_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (t) => [
    index("journal_period_idx").on(t.periodId, t.entryDate),
    index("journal_status_idx").on(t.status, t.entryDate),
    index("journal_source_idx").on(t.sourceType, t.sourceId),
  ],
);

export const journalLine = accountingSchema.table(
  "journal_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    journalId: uuid("journal_id")
      .notNull()
      .references(() => journal.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    debit: money("debit").notNull().default("0"),
    credit: money("credit").notNull().default("0"),
    currency: char("currency", { length: 3 }).notNull().default("MYR"),
    description: text("description"),
    costCentreId: uuid("cost_centre_id").references(() => costCentre.id),
    /** Constrained to cases.case once that schema exists (phase 9). */
    caseId: uuid("case_id"),
    taxCodeId: uuid("tax_code_id").references(() => taxCode.id),
    taxRateId: uuid("tax_rate_id").references(() => taxRate.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("journal_line_no_unique").on(t.journalId, t.lineNo),
    index("journal_line_journal_idx").on(t.journalId, t.lineNo),
    index("journal_line_account_idx").on(t.accountId),
    index("journal_line_case_idx").on(t.caseId),
  ],
);
