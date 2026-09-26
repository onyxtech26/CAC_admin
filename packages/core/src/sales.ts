import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { SYSTEM_ACCOUNTS } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, requireDifferentApprover, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { addDays, parseIsoDate, today, toIsoDate } from "./dates.js";
import { amountToSql, formatAmount, parseAmount, type Amount } from "./money.js";
import {
  computeDocumentLines,
  readDocumentLines,
  writeDocumentLines,
  type DocumentLineInput,
  type StoredLine,
} from "./documents.js";
import { postSourceJournal, reverseJournal } from "./posting.js";
import { allocateDocumentNumber } from "./sequence.js";
import { getSetting } from "./settings.js";

/**
 * Quotations, invoices and credit notes.
 *
 * The lifecycle is the point of this module, and it is deliberately not one step:
 *
 *   draft -> pending_approval -> approved -> issued
 *
 * Each arrow is a different act by a possibly different person. Drafting is
 * clerical. Approval is a commitment, and the person who approves may not be the
 * person who drafted it. Issuing is what reaches the customer *and* the ledger —
 * the revenue and the receivable are recognised at that moment and not before,
 * which is why a draft invoice appears in no report.
 *
 * Above a configured amount, approval needs `accounting.invoice.approve_high_value`
 * rather than `accounting.invoice.approve`. While that amount is unset, every
 * invoice needs the higher one. That is the conservative reading of an unanswered
 * question, not a guess at the answer: see Q-FIN-3.
 *
 * An issued invoice is never edited. It is voided — which posts a reversing
 * journal and keeps both entries visible — or credited with a credit note. Both
 * leave a record of what was sent to the customer, which is the only version that
 * matters in a dispute.
 */

export type InvoiceStatus = "draft" | "pending_approval" | "approved" | "issued" | "paid" | "void";
export type QuotationStatus = "draft" | "sent" | "accepted" | "declined" | "expired" | "converted";

export interface SalesDocumentInput {
  customerId: string;
  /** Defaults to today. */
  documentDate?: string;
  /** Invoices: defaults to the customer's payment terms. Quotations: validity. */
  dueDate?: string;
  reference?: string | null;
  subject?: string | null;
  notes?: string | null;
  terms?: string | null;
  lines: DocumentLineInput[];
}

export interface InvoiceView {
  id: string;
  invoiceNo: string | null;
  kind: "invoice" | "credit_note";
  status: InvoiceStatus;
  customerId: string;
  customerCode: string;
  customerName: string;
  customerAddress: string | null;
  customerTaxId: string | null;
  invoiceDate: string;
  dueDate: string;
  reference: string | null;
  subject: string | null;
  currency: string;
  subtotal: Amount;
  discountTotal: Amount;
  taxTotal: Amount;
  total: Amount;
  amountAllocated: Amount;
  outstanding: Amount;
  notes: string | null;
  terms: string | null;
  quotationId: string | null;
  quotationNo: string | null;
  journalId: string | null;
  journalNo: string | null;
  voidJournalId: string | null;
  voidReason: string | null;
  creditsInvoiceId: string | null;
  creditsInvoiceNo: string | null;
  createdBy: string;
  createdByName: string | null;
  submittedByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: Date | string | null;
  issuedByName: string | null;
  issuedAt: Date | string | null;
  voidedByName: string | null;
  createdAt: Date | string;
  lines: StoredLine[];
  /** Credit notes raised against this invoice. */
  creditNotes: Array<{ id: string; invoiceNo: string | null; total: Amount; status: InvoiceStatus }>;
}

// ---------------------------------------------------------------------------
// Quotations
// ---------------------------------------------------------------------------

export async function createQuotation(
  db: Executor,
  principal: Principal,
  input: SalesDocumentInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.quotation.create");

  const customer = await requireCustomer(db, input.customerId);
  const date = toIsoDate(input.documentDate ? parseIsoDate(input.documentDate, "documentDate") : today());
  const validityDays = await getSetting<number>(db, "accounting.quotation_validity_days", 30);
  const validUntil = input.dueDate
    ? toIsoDate(parseIsoDate(input.dueDate, "dueDate"))
    : toIsoDate(addDays(parseIsoDate(date), validityDays));

  const computed = await computeDocumentLines(db, input.lines, date);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.quotation
      (customer_id, quotation_date, valid_until, reference, subject, notes, terms, created_by)
    VALUES (${customer.id}, ${date}, ${validUntil}, ${input.reference?.trim() || null},
            ${input.subject?.trim() || null}, ${input.notes?.trim() || null},
            ${input.terms?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;
  await writeDocumentLines(db, "quotation_line", "quotation_id", id, computed.lines);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.QUOTATION_CREATED,
    entityType: "quotation",
    entityId: id,
    newValues: {
      customer: customer.name,
      date,
      validUntil,
      total: amountToSql(computed.totals.total),
      lines: computed.lines.length,
    },
  });

  return { id };
}

export async function updateQuotation(
  db: Executor,
  principal: Principal,
  quotationId: string,
  input: SalesDocumentInput,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.quotation.create");

  const existing = await db.execute<{ status: string; quotation_no: string | null; total: string }>(
    sql`SELECT status, quotation_no, total FROM accounting.quotation WHERE id = ${quotationId} FOR UPDATE`,
  );
  const quotation = existing.rows?.[0];
  if (!quotation) throw new NotFoundError("That quotation no longer exists.");
  if (quotation.status !== "draft") {
    throw new ConflictError(
      `This quotation has been ${quotation.status} and cannot be changed. Copy it into a new one instead.`,
    );
  }

  const customer = await requireCustomer(db, input.customerId);
  const date = toIsoDate(input.documentDate ? parseIsoDate(input.documentDate) : today());
  const validUntil = input.dueDate ? toIsoDate(parseIsoDate(input.dueDate, "dueDate")) : null;
  const computed = await computeDocumentLines(db, input.lines, date);

  await db.execute(sql`DELETE FROM accounting.quotation_line WHERE quotation_id = ${quotationId}`);
  await db.execute(sql`
    UPDATE accounting.quotation
       SET customer_id = ${customer.id}, quotation_date = ${date}, valid_until = ${validUntil},
           reference = ${input.reference?.trim() || null}, subject = ${input.subject?.trim() || null},
           notes = ${input.notes?.trim() || null}, terms = ${input.terms?.trim() || null},
           updated_by = ${principal.userId}
     WHERE id = ${quotationId}
  `);
  await writeDocumentLines(db, "quotation_line", "quotation_id", quotationId, computed.lines);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.QUOTATION_UPDATED,
    entityType: "quotation",
    entityId: quotationId,
    oldValues: { total: quotation.total },
    newValues: { customer: customer.name, total: amountToSql(computed.totals.total) },
  });
}

