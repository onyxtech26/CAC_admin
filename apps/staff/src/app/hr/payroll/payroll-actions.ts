"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@cac/db";
import {
  StatutoryRulesMissingError,
  abandonPayrollRun,
  approvePayrollRun,
  approveRuleVersion,
  createPayrollRun,
  finalisePayrollRun,
  postPayrollRun,
  preparePayrollRun,
  reversePayrollPosting,
  saveRuleVersion,
  type StatutoryKind,
} from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";
import { toFormState, type FormState } from "../../accounting/action-errors";

export type { FormState };

/**
 * Server actions for payroll.
 *
 * `StatutoryRulesMissingError` is handled specially rather than folded into the
 * generic error path. It is not a fault and not a data-entry mistake: it is the
 * platform declining to invent Malaysian law, and the message it carries names
 * exactly which schedules are absent. Flattening it into "something went wrong"
 * would hide the one thing the person needs to know.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string) => text(form, key) || null;

async function begin(capability: string) {
  const principal = await requireCapability(capability);
  const db = await getDb();
  const context = await getRequestContext();
  return { principal, db, context };
}

// ---------------------------------------------------------------------------
// Statutory rules
// ---------------------------------------------------------------------------

export async function saveRule(_prev: FormState, form: FormData): Promise<FormState> {
  let table: unknown;

  try {
    table = JSON.parse(text(form, "tableJson"));
  } catch {
    return {
      error:
        "That is not valid JSON. The table is entered as JSON because these are band " +
        "schedules rather than single rates, and a form with one box per band would have to " +
        "guess how many bands there are.",
      field: "tableJson",
    };
  }

  try {
    const { principal, db, context } = await begin("hr.statutory.manage");
    await db.transaction(async (tx) => {
      await saveRuleVersion(
        tx,
        principal,
        {
          ruleId: optional(form, "ruleId") ?? undefined,
          kind: text(form, "kind") as StatutoryKind,
          effectiveFrom: text(form, "effectiveFrom"),
          effectiveTo: optional(form, "effectiveTo"),
          sourceRef: text(form, "sourceRef"),
          sourceUrl: optional(form, "sourceUrl"),
          table,
          notes: optional(form, "notes"),
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "The rule could not be saved.");
  }

  revalidatePath("/hr/statutory");
  return {
    notice:
      "Saved as a draft. It has no effect until somebody else approves it — a statutory table " +
      "entered and used unchecked is the most expensive mistake available here.",
  };
}

export async function approveRule(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("hr.statutory.manage");
    await db.transaction(async (tx) => {
      await approveRuleVersion(tx, principal, text(form, "ruleId"), context);
    });
  } catch (error) {
    return toFormState(error, "The rule could not be approved.");
  }

  revalidatePath("/hr/statutory");
  revalidatePath("/hr/payroll");
  return { notice: "Approved. Payroll will use it for the dates it covers, and it is now fixed." };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function createRun(_prev: FormState, form: FormData): Promise<FormState> {
  let id: string | null = null;

  try {
    const { principal, db, context } = await begin("hr.payroll.prepare");
    await db.transaction(async (tx) => {
      const created = await createPayrollRun(
        tx,
        principal,
        {
          periodFrom: text(form, "periodFrom"),
          periodTo: text(form, "periodTo"),
          payDate: text(form, "payDate"),
          kind: text(form, "kind") === "supplementary" ? "supplementary" : "regular",
          correctsRunId: optional(form, "correctsRunId"),
          notes: optional(form, "notes"),
        },
        context,
      );
      id = created.id;
    });
  } catch (error) {
    return toFormState(error, "The run could not be created.");
  }

  revalidatePath("/hr/payroll");
  redirect(`/hr/payroll/${id}`);
}

export async function runAction(_prev: FormState, form: FormData): Promise<FormState> {
  const runId = text(form, "runId");
  const action = text(form, "action");
  let notice = "Done.";

  const capability =
    action === "prepare" || action === "abandon"
      ? "hr.payroll.prepare"
      : action === "approve"
        ? "hr.payroll.approve"
        : action === "finalise"
          ? "hr.payroll.finalise"
          : "hr.payroll.post";

  try {
    const { principal, db, context } = await begin(capability);
    await db.transaction(async (tx) => {
      switch (action) {
        case "prepare": {
          const result = await preparePayrollRun(tx, principal, runId, context);
          const parts = [`${result.payslips} payslip${result.payslips === 1 ? "" : "s"} computed`];
          if (result.skipped.length > 0) {
            parts.push(
              `${result.skipped.length} left out (${result.skipped
                .map((row) => `${row.employeeName}: ${row.why}`)
                .join("; ")})`,
            );
          }
          if (result.problems.length > 0) {
            parts.push(
              `${result.problems.length} could not be computed and must be looked at before this ` +
                "run can be approved",
            );
          }
          notice = `${result.runNo}. ${parts.join(". ")}.`;
          break;
        }
        case "approve":
          await approvePayrollRun(tx, principal, runId, context);
          notice = "Approved.";
          break;
        case "finalise":
          await finalisePayrollRun(tx, principal, runId, context);
          notice =
            "Finalised. The payslips are documents now, and the overtime this run paid cannot be " +
            "claimed again.";
          break;
        case "post": {
          const posted = await postPayrollRun(tx, principal, runId, context);
          notice = `Posted to the ledger as ${posted.journalNo}. Net pay is owed to staff in salaries payable; paying it is a separate voucher.`;
          break;
        }
        case "reverse": {
          const reversed = await reversePayrollPosting(
            tx,
            principal,
            runId,
            text(form, "reason"),
            context,
          );
          notice = `Ledger entry reversed as ${reversed.journalNo}. The payslips are untouched.`;
          break;
        }
        case "abandon":
          await abandonPayrollRun(tx, principal, runId, text(form, "reason"), context);
          notice = "Abandoned.";
          break;
        default:
          throw new Error(`Unknown payroll action: ${action}`);
      }
    });
  } catch (error) {
    // The one error worth its own message: the platform is declining to guess, and
    // the message already names which schedules are missing and why.
    if (error instanceof StatutoryRulesMissingError) {
      return { error: error.message, field: "statutory" };
    }
    return toFormState(error, "That could not be done.");
  }

  revalidatePath(`/hr/payroll/${runId}`);
  revalidatePath("/hr/payroll");
  return { notice };
}
