"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@cac/db";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
  closeFiscalYear,
  createAccount,
  createCustomer,
  createDraftJournal,
  createFiscalYear,
  createSupplier,
  deleteDraftJournal,
  postJournal,
  reverseJournal,
  setAccountActive,
  transitionPeriod,
  updateAccount,
  updateCustomer,
  updateDraftJournal,
  updateSupplier,
  type JournalLineInput,
  type PeriodTransition,
  type Principal,
} from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";

/**
 * Accounting server actions.
 *
 * Every one of these is the real boundary of the application: the browser can
 * send whatever it likes, so each action re-authenticates, re-authorises and
 * re-validates from scratch. Nothing trusts that the form it came from was the
 * one we rendered.
 *
 * The shape is always the same, and deliberately so:
 *
 *   1. resolve the caller from the session cookie;
 *   2. open a transaction;
 *   3. call the business function in @cac/core, which checks the capability,
 *      applies the rules and writes its own audit row in that transaction;
 *   4. commit, revalidate, redirect.
 *
 * Step 3 is where the logic lives, not here. This file is plumbing — it exists
 * so the same operations can later be driven from an import, a scheduled task or
 * an API without any of the rules being re-implemented.
 */

export interface FormState {
  error?: string;
  field?: string;
  notice?: string;
}

/**
 * Turns an exception into something worth reading.
 *
 * Errors we raised on purpose carry a message written for the user. Anything
 * else is a fault: the detail goes to the server log, and the browser gets an
 * apology. Echoing an unexpected error back would leak constraint names, table
 * names and occasionally data.
 */
function toFormState(error: unknown, fallback: string): FormState {
  if (error instanceof ValidationError) return { error: error.message, field: error.field };
  if (error instanceof ConflictError) return { error: error.message };
  if (error instanceof NotFoundError) return { error: error.message };
  if (error instanceof AuthorizationError || error instanceof AuthenticationError) {
    return { error: error.message };
  }

  // Database guards produce messages written for an engineer. They mean the
  // application let something through that the schema caught, which is a bug
  // worth seeing in the log rather than in the UI.
  console.error("[accounting] unexpected error:", error);
  return { error: fallback };
}

const text = (form: FormData, key: string): string => String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string): string | null => text(form, key) || null;

/**
 * Reads the repeating line rows out of a journal form.
 *
 * The form posts `lines[0].account`, `lines[0].debit` and so on. Rows are read
 * by index until they run out rather than from a count field, so a stale count
 * cannot make the server read rows that were not submitted.
 */
function readLines(form: FormData): JournalLineInput[] {
  const lines: JournalLineInput[] = [];
  for (let index = 0; form.has(`lines[${index}].account`); index += 1) {
    lines.push({
      accountId: String(form.get(`lines[${index}].account`) ?? "") || undefined,
      debit: String(form.get(`lines[${index}].debit`) ?? "").trim(),
      credit: String(form.get(`lines[${index}].credit`) ?? "").trim(),
      description: String(form.get(`lines[${index}].description`) ?? "").trim() || null,
      costCentreId: String(form.get(`lines[${index}].costCentre`) ?? "") || null,
    });
  }
  return lines;
}

/** Shared preamble: caller, database handle and audit context. */
async function begin(capability: string): Promise<{
  principal: Principal;
  db: Awaited<ReturnType<typeof getDb>>;
  context: Awaited<ReturnType<typeof getRequestContext>>;
}> {
  const principal = await requireCapability(capability);
  const db = await getDb();
  const context = await getRequestContext();
  return { principal, db, context };
}

// ---------------------------------------------------------------------------
// Fiscal calendar
// ---------------------------------------------------------------------------

