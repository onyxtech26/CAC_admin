"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@cac/db";
import {
  abandonReconciliation,
  completeReconciliation,
  createBankAccount,
  deleteStatement,
  ignoreStatementLine,
  importStatement,
  matchStatementLine,
  openReconciliation,
  parseStatement,
  postStatementLine,
  restoreStatementLine,
  unmatchStatementLine,
  updateBankAccount,
  type ColumnMapping,
} from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";
import { toFormState, type FormState } from "../action-errors";

export type { FormState };

/**
 * Server actions for the bank.
 *
 * The import one is the odd shape here. Everything else takes a form and does one
 * thing; importing is parse-then-confirm, and the file has to survive the step in
 * between. It is carried in a hidden field rather than held on the server between
 * requests: a server-side staging table would be a second place for a
 * half-imported statement to live, and the statement is small enough that this is
 * simply cheaper and has no cleanup story to get wrong.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string) => text(form, key) || null;
const numeric = (form: FormData, key: string) => {
  const value = text(form, key);
  return value === "" ? undefined : Number(value);
};

async function begin(capability: string) {
  const principal = await requireCapability(capability);
  const db = await getDb();
  const context = await getRequestContext();
  return { principal, db, context };
}

/** Rebuilds the mapping the preview screen submitted back. */
function readMapping(form: FormData): Partial<ColumnMapping> {
  const mapping: Partial<ColumnMapping> = {};
  const at = (key: keyof ColumnMapping) => numeric(form, `mapping.${key}`);

  const date = at("date");
  const description = at("description");
  const paidIn = at("paidIn");
  const paidOut = at("paidOut");
  const amount = at("amount");
  const reference = at("reference");
  const balance = at("balance");
  const valueDate = at("valueDate");

  if (date !== undefined && date >= 0) mapping.date = date;
  if (description !== undefined && description >= 0) mapping.description = description;
  if (paidIn !== undefined && paidIn >= 0) mapping.paidIn = paidIn;
  if (paidOut !== undefined && paidOut >= 0) mapping.paidOut = paidOut;
  if (amount !== undefined && amount >= 0) mapping.amount = amount;
  if (reference !== undefined && reference >= 0) mapping.reference = reference;
  if (balance !== undefined && balance >= 0) mapping.balance = balance;
  if (valueDate !== undefined && valueDate >= 0) mapping.valueDate = valueDate;

  const format = text(form, "mapping.dateFormat");
  if (format === "dmy" || format === "mdy" || format === "ymd" || format === "auto") {
    mapping.dateFormat = format;
  }

  // Money in and money out, or one signed column — never both. Sending both would
  // let the server read the amount twice and disagree with the preview.
  if (mapping.amount !== undefined && (mapping.paidIn !== undefined || mapping.paidOut !== undefined)) {
    delete mapping.amount;
  }

  return mapping;
}

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

