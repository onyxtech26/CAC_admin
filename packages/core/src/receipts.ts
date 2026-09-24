import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { SYSTEM_ACCOUNTS } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, today, toIsoDate } from "./dates.js";
import { amountToSql, formatAmount, parseAmount, sumAmounts, type Amount } from "./money.js";
import { postSourceJournal, reverseJournal } from "./posting.js";
import { allocateDocumentNumber } from "./sequence.js";

/**
 * Money in, and matching it to what it pays for.
 *
 * Recording a receipt and allocating it are two separate acts, on purpose. Cash
 * frequently arrives before anyone knows which invoices it settles — a customer
 * pays a round figure against four invoices, or pays early without a reference.
 * Forcing the allocation at the moment of receipt is how payments end up guessed
 * at, and a guessed allocation is worse than none: it makes the statement wrong
 * for both invoices.
 *
 * **Allocation posts nothing to the ledger, and that is correct.** Issuing the
 * invoice debited trade receivables; posting the receipt credited it. The control
 * account is already right. Allocation is bookkeeping *within* receivables — it
 * says which invoice the money was for — and posting a journal for it would
 * double-count. The proof that this holds is the AR reconciliation: the sum of
 * outstanding invoices must equal the balance on account 1210, and
 * `reconcileReceivables` computes exactly that.
 */

export interface ReceiptInput {
  customerId: string;
  receiptDate?: string;
  method?: "cash" | "cheque" | "transfer" | "card" | "other";
  reference?: string | null;
  /** The bank or cash account the money landed in. Id or code. */
  depositAccountId?: string | null;
  depositAccountCode?: string | null;
  amount: string;
  notes?: string | null;
}

export interface ReceiptView {
  id: string;
  receiptNo: string | null;
  status: "draft" | "posted" | "void";
  customerId: string;
  customerName: string;
  customerCode: string;
  receiptDate: string;
  method: string;
  reference: string | null;
  depositAccountId: string;
  depositAccountCode: string;
  depositAccountName: string;
  amount: Amount;
  amountAllocated: Amount;
  unallocated: Amount;
  notes: string | null;
  journalId: string | null;
  journalNo: string | null;
  voidReason: string | null;
  createdByName: string | null;
  postedByName: string | null;
  postedAt: Date | string | null;
  createdAt: Date | string;
  allocations: AllocationRow[];
}

export interface AllocationRow {
  id: string;
  invoiceId: string;
  invoiceNo: string | null;
  invoiceDate: string;
  invoiceTotal: Amount;
  invoiceOutstanding: Amount;
  amount: Amount;
  allocatedAt: Date | string;
  allocatedByName: string | null;
  sourceType: "receipt" | "credit_note";
}

export async function createReceipt(
  db: Executor,
  principal: Principal,
  input: ReceiptInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.receipt.create");

  const customer = await requireCustomer(db, input.customerId);
  const date = toIsoDate(input.receiptDate ? parseIsoDate(input.receiptDate, "receiptDate") : today());
  const amount = parseAmount(input.amount, "amount");
  if (amount <= 0n) throw new ValidationError("Enter the amount received.", "amount");

  const deposit = await requireDepositAccount(db, input);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.receipt
      (customer_id, receipt_date, method, reference, deposit_account_id, amount, notes, created_by)
    VALUES (${customer.id}, ${date}, ${input.method ?? "transfer"}, ${input.reference?.trim() || null},
            ${deposit.id}, ${amountToSql(amount)}, ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.RECEIPT_CREATED,
    entityType: "receipt",
    entityId: id,
    newValues: {
      customer: customer.name,
      date,
      amount: amountToSql(amount),
      method: input.method ?? "transfer",
      into: deposit.code,
    },
  });

  return { id };
}