/** Numbers the quotation and marks it sent. From here its contents are fixed. */
export async function sendQuotation(
  db: Executor,
  principal: Principal,
  quotationId: string,
  context?: AuditContext,
): Promise<{ quotationNo: string }> {
  requireCapability(principal, "accounting.quotation.create");

  const existing = await db.execute<{
    status: string;
    quotation_date: string;
    total: string;
    quotation_no: string | null;
  }>(sql`
    SELECT status, quotation_date, total, quotation_no
      FROM accounting.quotation WHERE id = ${quotationId} FOR UPDATE
  `);
  const quotation = existing.rows?.[0];
  if (!quotation) throw new NotFoundError("That quotation no longer exists.");
  if (quotation.status !== "draft") throw new ConflictError(`This quotation is already ${quotation.status}.`);
  if (parseAmount(quotation.total) <= 0n) {
    throw new ValidationError("A quotation for nothing cannot be sent.", "lines");
  }

  const date = String(quotation.quotation_date).slice(0, 10);
  const quotationNo = quotation.quotation_no ?? (await allocateDocumentNumber(db, "quotation", { on: date }));

  await db.execute(sql`
    UPDATE accounting.quotation
       SET status = 'sent', quotation_no = ${quotationNo}, sent_at = now(), updated_by = ${principal.userId}
     WHERE id = ${quotationId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.QUOTATION_SENT,
    entityType: "quotation",
    entityId: quotationId,
    newValues: { quotationNo, total: quotation.total },
  });

  return { quotationNo };
}

/**
 * Records the customer's answer to a quotation.
 *
 * Gated on `accounting.quotation.approve`, and acceptance needs somebody other than the person who
 * raised it. Both were declared and neither was true: this required
 * `accounting.quotation.create` and called no `requireDifferentApprover`, so the person who wrote a
 * quotation could accept it and convert it into a draft invoice without anybody else touching it —
 * while `rbac.ts` listed the pair in `MAKER_CHECKER_PAIRS` and `RBAC_MATRIX.md` handed out
 * `quotation.approve` selectively. The capability gated nothing at all.
 *
 * The second-person rule applies to acceptance rather than to both, because that is the decision that
 * turns into money: an accepted quotation converts to an invoice. A decline closes it and needs the
 * same capability, since it is the same set of people, but not a second pair of hands.
 */
export async function decideQuotation(
  db: Executor,
  principal: Principal,
  quotationId: string,
  decision: "accepted" | "declined",
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "accounting.quotation.approve");

  const existing = await db.execute<{
    status: string;
    quotation_no: string | null;
    created_by: string;
    valid_until: string | null;
  }>(
    sql`SELECT status, quotation_no, created_by, valid_until
          FROM accounting.quotation WHERE id = ${quotationId} FOR UPDATE`,
  );
  const quotation = existing.rows?.[0];
  if (!quotation) throw new NotFoundError("That quotation no longer exists.");
  if (quotation.status !== "sent") {
    throw new ConflictError(`Only a sent quotation can be marked ${decision}; this one is ${quotation.status}.`);
  }

  if (decision === "accepted") {
    requireDifferentApprover({
      principal,
      createdByUserId: quotation.created_by,
      action: "accept",
    });

    // An offer that has lapsed is not an offer. `valid_until` was computed, stored and displayed, and
    // read by nothing: a quotation that expired a year ago could be accepted and converted at the
    // price it carried then.
    const validUntil = quotation.valid_until ? String(quotation.valid_until).slice(0, 10) : null;
    if (validUntil && validUntil < toIsoDate(today())) {
      throw new ConflictError(
        `${quotation.quotation_no ?? "That quotation"} was valid until ${validUntil} and has lapsed. ` +
          "Raise a new one at today's prices rather than accepting the old figure.",
      );
    }
  }

  await db.execute(sql`
    UPDATE accounting.quotation
       SET status = ${decision}, decided_at = now(), updated_by = ${principal.userId}
     WHERE id = ${quotationId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: decision === "accepted" ? AUDIT.QUOTATION_ACCEPTED : AUDIT.QUOTATION_DECLINED,
    entityType: "quotation",
    entityId: quotationId,
    newValues: { quotationNo: quotation.quotation_no, decision },
    reason: options.reason ?? null,
  });
}

/**
 * Turns an accepted quotation into a draft invoice.
 *
 * Lines are copied, not shared. Editing the invoice afterwards must not rewrite
 * what the customer was quoted — the quotation is the offer that was accepted and
 * stays exactly as it was.
 */
