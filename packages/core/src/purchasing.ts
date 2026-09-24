import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { SYSTEM_ACCOUNTS } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, requireDifferentApprover, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, today, toIsoDate } from "./dates.js";
import { amountToSql, formatAmount, parseAmount, parseRate, type Amount } from "./money.js";
import {
  computeDocumentLines,
  readPurchaseLines,
  writePurchaseLines,
  type DocumentLineInput,
  type PurchaseLine,
} from "./documents.js";
import { postSourceJournal, reverseJournal } from "./posting.js";
import { allocateDocumentNumber } from "./sequence.js";
import { getSetting } from "./settings.js";

/**
 * Money out: purchase orders and payment vouchers.
 *
 * **A purchase order reaches no ledger account.** Committing to buy something is
 * not a liability until it arrives; posting an order would overstate both costs
 * and payables, and would have to be unwound when the supplier delivered less
 * than was ordered. The order exists so the commitment is visible, approved
 * before it is placed, and matchable against what turns up.
 *
 * **A payment voucher is where the expense happens.** It carries the same
 * lifecycle as an invoice — prepared, approved by somebody else, then posted —
 * for the same reason: money leaving the company is the single easiest thing to
 * get wrong or to steal, and one person doing all three steps is how it happens.
 *
 * `settlement` decides the credit side:
 *
 *   paid     Cr bank or cash. The common case for a firm this size.
 *   payable  Cr trade payables, for a supplier invoice settled later. A voucher
 *            of kind 'settlement' then pays it off, debiting payables.
 */

export type VoucherStatus = "draft" | "pending_approval" | "approved" | "posted" | "void";
export type PurchaseOrderStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "issued"
  | "received"
  | "closed"
  | "cancelled";

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export interface PurchaseOrderInput {
  supplierId: string;
  orderDate?: string;
  requiredBy?: string | null;
  reference?: string | null;
  subject?: string | null;
  deliveryNote?: string | null;
  notes?: string | null;
  lines: DocumentLineInput[];
}

export async function createPurchaseOrder(
  db: Executor,
  principal: Principal,
  input: PurchaseOrderInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.po.create");

  const supplier = await requireSupplier(db, input.supplierId);
  const date = toIsoDate(input.orderDate ? parseIsoDate(input.orderDate, "orderDate") : today());
  const requiredBy = input.requiredBy
    ? toIsoDate(parseIsoDate(input.requiredBy, "requiredBy"))
    : null;
  if (requiredBy && requiredBy < date) {
    throw new ValidationError("The date required cannot be before the order date.", "requiredBy");
  }

  const computed = await computeDocumentLines(db, input.lines, date);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.purchase_order
      (supplier_id, order_date, required_by, reference, subject, delivery_note, notes, created_by)
    VALUES (${supplier.id}, ${date}, ${requiredBy}, ${input.reference?.trim() || null},
            ${input.subject?.trim() || null}, ${input.deliveryNote?.trim() || null},
            ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;
  await writePurchaseLines(db, "purchase_order_line", "order_id", id, computed.lines);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PO_CREATED,
    entityType: "purchase_order",
    entityId: id,
    newValues: {
      supplier: supplier.name,
      orderDate: date,
      total: amountToSql(computed.totals.total),
      lines: computed.lines.length,
    },
  });

  return { id };
}

export async function updatePurchaseOrder(
  db: Executor,
  principal: Principal,
  orderId: string,
  input: PurchaseOrderInput,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.po.create");

  const order = await lockOrder(db, orderId);
  if (order.status !== "draft") {
    throw new ConflictError(`This order is ${order.status} and cannot be changed.`);
  }

  const supplier = await requireSupplier(db, input.supplierId);
  const date = toIsoDate(input.orderDate ? parseIsoDate(input.orderDate) : today());
  const computed = await computeDocumentLines(db, input.lines, date);

  await db.execute(sql`DELETE FROM accounting.purchase_order_line WHERE order_id = ${orderId}`);
  await db.execute(sql`
    UPDATE accounting.purchase_order
       SET supplier_id = ${supplier.id}, order_date = ${date},
           required_by = ${input.requiredBy ? toIsoDate(parseIsoDate(input.requiredBy)) : null},
           reference = ${input.reference?.trim() || null}, subject = ${input.subject?.trim() || null},
           delivery_note = ${input.deliveryNote?.trim() || null}, notes = ${input.notes?.trim() || null},
           updated_by = ${principal.userId}
     WHERE id = ${orderId}
  `);
  await writePurchaseLines(db, "purchase_order_line", "order_id", orderId, computed.lines);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PO_UPDATED,
    entityType: "purchase_order",
    entityId: orderId,
    oldValues: { total: order.total },
    newValues: { supplier: supplier.name, total: amountToSql(computed.totals.total) },
  });
}

