"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@cac/db";
import {
  addTaxRate,
  allocateCreditNote,
  allocateReceipt,
  approveInvoice,
  convertQuotationToInvoice,
  createCreditNote,
  createInvoice,
  createQuotation,
  createReceipt,
  decideQuotation,
  deleteInvoice,
  deleteReceipt,
  issueInvoice,
  postReceipt,
  removeAllocation,
  returnInvoiceToDraft,
  sendQuotation,
  submitInvoice,
  updateInvoice,
  updateQuotation,
  updateReceipt,
  voidInvoice,
  voidReceipt,
  type DocumentLineInput,
} from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";
import { toFormState, type FormState } from "./action-errors";

export type { FormState };

/**
 * Server actions for the sales cycle.
 *
 * Same shape as the ledger actions: resolve the caller, open a transaction, call
 * the business function in @cac/core — which checks the capability, applies the
 * rules and writes its own audit row inside that transaction — then commit and
 * revalidate.
 *
 * Nothing about a total, a tax figure or a status arrives from the browser. The
 * form sends descriptions, quantities and unit prices; everything else is
 * computed here.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string) => text(form, key) || null;

/**
 * Reads the repeating line rows out of a document form.
 *
 * Rows are read by index until they run out rather than from a count field, so a
 * stale or forged count cannot make the server read rows that were not submitted.
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
      discountPercent: at("discountPercent") || null,
      taxCodeId: at("taxCodeId") || null,
      accountId: at("accountId") || null,
    });
  }
  return lines;
}

function documentInput(form: FormData) {
  return {
    customerId: text(form, "customerId"),
    documentDate: optional(form, "documentDate") ?? undefined,
    dueDate: optional(form, "dueDate") ?? undefined,
    reference: optional(form, "reference"),
    subject: optional(form, "subject"),
    notes: optional(form, "notes"),
    terms: optional(form, "terms"),
    lines: readLines(form),
  };
}

async function begin(capability: string) {
  const principal = await requireCapability(capability);
  const db = await getDb();
  const context = await getRequestContext();
  return { principal, db, context };
}

// ---------------------------------------------------------------------------
// Quotations
// ---------------------------------------------------------------------------

export async function saveQuotation(_prev: FormState, form: FormData): Promise<FormState> {
  const quotationId = optional(form, "quotationId");
  let id = quotationId;

  try {
    const { principal, db, context } = await begin("accounting.quotation.create");
    await db.transaction(async (tx) => {
      if (quotationId) await updateQuotation(tx, principal, quotationId, documentInput(form), context);
      else id = (await createQuotation(tx, principal, documentInput(form), context)).id;
    });
  } catch (error) {
    return toFormState(error, "The quotation could not be saved.");
  }

  revalidatePath("/accounting/quotations");
  redirect(`/accounting/quotations/${id}`);
}

export async function quotationAction(_prev: FormState, form: FormData): Promise<FormState> {
  const quotationId = text(form, "quotationId");
  const action = text(form, "action");
  let invoiceId: string | undefined;

  // Each branch asks for the capability it actually needs. Every one of them used to ask for
  // `quotation.create`, which is how accepting a quotation ended up requiring nothing more than being
  // able to write one.
  const needed =
    action === "accept" || action === "decline"
      ? "accounting.quotation.approve"
      : action === "convert"
        ? "accounting.quotation.convert"
        : "accounting.quotation.create";

  try {
    const { principal, db, context } = await begin(needed);
    await db.transaction(async (tx) => {
      switch (action) {
        case "send":
          await sendQuotation(tx, principal, quotationId, context);
          break;
        case "accept":
          await decideQuotation(tx, principal, quotationId, "accepted", { context });
          break;
        case "decline":
          await decideQuotation(tx, principal, quotationId, "declined", {
            reason: optional(form, "reason"),
            context,
          });
          break;
        case "convert":
          invoiceId = (await convertQuotationToInvoice(tx, principal, quotationId, context)).invoiceId;
          break;
        default:
          throw new Error(`Unknown quotation action: ${action}`);
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  revalidatePath(`/accounting/quotations/${quotationId}`);
  revalidatePath("/accounting/quotations");
  if (invoiceId) redirect(`/accounting/invoices/${invoiceId}`);
  return { notice: "Done." };
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export async function saveInvoice(_prev: FormState, form: FormData): Promise<FormState> {
  const invoiceId = optional(form, "invoiceId");
  let id = invoiceId;

  try {
    const { principal, db, context } = await begin("accounting.invoice.create");
    await db.transaction(async (tx) => {
      if (invoiceId) await updateInvoice(tx, principal, invoiceId, documentInput(form), context);
      else id = (await createInvoice(tx, principal, documentInput(form), context)).id;
    });
  } catch (error) {
    return toFormState(error, "The invoice could not be saved.");
  }

  revalidatePath("/accounting/invoices");
  redirect(`/accounting/invoices/${id}`);
}

/**
 * Every step of the invoice lifecycle, in one action.
 *
 * One entry point rather than six because they share the plumbing exactly; the
 * differences are all inside @cac/core, where each step checks its own capability.
 * The `action` string is matched against a closed set — an unknown value is a bug
 * or an attack, and either way it stops here.
 */
