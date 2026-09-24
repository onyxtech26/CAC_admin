"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@cac/db";
import {
  acknowledgeAppraisal,
  cancelLeave,
  decideLeave,
  decideOvertime,
  decideTimeoff,
  openCycle,
  recalculateAttendance,
  recordReview,
  recordSelfAssessment,
  requestLeave,
  requestOvertime,
  requestTimeoff,
  saveCycle,
  saveLeaveType,
  setLeaveBalance,
  submitLeave,
  submitOvertime,
  submitTimeoff,
  type AppraisalTemplate,
  type TimeoffKind,
} from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";
import { toFormState, type FormState } from "../accounting/action-errors";

export type { FormState };

/**
 * Server actions for leave, overtime, time off and appraisals.
 *
 * One pattern repeats and is worth noting: several of these actions decide which
 * capability to demand from *what is being asked*, not from the form. Raising leave
 * for yourself needs `hr.leave.request`; raising it on somebody else's record needs
 * `hr.leave.approve`, because otherwise "requesting leave" is a way to put an
 * absence on a colleague's record. The core functions make that decision, so it
 * cannot be bypassed by calling them another way.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string) => text(form, key) || null;
const checkbox = (form: FormData, key: string) => form.get(key) !== null;
const number = (form: FormData, key: string, fallback: number) => {
  const value = text(form, key);
  if (value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

async function begin(capability: string) {
  const principal = await requireCapability(capability);
  const db = await getDb();
  const context = await getRequestContext();
  return { principal, db, context };
}

// ---------------------------------------------------------------------------
// Attendance calculation
// ---------------------------------------------------------------------------

export async function recalculate(_prev: FormState, form: FormData): Promise<FormState> {
  let notice = "Done.";

  try {
    const { principal, db, context } = await begin("hr.attendance.edit");
    const result = await db.transaction(async (tx) =>
      recalculateAttendance(
        tx,
        principal,
        { from: text(form, "from"), to: text(form, "to") },
        context,
      ),
    );

    const parts = [`${result.updated} day${result.updated === 1 ? "" : "s"} recalculated`];
    if (result.skippedFinal > 0) {
      parts.push(`${result.skippedFinal} left alone because they are final`);
    }
    if (result.unresolved.length > 0) {
      parts.push(
        `${result.unresolved.length} could not be measured and need somebody to look at them`,
      );
    }
    notice = `${parts.join(". ")}.`;
  } catch (error) {
    return toFormState(error, "The recalculation could not be run.");
  }

  revalidatePath("/hr/attendance");
  return { notice };
}

// ---------------------------------------------------------------------------
// Leave configuration
// ---------------------------------------------------------------------------

export async function saveLeaveTypeAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("hr.leave.manage_types");
    await db.transaction(async (tx) => {
      await saveLeaveType(
        tx,
        principal,
        {
          leaveTypeId: optional(form, "leaveTypeId") ?? undefined,
          code: text(form, "code"),
          name: text(form, "name"),
          isPaid: checkbox(form, "isPaid"),
          isStatutory: checkbox(form, "isStatutory"),
          defaultDays: optional(form, "defaultDays"),
          entitlementSource: optional(form, "entitlementSource"),
          requiresDocument: checkbox(form, "requiresDocument"),
          carryForwardMax: optional(form, "carryForwardMax"),
          allowsBackdating: checkbox(form, "allowsBackdating"),
          countsAsAttendance: checkbox(form, "countsAsAttendance"),
          notes: optional(form, "notes"),
          isActive: form.has("isActive") ? checkbox(form, "isActive") : true,
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "The leave type could not be saved.");
  }

  revalidatePath("/hr/leave/types");
  revalidatePath("/hr/leave");
  return { notice: "Saved." };
}

export async function saveBalanceAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("hr.leave.manage_balance");
    await db.transaction(async (tx) => {
      await setLeaveBalance(
        tx,
        principal,
        {
          employeeId: text(form, "employeeId"),
          leaveTypeId: text(form, "leaveTypeId"),
          year: number(form, "year", new Date().getUTCFullYear()),
          entitledDays: text(form, "entitledDays"),
          carriedDays: optional(form, "carriedDays") ?? "0",
          adjustmentDays: optional(form, "adjustmentDays") ?? "0",
          notes: optional(form, "notes"),
          reason: optional(form, "reason"),
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "The balance could not be set.");
  }

  revalidatePath("/hr/leave");
  return { notice: "Balance set." };
}

// ---------------------------------------------------------------------------
// Leave requests
// ---------------------------------------------------------------------------

export async function requestLeaveAction(_prev: FormState, form: FormData): Promise<FormState> {
  let notice = "";

  try {
    // The capability is decided inside `requestLeave` from whose record it is, so
    // the gate here is only the weaker of the two.
    const { principal, db, context } = await begin("hr.leave.request");
    const created = await db.transaction(async (tx) => {
      const result = await requestLeave(
        tx,
        principal,
        {
          employeeId: text(form, "employeeId"),
          leaveTypeId: text(form, "leaveTypeId"),
          startsOn: text(form, "startsOn"),
          endsOn: text(form, "endsOn"),
          halfDayStart: checkbox(form, "halfDayStart"),
          halfDayEnd: checkbox(form, "halfDayEnd"),
          reason: optional(form, "reason"),
          documentPath: optional(form, "documentPath"),
        },
        context,
      );

      // Submitting straight away is what people expect from a request form; keeping
      // the draft step would mean requests sitting unsent.
      const submitted = await submitLeave(tx, principal, result.id, context);
      return { ...result, requestNo: submitted.requestNo };
    });

    notice =
      `Submitted as ${created.requestNo}, for ${created.days} day` +
      `${created.days === 1 ? "" : "s"}. It now needs somebody else to decide it.`;
  } catch (error) {
    return toFormState(error, "The request could not be made.");
  }

  revalidatePath("/hr/leave");
  return { notice };
}

export async function decideLeaveAction(_prev: FormState, form: FormData): Promise<FormState> {
  const action = text(form, "action");
  let notice = "Done.";

  try {
    const { principal, db, context } = await begin(
      action === "cancel" ? "hr.leave.request" : "hr.leave.approve",
    );
    await db.transaction(async (tx) => {
      if (action === "approve") {
        await decideLeave(tx, principal, text(form, "requestId"), "approved", {
          note: optional(form, "note"),
          allowNegativeBalance: checkbox(form, "allowNegativeBalance"),
          context,
        });
        notice = "Approved.";
      } else if (action === "reject") {
        await decideLeave(tx, principal, text(form, "requestId"), "rejected", {
          note: text(form, "note"),
          context,
        });
        notice = "Refused. The person sees the reason.";
      } else if (action === "cancel") {
        await cancelLeave(tx, principal, text(form, "requestId"), text(form, "reason"), context);
        notice = "Cancelled, and the entitlement comes back.";
      } else {
        throw new Error(`Unknown leave action: ${action}`);
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  revalidatePath("/hr/leave");
  revalidatePath("/hr/attendance");
  return { notice };
}

// ---------------------------------------------------------------------------
// Overtime and time off
// ---------------------------------------------------------------------------

export async function requestOvertimeAction(_prev: FormState, form: FormData): Promise<FormState> {
  let notice = "";

  try {
    const { principal, db, context } = await begin("hr.overtime.request");
    const created = await db.transaction(async (tx) => {
      const result = await requestOvertime(
        tx,
        principal,
        {
          employeeId: text(form, "employeeId"),
          workDate: text(form, "workDate"),
          startsAt: optional(form, "startsAt"),
          endsAt: optional(form, "endsAt"),
          requestedHours: text(form, "requestedHours"),
          reason: text(form, "reason"),
        },
        context,
      );
      const submitted = await submitOvertime(tx, principal, result.id, context);
      return { ...result, requestNo: submitted.requestNo };
    });

    const kind =
      created.dayKind === "public_holiday"
        ? " It falls on a public holiday, which affects the rate."
        : created.dayKind === "rest_day"
          ? " It falls on a rest day, which affects the rate."
          : "";
    notice = `Submitted as ${created.requestNo}.${kind}`;
  } catch (error) {
    return toFormState(error, "The request could not be made.");
  }

  revalidatePath("/hr/overtime");
  return { notice };
}

export async function decideOvertimeAction(_prev: FormState, form: FormData): Promise<FormState> {
  const action = text(form, "action");
  let notice = "Done.";

  try {
    const { principal, db, context } = await begin("hr.overtime.approve");
    await db.transaction(async (tx) => {
      if (action === "approve") {
        await decideOvertime(tx, principal, text(form, "requestId"), "approved", {
          approvedHours: optional(form, "approvedHours") ?? undefined,
          rateMultiple: optional(form, "rateMultiple"),
          rateSource: optional(form, "rateSource"),
          note: optional(form, "note"),
          context,
        });
        notice = optional(form, "rateMultiple")
          ? "Approved, with the rate recorded."
          : "Approved. No rate is recorded yet, so payroll will not pay it until one is — see Q-HR-1.";
      } else if (action === "reject") {
        await decideOvertime(tx, principal, text(form, "requestId"), "rejected", {
          note: text(form, "note"),
          context,
        });
        notice = "Refused.";
      } else {
        throw new Error(`Unknown overtime action: ${action}`);
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  revalidatePath("/hr/overtime");
  revalidatePath("/hr/attendance");
  return { notice };
}

export async function requestTimeoffAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("hr.timeoff.request");
    await db.transaction(async (tx) => {
      const created = await requestTimeoff(
        tx,
        principal,
        {
          employeeId: text(form, "employeeId"),
          workDate: text(form, "workDate"),
          kind: (text(form, "kind") || "late_in") as TimeoffKind,
          startsAt: optional(form, "startsAt"),
          endsAt: optional(form, "endsAt"),
          minutes: number(form, "minutes", 0),
          isPaid: checkbox(form, "isPaid"),
          reason: text(form, "reason"),
        },
        context,
      );
      await submitTimeoff(tx, principal, created.id, context);
    });
  } catch (error) {
    return toFormState(error, "The request could not be made.");
  }

  revalidatePath("/hr/overtime");
  return { notice: "Submitted. Somebody else decides it." };
}

export async function decideTimeoffAction(_prev: FormState, form: FormData): Promise<FormState> {
  const decision = text(form, "action") === "approve" ? "approved" : "rejected";

  try {
    const { principal, db, context } = await begin("hr.timeoff.approve");
    await db.transaction(async (tx) => {
      await decideTimeoff(tx, principal, text(form, "requestId"), decision, {
        note: optional(form, "note"),
        context,
      });
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  revalidatePath("/hr/overtime");
  revalidatePath("/hr/attendance");
  return {
    notice:
      decision === "approved"
        ? "Approved. The attendance engine will stop counting it as lateness."
        : "Refused.",
  };
}

// ---------------------------------------------------------------------------
// Appraisals
// ---------------------------------------------------------------------------

/**
 * Builds a template from the simple form.
 *
 * The form offers one section per line with its questions, which is enough for a
 * firm of this size and avoids a template editor nobody asked for. A cycle needing
 * something more elaborate can have its JSON set directly.
 */