export async function updateReceipt(
  db: Executor,
  principal: Principal,
  receiptId: string,
  input: ReceiptInput,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.receipt.create");

  const receipt = await lockReceipt(db, receiptId);
  if (receipt.status !== "draft") {
    throw new ConflictError(`This receipt is ${receipt.status} and cannot be changed. Void it instead.`);
  }

  const customer = await requireCustomer(db, input.customerId);
  const date = toIsoDate(input.receiptDate ? parseIsoDate(input.receiptDate) : today());
  const amount = parseAmount(input.amount, "amount");
  if (amount <= 0n) throw new ValidationError("Enter the amount received.", "amount");
  const deposit = await requireDepositAccount(db, input);

  await db.execute(sql`
    UPDATE accounting.receipt
       SET customer_id = ${customer.id}, receipt_date = ${date}, method = ${input.method ?? "transfer"},
           reference = ${input.reference?.trim() || null}, deposit_account_id = ${deposit.id},
           amount = ${amountToSql(amount)}, notes = ${input.notes?.trim() || null},
           updated_by = ${principal.userId}
     WHERE id = ${receiptId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.RECEIPT_UPDATED,
    entityType: "receipt",
    entityId: receiptId,
    oldValues: { amount: receipt.amount },
    newValues: { customer: customer.name, amount: amountToSql(amount) },
  });
}

export async function deleteReceipt(
  db: Executor,
  principal: Principal,
  receiptId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "accounting.receipt.create");

  const receipt = await lockReceipt(db, receiptId);
  if (receipt.status !== "draft") {
    throw new ConflictError(`This receipt is ${receipt.status} and cannot be deleted.`);
  }

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.RECEIPT_DELETED,
    entityType: "receipt",
    entityId: receiptId,
    oldValues: { amount: receipt.amount, status: receipt.status },
    reason: options.reason ?? null,
  });

  await db.execute(sql`DELETE FROM accounting.receipt WHERE id = ${receiptId}`);
}

/**
 * Posts the receipt: number, and the ledger entry that says the money is in.
 *
 *   Dr  bank or cash
 *     Cr  trade receivables
 *
 * The credit hits the control account whether or not the receipt has been matched
 * to invoices yet, because the customer owes that much less either way.
 */
export async function postReceipt(
  db: Executor,
  principal: Principal,
  receiptId: string,
  context?: AuditContext,
): Promise<{ receiptNo: string; journalNo: string }> {
  requireCapability(principal, "accounting.receipt.approve");

  const receipt = await lockReceipt(db, receiptId);
  if (receipt.status !== "draft") throw new ConflictError(`This receipt is already ${receipt.status}.`);

  const date = String(receipt.receipt_date).slice(0, 10);
  const receiptNo = await allocateDocumentNumber(db, "receipt", { on: date });

  const customer = await db.execute<{ name: string; code: string }>(
    sql`SELECT name, code FROM accounting.customer WHERE id = ${receipt.customer_id}`,
  );
  const deposit = await db.execute<{ code: string }>(
    sql`SELECT code FROM accounting.account WHERE id = ${receipt.deposit_account_id}`,
  );

  const journal = await postSourceJournal(
    db,
    principal,
    {
      entryDate: date,
      memo: `Receipt ${receiptNo} — ${customer.rows![0]!.name}`,
      sourceType: "receipt",
      sourceId: receiptId,
      authorisedBy: "accounting.receipt.approve",
      lines: [
        {
          accountId: receipt.deposit_account_id,
          debit: receipt.amount,
          description: `${receipt.method}${receipt.reference ? ` ${receipt.reference}` : ""}`,
        },
        {
          accountCode: SYSTEM_ACCOUNTS.receivableControl,
          credit: receipt.amount,
          description: `${customer.rows![0]!.code} ${customer.rows![0]!.name}`,
        },
      ],
    },
    context,
  );

  await db.execute(sql`
    UPDATE accounting.receipt
       SET status = 'posted', receipt_no = ${receiptNo}, journal_id = ${journal.id},
           posted_at = now(), posted_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${receiptId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.RECEIPT_POSTED,
    entityType: "receipt",
    entityId: receiptId,
    newValues: {
      receiptNo,
      journalNo: journal.journalNo,
      amount: receipt.amount,
      into: deposit.rows![0]!.code,
    },
  });

  return { receiptNo, journalNo: journal.journalNo };
}

/**
 * Voids a posted receipt — a bounced cheque, or money recorded against the wrong
 * customer. Allocations must be removed first: leaving them would credit invoices
 * with money that is no longer there.
 */