export async function saveBankAccount(_prev: FormState, form: FormData): Promise<FormState> {
  const bankAccountId = optional(form, "bankAccountId");
  let id = bankAccountId;

  const input = {
    bankName: text(form, "bankName"),
    accountNo: optional(form, "accountNo"),
    accountLabel: optional(form, "accountLabel"),
    swiftCode: optional(form, "swiftCode"),
    notes: optional(form, "notes"),
  };

  try {
    const { principal, db, context } = await begin("accounting.bank.manage");
    await db.transaction(async (tx) => {
      if (bankAccountId) {
        await updateBankAccount(
          tx,
          principal,
          bankAccountId,
          { ...input, isActive: form.get("isActive") !== null },
          context,
        );
      } else {
        id = (
          await createBankAccount(tx, principal, { ...input, accountId: text(form, "accountId") }, context)
        ).id;
      }
    });
  } catch (error) {
    return toFormState(error, "The bank account could not be saved.");
  }

  revalidatePath("/accounting/bank");
  redirect(`/accounting/bank/${id}`);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportPreviewState extends FormState {
  /** Present once a file has been read: what the screen shows for confirmation. */
  preview?: {
    fileText: string;
    filename: string | null;
    header: string[];
    mapping: ColumnMapping;
    skipRows: number;
    rows: Array<{
      lineNo: number;
      txnDate: string;
      description: string;
      reference: string | null;
      paidIn: string;
      paidOut: string;
    }>;
    rejected: Array<{ rowNo: number; reason: string; raw: string[] }>;
    earliest: string | null;
    latest: string | null;
    totalIn: string;
    totalOut: string;
    /** closing − opening implied by the rows, for the balance fields. */
    impliedMovement: string;
  };
}

/**
 * Reads the file and shows what it found, without writing anything.
 *
 * A wrong column mapping imports a month of transactions against the wrong
 * fields, and nothing about the result looks wrong afterwards. So the guess is
 * always shown before it is used.
 */
export async function previewStatement(
  _prev: ImportPreviewState,
  form: FormData,
): Promise<ImportPreviewState> {
  await requireCapability("accounting.bank.import");

  const upload = form.get("file");
  const pasted = text(form, "pasted");
  const carried = text(form, "fileText");

  let fileText = carried;
  let filename = optional(form, "filename");

  if (upload instanceof File && upload.size > 0) {
    if (upload.size > 5_000_000) {
      return { error: "That file is larger than 5 MB. Import one statement period at a time." };
    }
    fileText = await upload.text();
    filename = upload.name;
  } else if (pasted !== "") {
    fileText = pasted;
    filename = filename ?? "pasted";
  }

  if (fileText.trim() === "") {
    return { error: "Choose a file to read, or paste the rows." };
  }

  const skipRows = numeric(form, "skipRows") ?? 0;

  try {
    const parsed = parseStatement(fileText, { mapping: readMapping(form), skipRows });

    return {
      preview: {
        fileText,
        filename,
        header: parsed.header,
        mapping: parsed.mapping,
        skipRows,
        rows: parsed.lines.slice(0, 200).map((line) => ({
          lineNo: line.lineNo,
          txnDate: line.txnDate,
          description: line.description,
          reference: line.reference,
          paidIn: line.paidIn.toString(),
          paidOut: line.paidOut.toString(),
        })),
        rejected: parsed.rejected.slice(0, 50),
        earliest: parsed.earliest,
        latest: parsed.latest,
        totalIn: parsed.totalIn.toString(),
        totalOut: parsed.totalOut.toString(),
        impliedMovement: (parsed.totalIn - parsed.totalOut).toString(),
      },
    };
  } catch (error) {
    return toFormState(error, "That file could not be read.");
  }
}

export async function confirmImport(_prev: FormState, form: FormData): Promise<FormState> {
  const bankAccountId = text(form, "bankAccountId");
  const fileText = String(form.get("fileText") ?? "");

  try {
    const { principal, db, context } = await begin("accounting.bank.import");
    const parsed = parseStatement(fileText, {
      mapping: readMapping(form),
      skipRows: numeric(form, "skipRows") ?? 0,
    });

    await db.transaction(async (tx) => {
      await importStatement(
        tx,
        principal,
        parsed,
        {
          bankAccountId,
          statementRef: optional(form, "statementRef"),
          periodFrom: optional(form, "periodFrom") ?? undefined,
          periodTo: optional(form, "periodTo") ?? undefined,
          openingBalance: text(form, "openingBalance"),
          closingBalance: text(form, "closingBalance"),
          sourceFilename: optional(form, "filename"),
          notes: optional(form, "notes"),
          allowDuplicate: form.get("allowDuplicate") !== null,
          acceptIncomplete: form.get("acceptIncomplete") !== null,
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "The statement could not be imported.");
  }

  revalidatePath(`/accounting/bank/${bankAccountId}`);
  redirect(`/accounting/bank/${bankAccountId}`);
}

export async function deleteStatementAction(_prev: FormState, form: FormData): Promise<FormState> {
  const bankAccountId = text(form, "bankAccountId");

  try {
    const { principal, db, context } = await begin("accounting.bank.import");
    await db.transaction(async (tx) => {
      await deleteStatement(tx, principal, text(form, "statementId"), {
        reason: optional(form, "reason"),
        context,
      });
    });
  } catch (error) {
    return toFormState(error, "That statement could not be deleted.");
  }

  revalidatePath(`/accounting/bank/${bankAccountId}`);
  return { notice: "Statement removed." };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export async function matchAction(_prev: FormState, form: FormData): Promise<FormState> {
  const bankAccountId = text(form, "bankAccountId");
  const action = text(form, "action");
  let notice = "Done.";

  try {
    const { principal, db, context } = await begin("accounting.bank.match");
    await db.transaction(async (tx) => {
      switch (action) {
        case "match":
          await matchStatementLine(
            tx,
            principal,
            {
              statementLineId: text(form, "statementLineId"),
              journalLineId: text(form, "journalLineId"),
              method: text(form, "method") === "suggested" ? "suggested" : "manual",
            },
            context,
          );
          notice = "Matched.";
          break;
        case "unmatch":
          await unmatchStatementLine(tx, principal, text(form, "statementLineId"), {
            reason: optional(form, "reason"),
            context,
          });
          notice = "Unmatched.";
          break;
        case "ignore":
          await ignoreStatementLine(
            tx,
            principal,
            text(form, "statementLineId"),
            text(form, "reason"),
            context,
          );
          notice = "Set aside, with your reason against it.";
          break;
        case "restore":
          await restoreStatementLine(tx, principal, text(form, "statementLineId"), context);
          notice = "Back in the list.";
          break;
        case "post": {
          const posted = await postStatementLine(
            tx,
            principal,
            {
              statementLineId: text(form, "statementLineId"),
              accountId: text(form, "accountId"),
              memo: optional(form, "memo"),
            },
            context,
          );
          notice = `Posted as ${posted.journalNo} and matched.`;
          break;
        }
        default:
          throw new Error(`Unknown matching action: ${action}`);
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  revalidatePath(`/accounting/bank/${bankAccountId}`);
  revalidatePath(`/accounting/bank/${bankAccountId}/reconcile`);
  return { notice };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export async function reconciliationAction(_prev: FormState, form: FormData): Promise<FormState> {
  const bankAccountId = text(form, "bankAccountId");
  const action = text(form, "action");
  let notice = "Done.";
  let goTo: string | null = null;

  try {
    const { principal, db, context } = await begin("accounting.bank.reconcile");
    await db.transaction(async (tx) => {
      switch (action) {
        case "open": {
          const opened = await openReconciliation(
            tx,
            principal,
            {
              bankAccountId,
              asAt: optional(form, "asAt") ?? undefined,
              notes: optional(form, "notes"),
            },
            context,
          );
          goTo = `/accounting/bank/${bankAccountId}/reconcile`;
          notice = "Reconciliation opened.";
          void opened;
          break;
        }
        case "complete": {
          const completed = await completeReconciliation(
            tx,
            principal,
            text(form, "reconciliationId"),
            { notes: optional(form, "notes"), context },
          );
          notice = `Reconciled. Signed off as ${completed.reconciliationNo}.`;
          break;
        }
        case "abandon":
          await abandonReconciliation(tx, principal, text(form, "reconciliationId"), {
            reason: optional(form, "reason"),
            context,
          });
          notice = "Abandoned. The matches made along the way have been kept.";
          break;
        default:
          throw new Error(`Unknown reconciliation action: ${action}`);
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  revalidatePath(`/accounting/bank/${bankAccountId}`);
  revalidatePath(`/accounting/bank/${bankAccountId}/reconcile`);
  if (goTo) redirect(goTo);
  return { notice };
}
