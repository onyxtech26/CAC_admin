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
import { accountingSchema, account, journal, supplier, taxCode, taxRate } from "./accounting.js";
import { costCentre } from "./org.js";
import { user } from "./auth.js";

/**
 * Money out: purchase orders, payment vouchers, petty cash and expense claims.
 *
 * Mirrors migrations 0007/0008. The constraints and triggers live there.
 *
 * The purchase order is the one document in this file that reaches no ledger
 * account: committing to buy something is not a liability until it arrives.
 */

const money = (name: string) => numeric(name, { precision: 18, scale: 4 });
const quantity = (name: string) => numeric(name, { precision: 18, scale: 6 });

/** Columns shared by every money-out line. No discount: it is in the price. */
const purchaseLineColumns = {
  lineNo: integer("line_no").notNull(),
  description: text("description").notNull(),
  quantity: quantity("quantity").notNull().default("1"),
  unit: text("unit"),
  unitPrice: money("unit_price").notNull().default("0"),
  taxCodeId: uuid("tax_code_id").references(() => taxCode.id),
  taxRateId: uuid("tax_rate_id").references(() => taxRate.id),
  taxAmount: money("tax_amount").notNull().default("0"),
  lineSubtotal: money("line_subtotal").notNull().default("0"),
  lineTotal: money("line_total").notNull().default("0"),
  accountId: uuid("account_id")
    .notNull()
    .references(() => account.id),
  costCentreId: uuid("cost_centre_id").references(() => costCentre.id),
  caseId: uuid("case_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
};

export const purchaseOrder = accountingSchema.table(
  "purchase_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderNo: text("order_no"),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => supplier.id),
    orderDate: date("order_date").notNull(),
    requiredBy: date("required_by"),
    reference: text("reference"),
    subject: text("subject"),
    /** draft | pending_approval | approved | issued | received | closed | cancelled */
    status: text("status").notNull().default("draft"),
    currency: char("currency", { length: 3 }).notNull().default("MYR"),
    subtotal: money("subtotal").notNull().default("0"),
    taxTotal: money("tax_total").notNull().default("0"),
    total: money("total").notNull().default("0"),
    deliveryNote: text("delivery_note"),
    notes: text("notes"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by").references(() => user.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => user.id),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    issuedBy: uuid("issued_by").references(() => user.id),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    receivedBy: uuid("received_by").references(() => user.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => user.id),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (t) => [
    index("po_supplier_idx").on(t.supplierId, t.orderDate),
    index("po_status_idx").on(t.status, t.orderDate),
  ],
);

export const purchaseOrderLine = accountingSchema.table(
  "purchase_order_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => purchaseOrder.id, { onDelete: "cascade" }),
    ...purchaseLineColumns,
    /** How much has actually turned up, for partial deliveries. */
    quantityReceived: quantity("quantity_received").notNull().default("0"),
  },
  (t) => [
    unique("po_line_no_unique").on(t.orderId, t.lineNo),
    index("po_line_parent_idx").on(t.orderId, t.lineNo),
  ],
);

export const paymentVoucher = accountingSchema.table(
  "payment_voucher",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    voucherNo: text("voucher_no"),
    supplierId: uuid("supplier_id").references(() => supplier.id),
    /** Where there is no registered supplier: a one-off payee. */
    payeeName: text("payee_name"),
    voucherDate: date("voucher_date").notNull(),
    reference: text("reference"),
    subject: text("subject"),
    /** expense buys something; settlement pays off trade payables. */
    kind: text("kind").notNull().default("expense"),
    /** paid credits bank or cash; payable credits trade payables. */
    settlement: text("settlement").notNull().default("paid"),
    method: text("method").notNull().default("transfer"),
    paymentAccountId: uuid("payment_account_id").references(() => account.id),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrder.id),
    /** draft | pending_approval | approved | posted | void */
    status: text("status").notNull().default("draft"),
    currency: char("currency", { length: 3 }).notNull().default("MYR"),
    subtotal: money("subtotal").notNull().default("0"),
    taxTotal: money("tax_total").notNull().default("0"),
    total: money("total").notNull().default("0"),
    journalId: uuid("journal_id").references(() => journal.id),
    voidJournalId: uuid("void_journal_id").references(() => journal.id),
    voidReason: text("void_reason"),
    notes: text("notes"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by").references(() => user.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => user.id),
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
    index("voucher_supplier_idx").on(t.supplierId, t.voucherDate),
    index("voucher_status_idx").on(t.status, t.voucherDate),
  ],
);