export async function voidReceipt(
  db: Executor,
  principal: Principal,
  receiptId: string,
  options: { reason: string; context?: AuditContext },
): Promise<{ journalNo: string }> {
  requireCapability(principal, "accounting.receipt.approve");

  const reason = options.reason?.trim();
  if (!reason) throw new ValidationError("A void needs a reason.", "reason");

  const receipt = await lockReceipt(db, receiptId);
  if (receipt.status !== "posted") {
    throw new ConflictError(`This receipt is ${receipt.status} and cannot be voided.`);
  }
  if (parseAmount(receipt.amount_allocated) > 0n) {
    throw new ConflictError(
      `${receipt.receipt_no} has ${formatAmount(parseAmount(receipt.amount_allocated), { currency: "RM" })} ` +
        "allocated to invoices. Remove those allocations first.",
    );
  }
  if (!receipt.journal_id) throw new ConflictError("This receipt has no ledger entry to reverse.");

  const reversal = await reverseJournal(db, principal, receipt.journal_id, {
    reason: `Receipt ${receipt.receipt_no} voided: ${reason}`,
    context: options.context,
  });

  await db.execute(sql`
    UPDATE accounting.receipt
       SET status = 'void', void_journal_id = ${reversal.journalId}, void_reason = ${reason},
           voided_at = now(), voided_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${receiptId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.RECEIPT_VOIDED,
    entityType: "receipt",
    entityId: receiptId,
    oldValues: { receiptNo: receipt.receipt_no, amount: receipt.amount },
    newValues: { status: "void", reversalJournal: reversal.journalNo },
    reason,
  });

  return { journalNo: reversal.journalNo };
}

export interface AllocationRequest {
  invoiceId: string;
  amount: string;
}

/**
 * Matches a posted receipt against invoices.
 *
 * Replaces the receipt's allocations wholesale rather than adding to them, which
 * makes the screen a plain statement of "this payment settles these invoices, in
 * these amounts" and removes any question of what a second submission does.
 *
 * The over-allocation checks are in the database trigger as well, with the rows
 * locked, so two people splitting the same receipt at the same moment cannot both
 * succeed.
 */
export async function allocateReceipt(
  db: Executor,
  principal: Principal,
  receiptId: string,
  requests: AllocationRequest[],
  context?: AuditContext,
): Promise<{ allocated: Amount }> {
  requireCapability(principal, "accounting.receipt.allocate");

  const receipt = await lockReceipt(db, receiptId);
  if (receipt.status !== "posted") {
    throw new ConflictError(
      receipt.status === "draft"
        ? "Post the receipt before allocating it — until then the money is not in the ledger."
        : "A voided receipt cannot be allocated.",
    );
  }

  const wanted = requests
    .map((request) => ({ invoiceId: request.invoiceId, amount: parseAmount(request.amount || "0") }))
    .filter((request) => request.amount > 0n);

  const total = sumAmounts(wanted.map((request) => request.amount));
  const receiptAmount = parseAmount(receipt.amount);
  if (total > receiptAmount) {
    throw new ValidationError(
      `That allocates ${formatAmount(total)} from a receipt of ${formatAmount(receiptAmount)}.`,
      "allocations",
    );
  }

  await db.execute(sql`DELETE FROM accounting.allocation WHERE receipt_id = ${receiptId}`);

  for (const request of wanted) {
    await db.execute(sql`
      INSERT INTO accounting.allocation (invoice_id, source_type, receipt_id, amount, allocated_by)
      VALUES (${request.invoiceId}, 'receipt', ${receiptId}, ${amountToSql(request.amount)}, ${principal.userId})
    `);
  }

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ALLOCATION_ADDED,
    entityType: "receipt",
    entityId: receiptId,
    newValues: {
      receiptNo: receipt.receipt_no,
      allocated: amountToSql(total),
      unallocated: amountToSql(receiptAmount - total),
      invoices: wanted.length,
    },
  });

  return { allocated: total };
}

/**
 * Suggests an allocation: oldest invoice first, until the money runs out.
 *
 * A suggestion only — it is returned for the user to confirm, not written. Which
 * invoice a payment is for is the customer's intention, and oldest-first is a
 * convention, not a fact. Guessing silently is how a disputed invoice gets marked
 * paid from money meant for another one.
 */
export async function suggestAllocation(
  db: Executor,
  receiptId: string,
): Promise<AllocationRequest[]> {
  const receipt = await db.execute<{ customer_id: string; amount: string; amount_allocated: string }>(
    sql`SELECT customer_id, amount, amount_allocated FROM accounting.receipt WHERE id = ${receiptId}`,
  );
  const row = receipt.rows?.[0];
  if (!row) throw new NotFoundError("That receipt no longer exists.");

  const open = await db.execute<{ id: string; outstanding: string }>(sql`
    SELECT id, (total - amount_allocated)::text AS outstanding
      FROM accounting.invoice
     WHERE customer_id = ${row.customer_id} AND kind = 'invoice'
       AND status IN ('issued', 'paid') AND total > amount_allocated
     ORDER BY due_date, invoice_date, invoice_no
  `);

  let remaining = parseAmount(row.amount);
  const suggestion: AllocationRequest[] = [];

  for (const invoice of open.rows ?? []) {
    if (remaining <= 0n) break;
    const outstanding = parseAmount(invoice.outstanding);
    const take = outstanding < remaining ? outstanding : remaining;
    suggestion.push({ invoiceId: invoice.id, amount: amountToSql(take) });
    remaining -= take;
  }

  return suggestion;
}

/** Applies a credit note to an invoice. Same rules, different source. */
export async function allocateCreditNote(
  db: Executor,
  principal: Principal,
  creditNoteId: string,
  requests: AllocationRequest[],
  context?: AuditContext,
): Promise<{ allocated: Amount }> {
  requireCapability(principal, "accounting.receipt.allocate");

  const note = await db.execute<{ status: string; invoice_no: string | null; total: string }>(
    sql`SELECT status, invoice_no, total FROM accounting.invoice
         WHERE id = ${creditNoteId} AND kind = 'credit_note' FOR UPDATE`,
  );
  const creditNote = note.rows?.[0];
  if (!creditNote) throw new NotFoundError("That credit note no longer exists.");
  if (creditNote.status !== "issued" && creditNote.status !== "paid") {
    throw new ConflictError(`Issue the credit note before applying it; it is ${creditNote.status}.`);
  }

  const wanted = requests
    .map((request) => ({ invoiceId: request.invoiceId, amount: parseAmount(request.amount || "0") }))
    .filter((request) => request.amount > 0n);
  const total = sumAmounts(wanted.map((request) => request.amount));

  if (total > parseAmount(creditNote.total)) {
    throw new ValidationError(
      `That applies ${formatAmount(total)} from a credit note worth ${formatAmount(parseAmount(creditNote.total))}.`,
      "allocations",
    );
  }

  await db.execute(sql`DELETE FROM accounting.allocation WHERE credit_note_id = ${creditNoteId}`);
  for (const request of wanted) {
    await db.execute(sql`
      INSERT INTO accounting.allocation (invoice_id, source_type, credit_note_id, amount, allocated_by)
      VALUES (${request.invoiceId}, 'credit_note', ${creditNoteId}, ${amountToSql(request.amount)}, ${principal.userId})
    `);
  }

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ALLOCATION_ADDED,
    entityType: "invoice",
    entityId: creditNoteId,
    newValues: { creditNote: creditNote.invoice_no, applied: amountToSql(total), invoices: wanted.length },
  });

  return { allocated: total };
}

export async function removeAllocation(
  db: Executor,
  principal: Principal,
  allocationId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "accounting.receipt.allocate");

  const found = await db.execute<{
    invoice_id: string;
    invoice_no: string | null;
    amount: string;
    receipt_id: string | null;
    credit_note_id: string | null;
  }>(sql`
    SELECT al.invoice_id, i.invoice_no, al.amount, al.receipt_id, al.credit_note_id
      FROM accounting.allocation al
      JOIN accounting.invoice i ON i.id = al.invoice_id
     WHERE al.id = ${allocationId}
  `);
  const allocation = found.rows?.[0];
  if (!allocation) throw new NotFoundError("That allocation no longer exists.");

  await db.execute(sql`DELETE FROM accounting.allocation WHERE id = ${allocationId}`);

  // Audited against the source, matching where the allocation was made, so that
  // reading a receipt's history shows its allocations appearing and disappearing.
  // The invoice it touched is in the payload.
  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ALLOCATION_REMOVED,
    entityType: allocation.receipt_id ? "receipt" : "invoice",
    entityId: allocation.receipt_id ?? allocation.credit_note_id,
    oldValues: {
      amount: allocation.amount,
      invoiceId: allocation.invoice_id,
      invoiceNo: allocation.invoice_no,
    },
    reason: options.reason ?? null,
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type LockedReceipt = {
  status: "draft" | "posted" | "void";
  receipt_no: string | null;
  customer_id: string;
  receipt_date: string;
  method: string;
  reference: string | null;
  deposit_account_id: string;
  amount: string;
  amount_allocated: string;
  journal_id: string | null;
};

async function lockReceipt(db: Executor, receiptId: string): Promise<LockedReceipt> {
  const result = await db.execute<LockedReceipt>(sql`
    SELECT status, receipt_no, customer_id, receipt_date, method, reference,
           deposit_account_id, amount, amount_allocated, journal_id
      FROM accounting.receipt WHERE id = ${receiptId} FOR UPDATE
  `);
  const receipt = result.rows?.[0];
  if (!receipt) throw new NotFoundError("That receipt no longer exists.");
  return receipt;
}

async function requireCustomer(db: Executor, customerId: string): Promise<{ id: string; name: string }> {
  if (!customerId) throw new ValidationError("Choose a customer.", "customerId");
  const result = await db.execute<{ id: string; name: string }>(
    sql`SELECT id, name FROM accounting.customer WHERE id = ${customerId}`,
  );
  const customer = result.rows?.[0];
  if (!customer) throw new ValidationError("That customer no longer exists.", "customerId");
  return customer;
}

async function requireDepositAccount(
  db: Executor,
  input: ReceiptInput,
): Promise<{ id: string; code: string }> {
  const identifier = input.depositAccountId || input.depositAccountCode;
  if (!identifier) {
    throw new ValidationError("Choose the account the money went into.", "depositAccountId");
  }

  const result = await db.execute<{ id: string; code: string; subtype: string | null; is_active: boolean }>(
    input.depositAccountId
      ? sql`SELECT id, code, subtype, is_active FROM accounting.account WHERE id = ${input.depositAccountId}`
      : sql`SELECT id, code, subtype, is_active FROM accounting.account WHERE code = ${input.depositAccountCode}`,
  );
  const account = result.rows?.[0];
  if (!account) throw new ValidationError("That account does not exist.", "depositAccountId");
  if (!account.is_active) throw new ValidationError("That account is no longer in use.", "depositAccountId");

  // Money received lands in a bank or cash account. Anything else is a sign the
  // wrong account was picked from a long list.
  if (account.subtype !== "bank" && account.subtype !== "cash") {
    throw new ValidationError(
      `${account.code} is not a bank or cash account. Money received has to land in one.`,
      "depositAccountId",
    );
  }

  return { id: account.id, code: account.code };
}

export async function getReceipt(db: Executor, receiptId: string): Promise<ReceiptView | null> {
  const result = await db.execute<Record<string, never>>(sql`
    SELECT r.*, c.name AS customer_name, c.code AS customer_code,
           a.code AS deposit_code, a.name AS deposit_name, j.journal_no,
           cb.full_name AS created_by_name, pb.full_name AS posted_by_name
      FROM accounting.receipt r
      JOIN accounting.customer c ON c.id = r.customer_id
      JOIN accounting.account a ON a.id = r.deposit_account_id
      LEFT JOIN accounting.journal j ON j.id = r.journal_id
      LEFT JOIN auth."user" cb ON cb.id = r.created_by
      LEFT JOIN auth."user" pb ON pb.id = r.posted_by
     WHERE r.id = ${receiptId}
  `);
  const row = result.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  const amount = parseAmount(String(row.amount));
  const allocated = parseAmount(String(row.amount_allocated));

  return {
    id: String(row.id),
    receiptNo: (row.receipt_no as string) ?? null,
    status: row.status as ReceiptView["status"],
    customerId: String(row.customer_id),
    customerName: String(row.customer_name),
    customerCode: String(row.customer_code),
    receiptDate: String(row.receipt_date).slice(0, 10),
    method: String(row.method),
    reference: (row.reference as string) ?? null,
    depositAccountId: String(row.deposit_account_id),
    depositAccountCode: String(row.deposit_code),
    depositAccountName: String(row.deposit_name),
    amount,
    amountAllocated: allocated,
    unallocated: amount - allocated,
    notes: (row.notes as string) ?? null,
    journalId: (row.journal_id as string) ?? null,
    journalNo: (row.journal_no as string) ?? null,
    voidReason: (row.void_reason as string) ?? null,
    createdByName: (row.created_by_name as string) ?? null,
    postedByName: (row.posted_by_name as string) ?? null,
    postedAt: (row.posted_at as Date | string) ?? null,
    createdAt: row.created_at as Date | string,
    allocations: await listAllocations(db, { receiptId }),
  };
}

export async function listAllocations(
  db: Executor,
  filter: { receiptId?: string; invoiceId?: string; creditNoteId?: string },
): Promise<AllocationRow[]> {
  const where = filter.receiptId
    ? sql`al.receipt_id = ${filter.receiptId}`
    : filter.creditNoteId
      ? sql`al.credit_note_id = ${filter.creditNoteId}`
      : sql`al.invoice_id = ${filter.invoiceId ?? null}`;

  const result = await db.execute<{
    id: string;
    invoice_id: string;
    invoice_no: string | null;
    invoice_date: string;
    invoice_total: string;
    invoice_outstanding: string;
    amount: string;
    allocated_at: Date | string;
    allocated_by_name: string | null;
    source_type: "receipt" | "credit_note";
  }>(sql`
    SELECT al.id, al.invoice_id, i.invoice_no, i.invoice_date, i.total AS invoice_total,
           (i.total - i.amount_allocated)::text AS invoice_outstanding,
           al.amount, al.allocated_at, u.full_name AS allocated_by_name, al.source_type
      FROM accounting.allocation al
      JOIN accounting.invoice i ON i.id = al.invoice_id
      LEFT JOIN auth."user" u ON u.id = al.allocated_by
     WHERE ${where}
     ORDER BY i.invoice_date, i.invoice_no
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    invoiceId: row.invoice_id,
    invoiceNo: row.invoice_no,
    invoiceDate: String(row.invoice_date).slice(0, 10),
    invoiceTotal: parseAmount(row.invoice_total),
    invoiceOutstanding: parseAmount(row.invoice_outstanding),
    amount: parseAmount(row.amount),
    allocatedAt: row.allocated_at,
    allocatedByName: row.allocated_by_name,
    sourceType: row.source_type,
  }));
}