export async function submitPurchaseOrder(
  db: Executor,
  principal: Principal,
  orderId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.po.create");

  const order = await lockOrder(db, orderId);
  if (order.status !== "draft") throw new ConflictError(`This order is already ${order.status}.`);
  if (parseAmount(order.total) <= 0n) {
    throw new ValidationError("An order for nothing cannot be submitted.", "lines");
  }

  await db.execute(sql`
    UPDATE accounting.purchase_order
       SET status = 'pending_approval', submitted_at = now(), submitted_by = ${principal.userId},
           updated_by = ${principal.userId}
     WHERE id = ${orderId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PO_SUBMITTED,
    entityType: "purchase_order",
    entityId: orderId,
    newValues: { total: order.total },
  });
}

export async function approvePurchaseOrder(
  db: Executor,
  principal: Principal,
  orderId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.po.approve");

  const order = await lockOrder(db, orderId);
  if (order.status !== "pending_approval") {
    throw new ConflictError(
      order.status === "draft"
        ? "This order has not been submitted for approval yet."
        : `This order is already ${order.status}.`,
    );
  }

  // Committing the firm's money, like approving an invoice, is not something the
  // person who asked for it does.
  requireDifferentApprover({ principal, createdByUserId: order.created_by, action: "approve" });

  await db.execute(sql`
    UPDATE accounting.purchase_order
       SET status = 'approved', approved_at = now(), approved_by = ${principal.userId},
           updated_by = ${principal.userId}
     WHERE id = ${orderId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PO_APPROVED,
    entityType: "purchase_order",
    entityId: orderId,
    newValues: { total: order.total },
  });
}