export async function convertQuotationToInvoice(
  db: Executor,
  principal: Principal,
  quotationId: string,
  context?: AuditContext,
): Promise<{ invoiceId: string }> {
  requireCapability(principal, "accounting.quotation.convert");
  requireCapability(principal, "accounting.invoice.create");

  const existing = await db.execute<{
    status: string;
    quotation_no: string | null;
    customer_id: string;
    reference: string | null;
    subject: string | null;
    notes: string | null;
    terms: string | null;
    converted_invoice_id: string | null;
  }>(sql`
    SELECT status, quotation_no, customer_id, reference, subject, notes, terms, converted_invoice_id
      FROM accounting.quotation WHERE id = ${quotationId} FOR UPDATE
  `);
  const quotation = existing.rows?.[0];
  if (!quotation) throw new NotFoundError("That quotation no longer exists.");
  if (quotation.converted_invoice_id) {
    throw new ConflictError(`${quotation.quotation_no} has already been converted to an invoice.`);
  }
  if (quotation.status !== "accepted") {
    throw new ConflictError(
      `Only an accepted quotation can be converted. Mark ${quotation.quotation_no ?? "it"} accepted first.`,
    );
  }

  const lines = await readDocumentLines(db, "quotation_line", "quotation_id", quotationId);
  const { id: invoiceId } = await createInvoice(
    db,
    principal,
    {
      customerId: quotation.customer_id,
      reference: quotation.reference,
      subject: quotation.subject,
      notes: quotation.notes,
      terms: quotation.terms,
      lines: lines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: amountToSql(line.unitPrice),
        discountPercent: line.discountPercent,
        discountAmount: line.discountPercent ? null : amountToSql(line.discountAmount),
        taxCodeId: line.taxCodeId,
        accountId: line.accountId,
        caseId: line.caseId,
      })),
    },
    context,
  );

  await db.execute(sql`
    UPDATE accounting.invoice SET quotation_id = ${quotationId} WHERE id = ${invoiceId}
  `);
  await db.execute(sql`
    UPDATE accounting.quotation
       SET status = 'converted', converted_invoice_id = ${invoiceId}, updated_by = ${principal.userId}
     WHERE id = ${quotationId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.QUOTATION_CONVERTED,
    entityType: "quotation",
    entityId: quotationId,
    newValues: { quotationNo: quotation.quotation_no, invoiceId },
  });

  return { invoiceId };
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export async function createInvoice(
  db: Executor,
  principal: Principal,
  input: SalesDocumentInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.invoice.create");

  const customer = await requireCustomer(db, input.customerId);
  const date = toIsoDate(input.documentDate ? parseIsoDate(input.documentDate, "documentDate") : today());
  const dueDate = input.dueDate
    ? toIsoDate(parseIsoDate(input.dueDate, "dueDate"))
    : toIsoDate(addDays(parseIsoDate(date), customer.paymentTermsDays));

  if (dueDate < date) {
    throw new ValidationError("The due date cannot be before the invoice date.", "dueDate");
  }

  const computed = await computeDocumentLines(db, input.lines, date);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.invoice
      (customer_id, invoice_date, due_date, reference, subject, notes, terms, created_by)
    VALUES (${customer.id}, ${date}, ${dueDate}, ${input.reference?.trim() || null},
            ${input.subject?.trim() || null}, ${input.notes?.trim() || null},
            ${input.terms?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;
  await writeDocumentLines(db, "invoice_line", "invoice_id", id, computed.lines);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.INVOICE_CREATED,
    entityType: "invoice",
    entityId: id,
    newValues: {
      customer: customer.name,
      invoiceDate: date,
      dueDate,
      total: amountToSql(computed.totals.total),
      lines: computed.lines.length,
    },
  });

  return { id };
}

export async function updateInvoice(
  db: Executor,
  principal: Principal,
  invoiceId: string,
  input: SalesDocumentInput,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.invoice.create");

  const existing = await db.execute<{
    status: string;
    kind: "invoice" | "credit_note";
    total: string;
    created_by: string;
    customer_id: string;
    credits_invoice_id: string | null;
  }>(
    sql`SELECT status, kind, total, created_by, customer_id, credits_invoice_id
          FROM accounting.invoice WHERE id = ${invoiceId} FOR UPDATE`,
  );
  const invoice = existing.rows?.[0];
  if (!invoice) throw new NotFoundError("That invoice no longer exists.");
  if (invoice.status !== "draft") {
    throw new ConflictError(
      invoice.status === "pending_approval"
        ? "This invoice is waiting for approval. Send it back to draft first."
        : `This invoice is ${invoice.status} and its terms are fixed.`,
    );
  }

  /**
   * A credit note is a row in this table too, and editing one is not editing an invoice.
   *
   * This function read `status, total, created_by` and never `kind`, while the "you may not credit
   * more than the invoice" rule lived only in `createCreditNote` and nowhere in the database. So:
   * credit an invoice of RM 1,000 in full, open the draft credit note in the edit screen, change the
   * line to RM 10,000 and the customer to somebody else, approve, issue — and `issueInvoice` posted a
   * RM 10,000 revenue reversal and a RM 9,000 credit balance for a customer who had never been
   * invoiced. Nothing along that path looked at the cap again.
   *
   * Two rules restore it. The customer belongs to the invoice being credited and cannot be moved, and
   * the amount is re-checked against what is left to credit, this draft excluded from the sum.
   */
  if (invoice.kind === "credit_note") {
    if (input.customerId !== invoice.customer_id) {
      throw new ValidationError(
        "A credit note belongs to the invoice it credits, so it cannot be moved to another customer. " +
          "Void it and raise a credit note against the right invoice instead.",
        "customerId",
      );
    }
  }

  const customer = await requireCustomer(db, input.customerId);
  const date = toIsoDate(input.documentDate ? parseIsoDate(input.documentDate) : today());
  const dueDate = input.dueDate
    ? toIsoDate(parseIsoDate(input.dueDate, "dueDate"))
    : toIsoDate(addDays(parseIsoDate(date), customer.paymentTermsDays));
  const computed = await computeDocumentLines(db, input.lines, date);

  if (invoice.kind === "credit_note" && invoice.credits_invoice_id) {
    const credited = await db.execute<{ total: string; invoice_no: string | null }>(sql`
      SELECT total::text AS total, invoice_no FROM accounting.invoice
       WHERE id = ${invoice.credits_invoice_id}
    `);
    const target = credited.rows?.[0];
    if (!target) throw new NotFoundError("The invoice this credit note credits no longer exists.");

    const outstanding =
      parseAmount(target.total) -
      (await creditedSoFar(db, invoice.credits_invoice_id, invoiceId));

    if (computed.totals.total > outstanding) {
      throw new ValidationError(
        `That credits ${formatAmount(computed.totals.total)} against ` +
          `${target.invoice_no ?? "an invoice"}, which has only ${formatAmount(outstanding)} left to ` +
          "credit. A credit note cannot reverse more than was invoiced.",
        "lines",
      );
    }
  }

  await db.execute(sql`DELETE FROM accounting.invoice_line WHERE invoice_id = ${invoiceId}`);
  await db.execute(sql`
    UPDATE accounting.invoice
       SET customer_id = ${customer.id}, invoice_date = ${date}, due_date = ${dueDate},
           reference = ${input.reference?.trim() || null}, subject = ${input.subject?.trim() || null},
           notes = ${input.notes?.trim() || null}, terms = ${input.terms?.trim() || null},
           updated_by = ${principal.userId}
     WHERE id = ${invoiceId}
  `);
  await writeDocumentLines(db, "invoice_line", "invoice_id", invoiceId, computed.lines);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.INVOICE_UPDATED,
    entityType: "invoice",
    entityId: invoiceId,
    oldValues: { total: invoice.total },
    newValues: { customer: customer.name, total: amountToSql(computed.totals.total) },
  });
}

export async function deleteInvoice(
  db: Executor,
  principal: Principal,
  invoiceId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "accounting.invoice.create");

  const existing = await db.execute<{ status: string; total: string; created_by: string }>(
    sql`SELECT status, total, created_by FROM accounting.invoice WHERE id = ${invoiceId} FOR UPDATE`,
  );
  const invoice = existing.rows?.[0];
  if (!invoice) throw new NotFoundError("That invoice no longer exists.");
  if (invoice.status !== "draft") {
    throw new ConflictError(
      `This invoice is ${invoice.status} and cannot be deleted. An issued invoice is voided, not removed.`,
    );
  }

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.INVOICE_DELETED,
    entityType: "invoice",
    entityId: invoiceId,
    oldValues: { status: invoice.status, total: invoice.total },
    reason: options.reason ?? null,
  });

  await db.execute(sql`DELETE FROM accounting.invoice WHERE id = ${invoiceId}`);
}

/** Hands the draft to whoever approves. */
export async function submitInvoice(
  db: Executor,
  principal: Principal,
  invoiceId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.invoice.create");

  const invoice = await lockInvoice(db, invoiceId);
  if (invoice.status !== "draft") throw new ConflictError(`This invoice is already ${invoice.status}.`);
  if (parseAmount(invoice.total) <= 0n) {
    throw new ValidationError("An invoice for nothing cannot be submitted.", "lines");
  }

  await db.execute(sql`
    UPDATE accounting.invoice
       SET status = 'pending_approval', submitted_at = now(), submitted_by = ${principal.userId},
           updated_by = ${principal.userId}
     WHERE id = ${invoiceId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.INVOICE_SUBMITTED,
    entityType: "invoice",
    entityId: invoiceId,
    newValues: { total: invoice.total },
  });
}

