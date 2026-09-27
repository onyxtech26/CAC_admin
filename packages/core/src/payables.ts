import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { SYSTEM_ACCOUNTS } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, requireDifferentApprover, type Principal } from "./authz.js";
import { parseIsoDate, toIsoDate, today } from "./dates.js";
import {
  computeDocumentLines,
  readDocumentLines,
  writeDocumentLines,
  type DocumentLineInput,
} from "./documents.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { amountToSql, formatAmount, parseAmount, type Amount } from "./money.js";
import { postSourceJournal, reverseJournal } from "./posting.js";
import { allocateDocumentNumber } from "./sequence.js";

/**
 * Accounts payable — the bills CAC receives, and what settles them.
 *
 * This is the mirror of `sales.ts`, and it is deliberately the same shape: the same lifecycle, the
 * same maker/checker, the same derived totals, the same refusal to edit anything that has reached
 * the ledger. AutoCount organises its A/R and A/P menus as twins for a reason — an accountant who
 * has learned one side has learned the other — and the twinning is worth as much in the code as it
 * is in the menu.
 *
 * ## What existed before, and why it was not enough
 *
 * A bill could be entered as a payment voucher with `settlement = 'payable'`. That credits trade
 * payables, so the general ledger was right. What was missing was everything underneath it: the
 * supplier's own document number, a due date belonging to the bill rather than to the payment, and
 * any way to answer *what makes up the payables balance and when is each piece due*. The control
 * account had no sub-ledger. `payment_voucher.settles_bill_id` and `accounting.payable_settlement`
 * are what give it one.
 *
 * ## Three differences from the sales side, each on purpose
 *
 * 1. **Two document numbers.** `billNo` is CAC's own reference, allocated at posting.
 *    `supplierDocNo` is what the supplier printed, and it is the one that matters in a dispute.
 *    It is required, and unique per supplier, because paying the same invoice twice is the most
 *    common way money leaves a small company by accident.
 * 2. **The lifecycle ends at `posted`, not `issued`.** CAC did not issue this document; it
 *    received it. Calling it "issued" would imply CAC produced the figures.
 * 3. **No value threshold on approving the bill itself.** The spending decision is made on the
 *    purchase order and again on the payment voucher that settles it. A third approval, to merely
 *    record what a supplier has already charged, teaches people to click through approvals — which
 *    is how approvals stop meaning anything anywhere.
 */

export type SupplierInvoiceStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "posted"
  | "settled"
  | "void";

export interface SupplierInvoiceInput {
  supplierId: string;
  /** The number the supplier printed on their own document. */
  supplierDocNo: string;
  billDate: string;
  dueDate: string;
  /** When it physically arrived, which is not the same as the date on it. */
  receivedDate?: string;
  subject?: string | null;
  notes?: string | null;
  purchaseOrderId?: string | null;
  lines: DocumentLineInput[];
}

interface LockedBill extends Record<string, unknown> {
  id: string;
  bill_no: string | null;
  kind: string;
  supplier_id: string;
  supplier_doc_no: string;
  bill_date: string;
  status: SupplierInvoiceStatus;
  total: string;
  tax_total: string;
  amount_settled: string;
  journal_id: string | null;
  credits_bill_id: string | null;
  created_by: string;
}

async function lockBill(db: Executor, billId: string): Promise<LockedBill> {
  const result = await db.execute<LockedBill>(sql`
    SELECT id, bill_no, kind, supplier_id, supplier_doc_no, bill_date::text AS bill_date,
           status, total::text AS total, tax_total::text AS tax_total,
           amount_settled::text AS amount_settled, journal_id, credits_bill_id, created_by
      FROM accounting.supplier_invoice
     WHERE id = ${billId}
     FOR UPDATE
  `);
  const row = result.rows?.[0];
  if (!row) throw new NotFoundError("That bill no longer exists.");
  return row;
}