export async function invoiceAction(_prev: FormState, form: FormData): Promise<FormState> {
  const invoiceId = text(form, "invoiceId");
  const action = text(form, "action");
  let notice = "Done.";
  let creditNoteId: string | undefined;

  const capability =
    action === "submit" || action === "return"
      ? "accounting.invoice.create"
      : action === "approve"
        ? "accounting.invoice.view"
        : action === "issue"
          ? "accounting.invoice.issue"
          : "accounting.invoice.void";

  try {
    const { principal, db, context } = await begin(capability);
    await db.transaction(async (tx) => {
      switch (action) {
        case "submit":
          await submitInvoice(tx, principal, invoiceId, context);
          notice = "Sent for approval.";
          break;
        case "return":
          await returnInvoiceToDraft(tx, principal, invoiceId, {
            reason: text(form, "reason"),
            context,
          });
          notice = "Sent back to the preparer.";
          break;
        case "approve":
          // The capability this needs depends on the amount, so approveInvoice
          // resolves and checks it rather than the gate above.
          await approveInvoice(tx, principal, invoiceId, context);
          notice = "Approved.";
          break;
        case "issue": {
          const issued = await issueInvoice(tx, principal, invoiceId, context);
          notice = `Issued as ${issued.invoiceNo}.`;
          break;
        }
        case "void":
          await voidInvoice(tx, principal, invoiceId, { reason: text(form, "reason"), context });
          notice = "Voided, and the ledger entry reversed.";
          break;
        case "credit":
          creditNoteId = (
            await createCreditNote(tx, principal, { invoiceId, reason: text(form, "reason") }, context)
          ).id;
          break;
        default:
          throw new Error(`Unknown invoice action: ${action}`);
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  revalidatePath(`/accounting/invoices/${invoiceId}`);
  revalidatePath("/accounting/invoices");
  revalidatePath("/accounting");
  if (creditNoteId) redirect(`/accounting/invoices/${creditNoteId}`);
  return { notice };
}

export async function deleteInvoiceAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("accounting.invoice.create");
    await db.transaction(async (tx) => {
      await deleteInvoice(tx, principal, text(form, "invoiceId"), {
        reason: optional(form, "reason"),
        context,
      });
    });
  } catch (error) {
    return toFormState(error, "The draft could not be deleted.");
  }

  revalidatePath("/accounting/invoices");
  redirect("/accounting/invoices");
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export async function saveReceipt(_prev: FormState, form: FormData): Promise<FormState> {
  const receiptId = optional(form, "receiptId");
  let id = receiptId;

  const input = {
    customerId: text(form, "customerId"),
    receiptDate: optional(form, "receiptDate") ?? undefined,
    method: (optional(form, "method") ?? "transfer") as "transfer",
    reference: optional(form, "reference"),
    depositAccountId: optional(form, "depositAccountId"),
    amount: text(form, "amount"),
    notes: optional(form, "notes"),
  };

  try {
    const { principal, db, context } = await begin("accounting.receipt.create");
    await db.transaction(async (tx) => {
      if (receiptId) await updateReceipt(tx, principal, receiptId, input, context);
      else id = (await createReceipt(tx, principal, input, context)).id;
    });
  } catch (error) {
    return toFormState(error, "The receipt could not be saved.");
  }

  revalidatePath("/accounting/receipts");
  redirect(`/accounting/receipts/${id}`);
}

export async function receiptAction(_prev: FormState, form: FormData): Promise<FormState> {
  const receiptId = text(form, "receiptId");
  const action = text(form, "action");
  let notice = "Done.";

  const capability =
    action === "delete" ? "accounting.receipt.create" : "accounting.receipt.approve";

  try {
    const { principal, db, context } = await begin(capability);
    await db.transaction(async (tx) => {
      switch (action) {
        case "post": {
          const posted = await postReceipt(tx, principal, receiptId, context);
          notice = `Posted as ${posted.receiptNo}.`;
          break;
        }
        case "void":
          await voidReceipt(tx, principal, receiptId, { reason: text(form, "reason"), context });
          notice = "Voided, and the ledger entry reversed.";
          break;
        case "delete":
          await deleteReceipt(tx, principal, receiptId, {
            reason: optional(form, "reason"),
            context,
          });
          notice = "Draft discarded.";
          break;
        default:
          throw new Error(`Unknown receipt action: ${action}`);
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  revalidatePath(`/accounting/receipts/${receiptId}`);
  revalidatePath("/accounting/receipts");
  revalidatePath("/accounting");
  if (action === "delete") redirect("/accounting/receipts");
  return { notice };
}

/**
 * Matches a receipt (or a credit note) against invoices.
 *
 * The form posts `allocation[<invoiceId>]` amounts; blank and zero rows are
 * dropped, and the whole set replaces whatever was there before.
 */
export async function allocateAction(_prev: FormState, form: FormData): Promise<FormState> {
  const receiptId = optional(form, "receiptId");
  const creditNoteId = optional(form, "creditNoteId");

  const allocations: Array<{ invoiceId: string; amount: string }> = [];
  for (const [key, value] of form.entries()) {
    const match = /^allocation\[(.+)\]$/.exec(key);
    if (!match) continue;
    const amount = String(value).trim();
    if (amount && amount !== "0" && Number.parseFloat(amount) !== 0) {
      allocations.push({ invoiceId: match[1]!, amount });
    }
  }

  try {
    const { principal, db, context } = await begin("accounting.receipt.allocate");
    await db.transaction(async (tx) => {
      if (creditNoteId) await allocateCreditNote(tx, principal, creditNoteId, allocations, context);
      else if (receiptId) await allocateReceipt(tx, principal, receiptId, allocations, context);
      else throw new Error("Nothing to allocate.");
    });
  } catch (error) {
    return toFormState(error, "The allocation could not be saved.");
  }

  if (receiptId) revalidatePath(`/accounting/receipts/${receiptId}`);
  if (creditNoteId) revalidatePath(`/accounting/invoices/${creditNoteId}`);
  revalidatePath("/accounting/invoices");
  return { notice: "Allocation saved." };
}

export async function removeAllocationAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("accounting.receipt.allocate");
    await db.transaction(async (tx) => {
      await removeAllocation(tx, principal, text(form, "allocationId"), {
        reason: optional(form, "reason"),
        context,
      });
    });
  } catch (error) {
    return toFormState(error, "The allocation could not be removed.");
  }

  revalidatePath("/accounting/receipts");
  revalidatePath("/accounting/invoices");
  return { notice: "Allocation removed." };
}

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

export async function addTaxRateAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("accounting.tax.manage");
    await db.transaction(async (tx) => {
      await addTaxRate(
        tx,
        principal,
        {
          taxCodeId: text(form, "taxCodeId"),
          rate: text(form, "rate"),
          effectiveFrom: text(form, "effectiveFrom"),
          effectiveTo: optional(form, "effectiveTo"),
          sourceRef: text(form, "sourceRef"),
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "The rate could not be recorded.");
  }

  revalidatePath("/accounting/tax");
  return { notice: "Rate recorded." };
}