export async function setUpFiscalYear(_prev: FormState, form: FormData): Promise<FormState> {
  const startsOn = text(form, "startsOn");
  const periods = Number(text(form, "periods") || "12");

  try {
    const { principal, db, context } = await begin("accounting.period.manage");
    await db.transaction(async (tx) => {
      await createFiscalYear(
        tx,
        principal,
        {
          startsOn,
          periods: periods === 4 ? 4 : periods === 1 ? 1 : 12,
          name: optional(form, "name") ?? undefined,
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "The fiscal year could not be created.");
  }

  revalidatePath("/accounting/periods");
  revalidatePath("/accounting");
  return { notice: "Fiscal year created." };
}

export async function changePeriodStatus(_prev: FormState, form: FormData): Promise<FormState> {
  const periodId = text(form, "periodId");
  const transition = text(form, "transition") as PeriodTransition;

  if (!["lock", "unlock", "close", "reopen"].includes(transition)) {
    return { error: "That is not a change this screen can make." };
  }

  const capability =
    transition === "lock" || transition === "unlock"
      ? "accounting.period.lock"
      : "accounting.period.close";

  try {
    const { principal, db, context } = await begin(capability);
    await db.transaction(async (tx) => {
      await transitionPeriod(tx, principal, periodId, transition, {
        reason: optional(form, "reason"),
        context,
      });
    });
  } catch (error) {
    return toFormState(error, "The period could not be changed.");
  }

  revalidatePath("/accounting/periods");
  revalidatePath("/accounting");
  return { notice: `Period ${transition === "reopen" ? "reopened" : `${transition}ed`}.` };
}

export async function closeYear(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("accounting.period.close");
    await db.transaction(async (tx) => {
      await closeFiscalYear(tx, principal, text(form, "fiscalYearId"), {
        reason: optional(form, "reason"),
        context,
      });
    });
  } catch (error) {
    return toFormState(error, "The fiscal year could not be closed.");
  }

  revalidatePath("/accounting/periods");
  return { notice: "Fiscal year closed." };
}

// ---------------------------------------------------------------------------
// Journals
// ---------------------------------------------------------------------------

/**
 * Saves a draft: creates one, or replaces the contents of an existing one.
 *
 * On success it redirects to the journal, which is outside the try block on
 * purpose — Next.js implements redirect by throwing, and catching that inside
 * the transaction would roll back the very work being confirmed.
 */
export async function saveJournal(_prev: FormState, form: FormData): Promise<FormState> {
  const journalId = optional(form, "journalId");
  const input = {
    entryDate: text(form, "entryDate"),
    memo: optional(form, "memo"),
    lines: readLines(form),
  };

  let createdId = journalId;

  try {
    const { principal, db, context } = await begin("accounting.journal.create");
    await db.transaction(async (tx) => {
      if (journalId) {
        await updateDraftJournal(tx, principal, journalId, input, context);
      } else {
        const created = await createDraftJournal(tx, principal, input, context);
        createdId = created.id;
      }
    });
  } catch (error) {
    return toFormState(error, "The journal could not be saved.");
  }

  revalidatePath("/accounting/journals");
  redirect(`/accounting/journals/${createdId}`);
}

export async function postJournalAction(_prev: FormState, form: FormData): Promise<FormState> {
  const journalId = text(form, "journalId");

  try {
    const { principal, db, context } = await begin("accounting.journal.post");
    await db.transaction(async (tx) => {
      await postJournal(tx, principal, journalId, {
        reason: optional(form, "reason"),
        context,
      });
    });
  } catch (error) {
    return toFormState(error, "The journal could not be posted.");
  }

  revalidatePath(`/accounting/journals/${journalId}`);
  revalidatePath("/accounting/journals");
  revalidatePath("/accounting");
  return { notice: "Posted to the ledger." };
}

export async function reverseJournalAction(_prev: FormState, form: FormData): Promise<FormState> {
  const journalId = text(form, "journalId");
  let reversalId: string | undefined;

  try {
    const { principal, db, context } = await begin("accounting.journal.reverse");
    await db.transaction(async (tx) => {
      const result = await reverseJournal(tx, principal, journalId, {
        reason: text(form, "reason"),
        entryDate: optional(form, "entryDate") ?? undefined,
        context,
      });
      reversalId = result.journalId;
    });
  } catch (error) {
    return toFormState(error, "The journal could not be reversed.");
  }

  revalidatePath(`/accounting/journals/${journalId}`);
  revalidatePath("/accounting/journals");
  revalidatePath("/accounting");
  redirect(`/accounting/journals/${reversalId}`);
}

export async function deleteJournalAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("accounting.journal.create");
    await db.transaction(async (tx) => {
      await deleteDraftJournal(tx, principal, text(form, "journalId"), {
        reason: optional(form, "reason"),
        context,
      });
    });
  } catch (error) {
    return toFormState(error, "The draft could not be deleted.");
  }

  revalidatePath("/accounting/journals");
  redirect("/accounting/journals");
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

export async function createAccountAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("accounting.coa.manage");
    await db.transaction(async (tx) => {
      await createAccount(
        tx,
        principal,
        {
          code: text(form, "code"),
          name: text(form, "name"),
          type: text(form, "type") as "ASSET",
          parentCode: optional(form, "parentCode"),
          subtype: optional(form, "subtype"),
          isPostable: text(form, "isPostable") !== "heading",
          isContra: form.get("isContra") === "on",
          description: optional(form, "description"),
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "The account could not be created.");
  }

  revalidatePath("/accounting/accounts");
  return { notice: "Account created." };
}

export async function updateAccountAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("accounting.coa.manage");
    await db.transaction(async (tx) => {
      await updateAccount(
        tx,
        principal,
        text(form, "accountId"),
        {
          name: text(form, "name"),
          subtype: optional(form, "subtype"),
          description: optional(form, "description"),
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "The account could not be updated.");
  }

  revalidatePath("/accounting/accounts");
  return { notice: "Account updated." };
}

export async function toggleAccountAction(_prev: FormState, form: FormData): Promise<FormState> {
  const activate = text(form, "activate") === "true";

  try {
    const { principal, db, context } = await begin("accounting.coa.manage");
    await db.transaction(async (tx) => {
      await setAccountActive(tx, principal, text(form, "accountId"), activate, {
        reason: optional(form, "reason"),
        context,
      });
    });
  } catch (error) {
    return toFormState(error, "The account could not be changed.");
  }

  revalidatePath("/accounting/accounts");
  return { notice: activate ? "Account back in use." : "Account taken out of use." };
}

// ---------------------------------------------------------------------------
// Customers and suppliers
// ---------------------------------------------------------------------------

function partyInput(form: FormData) {
  const terms = text(form, "paymentTermsDays");
  return {
    code: text(form, "code"),
    name: text(form, "name"),
    registrationNo: optional(form, "registrationNo"),
    taxIdentifier: optional(form, "taxIdentifier"),
    email: optional(form, "email"),
    phone: optional(form, "phone"),
    address: optional(form, "address"),
    contactPerson: optional(form, "contactPerson"),
    paymentTermsDays: terms === "" ? 30 : Number(terms),
    notes: optional(form, "notes"),
    isActive: form.get("isActive") !== "off",
  };
}

export async function saveCustomerAction(_prev: FormState, form: FormData): Promise<FormState> {
  const customerId = optional(form, "customerId");

  try {
    const { principal, db, context } = await begin("accounting.customer.manage");
    await db.transaction(async (tx) => {
      const input = { ...partyInput(form), creditLimit: optional(form, "creditLimit") };
      if (customerId) await updateCustomer(tx, principal, customerId, input, context);
      else await createCustomer(tx, principal, input, context);
    });
  } catch (error) {
    return toFormState(error, "The customer could not be saved.");
  }

  revalidatePath("/accounting/customers");
  return { notice: customerId ? "Customer updated." : "Customer created." };
}

export async function saveSupplierAction(_prev: FormState, form: FormData): Promise<FormState> {
  const supplierId = optional(form, "supplierId");

  try {
    const { principal, db, context } = await begin("accounting.supplier.manage");
    await db.transaction(async (tx) => {
      const input = {
        ...partyInput(form),
        bankName: optional(form, "bankName"),
        bankAccountNo: optional(form, "bankAccountNo"),
      };
      if (supplierId) await updateSupplier(tx, principal, supplierId, input, context);
      else await createSupplier(tx, principal, input, context);
    });
  } catch (error) {
    return toFormState(error, "The supplier could not be saved.");
  }

  revalidatePath("/accounting/suppliers");
  return { notice: supplierId ? "Supplier updated." : "Supplier created." };
}