export const paymentVoucherLine = accountingSchema.table(
  "payment_voucher_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    voucherId: uuid("voucher_id")
      .notNull()
      .references(() => paymentVoucher.id, { onDelete: "cascade" }),
    ...purchaseLineColumns,
  },
  (t) => [
    unique("voucher_line_no_unique").on(t.voucherId, t.lineNo),
    index("voucher_line_parent_idx").on(t.voucherId, t.lineNo),
  ],
);

export const pettyCashTxn = accountingSchema.table(
  "petty_cash_txn",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    txnNo: text("txn_no"),
    txnDate: date("txn_date").notNull(),
    /** top_up | expense | adjustment */
    kind: text("kind").notNull(),
    description: text("description").notNull(),
    amount: money("amount").notNull(),
    /** Top-up: the bank it came from. Expense: what it was spent on. */
    counterpartAccountId: uuid("counterpart_account_id")
      .notNull()
      .references(() => account.id),
    /** The float itself, so more than one is possible later. */
    floatAccountId: uuid("float_account_id")
      .notNull()
      .references(() => account.id),
    taxCodeId: uuid("tax_code_id").references(() => taxCode.id),
    taxRateId: uuid("tax_rate_id").references(() => taxRate.id),
    taxAmount: money("tax_amount").notNull().default("0"),
    receiptRef: text("receipt_ref"),
    costCentreId: uuid("cost_centre_id").references(() => costCentre.id),
    caseId: uuid("case_id"),
    /** draft | posted | void */
    status: text("status").notNull().default("draft"),
    journalId: uuid("journal_id").references(() => journal.id),
    voidJournalId: uuid("void_journal_id").references(() => journal.id),
    voidReason: text("void_reason"),
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
    index("petty_date_idx").on(t.floatAccountId, t.txnDate),
    index("petty_status_idx").on(t.status, t.txnDate),
  ],
);

/**
 * A physical count of the float.
 *
 * `bookAmount` is captured at the moment of counting rather than recomputed
 * later, so the count stays reproducible even after the ledger moves on.
 */
export const pettyCashCount = accountingSchema.table(
  "petty_cash_count",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    floatAccountId: uuid("float_account_id")
      .notNull()
      .references(() => account.id),
    countedOn: date("counted_on").notNull(),
    countedAmount: money("counted_amount").notNull(),
    bookAmount: money("book_amount").notNull(),
    difference: money("difference").notNull(),
    notes: text("notes"),
    adjustmentTxnId: uuid("adjustment_txn_id").references(() => pettyCashTxn.id),
    countedBy: uuid("counted_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("petty_count_idx").on(t.floatAccountId, t.countedOn)],
);

export const expenseClaim = accountingSchema.table(
  "expense_claim",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimNo: text("claim_no"),
    /** Always the person making the claim, taken from the session. */
    claimantId: uuid("claimant_id")
      .notNull()
      .references(() => user.id),
    /** Populated from phase 5, when employees exist as records. */
    employeeId: uuid("employee_id"),
    claimDate: date("claim_date").notNull(),
    periodFrom: date("period_from"),
    periodTo: date("period_to"),
    subject: text("subject"),
    /** draft | submitted | approved | posted | reimbursed | rejected */
    status: text("status").notNull().default("draft"),
    currency: char("currency", { length: 3 }).notNull().default("MYR"),
    subtotal: money("subtotal").notNull().default("0"),
    taxTotal: money("tax_total").notNull().default("0"),
    total: money("total").notNull().default("0"),
    journalId: uuid("journal_id").references(() => journal.id),
    reimbursementVoucherId: uuid("reimbursement_voucher_id").references(() => paymentVoucher.id),
    rejectReason: text("reject_reason"),
    notes: text("notes"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => user.id),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by").references(() => user.id),
    reimbursedAt: timestamp("reimbursed_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectedBy: uuid("rejected_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (t) => [
    index("claim_claimant_idx").on(t.claimantId, t.claimDate),
    index("claim_status_idx").on(t.status, t.claimDate),
  ],
);

export const expenseClaimLine = accountingSchema.table(
  "expense_claim_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => expenseClaim.id, { onDelete: "cascade" }),
    ...purchaseLineColumns,
    /** When the money was actually spent, which is not the claim date. */
    spentOn: date("spent_on").notNull(),
    receiptRef: text("receipt_ref"),
  },
  (t) => [
    unique("claim_line_no_unique").on(t.claimId, t.lineNo),
    index("claim_line_parent_idx").on(t.claimId, t.lineNo),
  ],
);