async function requireSupplier(
  db: Executor,
  supplierId: string,
): Promise<{ id: string; code: string; name: string }> {
  const result = await db.execute<{ id: string; code: string; name: string; is_active: boolean }>(
    sql`SELECT id, code, name, is_active FROM accounting.supplier WHERE id = ${supplierId}`,
  );
  const row = result.rows?.[0];
  if (!row) throw new ValidationError("Choose a supplier.", "supplierId");
  if (!row.is_active) {
    throw new ValidationError(
      `${row.name} is no longer in use. A bill cannot be entered against them until they are active again.`,
      "supplierId",
    );
  }
  return { id: row.id, code: row.code, name: row.name };
}

/**
 * The duplicate check, in the application as well as in the index.
 *
 * The unique index is the thing that actually holds. This exists so that the person entering the
 * bill is told which bill it duplicates, rather than being shown a constraint violation — a
 * message that says "this is already here, and here is its reference" is the difference between
 * catching a double payment and working around the error.
 */
async function refuseDuplicate(
  db: Executor,
  supplierId: string,
  supplierDocNo: string,
  exceptId?: string,
): Promise<void> {
  const result = await db.execute<{ bill_no: string | null; status: string; total: string }>(sql`
    SELECT bill_no, status, total::text AS total
      FROM accounting.supplier_invoice
     WHERE supplier_id = ${supplierId}
       AND upper(btrim(supplier_doc_no)) = upper(btrim(${supplierDocNo}))
       AND status <> 'void'
       AND (${exceptId ?? null}::uuid IS NULL OR id <> ${exceptId ?? null}::uuid)
     LIMIT 1
  `);
  const existing = result.rows?.[0];
  if (!existing) return;

  throw new ConflictError(
    `${supplierDocNo} has already been entered for this supplier` +
      (existing.bill_no ? ` as ${existing.bill_no}` : " as a draft") +
      `, for ${formatAmount(parseAmount(existing.total))}. ` +
      "Entering it twice is how a supplier gets paid twice.",
  );
}

function requireDocNo(raw: string | undefined | null): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    throw new ValidationError(
      "Enter the number the supplier printed on their invoice. It is what they will quote, and " +
        "it is how a duplicate is caught.",
      "supplierDocNo",
    );
  }
  if (value.length > 60) {
    throw new ValidationError("That is too long for a document number.", "supplierDocNo");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Entering a bill
// ---------------------------------------------------------------------------

export async function createSupplierInvoice(
  db: Executor,
  principal: Principal,
  input: SupplierInvoiceInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.bill.create");

  const supplier = await requireSupplier(db, input.supplierId);
  const supplierDocNo = requireDocNo(input.supplierDocNo);
  await refuseDuplicate(db, supplier.id, supplierDocNo);

  const billDate = toIsoDate(parseIsoDate(input.billDate, "billDate"));
  const dueDate = toIsoDate(parseIsoDate(input.dueDate, "dueDate"));
  if (dueDate < billDate) {
    throw new ValidationError("The due date cannot be before the date on the bill.", "dueDate");
  }

  const receivedDate = input.receivedDate
    ? toIsoDate(parseIsoDate(input.receivedDate, "receivedDate"))
    : toIsoDate(today());
  if (receivedDate < billDate) {
    throw new ValidationError(
      "A bill cannot have been received before it was written.",
      "receivedDate",
    );
  }

  const computed = await computeDocumentLines(db, input.lines, billDate);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.supplier_invoice
      (kind, supplier_id, supplier_doc_no, bill_date, due_date, received_date, subject, notes,
       purchase_order_id, created_by)
    VALUES ('invoice', ${supplier.id}, ${supplierDocNo}, ${billDate}, ${dueDate}, ${receivedDate},
            ${input.subject ?? null}, ${input.notes ?? null}, ${input.purchaseOrderId ?? null},
            ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeDocumentLines(db, "supplier_invoice_line", "supplier_invoice_id", id, computed.lines);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.BILL_CREATED,
    entityType: "supplier_invoice",
    entityId: id,
    newValues: { supplier: supplier.name, supplierDocNo, billDate, dueDate },
  });

  return { id };
}