/** Puts a submitted invoice back in the preparer's hands. */
export async function returnInvoiceToDraft(
  db: Executor,
  principal: Principal,
  invoiceId: string,
  options: { reason: string; context?: AuditContext },
): Promise<void> {
  requireCapability(principal, "accounting.invoice.create");
  if (!options.reason?.trim()) {
    throw new ValidationError("Say what needs changing. The preparer will see it.", "reason");
  }

  const invoice = await lockInvoice(db, invoiceId);
  if (invoice.status !== "pending_approval" && invoice.status !== "approved") {
    throw new ConflictError(`This invoice is ${invoice.status} and cannot be sent back.`);
  }

  await db.execute(sql`
    UPDATE accounting.invoice
       SET status = 'draft', submitted_at = NULL, submitted_by = NULL,
           approved_at = NULL, approved_by = NULL, updated_by = ${principal.userId}
     WHERE id = ${invoiceId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.INVOICE_RETURNED,
    entityType: "invoice",
    entityId: invoiceId,
    oldValues: { status: invoice.status },
    newValues: { status: "draft" },
    reason: options.reason,
  });
}

/**
 * The capability an invoice of this size needs.
 *
 * With the threshold unset, everything needs the higher one. That is the safe
 * reading of a question CAC has not yet answered, and it is visible on the screen
 * rather than silent.
 */
export async function approvalCapabilityFor(db: Executor, total: Amount): Promise<{
  capability: string;
  threshold: Amount | null;
}> {
  const raw = await getSetting<number | string | null>(db, "accounting.approval_threshold_myr", null);
  if (raw === null || raw === "") {
    return { capability: "accounting.invoice.approve_high_value", threshold: null };
  }
  const threshold = parseAmount(String(raw));
  return {
    capability:
      total > threshold ? "accounting.invoice.approve_high_value" : "accounting.invoice.approve",
    threshold,
  };
}

export async function approveInvoice(
  db: Executor,
  principal: Principal,
  invoiceId: string,
  context?: AuditContext,
): Promise<void> {
  const invoice = await lockInvoice(db, invoiceId);
  if (invoice.status !== "pending_approval") {
    throw new ConflictError(
      invoice.status === "draft"
        ? "This invoice has not been submitted for approval yet."
        : `This invoice is already ${invoice.status}.`,
    );
  }

  const total = parseAmount(invoice.total);
  const { capability, threshold } = await approvalCapabilityFor(db, total);

  try {
    requireCapability(principal, capability);
  } catch (error) {
    if (capability.endsWith("approve_high_value")) {
      throw new ConflictError(
        threshold === null
          ? `Approving invoices needs director-level authority while the approval limit is unset (see Q-FIN-3). ` +
            `${formatAmount(total, { currency: "RM" })} cannot be approved by you.`
          : `${formatAmount(total, { currency: "RM" })} is above the approval limit of ` +
            `${formatAmount(threshold, { currency: "RM" })}, so it needs a director.`,
      );
    }
    throw error;
  }

  // The rule that makes approval mean anything.
  requireDifferentApprover({
    principal,
    createdByUserId: invoice.created_by,
    action: "approve",
  });

  await db.execute(sql`
    UPDATE accounting.invoice
       SET status = 'approved', approved_at = now(), approved_by = ${principal.userId},
           updated_by = ${principal.userId}
     WHERE id = ${invoiceId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.INVOICE_APPROVED,
    entityType: "invoice",
    entityId: invoiceId,
    newValues: {
      total: invoice.total,
      capabilityUsed: capability,
      thresholdAtTheTime: threshold === null ? null : amountToSql(threshold),
    },
  });
}