/** Numbers the order and marks it sent to the supplier. Still no ledger entry. */
export async function issuePurchaseOrder(
  db: Executor,
  principal: Principal,
  orderId: string,
  context?: AuditContext,
): Promise<{ orderNo: string }> {
  requireCapability(principal, "accounting.po.create");

  const order = await lockOrder(db, orderId);
  if (order.status !== "approved") {
    throw new ConflictError(`This order is ${order.status} and cannot be sent to the supplier.`);
  }

  const orderNo = await allocateDocumentNumber(db, "purchase_order", {
    on: String(order.order_date).slice(0, 10),
  });

  await db.execute(sql`
    UPDATE accounting.purchase_order
       SET status = 'issued', order_no = ${orderNo}, issued_at = now(),
           issued_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${orderId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PO_ISSUED,
    entityType: "purchase_order",
    entityId: orderId,
    newValues: { orderNo, total: order.total },
  });

  return { orderNo };
}

/**
 * Records what actually turned up.
 *
 * Quantities per line, because partial deliveries are the norm. The order moves
 * to 'received' when every line is complete and stays 'issued' otherwise, so the
 * outstanding-orders list means what it says.
 */
export async function receivePurchaseOrder(
  db: Executor,
  principal: Principal,
  orderId: string,
  received: Array<{ lineId: string; quantity: string }>,
  context?: AuditContext,
): Promise<{ complete: boolean }> {
  requireCapability(principal, "accounting.po.receive");

  const order = await lockOrder(db, orderId);
  if (order.status !== "issued" && order.status !== "received") {
    throw new ConflictError(
      `Only an order that has been sent to the supplier can be received; this one is ${order.status}.`,
    );
  }

  for (const entry of received) {
    const quantity = parseRate(entry.quantity || "0", "quantity");
    if (quantity < 0n) throw new ValidationError("A received quantity cannot be negative.", "quantity");

    const line = await db.execute<{ quantity: string; description: string }>(
      sql`SELECT quantity, description FROM accounting.purchase_order_line
           WHERE id = ${entry.lineId} AND order_id = ${orderId}`,
    );
    const found = line.rows?.[0];
    if (!found) throw new NotFoundError("That order line no longer exists.");

    if (quantity > parseRate(found.quantity)) {
      throw new ValidationError(
        `More of "${found.description}" has been received than was ordered. Raise a new order for the extra, ` +
          "so what was agreed and what arrived stay separable.",
        "quantity",
      );
    }

    await db.execute(sql`
      UPDATE accounting.purchase_order_line SET quantity_received = ${entry.quantity}
       WHERE id = ${entry.lineId}
    `);
  }

  const outstanding = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM accounting.purchase_order_line
     WHERE order_id = ${orderId} AND quantity_received < quantity
  `);
  const complete = (outstanding.rows?.[0]?.count ?? 0) === 0;

  await db.execute(sql`
    UPDATE accounting.purchase_order
       SET status = ${complete ? "received" : "issued"},
           received_at = ${complete ? sql`now()` : sql`NULL`},
           received_by = ${complete ? principal.userId : null},
           updated_by = ${principal.userId}
     WHERE id = ${orderId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PO_RECEIVED,
    entityType: "purchase_order",
    entityId: orderId,
    newValues: { orderNo: order.order_no, lines: received.length, complete },
  });

  return { complete };
}

export async function closePurchaseOrder(
  db: Executor,
  principal: Principal,
  orderId: string,
  options: { reason?: string | null; cancel?: boolean; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, options.cancel ? "accounting.po.approve" : "accounting.po.close");

  const order = await lockOrder(db, orderId);

  if (options.cancel) {
    if (!options.reason?.trim()) {
      throw new ValidationError("Say why the order is being cancelled.", "reason");
    }
    if (order.status === "closed" || order.status === "cancelled") {
      throw new ConflictError(`This order is already ${order.status}.`);
    }
    await db.execute(sql`
      UPDATE accounting.purchase_order
         SET status = 'cancelled', cancel_reason = ${options.reason.trim()},
             closed_at = now(), closed_by = ${principal.userId}, updated_by = ${principal.userId}
       WHERE id = ${orderId}
    `);
  } else {
    if (order.status !== "issued" && order.status !== "received") {
      throw new ConflictError(`This order is ${order.status} and cannot be closed.`);
    }
    await db.execute(sql`
      UPDATE accounting.purchase_order
         SET status = 'closed', closed_at = now(), closed_by = ${principal.userId},
             updated_by = ${principal.userId}
       WHERE id = ${orderId}
    `);
  }

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: options.cancel ? AUDIT.PO_CANCELLED : AUDIT.PO_CLOSED,
    entityType: "purchase_order",
    entityId: orderId,
    oldValues: { orderNo: order.order_no, status: order.status },
    reason: options.reason ?? null,
  });
}

export async function deletePurchaseOrder(
  db: Executor,
  principal: Principal,
  orderId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "accounting.po.create");

  const order = await lockOrder(db, orderId);
  if (order.status !== "draft") {
    throw new ConflictError(`This order is ${order.status} and cannot be deleted; cancel it instead.`);
  }

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PO_DELETED,
    entityType: "purchase_order",
    entityId: orderId,
    oldValues: { total: order.total, status: order.status },
    reason: options.reason ?? null,
  });

  await db.execute(sql`DELETE FROM accounting.purchase_order WHERE id = ${orderId}`);
}

// ---------------------------------------------------------------------------
// Payment vouchers
// ---------------------------------------------------------------------------

export interface VoucherInput {
  supplierId?: string | null;
  /** Where there is no registered supplier: a one-off payee. */
  payeeName?: string | null;
  voucherDate?: string;
  reference?: string | null;
  subject?: string | null;
  kind?: "expense" | "settlement";
  settlement?: "paid" | "payable";
  method?: "cash" | "cheque" | "transfer" | "card" | "other";
  paymentAccountId?: string | null;
  purchaseOrderId?: string | null;
  notes?: string | null;
  lines: DocumentLineInput[];
}

export async function createVoucher(
  db: Executor,
  principal: Principal,
  input: VoucherInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.voucher.create");

  const { supplierId, payeeName } = await resolvePayee(db, input);
  const date = toIsoDate(input.voucherDate ? parseIsoDate(input.voucherDate, "voucherDate") : today());
  const settlement = input.settlement ?? "paid";
  const kind = input.kind ?? "expense";

  const paymentAccountId =
    settlement === "payable" && kind === "expense"
      ? null
      : (await requirePaymentAccount(db, input.paymentAccountId)).id;

  const computed = await computeDocumentLines(db, input.lines, date);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.payment_voucher
      (supplier_id, payee_name, voucher_date, reference, subject, kind, settlement, method,
       payment_account_id, purchase_order_id, notes, created_by)
    VALUES (${supplierId}, ${payeeName}, ${date}, ${input.reference?.trim() || null},
            ${input.subject?.trim() || null}, ${kind}, ${settlement}, ${input.method ?? "transfer"},
            ${paymentAccountId}, ${input.purchaseOrderId ?? null}, ${input.notes?.trim() || null},
            ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;
  await writePurchaseLines(db, "payment_voucher_line", "voucher_id", id, computed.lines);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.VOUCHER_CREATED,
    entityType: "payment_voucher",
    entityId: id,
    newValues: {
      payee: payeeName ?? supplierId,
      voucherDate: date,
      settlement,
      total: amountToSql(computed.totals.total),
    },
  });

  return { id };
}

export async function updateVoucher(
  db: Executor,
  principal: Principal,
  voucherId: string,
  input: VoucherInput,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.voucher.create");

  const voucher = await lockVoucher(db, voucherId);
  if (voucher.status !== "draft") {
    throw new ConflictError(`This voucher is ${voucher.status} and cannot be changed.`);
  }

  const { supplierId, payeeName } = await resolvePayee(db, input);
  const date = toIsoDate(input.voucherDate ? parseIsoDate(input.voucherDate) : today());
  const settlement = input.settlement ?? "paid";
  const kind = input.kind ?? "expense";
  const paymentAccountId =
    settlement === "payable" && kind === "expense"
      ? null
      : (await requirePaymentAccount(db, input.paymentAccountId)).id;

  const computed = await computeDocumentLines(db, input.lines, date);

  await db.execute(sql`DELETE FROM accounting.payment_voucher_line WHERE voucher_id = ${voucherId}`);
  await db.execute(sql`
    UPDATE accounting.payment_voucher
       SET supplier_id = ${supplierId}, payee_name = ${payeeName}, voucher_date = ${date},
           reference = ${input.reference?.trim() || null}, subject = ${input.subject?.trim() || null},
           kind = ${kind}, settlement = ${settlement}, method = ${input.method ?? "transfer"},
           payment_account_id = ${paymentAccountId}, purchase_order_id = ${input.purchaseOrderId ?? null},
           notes = ${input.notes?.trim() || null}, updated_by = ${principal.userId}
     WHERE id = ${voucherId}
  `);
  await writePurchaseLines(db, "payment_voucher_line", "voucher_id", voucherId, computed.lines);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.VOUCHER_UPDATED,
    entityType: "payment_voucher",
    entityId: voucherId,
    oldValues: { total: voucher.total },
    newValues: { total: amountToSql(computed.totals.total) },
  });
}

export async function submitVoucher(
  db: Executor,
  principal: Principal,
  voucherId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.voucher.create");

  const voucher = await lockVoucher(db, voucherId);
  if (voucher.status !== "draft") throw new ConflictError(`This voucher is already ${voucher.status}.`);
  if (parseAmount(voucher.total) <= 0n) {
    throw new ValidationError("A voucher for nothing cannot be submitted.", "lines");
  }

  await db.execute(sql`
    UPDATE accounting.payment_voucher
       SET status = 'pending_approval', submitted_at = now(), submitted_by = ${principal.userId},
           updated_by = ${principal.userId}
     WHERE id = ${voucherId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.VOUCHER_SUBMITTED,
    entityType: "payment_voucher",
    entityId: voucherId,
    newValues: { total: voucher.total },
  });
}