export interface ReceiptSummary {
  id: string;
  receiptNo: string | null;
  status: "draft" | "posted" | "void";
  customerName: string;
  receiptDate: string;
  method: string;
  reference: string | null;
  amount: Amount;
  unallocated: Amount;
}

export async function listReceipts(
  db: Executor,
  filters: {
    status?: "draft" | "posted" | "void";
    customerId?: string;
    unallocatedOnly?: boolean;
    search?: string;
    limit?: number;
  } = {},
): Promise<ReceiptSummary[]> {
  const where = [sql`true`];
  if (filters.status) where.push(sql`r.status = ${filters.status}`);
  if (filters.customerId) where.push(sql`r.customer_id = ${filters.customerId}`);
  if (filters.unallocatedOnly) where.push(sql`r.status = 'posted' AND r.amount > r.amount_allocated`);
  if (filters.search?.trim()) {
    const term = `%${filters.search.trim().toLowerCase()}%`;
    where.push(
      sql`(lower(coalesce(r.receipt_no, '')) LIKE ${term} OR lower(coalesce(r.reference, '')) LIKE ${term} OR lower(c.name) LIKE ${term})`,
    );
  }

  const result = await db.execute<{
    id: string;
    receipt_no: string | null;
    status: ReceiptSummary["status"];
    customer_name: string;
    receipt_date: string;
    method: string;
    reference: string | null;
    amount: string;
    unallocated: string;
  }>(sql`
    SELECT r.id, r.receipt_no, r.status, c.name AS customer_name, r.receipt_date, r.method,
           r.reference, r.amount, (r.amount - r.amount_allocated)::text AS unallocated
      FROM accounting.receipt r
      JOIN accounting.customer c ON c.id = r.customer_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY r.receipt_date DESC, r.receipt_no DESC NULLS FIRST, r.created_at DESC
     LIMIT ${Math.min(Math.max(filters.limit ?? 100, 1), 500)}
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    receiptNo: row.receipt_no,
    status: row.status,
    customerName: row.customer_name,
    receiptDate: String(row.receipt_date).slice(0, 10),
    method: row.method,
    reference: row.reference,
    amount: parseAmount(row.amount),
    unallocated: parseAmount(row.unallocated),
  }));
}