export async function updateSupplierInvoice(
  db: Executor,
  principal: Principal,
  billId: string,
  input: SupplierInvoiceInput,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.bill.create");

  const bill = await lockBill(db, billId);
  if (bill.status !== "draft") {
    throw new ConflictError(`This bill is ${bill.status} and can no longer be edited.`);
  }

  const supplier = await requireSupplier(db, input.supplierId);
  const supplierDocNo = requireDocNo(input.supplierDocNo);
  await refuseDuplicate(db, supplier.id, supplierDocNo, billId);

  const billDate = toIsoDate(parseIsoDate(input.billDate, "billDate"));
  const dueDate = toIsoDate(parseIsoDate(input.dueDate, "dueDate"));
  if (dueDate < billDate) {
    throw new ValidationError("The due date cannot be before the date on the bill.", "dueDate");
  }
  const receivedDate = input.receivedDate
    ? toIsoDate(parseIsoDate(input.receivedDate, "receivedDate"))
    : billDate;

  const computed = await computeDocumentLines(db, input.lines, billDate);

  await db.execute(sql`
    UPDATE accounting.supplier_invoice
       SET supplier_id = ${supplier.id}, supplier_doc_no = ${supplierDocNo},
           bill_date = ${billDate}, due_date = ${dueDate}, received_date = ${receivedDate},
           subject = ${input.subject ?? null}, notes = ${input.notes ?? null},
           purchase_order_id = ${input.purchaseOrderId ?? null},
           updated_at = now(), updated_by = ${principal.userId}
     WHERE id = ${billId}
  `);

  await db.execute(
    sql`DELETE FROM accounting.supplier_invoice_line WHERE supplier_invoice_id = ${billId}`,
  );
  await writeDocumentLines(
    db,
    "supplier_invoice_line",
    "supplier_invoice_id",
    billId,
    computed.lines,
  );

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.BILL_UPDATED,
    entityType: "supplier_invoice",
    entityId: billId,
    newValues: { supplier: supplier.name, supplierDocNo, billDate, dueDate },
  });
}

export async function deleteSupplierInvoice(
  db: Executor,
  principal: Principal,
  billId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.bill.create");

  const bill = await lockBill(db, billId);
  if (bill.status !== "draft") {
    throw new ConflictError(
      `This bill is ${bill.status}. Only a draft can be deleted; anything further on is voided.`,
    );
  }

  await db.execute(sql`DELETE FROM accounting.supplier_invoice WHERE id = ${billId}`);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.BILL_DELETED,
    entityType: "supplier_invoice",
    entityId: billId,
    oldValues: { supplierDocNo: bill.supplier_doc_no, total: bill.total },
  });
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export async function submitSupplierInvoice(
  db: Executor,
  principal: Principal,
  billId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.bill.create");

  const bill = await lockBill(db, billId);
  if (bill.status !== "draft") {
    throw new ConflictError(`This bill is ${bill.status} and cannot be submitted.`);
  }

  const lines = await readDocumentLines(
    db,
    "supplier_invoice_line",
    "supplier_invoice_id",
    billId,
  );
  if (lines.length === 0) {
    throw new ValidationError("A bill with no lines cannot be submitted.", "lines");
  }

  await db.execute(sql`
    UPDATE accounting.supplier_invoice
       SET status = 'pending_approval', submitted_at = now(), submitted_by = ${principal.userId},
           updated_at = now(), updated_by = ${principal.userId}
     WHERE id = ${billId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.BILL_SUBMITTED,
    entityType: "supplier_invoice",
    entityId: billId,
    newValues: { supplierDocNo: bill.supplier_doc_no, total: bill.total },
  });
}

export async function returnSupplierInvoiceToDraft(
  db: Executor,
  principal: Principal,
  billId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.bill.approve");

  const trimmed = reason?.trim();
  if (!trimmed) {
    throw new ValidationError("Say what needs correcting.", "reason");
  }

  const bill = await lockBill(db, billId);
  if (bill.status !== "pending_approval") {
    throw new ConflictError(`This bill is ${bill.status}, not waiting for approval.`);
  }

  await db.execute(sql`
    UPDATE accounting.supplier_invoice
       SET status = 'draft', submitted_at = NULL, submitted_by = NULL,
           updated_at = now(), updated_by = ${principal.userId}
     WHERE id = ${billId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.BILL_RETURNED,
    entityType: "supplier_invoice",
    entityId: billId,
    reason: trimmed,
  });
}