/**
 * The capability a payment of this size needs.
 *
 * Same rule as invoices, and the same conservative default: while the limit is
 * unset, every payment needs director-level authority. Paying money out is the
 * side where getting the threshold wrong costs the most.
 */
export async function voucherApprovalCapabilityFor(
  db: Executor,
  total: Amount,
): Promise<{ capability: string; threshold: Amount | null }> {
  const raw = await getSetting<number | string | null>(db, "accounting.approval_threshold_myr", null);
  if (raw === null || raw === "") {
    return { capability: "accounting.voucher.approve_high_value", threshold: null };
  }
  const threshold = parseAmount(String(raw));
  return {
    capability:
      total > threshold ? "accounting.voucher.approve_high_value" : "accounting.voucher.approve",
    threshold,
  };
}

export async function approveVoucher(
  db: Executor,
  principal: Principal,
  voucherId: string,
  context?: AuditContext,
): Promise<void> {
  const voucher = await lockVoucher(db, voucherId);
  if (voucher.status !== "pending_approval") {
    throw new ConflictError(
      voucher.status === "draft"
        ? "This voucher has not been submitted for approval yet."
        : `This voucher is already ${voucher.status}.`,
    );
  }

  const total = parseAmount(voucher.total);
  const { capability, threshold } = await voucherApprovalCapabilityFor(db, total);

  try {
    requireCapability(principal, capability);
  } catch (error) {
    if (capability.endsWith("approve_high_value")) {
      throw new ConflictError(
        threshold === null
          ? "Approving payments needs director-level authority while the approval limit is unset " +
            `(see Q-FIN-3). ${formatAmount(total, { currency: "RM" })} cannot be approved by you.`
          : `${formatAmount(total, { currency: "RM" })} is above the approval limit of ` +
            `${formatAmount(threshold, { currency: "RM" })}, so it needs a director.`,
      );
    }
    throw error;
  }

  requireDifferentApprover({ principal, createdByUserId: voucher.created_by, action: "approve" });

  await db.execute(sql`
    UPDATE accounting.payment_voucher
       SET status = 'approved', approved_at = now(), approved_by = ${principal.userId},
           updated_by = ${principal.userId}
     WHERE id = ${voucherId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.VOUCHER_APPROVED,
    entityType: "payment_voucher",
    entityId: voucherId,
    newValues: {
      total: voucher.total,
      capabilityUsed: capability,
      thresholdAtTheTime: threshold === null ? null : amountToSql(threshold),
    },
  });
}

/**
 * Posts the voucher, which is the moment the money is treated as gone.
 *
 *   expense, paid     Dr each expense line (+ input tax)   Cr bank or cash
 *   expense, payable  Dr each expense line (+ input tax)   Cr trade payables
 *   settlement        Dr trade payables                    Cr bank or cash
 */
export async function postVoucher(
  db: Executor,
  principal: Principal,
  voucherId: string,
  context?: AuditContext,
): Promise<{ voucherNo: string; journalNo: string }> {
  requireCapability(principal, "accounting.voucher.pay");

  const voucher = await lockVoucher(db, voucherId);
  if (voucher.status !== "approved") {
    throw new ConflictError(
      voucher.status === "pending_approval"
        ? "This voucher has not been approved yet."
        : `This voucher is ${voucher.status} and cannot be posted.`,
    );
  }

  const lines = await readPurchaseLines(db, "payment_voucher_line", "voucher_id", voucherId);
  if (lines.length === 0) {
    throw new ValidationError("A voucher with no lines cannot be posted.", "lines");
  }

  const date = String(voucher.voucher_date).slice(0, 10);
  const total = parseAmount(voucher.total);
  const taxTotal = parseAmount(voucher.tax_total);
  const voucherNo = await allocateDocumentNumber(db, "voucher", { on: date });
  const payee = await describePayee(db, voucher);

  const debits =
    voucher.kind === "settlement"
      ? [
          {
            accountCode: SYSTEM_ACCOUNTS.payableControl,
            debit: amountToSql(total),
            description: payee,
          },
        ]
      : [
          ...lines.map((line) => ({
            accountId: line.accountId,
            debit: amountToSql(line.lineSubtotal),
            description: line.description,
            costCentreId: line.costCentreId,
            caseId: line.caseId,
          })),
          ...(taxTotal > 0n
            ? [
                {
                  accountCode: SYSTEM_ACCOUNTS.sstInput,
                  debit: amountToSql(taxTotal),
                  description: "Service tax paid",
                },
              ]
            : []),
        ];

  const credit =
    voucher.settlement === "payable" && voucher.kind === "expense"
      ? { accountCode: SYSTEM_ACCOUNTS.payableControl, credit: amountToSql(total), description: payee }
      : {
          accountId: voucher.payment_account_id!,
          credit: amountToSql(total),
          description: `${voucher.method}${voucher.reference ? ` ${voucher.reference}` : ""}`,
        };

  const journal = await postSourceJournal(
    db,
    principal,
    {
      entryDate: date,
      memo: `Voucher ${voucherNo} — ${payee}`,
      sourceType: "voucher",
      sourceId: voucherId,
      authorisedBy: "accounting.voucher.pay",
      lines: [...debits, credit],
    },
    context,
  );

  await db.execute(sql`
    UPDATE accounting.payment_voucher
       SET status = 'posted', voucher_no = ${voucherNo}, journal_id = ${journal.id},
           posted_at = now(), posted_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${voucherId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.VOUCHER_POSTED,
    entityType: "payment_voucher",
    entityId: voucherId,
    newValues: {
      voucherNo,
      journalNo: journal.journalNo,
      total: voucher.total,
      payee,
      settlement: voucher.settlement,
    },
  });

  return { voucherNo, journalNo: journal.journalNo };
}

