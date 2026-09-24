"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@cac/db";
import {
  approvePurchaseOrder,
  approveVoucher,
  closePurchaseOrder,
  countPettyCash,
  createClaim,
  createPurchaseOrder,
  createVoucher,
  decideClaim,
  deleteClaim,
  deletePurchaseOrder,
  deleteVoucher,
  issuePurchaseOrder,
  markClaimReimbursed,
  postClaim,
  postPettyCash,
  postVoucher,
  receivePurchaseOrder,
  recordPettyCash,
  submitClaim,
  submitPurchaseOrder,
  submitVoucher,
  updateClaim,
  updatePurchaseOrder,
  updateVoucher,
  voidPettyCash,
  voidVoucher,
  type DocumentLineInput,
} from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";
import { toFormState, type FormState } from "./action-errors";

export type { FormState };

/**
 * Server actions for the money-out documents.
 *
 * Same shape as the sales actions. Every one re-authenticates, opens a
 * transaction, and calls the business function in @cac/core, which checks the
 * capability, applies the rules and writes its own audit row inside the same
 * transaction.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string) => text(form, key) || null;

/**
 * Reads the repeating line rows.
 *
 * Read by index until they run out rather than from a count field, so a stale or
 * forged count cannot make the server read rows that were not submitted.
 */
function readLines(form: FormData): DocumentLineInput[] {
  const lines: DocumentLineInput[] = [];
  for (let index = 0; form.has(`lines[${index}].description`); index += 1) {
    const at = (name: string) => String(form.get(`lines[${index}].${name}`) ?? "").trim();
    lines.push({
      description: at("description"),
      quantity: at("quantity") || "1",
      unit: at("unit") || null,
      unitPrice: at("unitPrice") || "0",
      taxCodeId: at("taxCodeId") || null,
      accountId: at("accountId") || null,
      costCentreId: at("costCentreId") || null,
      spentOn: at("spentOn") || null,
      receiptRef: at("receiptRef") || null,
    });
  }
  return lines;
}