/**
 * Issues an approved invoice: number, ledger entry, and from here it is fixed.
 *
 * The journal debits trade receivables for the whole document and credits each
 * line's own revenue account, plus output tax if any was charged. Posted through
 * the same engine as everything else, so it cannot be unbalanced and it lands in
 * the same period discipline.
 */
export async function issueInvoice(
  db: Executor,
  principal: Principal,
  invoiceId: string,
  context?: AuditContext,
): Promise<{ invoiceNo: string; journalNo: string }> {
  requireCapability(principal, "accounting.invoice.issue");

  const invoice = await lockInvoice(db, invoiceId);
  if (invoice.status !== "approved") {
    throw new ConflictError(
      invoice.status === "pending_approval"
        ? "This invoice has not been approved yet."
        : `This invoice is ${invoice.status} and cannot be issued.`,
    );
  }

  const lines = await readDocumentLines(db, "invoice_line", "invoice_id", invoiceId);
  if (lines.length === 0) throw new ValidationError("An invoice with no lines cannot be issued.", "lines");

  const date = String(invoice.invoice_date).slice(0, 10);
  const total = parseAmount(invoice.total);
  const taxTotal = parseAmount(invoice.tax_total);
  const credit = invoice.kind === "credit_note";

  // The cap, one last time, at the point where it stops being a document and becomes a ledger entry.
  //
  // It is checked when the note is raised and again when it is edited; this is the gate that actually
  // guards the money, and it is cheap. The cap has never existed in the database, so the only thing
  // standing between an over-credit and a posted reversal of revenue is a check in application code —
  // which means there should be one on every path that posts.
  if (credit && invoice.credits_invoice_id) {
    const target = await db.execute<{ total: string; invoice_no: string | null }>(sql`
      SELECT total::text AS total, invoice_no FROM accounting.invoice
       WHERE id = ${invoice.credits_invoice_id}
    `);
    const original = target.rows?.[0];
    if (!original) throw new NotFoundError("The invoice this credit note credits no longer exists.");

    const outstanding =
      parseAmount(original.total) -
      (await creditedSoFar(db, invoice.credits_invoice_id, invoiceId));

    if (total > outstanding) {
      throw new ConflictError(
        `This credit note is for ${formatAmount(total)} against ` +
          `${original.invoice_no ?? "an invoice"}, which has only ${formatAmount(outstanding)} left ` +
          "to credit. Issuing it would reverse revenue that was never invoiced.",
      );
    }
  }

  const invoiceNo = await allocateDocumentNumber(db, credit ? "credit_note" : "invoice", { on: date });

  const customer = await db.execute<{ name: string; code: string }>(
    sql`SELECT name, code FROM accounting.customer WHERE id = ${invoice.customer_id}`,
  );
  const memo = `${credit ? "Credit note" : "Invoice"} ${invoiceNo} — ${customer.rows![0]!.name}`;

  // A credit note is the same entry with the sides swapped.
  const receivable = {
    accountCode: SYSTEM_ACCOUNTS.receivableControl,
    description: `${customer.rows![0]!.code} ${customer.rows![0]!.name}`,
    ...(credit ? { credit: amountToSql(total) } : { debit: amountToSql(total) }),
  };
  const revenueLines = lines.map((line) => ({
    accountId: line.accountId,
    description: line.description,
    caseId: line.caseId,
    ...(credit
      ? { debit: amountToSql(line.lineSubtotal - line.discountAmount) }
      : { credit: amountToSql(line.lineSubtotal - line.discountAmount) }),
  }));
  const taxLines =
    taxTotal > 0n
      ? [
          {
            accountCode: SYSTEM_ACCOUNTS.sstOutput,
            description: "Service tax charged",
            ...(credit ? { debit: amountToSql(taxTotal) } : { credit: amountToSql(taxTotal) }),
          },
        ]
      : [];

  const journal = await postSourceJournal(
    db,
    principal,
    {
      entryDate: date,
      memo,
      sourceType: "invoice",
      sourceId: invoiceId,
      authorisedBy: "accounting.invoice.issue",
      lines: [receivable, ...revenueLines, ...taxLines],
    },
    context,
  );

  await db.execute(sql`
    UPDATE accounting.invoice
       SET status = 'issued', invoice_no = ${invoiceNo}, journal_id = ${journal.id},
           issued_at = now(), issued_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${invoiceId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.INVOICE_ISSUED,
    entityType: "invoice",
    entityId: invoiceId,
    newValues: {
      invoiceNo,
      journalNo: journal.journalNo,
      total: invoice.total,
      customer: customer.rows![0]!.name,
    },
  });

  return { invoiceNo, journalNo: journal.journalNo };
}

/**
 * Voids an issued invoice by reversing its journal.
 *
 * Only for an invoice that should never have existed — wrong customer, duplicate,
 * issued in error. Where the work was done and the amount is merely wrong, a
 * credit note is the honest instrument: it leaves the original visible to the
 * customer, which is what they will have in their own records.
 *
 * An invoice with anything allocated against it cannot be voided; unallocate
 * first, so the receipt does not end up pointing at nothing.
 */
export async function voidInvoice(
  db: Executor,
  principal: Principal,
  invoiceId: string,
  options: { reason: string; context?: AuditContext },
): Promise<{ journalNo: string }> {
  requireCapability(principal, "accounting.invoice.void");

  const reason = options.reason?.trim();
  if (!reason) {
    throw new ValidationError("A void needs a reason. It stays on the record.", "reason");
  }

  const invoice = await lockInvoice(db, invoiceId);
  if (invoice.status !== "issued" && invoice.status !== "paid") {
    throw new ConflictError(`This invoice is ${invoice.status} and cannot be voided.`);
  }
  if (parseAmount(invoice.amount_allocated) > 0n) {
    throw new ConflictError(
      `${invoice.invoice_no} has ${formatAmount(parseAmount(invoice.amount_allocated), { currency: "RM" })} ` +
        "allocated against it. Remove the allocations first, or raise a credit note instead.",
    );
  }
  if (!invoice.journal_id) {
    throw new ConflictError("This invoice has no ledger entry to reverse, which should not happen.");
  }

  const reversal = await reverseJournal(db, principal, invoice.journal_id, {
    reason: `Invoice ${invoice.invoice_no} voided: ${reason}`,
    context: options.context,
  });

  await db.execute(sql`
    UPDATE accounting.invoice
       SET status = 'void', void_journal_id = ${reversal.journalId}, void_reason = ${reason},
           voided_at = now(), voided_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${invoiceId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.INVOICE_VOIDED,
    entityType: "invoice",
    entityId: invoiceId,
    oldValues: { invoiceNo: invoice.invoice_no, status: invoice.status },
    newValues: { status: "void", reversalJournal: reversal.journalNo },
    reason,
  });

  return { journalNo: reversal.journalNo };
}