export async function voidVoucher(
  db: Executor,
  principal: Principal,
  voucherId: string,
  options: { reason: string; context?: AuditContext },
): Promise<{ journalNo: string }> {
  requireCapability(principal, "accounting.voucher.approve");

  const reason = options.reason?.trim();
  if (!reason) throw new ValidationError("A void needs a reason.", "reason");

  const voucher = await lockVoucher(db, voucherId);
  if (voucher.status !== "posted") {
    throw new ConflictError(`This voucher is ${voucher.status} and cannot be voided.`);
  }
  if (!voucher.journal_id) throw new ConflictError("This voucher has no ledger entry to reverse.");

  const reversal = await reverseJournal(db, principal, voucher.journal_id, {
    reason: `Voucher ${voucher.voucher_no} voided: ${reason}`,
    context: options.context,
  });

  await db.execute(sql`
    UPDATE accounting.payment_voucher
       SET status = 'void', void_journal_id = ${reversal.journalId}, void_reason = ${reason},
           voided_at = now(), voided_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${voucherId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.VOUCHER_VOIDED,
    entityType: "payment_voucher",
    entityId: voucherId,
    oldValues: { voucherNo: voucher.voucher_no, total: voucher.total },
    newValues: { status: "void", reversalJournal: reversal.journalNo },
    reason,
  });

  return { journalNo: reversal.journalNo };
}

export async function deleteVoucher(
  db: Executor,
  principal: Principal,
  voucherId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "accounting.voucher.create");

  const voucher = await lockVoucher(db, voucherId);
  if (voucher.status !== "draft") {
    throw new ConflictError(`This voucher is ${voucher.status} and cannot be deleted.`);
  }

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.VOUCHER_DELETED,
    entityType: "payment_voucher",
    entityId: voucherId,
    oldValues: { total: voucher.total },
    reason: options.reason ?? null,
  });

  await db.execute(sql`DELETE FROM accounting.payment_voucher WHERE id = ${voucherId}`);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type LockedOrder = {
  status: PurchaseOrderStatus;
  order_no: string | null;
  supplier_id: string;
  order_date: string;
  total: string;
  created_by: string;
};

async function lockOrder(db: Executor, orderId: string): Promise<LockedOrder> {
  const result = await db.execute<LockedOrder>(sql`
    SELECT status, order_no, supplier_id, order_date, total, created_by
      FROM accounting.purchase_order WHERE id = ${orderId} FOR UPDATE
  `);
  const order = result.rows?.[0];
  if (!order) throw new NotFoundError("That purchase order no longer exists.");
  return order;
}

type LockedVoucher = {
  status: VoucherStatus;
  voucher_no: string | null;
  supplier_id: string | null;
  payee_name: string | null;
  voucher_date: string;
  kind: "expense" | "settlement";
  settlement: "paid" | "payable";
  method: string;
  reference: string | null;
  payment_account_id: string | null;
  total: string;
  tax_total: string;
  journal_id: string | null;
  created_by: string;
};

async function lockVoucher(db: Executor, voucherId: string): Promise<LockedVoucher> {
  const result = await db.execute<LockedVoucher>(sql`
    SELECT status, voucher_no, supplier_id, payee_name, voucher_date, kind, settlement, method,
           reference, payment_account_id, total, tax_total, journal_id, created_by
      FROM accounting.payment_voucher WHERE id = ${voucherId} FOR UPDATE
  `);
  const voucher = result.rows?.[0];
  if (!voucher) throw new NotFoundError("That voucher no longer exists.");
  return voucher;
}

async function requireSupplier(db: Executor, supplierId: string): Promise<{ id: string; name: string }> {
  if (!supplierId) throw new ValidationError("Choose a supplier.", "supplierId");
  const result = await db.execute<{ id: string; name: string; is_active: boolean }>(
    sql`SELECT id, name, is_active FROM accounting.supplier WHERE id = ${supplierId}`,
  );
  const supplier = result.rows?.[0];
  if (!supplier) throw new ValidationError("That supplier no longer exists.", "supplierId");
  if (!supplier.is_active) throw new ValidationError(`${supplier.name} is marked inactive.`, "supplierId");
  return { id: supplier.id, name: supplier.name };
}

async function resolvePayee(
  db: Executor,
  input: VoucherInput,
): Promise<{ supplierId: string | null; payeeName: string | null }> {
  if (input.supplierId) {
    const supplier = await requireSupplier(db, input.supplierId);
    return { supplierId: supplier.id, payeeName: null };
  }
  const payeeName = input.payeeName?.trim();
  if (!payeeName) {
    throw new ValidationError(
      "Say who is being paid — either a registered supplier or a name.",
      "payeeName",
    );
  }
  return { supplierId: null, payeeName };
}

async function describePayee(db: Executor, voucher: LockedVoucher): Promise<string> {
  if (voucher.payee_name) return voucher.payee_name;
  const result = await db.execute<{ name: string }>(
    sql`SELECT name FROM accounting.supplier WHERE id = ${voucher.supplier_id}`,
  );
  return result.rows?.[0]?.name ?? "supplier";
}

async function requirePaymentAccount(
  db: Executor,
  accountId: string | null | undefined,
): Promise<{ id: string; code: string }> {
  if (!accountId) {
    throw new ValidationError("Choose the account the money is paid from.", "paymentAccountId");
  }
  const result = await db.execute<{ id: string; code: string; subtype: string | null; is_active: boolean }>(
    sql`SELECT id, code, subtype, is_active FROM accounting.account WHERE id = ${accountId}`,
  );
  const account = result.rows?.[0];
  if (!account) throw new ValidationError("That account does not exist.", "paymentAccountId");
  if (!account.is_active) throw new ValidationError("That account is no longer in use.", "paymentAccountId");
  if (account.subtype !== "bank" && account.subtype !== "cash") {
    throw new ValidationError(
      `${account.code} is not a bank or cash account; money cannot be paid from it.`,
      "paymentAccountId",
    );
  }
  return { id: account.id, code: account.code };
}

export interface PurchaseOrderView {
  id: string;
  orderNo: string | null;
  status: PurchaseOrderStatus;
  supplierId: string;
  supplierName: string;
  supplierCode: string;
  orderDate: string;
  requiredBy: string | null;
  reference: string | null;
  subject: string | null;
  deliveryNote: string | null;
  notes: string | null;
  subtotal: Amount;
  taxTotal: Amount;
  total: Amount;
  cancelReason: string | null;
  createdBy: string;
  createdByName: string | null;
  approvedByName: string | null;
  issuedByName: string | null;
  receivedByName: string | null;
  createdAt: Date | string;
  lines: PurchaseLine[];
}

export async function getPurchaseOrder(
  db: Executor,
  orderId: string,
): Promise<PurchaseOrderView | null> {
  const result = await db.execute<Record<string, never>>(sql`
    SELECT p.*, s.name AS supplier_name, s.code AS supplier_code,
           cb.full_name AS created_by_name, ab.full_name AS approved_by_name,
           ib.full_name AS issued_by_name, rb.full_name AS received_by_name
      FROM accounting.purchase_order p
      JOIN accounting.supplier s ON s.id = p.supplier_id
      LEFT JOIN auth."user" cb ON cb.id = p.created_by
      LEFT JOIN auth."user" ab ON ab.id = p.approved_by
      LEFT JOIN auth."user" ib ON ib.id = p.issued_by
      LEFT JOIN auth."user" rb ON rb.id = p.received_by
     WHERE p.id = ${orderId}
  `);
  const raw = result.rows?.[0] as Record<string, unknown> | undefined;
  if (!raw) return null;

  return {
    id: String(raw.id),
    orderNo: (raw.order_no as string) ?? null,
    status: raw.status as PurchaseOrderStatus,
    supplierId: String(raw.supplier_id),
    supplierName: String(raw.supplier_name),
    supplierCode: String(raw.supplier_code),
    orderDate: String(raw.order_date).slice(0, 10),
    requiredBy: raw.required_by ? String(raw.required_by).slice(0, 10) : null,
    reference: (raw.reference as string) ?? null,
    subject: (raw.subject as string) ?? null,
    deliveryNote: (raw.delivery_note as string) ?? null,
    notes: (raw.notes as string) ?? null,
    subtotal: parseAmount(String(raw.subtotal)),
    taxTotal: parseAmount(String(raw.tax_total)),
    total: parseAmount(String(raw.total)),
    cancelReason: (raw.cancel_reason as string) ?? null,
    createdBy: String(raw.created_by),
    createdByName: (raw.created_by_name as string) ?? null,
    approvedByName: (raw.approved_by_name as string) ?? null,
    issuedByName: (raw.issued_by_name as string) ?? null,
    receivedByName: (raw.received_by_name as string) ?? null,
    createdAt: raw.created_at as Date | string,
    lines: await readPurchaseLines(db, "purchase_order_line", "order_id", orderId),
  };
}

export interface VoucherView {
  id: string;
  voucherNo: string | null;
  status: VoucherStatus;
  kind: "expense" | "settlement";
  settlement: "paid" | "payable";
  supplierId: string | null;
  supplierName: string | null;
  payeeName: string | null;
  payee: string;
  voucherDate: string;
  method: string;
  reference: string | null;
  subject: string | null;
  notes: string | null;
  paymentAccountId: string | null;
  paymentAccountCode: string | null;
  paymentAccountName: string | null;
  purchaseOrderId: string | null;
  purchaseOrderNo: string | null;
  subtotal: Amount;
  taxTotal: Amount;
  total: Amount;
  journalId: string | null;
  journalNo: string | null;
  voidJournalId: string | null;
  voidReason: string | null;
  createdBy: string;
  createdByName: string | null;
  approvedByName: string | null;
  postedByName: string | null;
  createdAt: Date | string;
  lines: PurchaseLine[];
}

export async function getVoucher(db: Executor, voucherId: string): Promise<VoucherView | null> {
  const result = await db.execute<Record<string, never>>(sql`
    SELECT v.*, s.name AS supplier_name, a.code AS payment_code, a.name AS payment_name,
           j.journal_no, po.order_no AS purchase_order_no,
           cb.full_name AS created_by_name, ab.full_name AS approved_by_name,
           pb.full_name AS posted_by_name
      FROM accounting.payment_voucher v
      LEFT JOIN accounting.supplier s ON s.id = v.supplier_id
      LEFT JOIN accounting.account a ON a.id = v.payment_account_id
      LEFT JOIN accounting.journal j ON j.id = v.journal_id
      LEFT JOIN accounting.purchase_order po ON po.id = v.purchase_order_id
      LEFT JOIN auth."user" cb ON cb.id = v.created_by
      LEFT JOIN auth."user" ab ON ab.id = v.approved_by
      LEFT JOIN auth."user" pb ON pb.id = v.posted_by
     WHERE v.id = ${voucherId}
  `);
  const raw = result.rows?.[0] as Record<string, unknown> | undefined;
  if (!raw) return null;

  return {
    id: String(raw.id),
    voucherNo: (raw.voucher_no as string) ?? null,
    status: raw.status as VoucherStatus,
    kind: raw.kind as "expense" | "settlement",
    settlement: raw.settlement as "paid" | "payable",
    supplierId: (raw.supplier_id as string) ?? null,
    supplierName: (raw.supplier_name as string) ?? null,
    payeeName: (raw.payee_name as string) ?? null,
    payee: String(raw.payee_name ?? raw.supplier_name ?? ""),
    voucherDate: String(raw.voucher_date).slice(0, 10),
    method: String(raw.method),
    reference: (raw.reference as string) ?? null,
    subject: (raw.subject as string) ?? null,
    notes: (raw.notes as string) ?? null,
    paymentAccountId: (raw.payment_account_id as string) ?? null,
    paymentAccountCode: (raw.payment_code as string) ?? null,
    paymentAccountName: (raw.payment_name as string) ?? null,
    purchaseOrderId: (raw.purchase_order_id as string) ?? null,
    purchaseOrderNo: (raw.purchase_order_no as string) ?? null,
    subtotal: parseAmount(String(raw.subtotal)),
    taxTotal: parseAmount(String(raw.tax_total)),
    total: parseAmount(String(raw.total)),
    journalId: (raw.journal_id as string) ?? null,
    journalNo: (raw.journal_no as string) ?? null,
    voidJournalId: (raw.void_journal_id as string) ?? null,
    voidReason: (raw.void_reason as string) ?? null,
    createdBy: String(raw.created_by),
    createdByName: (raw.created_by_name as string) ?? null,
    approvedByName: (raw.approved_by_name as string) ?? null,
    postedByName: (raw.posted_by_name as string) ?? null,
    createdAt: raw.created_at as Date | string,
    lines: await readPurchaseLines(db, "payment_voucher_line", "voucher_id", voucherId),
  };
}

export interface PurchaseOrderSummary {
  id: string;
  orderNo: string | null;
  status: PurchaseOrderStatus;
  supplierName: string;
  orderDate: string;
  requiredBy: string | null;
  subject: string | null;
  total: Amount;
  /** Lines not yet fully delivered. */
  outstandingLines: number;
}

export async function listPurchaseOrders(
  db: Executor,
  filters: { status?: PurchaseOrderStatus; supplierId?: string; search?: string; limit?: number } = {},
): Promise<PurchaseOrderSummary[]> {
  const where = [sql`true`];
  if (filters.status) where.push(sql`p.status = ${filters.status}`);
  if (filters.supplierId) where.push(sql`p.supplier_id = ${filters.supplierId}`);
  if (filters.search?.trim()) {
    const term = `%${filters.search.trim().toLowerCase()}%`;
    where.push(
      sql`(lower(coalesce(p.order_no, '')) LIKE ${term} OR lower(coalesce(p.subject, '')) LIKE ${term} OR lower(s.name) LIKE ${term})`,
    );
  }

  const result = await db.execute<{
    id: string;
    order_no: string | null;
    status: PurchaseOrderStatus;
    supplier_name: string;
    order_date: string;
    required_by: string | null;
    subject: string | null;
    total: string;
    outstanding_lines: number;
  }>(sql`
    SELECT p.id, p.order_no, p.status, s.name AS supplier_name, p.order_date, p.required_by,
           p.subject, p.total,
           (SELECT count(*) FROM accounting.purchase_order_line l
             WHERE l.order_id = p.id AND l.quantity_received < l.quantity)::int AS outstanding_lines
      FROM accounting.purchase_order p
      JOIN accounting.supplier s ON s.id = p.supplier_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY p.order_date DESC, p.created_at DESC
     LIMIT ${Math.min(Math.max(filters.limit ?? 100, 1), 500)}
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    orderNo: row.order_no,
    status: row.status,
    supplierName: row.supplier_name,
    orderDate: String(row.order_date).slice(0, 10),
    requiredBy: row.required_by ? String(row.required_by).slice(0, 10) : null,
    subject: row.subject,
    total: parseAmount(row.total),
    outstandingLines: row.outstanding_lines,
  }));
}