export async function approveSupplierInvoice(
  db: Executor,
  principal: Principal,
  billId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.bill.approve");

  const bill = await lockBill(db, billId);
  if (bill.status !== "pending_approval") {
    throw new ConflictError(`This bill is ${bill.status}, not waiting for approval.`);
  }

  // The person who entered the bill is not the person who confirms it is genuine. This is the
  // whole of the control: a fabricated supplier invoice that one person can both enter and
  // approve is a fabricated supplier invoice that gets paid.
  requireDifferentApprover({
    principal,
    createdByUserId: bill.created_by,
    action: "approve a bill",
  });

  await db.execute(sql`
    UPDATE accounting.supplier_invoice
       SET status = 'approved', approved_at = now(), approved_by = ${principal.userId},
           updated_at = now(), updated_by = ${principal.userId}
     WHERE id = ${billId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.BILL_APPROVED,
    entityType: "supplier_invoice",
    entityId: billId,
    newValues: { supplierDocNo: bill.supplier_doc_no, total: bill.total },
  });
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/**
 * Posts an approved bill to the ledger.
 *
 * The entry is the sales invoice's, reflected:
 *
 *     Dr  each line's expense or asset account   (net of discount)
 *     Dr  SST input tax                          (if any)
 *       Cr  trade payables control               (the total)
 *
 * A supplier credit note is the same entry with the sides swapped.
 */
export async function postSupplierInvoice(
  db: Executor,
  principal: Principal,
  billId: string,
  context?: AuditContext,
): Promise<{ billNo: string; journalNo: string }> {
  requireCapability(principal, "accounting.bill.post");

  const bill = await lockBill(db, billId);
  if (bill.status !== "approved") {
    throw new ConflictError(
      bill.status === "pending_approval"
        ? "This bill has not been approved yet."
        : `This bill is ${bill.status} and cannot be posted.`,
    );
  }

  const lines = await readDocumentLines(db, "supplier_invoice_line", "supplier_invoice_id", billId);
  if (lines.length === 0) {
    throw new ValidationError("A bill with no lines cannot be posted.", "lines");
  }

  const date = String(bill.bill_date).slice(0, 10);
  const total = parseAmount(bill.total);
  const taxTotal = parseAmount(bill.tax_total);
  const credit = bill.kind === "credit_note";

  // The same cap the sales side applies to its credit notes, for the same reason: a supplier
  // credit note for more than the bill it credits would remove a cost that was never incurred.
  if (credit && bill.credits_bill_id) {
    const target = await db.execute<{ total: string; bill_no: string | null }>(sql`
      SELECT total::text AS total, bill_no FROM accounting.supplier_invoice
       WHERE id = ${bill.credits_bill_id}
    `);
    const original = target.rows?.[0];
    if (!original) throw new NotFoundError("The bill this credit note credits no longer exists.");

    const outstanding =
      parseAmount(original.total) - (await creditedSoFar(db, bill.credits_bill_id, billId));
    if (total > outstanding) {
      throw new ConflictError(
        `This credit note is for ${formatAmount(total)} against ` +
          `${original.bill_no ?? "a bill"}, which has only ${formatAmount(outstanding)} left to ` +
          "credit. Posting it would remove a cost that was never incurred.",
      );
    }
  }

  const billNo = await allocateDocumentNumber(
    db,
    credit ? "supplier_credit_note" : "supplier_invoice",
    { on: date },
  );

  const supplier = await db.execute<{ name: string; code: string }>(
    sql`SELECT name, code FROM accounting.supplier WHERE id = ${bill.supplier_id}`,
  );
  const who = supplier.rows![0]!;
  const memo =
    `${credit ? "Supplier credit note" : "Bill"} ${billNo} — ${who.name} ` +
    `(their ${bill.supplier_doc_no})`;

  const payable = {
    accountCode: SYSTEM_ACCOUNTS.payableControl,
    description: `${who.code} ${who.name}`,
    ...(credit ? { debit: amountToSql(total) } : { credit: amountToSql(total) }),
  };
  const costLines = lines.map((line) => ({
    accountId: line.accountId,
    description: line.description,
    caseId: line.caseId,
    ...(credit
      ? { credit: amountToSql(line.lineSubtotal - line.discountAmount) }
      : { debit: amountToSql(line.lineSubtotal - line.discountAmount) }),
  }));
  const taxLines =
    taxTotal > 0n
      ? [
          {
            accountCode: SYSTEM_ACCOUNTS.sstInput,
            description: "Service tax charged by the supplier",
            ...(credit ? { credit: amountToSql(taxTotal) } : { debit: amountToSql(taxTotal) }),
          },
        ]
      : [];

  const journal = await postSourceJournal(
    db,
    principal,
    {
      entryDate: date,
      memo,
      sourceType: "supplier_invoice",
      sourceId: billId,
      authorisedBy: "accounting.bill.post",
      lines: [payable, ...costLines, ...taxLines],
    },
    context,
  );

  await db.execute(sql`
    UPDATE accounting.supplier_invoice
       SET status = 'posted', bill_no = ${billNo}, journal_id = ${journal.id},
           posted_at = now(), posted_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${billId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.BILL_POSTED,
    entityType: "supplier_invoice",
    entityId: billId,
    newValues: {
      billNo,
      journalNo: journal.journalNo,
      total: bill.total,
      supplier: who.name,
      supplierDocNo: bill.supplier_doc_no,
    },
  });

  return { billNo, journalNo: journal.journalNo };
}