/**
 * Raises a credit note against an issued invoice.
 *
 * Defaults to crediting the whole invoice; pass lines to credit part of it. The
 * credit note goes through the same draft → approve → issue path, because
 * crediting a customer is a commitment like any other.
 */
export async function createCreditNote(
  db: Executor,
  principal: Principal,
  input: { invoiceId: string; lines?: DocumentLineInput[]; reason: string },
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.invoice.void");

  const reason = input.reason?.trim();
  if (!reason) {
    throw new ValidationError("Say why the customer is being credited.", "reason");
  }

  const invoice = await lockInvoice(db, input.invoiceId);
  if (invoice.kind !== "invoice") throw new ConflictError("A credit note cannot credit a credit note.");
  if (invoice.status !== "issued" && invoice.status !== "paid") {
    throw new ConflictError(`Only an issued invoice can be credited; this one is ${invoice.status}.`);
  }

  const original = await readDocumentLines(db, "invoice_line", "invoice_id", input.invoiceId);
  const date = toIsoDate(today());

  const lines =
    input.lines && input.lines.length > 0
      ? input.lines
      : original.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: amountToSql(line.unitPrice),
          discountPercent: line.discountPercent,
          discountAmount: line.discountPercent ? null : amountToSql(line.discountAmount),
          taxCodeId: line.taxCodeId,
          accountId: line.accountId,
          caseId: line.caseId,
        }));

  const computed = await computeDocumentLines(db, lines, date);

  const outstandingCredit = parseAmount(invoice.total) - (await creditedSoFar(db, input.invoiceId));
  if (computed.totals.total > outstandingCredit) {
    throw new ValidationError(
      `That credits ${formatAmount(computed.totals.total)} against an invoice with only ` +
        `${formatAmount(outstandingCredit)} left to credit.`,
      "lines",
    );
  }

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.invoice
      (kind, customer_id, invoice_date, due_date, reference, subject, notes,
       credits_invoice_id, created_by)
    VALUES ('credit_note', ${invoice.customer_id}, ${date}, ${date},
            ${invoice.invoice_no}, ${`Credit note against ${invoice.invoice_no}`},
            ${reason}, ${input.invoiceId}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;
  await writeDocumentLines(db, "invoice_line", "invoice_id", id, computed.lines);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CREDIT_NOTE_CREATED,
    entityType: "invoice",
    entityId: id,
    newValues: {
      creditsInvoice: invoice.invoice_no,
      total: amountToSql(computed.totals.total),
    },
    reason,
  });

  return { id };
}

/**
 * What has already been credited against an invoice.
 *
 * `exceptId` leaves one credit note out, which is what editing one needs: the draft being edited is
 * itself in the sum, and counting it would make every edit look like it exceeded the cap.
 */