async function begin(capability: string) {
  const principal = await requireCapability(capability);
  const db = await getDb();
  const context = await getRequestContext();
  return { principal, db, context };
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export async function savePurchaseOrder(_prev: FormState, form: FormData): Promise<FormState> {
  const orderId = optional(form, "orderId");
  let id = orderId;

  const input = {
    supplierId: text(form, "supplierId"),
    orderDate: optional(form, "orderDate") ?? undefined,
    requiredBy: optional(form, "requiredBy"),
    reference: optional(form, "reference"),
    subject: optional(form, "subject"),
    deliveryNote: optional(form, "deliveryNote"),
    notes: optional(form, "notes"),
    lines: readLines(form),
  };

  try {
    const { principal, db, context } = await begin("accounting.po.create");
    await db.transaction(async (tx) => {
      if (orderId) await updatePurchaseOrder(tx, principal, orderId, input, context);
      else id = (await createPurchaseOrder(tx, principal, input, context)).id;
    });
  } catch (error) {
    return toFormState(error, "The purchase order could not be saved.");
  }

  revalidatePath("/accounting/purchase-orders");
  redirect(`/accounting/purchase-orders/${id}`);
}

export async function purchaseOrderAction(_prev: FormState, form: FormData): Promise<FormState> {
  const orderId = text(form, "orderId");
  const action = text(form, "action");
  let notice = "Done.";

  const capability =
    action === "approve" || action === "cancel"
      ? "accounting.po.approve"
      : action === "receive"
        ? "accounting.po.receive"
        : action === "close"
          ? "accounting.po.close"
          : "accounting.po.create";

  try {
    const { principal, db, context } = await begin(capability);
    await db.transaction(async (tx) => {
      switch (action) {
        case "submit":
          await submitPurchaseOrder(tx, principal, orderId, context);
          notice = "Sent for approval.";
          break;
        case "approve":
          await approvePurchaseOrder(tx, principal, orderId, context);
          notice = "Approved.";
          break;
        case "issue": {
          const issued = await issuePurchaseOrder(tx, principal, orderId, context);
          notice = `Sent to the supplier as ${issued.orderNo}.`;
          break;
        }
        case "receive": {
          // Quantities arrive as receive[<lineId>].
          const received: Array<{ lineId: string; quantity: string }> = [];
          for (const [key, value] of form.entries()) {
            const match = /^receive\[(.+)\]$/.exec(key);
            if (match && String(value).trim() !== "") {
              received.push({ lineId: match[1]!, quantity: String(value).trim() });
            }
          }
          const result = await receivePurchaseOrder(tx, principal, orderId, received, context);
          notice = result.complete
            ? "Everything on this order has now been received."
            : "Delivery recorded. Some lines are still outstanding.";
          break;
        }
        case "close":
          await closePurchaseOrder(tx, principal, orderId, { context });
          notice = "Order closed.";
          break;
        case "cancel":
          await closePurchaseOrder(tx, principal, orderId, {
            cancel: true,
            reason: text(form, "reason"),
            context,
          });
          notice = "Order cancelled.";
          break;
        default:
          throw new Error(`Unknown purchase order action: ${action}`);
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  revalidatePath(`/accounting/purchase-orders/${orderId}`);
  revalidatePath("/accounting/purchase-orders");
  return { notice };
}

export async function deletePurchaseOrderAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("accounting.po.create");
    await db.transaction(async (tx) => {
      await deletePurchaseOrder(tx, principal, text(form, "orderId"), {
        reason: optional(form, "reason"),
        context,
      });
    });
  } catch (error) {
    return toFormState(error, "The draft could not be deleted.");
  }

  revalidatePath("/accounting/purchase-orders");
  redirect("/accounting/purchase-orders");
}

// ---------------------------------------------------------------------------
// Payment vouchers
// ---------------------------------------------------------------------------

export async function saveVoucher(_prev: FormState, form: FormData): Promise<FormState> {
  const voucherId = optional(form, "voucherId");
  let id = voucherId;

  const input = {
    supplierId: optional(form, "supplierId"),
    payeeName: optional(form, "payeeName"),
    voucherDate: optional(form, "voucherDate") ?? undefined,
    reference: optional(form, "reference"),
    subject: optional(form, "subject"),
    kind: (optional(form, "kind") ?? "expense") as "expense",
    settlement: (optional(form, "settlement") ?? "paid") as "paid",
    method: (optional(form, "method") ?? "transfer") as "transfer",
    paymentAccountId: optional(form, "paymentAccountId"),
    purchaseOrderId: optional(form, "purchaseOrderId"),
    notes: optional(form, "notes"),
    lines: readLines(form),
  };

  try {
    const { principal, db, context } = await begin("accounting.voucher.create");
    await db.transaction(async (tx) => {
      if (voucherId) await updateVoucher(tx, principal, voucherId, input, context);
      else id = (await createVoucher(tx, principal, input, context)).id;
    });
  } catch (error) {
    return toFormState(error, "The voucher could not be saved.");
  }

  revalidatePath("/accounting/vouchers");
  redirect(`/accounting/vouchers/${id}`);
}

export async function voucherAction(_prev: FormState, form: FormData): Promise<FormState> {
  const voucherId = text(form, "voucherId");
  const action = text(form, "action");
  let notice = "Done.";

  const capability =
    action === "approve"
      ? "accounting.voucher.view"
      : action === "post"
        ? "accounting.voucher.pay"
        : action === "void"
          ? "accounting.voucher.approve"
          : "accounting.voucher.create";

  try {
    const { principal, db, context } = await begin(capability);
    await db.transaction(async (tx) => {
      switch (action) {
        case "submit":
          await submitVoucher(tx, principal, voucherId, context);
          notice = "Sent for approval.";
          break;
        case "approve":
          // Which capability this needs depends on the amount, so approveVoucher
          // resolves and checks it rather than the gate above.
          await approveVoucher(tx, principal, voucherId, context);
          notice = "Approved.";
          break;
        case "post": {
          const posted = await postVoucher(tx, principal, voucherId, context);
          notice = `Posted as ${posted.voucherNo}.`;
          break;
        }
        case "void":
          await voidVoucher(tx, principal, voucherId, { reason: text(form, "reason"), context });
          notice = "Voided, and the ledger entry reversed.";
          break;
        case "delete":
          await deleteVoucher(tx, principal, voucherId, {
            reason: optional(form, "reason"),
            context,
          });
          notice = "Draft discarded.";
          break;
        default:
          throw new Error(`Unknown voucher action: ${action}`);
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  revalidatePath(`/accounting/vouchers/${voucherId}`);
  revalidatePath("/accounting/vouchers");
  revalidatePath("/accounting");
  if (action === "delete") redirect("/accounting/vouchers");
  return { notice };
}

// ---------------------------------------------------------------------------
// Petty cash
// ---------------------------------------------------------------------------

export async function recordPettyCashAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("accounting.pettycash.create");
    await db.transaction(async (tx) => {
      await recordPettyCash(
        tx,
        principal,
        {
          kind: (text(form, "kind") || "expense") as "expense",
          txnDate: optional(form, "txnDate") ?? undefined,
          description: text(form, "description"),
          amount: text(form, "amount"),
          counterpartAccountId: optional(form, "counterpartAccountId"),
          taxCodeId: optional(form, "taxCodeId"),
          receiptRef: optional(form, "receiptRef"),
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "The entry could not be recorded.");
  }

  revalidatePath("/accounting/petty-cash");
  return { notice: "Recorded. It reaches the ledger when somebody posts it." };
}

export async function pettyCashAction(_prev: FormState, form: FormData): Promise<FormState> {
  const txnId = text(form, "txnId");
  const action = text(form, "action");
  let notice = "Done.";

  try {
    const { principal, db, context } = await begin("accounting.pettycash.approve");
    await db.transaction(async (tx) => {
      if (action === "post") {
        const posted = await postPettyCash(tx, principal, txnId, context);
        notice = `Posted as ${posted.txnNo}.`;
      } else if (action === "void") {
        await voidPettyCash(tx, principal, txnId, { reason: text(form, "reason"), context });
        notice = "Voided, and the ledger entry reversed.";
      } else {
        throw new Error(`Unknown petty cash action: ${action}`);
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  revalidatePath("/accounting/petty-cash");
  revalidatePath("/accounting");
  return { notice };
}

export async function countPettyCashAction(_prev: FormState, form: FormData): Promise<FormState> {
  let message = "";

  try {
    const { principal, db, context } = await begin("accounting.pettycash.reconcile");
    const result = await db.transaction(async (tx) =>
      countPettyCash(
        tx,
        principal,
        {
          countedAmount: text(form, "countedAmount"),
          countedOn: optional(form, "countedOn") ?? undefined,
          notes: optional(form, "notes"),
        },
        context,
      ),
    );

    message =
      result.difference === 0n
        ? "Counted, and the float agrees with the ledger exactly."
        : "Counted. The difference has been posted as an adjustment, with your name against it.";
  } catch (error) {
    return toFormState(error, "The count could not be recorded.");
  }

  revalidatePath("/accounting/petty-cash");
  return { notice: message };
}

// ---------------------------------------------------------------------------
// Expense claims
// ---------------------------------------------------------------------------

export async function saveClaim(_prev: FormState, form: FormData): Promise<FormState> {
  const claimId = optional(form, "claimId");
  let id = claimId;

  const input = {
    claimDate: optional(form, "claimDate") ?? undefined,
    periodFrom: optional(form, "periodFrom"),
    periodTo: optional(form, "periodTo"),
    subject: optional(form, "subject"),
    notes: optional(form, "notes"),
    lines: readLines(form),
  };

  try {
    const { principal, db, context } = await begin("accounting.claim.create");
    await db.transaction(async (tx) => {
      if (claimId) await updateClaim(tx, principal, claimId, input, context);
      else id = (await createClaim(tx, principal, input, context)).id;
    });
  } catch (error) {
    return toFormState(error, "The claim could not be saved.");
  }

  revalidatePath("/accounting/claims");
  redirect(`/accounting/claims/${id}`);
}

export async function claimAction(_prev: FormState, form: FormData): Promise<FormState> {
  const claimId = text(form, "claimId");
  const action = text(form, "action");
  let notice = "Done.";

  const capability =
    action === "submit" || action === "delete"
      ? "accounting.claim.create"
      : action === "reimburse"
        ? "accounting.claim.reimburse"
        : "accounting.claim.approve";

  try {
    const { principal, db, context } = await begin(capability);
    await db.transaction(async (tx) => {
      switch (action) {
        case "submit": {
          const submitted = await submitClaim(tx, principal, claimId, context);
          notice = `Submitted as ${submitted.claimNo}.`;
          break;
        }
        case "approve":
          await decideClaim(tx, principal, claimId, "approved", { context });
          notice = "Approved.";
          break;
        case "reject":
          await decideClaim(tx, principal, claimId, "rejected", {
            reason: text(form, "reason"),
            context,
          });
          notice = "Rejected. The claimant can see why.";
          break;
        case "post":
          await postClaim(tx, principal, claimId, context);
          notice = "Posted. The amount is now owed to the claimant.";
          break;
        case "reimburse":
          await markClaimReimbursed(tx, principal, claimId, text(form, "voucherId"), context);
          notice = "Marked as reimbursed.";
          break;
        case "delete":
          await deleteClaim(tx, principal, claimId, {
            reason: optional(form, "reason"),
            context,
          });
          notice = "Draft discarded.";
          break;
        default:
          throw new Error(`Unknown claim action: ${action}`);
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  revalidatePath(`/accounting/claims/${claimId}`);
  revalidatePath("/accounting/claims");
  if (action === "delete") redirect("/accounting/claims");
  return { notice };
}