async function creditedSoFar(db: Executor, billId: string, exceptId?: string): Promise<Amount> {
  const result = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(total), 0)::text AS total FROM accounting.supplier_invoice
     WHERE credits_bill_id = ${billId} AND status <> 'void'
       AND (${exceptId ?? null}::uuid IS NULL OR id <> ${exceptId ?? null}::uuid)
  `);
  return parseAmount(result.rows?.[0]?.total ?? "0");
}

export async function voidSupplierInvoice(
  db: Executor,
  principal: Principal,
  billId: string,
  reason: string,
  context?: AuditContext,
): Promise<{ journalNo: string }> {
  requireCapability(principal, "accounting.bill.void");

  const trimmed = reason?.trim();
  if (!trimmed) {
    throw new ValidationError("Say why this bill is being voided.", "reason");
  }

  const bill = await lockBill(db, billId);
  if (bill.status !== "posted" && bill.status !== "settled") {
    throw new ConflictError(
      `This bill is ${bill.status}. Only a posted bill is voided; a draft is simply deleted.`,
    );
  }
  if (parseAmount(bill.amount_settled) > 0n) {
    throw new ConflictError(
      "Something has been settled against this bill. Remove the settlement first, so the payment " +
        "does not end up pointing at nothing.",
    );
  }
  if (!bill.journal_id) {
    throw new ConflictError("This bill has no journal to reverse, which should not be possible.");
  }

  const reversal = await reverseJournal(db, principal, bill.journal_id, {
    reason: trimmed,
    context,
  });

  await db.execute(sql`
    UPDATE accounting.supplier_invoice
       SET status = 'void', void_journal_id = ${reversal.journalId}, void_reason = ${trimmed},
           voided_at = now(), voided_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${billId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.BILL_VOIDED,
    entityType: "supplier_invoice",
    entityId: billId,
    reason: trimmed,
    newValues: { billNo: bill.bill_no, reversalJournalNo: reversal.journalNo },
  });

  return { journalNo: reversal.journalNo };
}

// ---------------------------------------------------------------------------
// Supplier credit notes
// ---------------------------------------------------------------------------