function readTemplate(form: FormData): AppraisalTemplate | null {
  const raw = text(form, "templateJson");
  if (raw !== "") {
    try {
      return JSON.parse(raw) as AppraisalTemplate;
    } catch {
      throw new Error("template-json");
    }
  }

  const sections = text(form, "sections");
  if (sections === "") return null;

  const min = number(form, "scaleMin", 1);
  const max = number(form, "scaleMax", 5);

  return {
    scale: { min, max },
    sections: sections
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line, index) => {
        // "Delivery: report quality, meeting dates"
        const [title, questions] = line.split(":");
        const key = (title ?? `section${index}`)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "");
        return {
          key: key || `section${index}`,
          title: (title ?? "").trim(),
          questions: (questions ?? "")
            .split(",")
            .map((prompt) => prompt.trim())
            .filter((prompt) => prompt !== "")
            .map((prompt, position) => ({
              key: `${key}_${position}`,
              prompt,
              rated: true,
              comment: true,
            })),
        };
      }),
  };
}

export async function saveCycleAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("hr.appraisal.manage");

    let template: AppraisalTemplate | null;
    try {
      template = readTemplate(form);
    } catch {
      return { error: "That template is not valid JSON.", field: "templateJson" };
    }

    await db.transaction(async (tx) => {
      await saveCycle(
        tx,
        principal,
        {
          cycleId: optional(form, "cycleId") ?? undefined,
          code: text(form, "code"),
          name: text(form, "name"),
          periodFrom: text(form, "periodFrom"),
          periodTo: text(form, "periodTo"),
          template,
          opensOn: optional(form, "opensOn"),
          dueOn: optional(form, "dueOn"),
          notes: optional(form, "notes"),
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "The cycle could not be saved.");
  }

  revalidatePath("/hr/appraisals");
  return { notice: "Saved." };
}

export async function openCycleAction(_prev: FormState, form: FormData): Promise<FormState> {
  let notice = "Opened.";

  try {
    const { principal, db, context } = await begin("hr.appraisal.manage");
    const result = await db.transaction(async (tx) =>
      openCycle(tx, principal, text(form, "cycleId"), context),
    );

    notice =
      result.withoutReviewer.length === 0
        ? `Opened. ${result.created} appraisal${result.created === 1 ? "" : "s"} created.`
        : `Opened, with ${result.created} created. ${result.withoutReviewer.length} ` +
          `${result.withoutReviewer.length === 1 ? "person has" : "people have"} no manager ` +
          "recorded, so no appraisal was started for them — an appraisal by the wrong person is " +
          "worse than none: " +
          result.withoutReviewer.map((row) => row.fullName).join(", ") +
          ".";
  } catch (error) {
    return toFormState(error, "The cycle could not be opened.");
  }

  revalidatePath("/hr/appraisals");
  return { notice };
}

/**
 * Reads the answers a form posted.
 *
 * Fields are named `answer.<section>.<question>`, which keeps the shape of the
 * template without the form needing to know what is in it.
 */
function readAnswers(form: FormData): Record<string, Record<string, unknown>> {
  const answers: Record<string, Record<string, unknown>> = {};

  for (const [key, value] of form.entries()) {
    const match = /^answer\.([^.]+)\.(.+)$/.exec(key);
    if (!match) continue;
    const [, section, question] = match;
    answers[section!] ??= {};
    const text = String(value).trim();
    if (text === "") continue;
    const asNumber = Number(text);
    answers[section!]![question!] = Number.isFinite(asNumber) && text !== "" ? asNumber : text;
  }

  return answers;
}

export async function selfAssessAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("hr.appraisal.view");
    await db.transaction(async (tx) => {
      await recordSelfAssessment(tx, principal, text(form, "appraisalId"), readAnswers(form), context);
    });
  } catch (error) {
    return toFormState(error, "Your assessment could not be saved.");
  }

  revalidatePath("/hr/appraisals");
  return { notice: "Saved, and sent to your reviewer." };
}

export async function reviewAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("hr.appraisal.review");
    await db.transaction(async (tx) => {
      await recordReview(
        tx,
        principal,
        text(form, "appraisalId"),
        {
          review: readAnswers(form),
          overallScore: optional(form, "overallScore"),
          overallComment: optional(form, "overallComment"),
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "The review could not be saved.");
  }

  revalidatePath("/hr/appraisals");
  return { notice: "Recorded. The person can now read and acknowledge it." };
}

export async function acknowledgeAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("hr.appraisal.view");
    await db.transaction(async (tx) => {
      await acknowledgeAppraisal(
        tx,
        principal,
        text(form, "appraisalId"),
        optional(form, "comment"),
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "That could not be recorded.");
  }

  revalidatePath("/hr/appraisals");
  return {
    notice:
      "Acknowledged. It is now fixed — acknowledging is not agreeing, and your comment is part of the record.",
  };
}