export interface VoucherSummary {
  id: string;
  voucherNo: string | null;
  status: VoucherStatus;
  kind: "expense" | "settlement";
  settlement: "paid" | "payable";
  payee: string;
  voucherDate: string;
  method: string;
  subject: string | null;
  total: Amount;
}

export async function listVouchers(
  db: Executor,
  filters: {
    status?: VoucherStatus;
    supplierId?: string;
    purchaseOrderId?: string;
    search?: string;
    limit?: number;
  } = {},
): Promise<VoucherSummary[]> {
  const where = [sql`true`];
  if (filters.status) where.push(sql`v.status = ${filters.status}`);
  if (filters.supplierId) where.push(sql`v.supplier_id = ${filters.supplierId}`);
  if (filters.purchaseOrderId) where.push(sql`v.purchase_order_id = ${filters.purchaseOrderId}`);
  if (filters.search?.trim()) {
    const term = `%${filters.search.trim().toLowerCase()}%`;
    where.push(sql`(
      lower(coalesce(v.voucher_no, '')) LIKE ${term}
      OR lower(coalesce(v.subject, '')) LIKE ${term}
      OR lower(coalesce(v.payee_name, '')) LIKE ${term}
      OR lower(coalesce(s.name, '')) LIKE ${term}
    )`);
  }

  const result = await db.execute<{
    id: string;
    voucher_no: string | null;
    status: VoucherStatus;
    kind: "expense" | "settlement";
    settlement: "paid" | "payable";
    payee: string;
    voucher_date: string;
    method: string;
    subject: string | null;
    total: string;
  }>(sql`
    SELECT v.id, v.voucher_no, v.status, v.kind, v.settlement,
           COALESCE(v.payee_name, s.name, '') AS payee,
           v.voucher_date, v.method, v.subject, v.total
      FROM accounting.payment_voucher v
      LEFT JOIN accounting.supplier s ON s.id = v.supplier_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY v.voucher_date DESC, v.created_at DESC
     LIMIT ${Math.min(Math.max(filters.limit ?? 100, 1), 500)}
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    voucherNo: row.voucher_no,
    status: row.status,
    kind: row.kind,
    settlement: row.settlement,
    payee: row.payee,
    voucherDate: String(row.voucher_date).slice(0, 10),
    method: row.method,
    subject: row.subject,
    total: parseAmount(row.total),
  }));
}