export async function createSupplierCreditNote(
  db: Executor,
  principal: Principal,
  input: { billId: string; supplierDocNo: string; lines?: DocumentLineInput[]; reason: string },
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.bill.create");

  const reason = input.reason?.trim();
  if (!reason) {
    throw new ValidationError("Say what the supplier is crediting.", "reason");
  }

  const bill = await lockBill(db, input.billId);
  if (bill.kind !== "invoice") {
    throw new ConflictError("A credit note cannot credit another credit note.");
  }
  if (bill.status !== "posted" && bill.status !== "settled") {
    throw new ConflictError(`Only a posted bill can be credited; this one is ${bill.status}.`);
  }

  const supplierDocNo = requireDocNo(input.supplierDocNo);
  await refuseDuplicate(db, bill.supplier_id, supplierDocNo);

  const original = await readDocumentLines(
    db,
    "supplier_invoice_line",
    "supplier_invoice_id",
    input.billId,
  );
  const date = toIsoDate(today());

  // Credit the whole bill unless specific lines are given. A partial credit is the common case —
  // a supplier over-charged one line — and it must be possible to say so.
  const lines =
    input.lines && input.lines.length > 0
      ? input.lines
      : original.map((line) => ({
          description: line.description,
          quantity: String(line.quantity),
          unitPrice: formatAmount(line.unitPrice),
          accountId: line.accountId,
          taxCodeId: line.taxCodeId,
          caseId: line.caseId,
          unit: line.unit,
        }));

  const computed = await computeDocumentLines(db, lines, date);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.supplier_invoice
      (kind, supplier_id, supplier_doc_no, bill_date, due_date, received_date, subject, notes,
       credits_bill_id, created_by)
    VALUES ('credit_note', ${bill.supplier_id}, ${supplierDocNo}, ${date}, ${date}, ${date},
            ${`Credit against ${bill.bill_no ?? bill.supplier_doc_no}`}, ${reason},
            ${input.billId}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeDocumentLines(db, "supplier_invoice_line", "supplier_invoice_id", id, computed.lines);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.BILL_CREATED,
    entityType: "supplier_invoice",
    entityId: id,
    reason,
    newValues: { kind: "credit_note", credits: bill.bill_no, supplierDocNo },
  });

  return { id };
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/**
 * Applies a posted payment voucher to one or more bills.
 *
 * The mirror of `allocateReceipt`. The database enforces that the voucher and the bills belong to
 * the same supplier, that nothing is over-applied on either side, and that the bill's settled
 * status follows from the arithmetic rather than from an instruction.
 */
export async function settleBills(
  db: Executor,
  principal: Principal,
  input: { voucherId: string; allocations: Array<{ billId: string; amount: string }> },
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.bill.settle");

  if (input.allocations.length === 0) {
    throw new ValidationError("Choose at least one bill to settle.", "allocations");
  }

  const voucher = await db.execute<{ status: string; total: string; voucher_no: string | null }>(sql`
    SELECT status, total::text AS total, voucher_no
      FROM accounting.payment_voucher WHERE id = ${input.voucherId} FOR UPDATE
  `);
  const row = voucher.rows?.[0];
  if (!row) throw new NotFoundError("That payment voucher no longer exists.");
  if (row.status !== "posted") {
    throw new ConflictError(
      `A voucher settles a bill only once it is posted; this one is ${row.status}.`,
    );
  }

  for (const allocation of input.allocations) {
    const amount = parseAmount(allocation.amount);
    if (amount <= 0n) {
      throw new ValidationError("A settlement has to be for more than nothing.", "amount");
    }
    await db.execute(sql`
      INSERT INTO accounting.payable_settlement
        (supplier_invoice_id, source_type, voucher_id, amount, settled_by)
      VALUES (${allocation.billId}, 'voucher', ${input.voucherId}, ${amountToSql(amount)},
              ${principal.userId})
      ON CONFLICT (supplier_invoice_id, voucher_id) WHERE voucher_id IS NOT NULL
      DO UPDATE SET amount = EXCLUDED.amount, settled_at = now(), settled_by = EXCLUDED.settled_by
    `);
  }

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.BILL_SETTLED,
    entityType: "payment_voucher",
    entityId: input.voucherId,
    newValues: {
      voucherNo: row.voucher_no,
      bills: input.allocations.length,
      total: input.allocations.reduce((sum, a) => sum + parseAmount(a.amount), 0n).toString(),
    },
  });
}

