"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@cac/db";
import {
  applySupplierCreditNote,
  approveSupplierInvoice,
  createSupplierCreditNote,
  createSupplierInvoice,
  deleteSupplierInvoice,
  postSupplierInvoice,
  removeSettlement,
  returnSupplierInvoiceToDraft,
  settleBills,
  submitSupplierInvoice,
  updateSupplierInvoice,
  voidSupplierInvoice,
  type DocumentLineInput,
} from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";
import { toFormState, type FormState } from "./action-errors";

export type { FormState };

/**
 * Server actions for the payables sub-ledger.
 *
 * Same shape as the purchasing actions: every one re-authenticates, opens a transaction, and
 * calls the business function in @cac/core, which checks the capability, applies the rules and
 * writes its own audit row inside the same transaction. Nothing here decides anything.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string) => text(form, key) || null;

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
      caseId: at("caseId") || null,
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

export async function saveBill(_prev: FormState, form: FormData): Promise<FormState> {
  const billId = optional(form, "billId");
  let id = billId;

  const input = {
    supplierId: text(form, "supplierId"),
    supplierDocNo: text(form, "supplierDocNo"),
    billDate: text(form, "billDate"),
    dueDate: text(form, "dueDate"),
    receivedDate: optional(form, "receivedDate") ?? undefined,
    subject: optional(form, "subject"),
    notes: optional(form, "notes"),
    purchaseOrderId: optional(form, "purchaseOrderId"),
    lines: readLines(form),
  };

  try {
    const { principal, db, context } = await begin("accounting.bill.create");
    await db.transaction(async (tx) => {
      if (billId) await updateSupplierInvoice(tx, principal, billId, input, context);
      else id = (await createSupplierInvoice(tx, principal, input, context)).id;
    });
  } catch (error) {
    return toFormState(error, "The bill could not be saved.");
  }

  revalidatePath("/accounting/bills");
  redirect(`/accounting/bills/${id}`);
}

export async function billAction(_prev: FormState, form: FormData): Promise<FormState> {
  const billId = text(form, "billId");
  const action = text(form, "action");
  let notice = "Done.";

  // The gate here is the coarse one that lets the request through to the business function; the
  // function itself checks the capability that actually governs the act, and, where it matters,
  // that the approver is not the maker.
  const capability =
    action === "approve" || action === "return"
      ? "accounting.bill.approve"
      : action === "post"
        ? "accounting.bill.post"
        : action === "void"
          ? "accounting.bill.void"
          : "accounting.bill.create";

  try {
    const { principal, db, context } = await begin(capability);
    await db.transaction(async (tx) => {
      switch (action) {
        case "submit":
          await submitSupplierInvoice(tx, principal, billId, context);
          notice = "Sent for approval.";
          break;
        case "return":
          await returnSupplierInvoiceToDraft(tx, principal, billId, text(form, "reason"), context);
          notice = "Sent back for correction.";
          break;
        case "approve":
          await approveSupplierInvoice(tx, principal, billId, context);
          notice = "Approved.";
          break;
        case "post": {
          const posted = await postSupplierInvoice(tx, principal, billId, context);
          notice = `Posted as ${posted.billNo}, journal ${posted.journalNo}.`;
          break;
        }
        case "void": {
          const voided = await voidSupplierInvoice(
            tx,
            principal,
            billId,
            text(form, "reason"),
            context,
          );
          notice = `Voided; reversed by journal ${voided.journalNo}.`;
          break;
        }
        case "delete":
          await deleteSupplierInvoice(tx, principal, billId, context);
          break;
        default:
          throw new Error(`Unknown action ${action}`);
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  if (action === "delete") {
    revalidatePath("/accounting/bills");
    redirect("/accounting/bills");
  }

  revalidatePath(`/accounting/bills/${billId}`);
  return { notice };
}

export async function raiseSupplierCreditNote(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const billId = text(form, "billId");
  let id: string | undefined;

  try {
    const { principal, db, context } = await begin("accounting.bill.create");
    await db.transaction(async (tx) => {
      id = (
        await createSupplierCreditNote(
          tx,
          principal,
          {
            billId,
            supplierDocNo: text(form, "supplierDocNo"),
            reason: text(form, "reason"),
            lines: readLines(form),
          },
          context,
        )
      ).id;
    });
  } catch (error) {
    return toFormState(error, "The credit note could not be raised.");
  }

  revalidatePath("/accounting/bills");
  redirect(`/accounting/bills/${id}`);
}

export async function settleBill(_prev: FormState, form: FormData): Promise<FormState> {
  const billId = text(form, "billId");

  try {
    const { principal, db, context } = await begin("accounting.bill.settle");
    await db.transaction(async (tx) => {
      const source = text(form, "source");
      if (source === "credit_note") {
        await applySupplierCreditNote(
          tx,
          principal,
          {
            creditNoteId: text(form, "creditNoteId"),
            billId,
            amount: text(form, "amount"),
          },
          context,
        );
      } else {
        await settleBills(
          tx,
          principal,
          {
            voucherId: text(form, "voucherId"),
            allocations: [{ billId, amount: text(form, "amount") }],
          },
          context,
        );
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be applied.");
  }

  revalidatePath(`/accounting/bills/${billId}`);
  return { notice: "Applied." };
}

export async function unsettleBill(_prev: FormState, form: FormData): Promise<FormState> {
  const billId = text(form, "billId");

  try {
    const { principal, db, context } = await begin("accounting.bill.settle");
    await db.transaction(async (tx) => {
      await removeSettlement(tx, principal, text(form, "settlementId"), text(form, "reason"), context);
    });
  } catch (error) {
    return toFormState(error, "That could not be removed.");
  }

  revalidatePath(`/accounting/bills/${billId}`);
  return { notice: "Removed." };
}
