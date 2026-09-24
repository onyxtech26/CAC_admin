import {
  char,
  date,
  index,
  integer,
  numeric,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { accountingSchema, account, customer, journal, taxCode, taxRate } from "./accounting.js";
import { user } from "./auth.js";

/**
 * The sales cycle: quotation, invoice, receipt, allocation.
 *
 * Mirrors migrations 0004/0005. As with the ledger schema, the constraints and
 * triggers live in the migrations — this file exists for typed queries and to put
 * the shape in one readable place.
 *
 * Money is `numeric(18,4)` and arrives in TypeScript as a string; use
 * `parseAmount` from @cac/core rather than `Number()`.
 */

const money = (name: string) => numeric(name, { precision: 18, scale: 4 });

export const quotation = accountingSchema.table(
  "quotation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quotationNo: text("quotation_no"),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id),
    quotationDate: date("quotation_date").notNull(),
    validUntil: date("valid_until"),
    reference: text("reference"),
    subject: text("subject"),
    /** draft | sent | accepted | declined | expired | converted */
    status: text("status").notNull().default("draft"),
    currency: char("currency", { length: 3 }).notNull().default("MYR"),
    subtotal: money("subtotal").notNull().default("0"),
    discountTotal: money("discount_total").notNull().default("0"),
    taxTotal: money("tax_total").notNull().default("0"),
    total: money("total").notNull().default("0"),
    notes: text("notes"),
    terms: text("terms"),
    convertedInvoiceId: uuid("converted_invoice_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => user.id),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (t) => [
    index("quotation_customer_idx").on(t.customerId, t.quotationDate),
    index("quotation_status_idx").on(t.status, t.quotationDate),
  ],
);

export const invoice = accountingSchema.table(
  "invoice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceNo: text("invoice_no"),
    /** invoice | credit_note — a credit note is the same document with the signs reversed. */
    kind: text("kind").notNull().default("invoice"),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id),
    invoiceDate: date("invoice_date").notNull(),
    dueDate: date("due_date").notNull(),
    reference: text("reference"),
    subject: text("subject"),
    /** draft | pending_approval | approved | issued | paid | void */
    status: text("status").notNull().default("draft"),
    currency: char("currency", { length: 3 }).notNull().default("MYR"),
    subtotal: money("subtotal").notNull().default("0"),
    discountTotal: money("discount_total").notNull().default("0"),
    taxTotal: money("tax_total").notNull().default("0"),
    total: money("total").notNull().default("0"),
    /** Maintained by trigger from accounting.allocation. */
    amountAllocated: money("amount_allocated").notNull().default("0"),
    quotationId: uuid("quotation_id").references(() => quotation.id),
    journalId: uuid("journal_id").references(() => journal.id),
    voidJournalId: uuid("void_journal_id").references(() => journal.id),
    voidReason: text("void_reason"),
    creditsInvoiceId: uuid("credits_invoice_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by").references(() => user.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => user.id),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    issuedBy: uuid("issued_by").references(() => user.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => user.id),
    notes: text("notes"),
    terms: text("terms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (t) => [
    index("invoice_customer_idx").on(t.customerId, t.invoiceDate),
    index("invoice_status_idx").on(t.status, t.dueDate),
  ],
);

const lineColumns = {
  lineNo: integer("line_no").notNull(),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 18, scale: 6 }).notNull().default("1"),
  unit: text("unit"),
  unitPrice: money("unit_price").notNull().default("0"),
  /** What was entered, when a percentage was entered. */
  discountPercent: numeric("discount_percent", { precision: 9, scale: 6 }),
  /** What was actually applied. Always populated. */
  discountAmount: money("discount_amount").notNull().default("0"),
  taxCodeId: uuid("tax_code_id").references(() => taxCode.id),
  /** The rate row used, so the document reprints identically after a rate change. */
  taxRateId: uuid("tax_rate_id").references(() => taxRate.id),
  taxAmount: money("tax_amount").notNull().default("0"),
  /** quantity x unit price, before discount. */
  lineSubtotal: money("line_subtotal").notNull().default("0"),
  /** subtotal - discount + tax. */
  lineTotal: money("line_total").notNull().default("0"),
  accountId: uuid("account_id")
    .notNull()
    .references(() => account.id),
  caseId: uuid("case_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
};

export const quotationLine = accountingSchema.table(
  "quotation_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quotationId: uuid("quotation_id")
      .notNull()
      .references(() => quotation.id, { onDelete: "cascade" }),
    ...lineColumns,
  },
  (t) => [
    unique("quotation_line_no_unique").on(t.quotationId, t.lineNo),
    index("quotation_line_parent_idx").on(t.quotationId, t.lineNo),
  ],
);

export const invoiceLine = accountingSchema.table(
  "invoice_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoice.id, { onDelete: "cascade" }),
    ...lineColumns,
  },
  (t) => [
    unique("invoice_line_no_unique").on(t.invoiceId, t.lineNo),
    index("invoice_line_parent_idx").on(t.invoiceId, t.lineNo),
    index("invoice_line_account_idx").on(t.accountId),
  ],
);

export const receipt = accountingSchema.table(
  "receipt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptNo: text("receipt_no"),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id),
    receiptDate: date("receipt_date").notNull(),
    /** cash | cheque | transfer | card | other */
    method: text("method").notNull().default("transfer"),
    reference: text("reference"),
    /** The bank or cash account the money landed in. */
    depositAccountId: uuid("deposit_account_id")
      .notNull()
      .references(() => account.id),
    amount: money("amount").notNull(),
    amountAllocated: money("amount_allocated").notNull().default("0"),
    /** draft | posted | void */
    status: text("status").notNull().default("draft"),
    journalId: uuid("journal_id").references(() => journal.id),
    voidJournalId: uuid("void_journal_id").references(() => journal.id),
    voidReason: text("void_reason"),
    notes: text("notes"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by").references(() => user.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (t) => [
    index("receipt_customer_idx").on(t.customerId, t.receiptDate),
    index("receipt_status_idx").on(t.status, t.receiptDate),
  ],
);

/**
 * What settles what.
 *
 * Many-to-many on purpose: one payment covering four invoices, and one invoice
 * settled in three instalments, are both ordinary.
 */
export const allocation = accountingSchema.table(
  "allocation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoice.id),
    /** receipt | credit_note */
    sourceType: text("source_type").notNull(),
    receiptId: uuid("receipt_id").references(() => receipt.id),
    creditNoteId: uuid("credit_note_id").references(() => invoice.id),
    amount: money("amount").notNull(),
    allocatedAt: timestamp("allocated_at", { withTimezone: true }).notNull().defaultNow(),
    allocatedBy: uuid("allocated_by")
      .notNull()
      .references(() => user.id),
  },
  (t) => [
    index("allocation_invoice_idx").on(t.invoiceId),
    index("allocation_receipt_idx").on(t.receiptId),
  ],
);