/** Offsets a posted supplier credit note against a bill from the same supplier. */
export async function applySupplierCreditNote(
  db: Executor,
  principal: Principal,
  input: { creditNoteId: string; billId: string; amount: string },
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.bill.settle");

  const amount = parseAmount(input.amount);
  if (amount <= 0n) {
    throw new ValidationError("A credit has to be for more than nothing.", "amount");
  }

  await db.execute(sql`
    INSERT INTO accounting.payable_settlement
      (supplier_invoice_id, source_type, credit_note_id, amount, settled_by)
    VALUES (${input.billId}, 'credit_note', ${input.creditNoteId}, ${amountToSql(amount)},
            ${principal.userId})
    ON CONFLICT (supplier_invoice_id, credit_note_id) WHERE credit_note_id IS NOT NULL
    DO UPDATE SET amount = EXCLUDED.amount, settled_at = now(), settled_by = EXCLUDED.settled_by
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.BILL_SETTLED,
    entityType: "supplier_invoice",
    entityId: input.billId,
    newValues: { source: "credit_note", creditNoteId: input.creditNoteId, amount: input.amount },
  });
}

export async function removeSettlement(
  db: Executor,
  principal: Principal,
  settlementId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.bill.settle");

  const trimmed = reason?.trim();
  if (!trimmed) {
    throw new ValidationError("Say why the settlement is being removed.", "reason");
  }

  const existing = await db.execute<{
    supplier_invoice_id: string;
    amount: string;
    source_type: string;
  }>(sql`
    SELECT supplier_invoice_id, amount::text AS amount, source_type
      FROM accounting.payable_settlement WHERE id = ${settlementId}
  `);
  const row = existing.rows?.[0];
  if (!row) throw new NotFoundError("That settlement no longer exists.");

  await db.execute(sql`DELETE FROM accounting.payable_settlement WHERE id = ${settlementId}`);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.BILL_UNSETTLED,
    entityType: "supplier_invoice",
    entityId: row.supplier_invoice_id,
    reason: trimmed,
    oldValues: { amount: row.amount, sourceType: row.source_type },
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface SupplierInvoiceView {
  id: string;
  billNo: string | null;
  kind: string;
  supplierId: string;
  supplierName: string;
  supplierCode: string;
  supplierDocNo: string;
  billDate: string;
  dueDate: string;
  receivedDate: string;
  subject: string | null;
  notes: string | null;
  status: SupplierInvoiceStatus;
  subtotal: Amount;
  discountTotal: Amount;
  taxTotal: Amount;
  total: Amount;
  amountSettled: Amount;
  outstanding: Amount;
  journalId: string | null;
  journalNo: string | null;
  creditsBillId: string | null;
  createdBy: string;
  lines: Awaited<ReturnType<typeof readDocumentLines>>;
}

export async function getSupplierInvoice(
  db: Executor,
  billId: string,
): Promise<SupplierInvoiceView | null> {
  const result = await db.execute<Record<string, string | null>>(sql`
    SELECT b.id, b.bill_no, b.kind, b.supplier_id, b.supplier_doc_no,
           b.bill_date::text AS bill_date, b.due_date::text AS due_date,
           b.received_date::text AS received_date, b.subject, b.notes, b.status,
           b.subtotal::text AS subtotal, b.discount_total::text AS discount_total,
           b.tax_total::text AS tax_total, b.total::text AS total,
           b.amount_settled::text AS amount_settled, b.journal_id, b.credits_bill_id, b.created_by,
           s.name AS supplier_name, s.code AS supplier_code, j.journal_no
      FROM accounting.supplier_invoice b
      JOIN accounting.supplier s ON s.id = b.supplier_id
      LEFT JOIN accounting.journal j ON j.id = b.journal_id
     WHERE b.id = ${billId}
  `);
  const row = result.rows?.[0];
  if (!row) return null;

  const total = parseAmount(row.total!);
  const settled = parseAmount(row.amount_settled!);

  return {
    id: row.id!,
    billNo: row.bill_no,
    kind: row.kind!,
    supplierId: row.supplier_id!,
    supplierName: row.supplier_name!,
    supplierCode: row.supplier_code!,
    supplierDocNo: row.supplier_doc_no!,
    billDate: row.bill_date!,
    dueDate: row.due_date!,
    receivedDate: row.received_date!,
    subject: row.subject,
    notes: row.notes,
    status: row.status as SupplierInvoiceStatus,
    subtotal: parseAmount(row.subtotal!),
    discountTotal: parseAmount(row.discount_total!),
    taxTotal: parseAmount(row.tax_total!),
    total,
    amountSettled: settled,
    outstanding: total - settled,
    journalId: row.journal_id,
    journalNo: row.journal_no,
    creditsBillId: row.credits_bill_id,
    createdBy: row.created_by!,
    lines: await readDocumentLines(db, "supplier_invoice_line", "supplier_invoice_id", billId),
  };
}

export interface SupplierInvoiceRow {
  id: string;
  billNo: string | null;
  kind: string;
  supplierName: string;
  supplierDocNo: string;
  billDate: string;
  dueDate: string;
  status: SupplierInvoiceStatus;
  total: Amount;
  outstanding: Amount;
  overdueDays: number;
}

export async function listSupplierInvoices(
  db: Executor,
  options: {
    supplierId?: string;
    status?: SupplierInvoiceStatus;
    search?: string;
    onlyOutstanding?: boolean;
    limit?: number;
  } = {},
): Promise<SupplierInvoiceRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const search = options.search?.trim() ? `%${options.search.trim()}%` : null;

  const result = await db.execute<Record<string, string | null>>(sql`
    SELECT b.id, b.bill_no, b.kind, b.supplier_doc_no, b.bill_date::text AS bill_date,
           b.due_date::text AS due_date, b.status, b.total::text AS total,
           b.amount_settled::text AS amount_settled, s.name AS supplier_name,
           GREATEST(0, (CURRENT_DATE - b.due_date))::text AS overdue_days
      FROM accounting.supplier_invoice b
      JOIN accounting.supplier s ON s.id = b.supplier_id
     WHERE (${options.supplierId ?? null}::uuid IS NULL OR b.supplier_id = ${options.supplierId ?? null}::uuid)
       AND (${options.status ?? null}::text IS NULL OR b.status = ${options.status ?? null})
       AND (${search}::text IS NULL
            OR b.bill_no ILIKE ${search} OR b.supplier_doc_no ILIKE ${search}
            OR s.name ILIKE ${search} OR b.subject ILIKE ${search})
       AND (NOT ${options.onlyOutstanding ?? false}
            OR (b.status IN ('posted', 'settled') AND b.amount_settled < b.total))
     ORDER BY b.bill_date DESC, b.created_at DESC
     LIMIT ${limit}
  `);

  return (result.rows ?? []).map((row) => {
    const total = parseAmount(row.total!);
    const settled = parseAmount(row.amount_settled!);
    return {
      id: row.id!,
      billNo: row.bill_no,
      kind: row.kind!,
      supplierName: row.supplier_name!,
      supplierDocNo: row.supplier_doc_no!,
      billDate: row.bill_date!,
      dueDate: row.due_date!,
      status: row.status as SupplierInvoiceStatus,
      total,
      outstanding: total - settled,
      overdueDays:
        row.status === "posted" && total > settled ? Number(row.overdue_days ?? "0") : 0,
    };
  });
}

export async function listSettlements(
  db: Executor,
  billId: string,
): Promise<
  Array<{
    id: string;
    sourceType: string;
    reference: string | null;
    amount: Amount;
    settledAt: string;
  }>
> {
  const result = await db.execute<Record<string, string | null>>(sql`
    SELECT ps.id, ps.source_type, ps.amount::text AS amount, ps.settled_at::text AS settled_at,
           COALESCE(v.voucher_no, cn.bill_no) AS reference
      FROM accounting.payable_settlement ps
      LEFT JOIN accounting.payment_voucher v ON v.id = ps.voucher_id
      LEFT JOIN accounting.supplier_invoice cn ON cn.id = ps.credit_note_id
     WHERE ps.supplier_invoice_id = ${billId}
     ORDER BY ps.settled_at
  `);
  return (result.rows ?? []).map((row) => ({
    id: row.id!,
    sourceType: row.source_type!,
    reference: row.reference,
    amount: parseAmount(row.amount!),
    settledAt: row.settled_at!,
  }));
}

/**
 * What is outstanding to a supplier, oldest first.
 *
 * Used when settling: the person paying needs to see what they are paying against, and in the
 * order it fell due.
 */
export async function outstandingForSupplier(
  db: Executor,
  supplierId: string,
): Promise<SupplierInvoiceRow[]> {
  return listSupplierInvoices(db, { supplierId, onlyOutstanding: true, limit: 500 });
}