async function creditedSoFar(
  db: Executor,
  invoiceId: string,
  exceptId?: string,
): Promise<Amount> {
  const result = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(total), 0)::text AS total FROM accounting.invoice
     WHERE credits_invoice_id = ${invoiceId} AND status <> 'void'
       AND (${exceptId ?? null}::uuid IS NULL OR id <> ${exceptId ?? null}::uuid)
  `);
  return parseAmount(result.rows?.[0]?.total ?? "0");
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type LockedInvoice = {
  status: InvoiceStatus;
  kind: "invoice" | "credit_note";
  invoice_no: string | null;
  customer_id: string;
  invoice_date: string;
  total: string;
  tax_total: string;
  amount_allocated: string;
  journal_id: string | null;
  created_by: string;
  /** Set on a credit note: the invoice it credits, and so the cap it may not exceed. */
  credits_invoice_id: string | null;
};

async function lockInvoice(db: Executor, invoiceId: string): Promise<LockedInvoice> {
  const result = await db.execute<LockedInvoice>(sql`
    SELECT status, kind, invoice_no, customer_id, invoice_date, total, tax_total,
           amount_allocated, journal_id, created_by, credits_invoice_id
      FROM accounting.invoice WHERE id = ${invoiceId} FOR UPDATE
  `);
  const invoice = result.rows?.[0];
  if (!invoice) throw new NotFoundError("That invoice no longer exists.");
  return invoice;
}

async function requireCustomer(
  db: Executor,
  customerId: string,
): Promise<{ id: string; name: string; paymentTermsDays: number }> {
  if (!customerId) throw new ValidationError("Choose a customer.", "customerId");
  const result = await db.execute<{ id: string; name: string; payment_terms_days: number; is_active: boolean }>(
    sql`SELECT id, name, payment_terms_days, is_active FROM accounting.customer WHERE id = ${customerId}`,
  );
  const customer = result.rows?.[0];
  if (!customer) throw new ValidationError("That customer no longer exists.", "customerId");
  if (!customer.is_active) {
    throw new ValidationError(`${customer.name} is marked inactive.`, "customerId");
  }
  return { id: customer.id, name: customer.name, paymentTermsDays: customer.payment_terms_days };
}

export async function getInvoice(db: Executor, invoiceId: string): Promise<InvoiceView | null> {
  const result = await db.execute<Record<string, never>>(sql`
    SELECT i.*, c.code AS customer_code, c.name AS customer_name, c.address AS customer_address,
           c.tax_identifier AS customer_tax_id,
           q.quotation_no, j.journal_no,
           orig.invoice_no AS credits_invoice_no,
           cb.full_name AS created_by_name, sb.full_name AS submitted_by_name,
           ab.full_name AS approved_by_name, ib.full_name AS issued_by_name,
           vb.full_name AS voided_by_name
      FROM accounting.invoice i
      JOIN accounting.customer c ON c.id = i.customer_id
      LEFT JOIN accounting.quotation q ON q.id = i.quotation_id
      LEFT JOIN accounting.journal j ON j.id = i.journal_id
      LEFT JOIN accounting.invoice orig ON orig.id = i.credits_invoice_id
      LEFT JOIN auth."user" cb ON cb.id = i.created_by
      LEFT JOIN auth."user" sb ON sb.id = i.submitted_by
      LEFT JOIN auth."user" ab ON ab.id = i.approved_by
      LEFT JOIN auth."user" ib ON ib.id = i.issued_by
      LEFT JOIN auth."user" vb ON vb.id = i.voided_by
     WHERE i.id = ${invoiceId}
  `);
  const row = result.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  const lines = await readDocumentLines(db, "invoice_line", "invoice_id", invoiceId);

  const credits = await db.execute<{ id: string; invoice_no: string | null; total: string; status: InvoiceStatus }>(
    sql`SELECT id, invoice_no, total, status FROM accounting.invoice
         WHERE credits_invoice_id = ${invoiceId} ORDER BY created_at`,
  );

  const total = parseAmount(String(row.total));
  const allocated = parseAmount(String(row.amount_allocated));

  return {
    id: String(row.id),
    invoiceNo: (row.invoice_no as string) ?? null,
    kind: row.kind as "invoice" | "credit_note",
    status: row.status as InvoiceStatus,
    customerId: String(row.customer_id),
    customerCode: String(row.customer_code),
    customerName: String(row.customer_name),
    customerAddress: (row.customer_address as string) ?? null,
    customerTaxId: (row.customer_tax_id as string) ?? null,
    invoiceDate: String(row.invoice_date).slice(0, 10),
    dueDate: String(row.due_date).slice(0, 10),
    reference: (row.reference as string) ?? null,
    subject: (row.subject as string) ?? null,
    currency: String(row.currency).trim(),
    subtotal: parseAmount(String(row.subtotal)),
    discountTotal: parseAmount(String(row.discount_total)),
    taxTotal: parseAmount(String(row.tax_total)),
    total,
    amountAllocated: allocated,
    outstanding: total - allocated,
    notes: (row.notes as string) ?? null,
    terms: (row.terms as string) ?? null,
    quotationId: (row.quotation_id as string) ?? null,
    quotationNo: (row.quotation_no as string) ?? null,
    journalId: (row.journal_id as string) ?? null,
    journalNo: (row.journal_no as string) ?? null,
    voidJournalId: (row.void_journal_id as string) ?? null,
    voidReason: (row.void_reason as string) ?? null,
    creditsInvoiceId: (row.credits_invoice_id as string) ?? null,
    creditsInvoiceNo: (row.credits_invoice_no as string) ?? null,
    createdBy: String(row.created_by),
    createdByName: (row.created_by_name as string) ?? null,
    submittedByName: (row.submitted_by_name as string) ?? null,
    approvedBy: (row.approved_by as string) ?? null,
    approvedByName: (row.approved_by_name as string) ?? null,
    approvedAt: (row.approved_at as Date | string) ?? null,
    issuedByName: (row.issued_by_name as string) ?? null,
    issuedAt: (row.issued_at as Date | string) ?? null,
    voidedByName: (row.voided_by_name as string) ?? null,
    createdAt: row.created_at as Date | string,
    lines,
    creditNotes: (credits.rows ?? []).map((note) => ({
      id: note.id,
      invoiceNo: note.invoice_no,
      total: parseAmount(note.total),
      status: note.status,
    })),
  };
}

export interface InvoiceSummary {
  id: string;
  invoiceNo: string | null;
  kind: "invoice" | "credit_note";
  status: InvoiceStatus;
  customerName: string;
  customerCode: string;
  invoiceDate: string;
  dueDate: string;
  subject: string | null;
  total: Amount;
  outstanding: Amount;
  /** Days past due; negative when not yet due. Null unless outstanding. */
  daysOverdue: number | null;
}

export interface InvoiceFilters {
  status?: InvoiceStatus;
  kind?: "invoice" | "credit_note";
  customerId?: string;
  from?: string;
  to?: string;
  search?: string;
  /** Issued or partly paid, with something still owing. */
  outstandingOnly?: boolean;
  limit?: number;
}

export async function listInvoices(
  db: Executor,
  filters: InvoiceFilters = {},
): Promise<InvoiceSummary[]> {
  const where = [sql`true`];
  if (filters.status) where.push(sql`i.status = ${filters.status}`);
  if (filters.kind) where.push(sql`i.kind = ${filters.kind}`);
  if (filters.customerId) where.push(sql`i.customer_id = ${filters.customerId}`);
  if (filters.from) where.push(sql`i.invoice_date >= ${toIsoDate(parseIsoDate(filters.from))}::date`);
  if (filters.to) where.push(sql`i.invoice_date <= ${toIsoDate(parseIsoDate(filters.to))}::date`);
  if (filters.outstandingOnly) {
    where.push(sql`i.status IN ('issued', 'paid') AND i.total > i.amount_allocated`);
  }
  if (filters.search?.trim()) {
    const term = `%${filters.search.trim().toLowerCase()}%`;
    where.push(sql`(
      lower(coalesce(i.invoice_no, '')) LIKE ${term}
      OR lower(coalesce(i.subject, '')) LIKE ${term}
      OR lower(coalesce(i.reference, '')) LIKE ${term}
      OR lower(c.name) LIKE ${term}
    )`);
  }

  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const asOf = toIsoDate(today());

  const result = await db.execute<{
    id: string;
    invoice_no: string | null;
    kind: "invoice" | "credit_note";
    status: InvoiceStatus;
    customer_name: string;
    customer_code: string;
    invoice_date: string;
    due_date: string;
    subject: string | null;
    total: string;
    outstanding: string;
    days_overdue: number | null;
  }>(sql`
    SELECT i.id, i.invoice_no, i.kind, i.status, c.name AS customer_name, c.code AS customer_code,
           i.invoice_date, i.due_date, i.subject, i.total,
           (i.total - i.amount_allocated)::text AS outstanding,
           CASE WHEN i.status IN ('issued', 'paid') AND i.total > i.amount_allocated
                THEN (${asOf}::date - i.due_date) END AS days_overdue
      FROM accounting.invoice i
      JOIN accounting.customer c ON c.id = i.customer_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY i.invoice_date DESC, i.invoice_no DESC NULLS FIRST, i.created_at DESC
     LIMIT ${limit}
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    invoiceNo: row.invoice_no,
    kind: row.kind,
    status: row.status,
    customerName: row.customer_name,
    customerCode: row.customer_code,
    invoiceDate: String(row.invoice_date).slice(0, 10),
    dueDate: String(row.due_date).slice(0, 10),
    subject: row.subject,
    total: parseAmount(row.total),
    outstanding: parseAmount(row.outstanding),
    daysOverdue: row.days_overdue === null ? null : Number(row.days_overdue),
  }));
}

export interface QuotationSummary {
  id: string;
  quotationNo: string | null;
  status: QuotationStatus;
  customerName: string;
  quotationDate: string;
  validUntil: string | null;
  subject: string | null;
  total: Amount;
  convertedInvoiceId: string | null;
}

export async function listQuotations(
  db: Executor,
  filters: { status?: QuotationStatus; customerId?: string; search?: string; limit?: number } = {},
): Promise<QuotationSummary[]> {
  const where = [sql`true`];
  if (filters.status) where.push(sql`q.status = ${filters.status}`);
  if (filters.customerId) where.push(sql`q.customer_id = ${filters.customerId}`);
  if (filters.search?.trim()) {
    const term = `%${filters.search.trim().toLowerCase()}%`;
    where.push(
      sql`(lower(coalesce(q.quotation_no, '')) LIKE ${term} OR lower(coalesce(q.subject, '')) LIKE ${term} OR lower(c.name) LIKE ${term})`,
    );
  }

  const result = await db.execute<{
    id: string;
    quotation_no: string | null;
    status: QuotationStatus;
    customer_name: string;
    quotation_date: string;
    valid_until: string | null;
    subject: string | null;
    total: string;
    converted_invoice_id: string | null;
  }>(sql`
    SELECT q.id, q.quotation_no, q.status, c.name AS customer_name, q.quotation_date,
           q.valid_until, q.subject, q.total, q.converted_invoice_id
      FROM accounting.quotation q
      JOIN accounting.customer c ON c.id = q.customer_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY q.quotation_date DESC, q.created_at DESC
     LIMIT ${Math.min(Math.max(filters.limit ?? 100, 1), 500)}
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    quotationNo: row.quotation_no,
    status: row.status,
    customerName: row.customer_name,
    quotationDate: String(row.quotation_date).slice(0, 10),
    validUntil: row.valid_until ? String(row.valid_until).slice(0, 10) : null,
    subject: row.subject,
    total: parseAmount(row.total),
    convertedInvoiceId: row.converted_invoice_id,
  }));
}

export interface QuotationView extends Omit<QuotationSummary, "total"> {
  customerId: string;
  customerCode: string;
  customerAddress: string | null;
  reference: string | null;
  notes: string | null;
  terms: string | null;
  currency: string;
  subtotal: Amount;
  discountTotal: Amount;
  taxTotal: Amount;
  total: Amount;
  createdByName: string | null;
  createdAt: Date | string;
  lines: StoredLine[];
}

export async function getQuotation(db: Executor, quotationId: string): Promise<QuotationView | null> {
  const result = await db.execute<Record<string, never>>(sql`
    SELECT q.*, c.code AS customer_code, c.name AS customer_name, c.address AS customer_address,
           cb.full_name AS created_by_name
      FROM accounting.quotation q
      JOIN accounting.customer c ON c.id = q.customer_id
      LEFT JOIN auth."user" cb ON cb.id = q.created_by
     WHERE q.id = ${quotationId}
  `);
  const row = result.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    id: String(row.id),
    quotationNo: (row.quotation_no as string) ?? null,
    status: row.status as QuotationStatus,
    customerId: String(row.customer_id),
    customerCode: String(row.customer_code),
    customerName: String(row.customer_name),
    customerAddress: (row.customer_address as string) ?? null,
    quotationDate: String(row.quotation_date).slice(0, 10),
    validUntil: row.valid_until ? String(row.valid_until).slice(0, 10) : null,
    reference: (row.reference as string) ?? null,
    subject: (row.subject as string) ?? null,
    notes: (row.notes as string) ?? null,
    terms: (row.terms as string) ?? null,
    currency: String(row.currency).trim(),
    subtotal: parseAmount(String(row.subtotal)),
    discountTotal: parseAmount(String(row.discount_total)),
    taxTotal: parseAmount(String(row.tax_total)),
    total: parseAmount(String(row.total)),
    convertedInvoiceId: (row.converted_invoice_id as string) ?? null,
    createdByName: (row.created_by_name as string) ?? null,
    createdAt: row.created_at as Date | string,
    lines: await readDocumentLines(db, "quotation_line", "quotation_id", quotationId),
  };
}
