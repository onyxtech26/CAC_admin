"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@cac/db";
import {
  addRequirement,
  answerFact,
  approveRequirementRule,
  assignToCase,
  cancelTask,
  closeCase,
  completeTask,
  createTask,
  openCase,
  recomputeChecklist,
  recordAsset,
  recordCaseMilestone,
  recordLiability,
  recordParty,
  registerDocument,
  removeDocument,
  removeFromCase,
  reopenCase,
  retireRequirementRule,
  saveFactDefinition,
  saveRequirementRule,
  setRequirementStatus,
  setVerification,
  updateAsset,
  updateCase,
  type AssetCategory,
  type CaseAssignmentView,
  type FactKind,
  type LiabilityCategory,
  type MatterType,
  type PartyRole,
  type RequirementKind,
  type RequirementStatus,
  type VerifiableKind,
} from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";
import { toFormState, type FormState } from "../accounting/action-errors";

export type { FormState };

/**
 * Server actions for estate cases.
 *
 * Two habits run through the file.
 *
 * **Nothing is read from the form that the server can decide itself.** The case a
 * write belongs to comes from the form because the URL is where it lives, but every
 * write then goes through `requireWritableCase` inside the core layer, which checks
 * the principal's access to *that* case and that the file is open. Posting another
 * case's id gets a 404, not a write.
 *
 * **A condition is written as a small form, not as JSON.** The rule editor collects
 * repeated rows — fact, test, value — and assembles them here. Somebody writing down a
 * legal requirement should not have to hand-write a condition tree, and a form that
 * only produces valid shapes is one fewer way to get a rule wrong.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string) => text(form, key) || null;
const checked = (form: FormData, key: string) => form.get(key) !== null;

async function begin(capability: string) {
  const principal = await requireCapability(capability);
  const db = await getDb();
  const context = await getRequestContext();
  return { principal, db, context };
}

function refreshCase(caseId: string) {
  revalidatePath(`/cases/${caseId}`);
  revalidatePath(`/cases/${caseId}/file`);
  revalidatePath(`/cases/${caseId}/intake`);
  revalidatePath(`/cases/${caseId}/checklist`);
  revalidatePath("/cases");
}

// ---------------------------------------------------------------------------
// The matter
// ---------------------------------------------------------------------------

export async function openCaseAction(_prev: FormState, form: FormData): Promise<FormState> {
  let opened: { id: string } | null = null;
  try {
    const { principal, db, context } = await begin("case.create");
    opened = await db.transaction(async (tx) =>
      openCase(
        tx,
        principal,
        {
          matterType: text(form, "matterType") as MatterType,
          title: text(form, "title"),
          deceasedName: text(form, "deceasedName"),
          deceasedId: optional(form, "deceasedId"),
          dateOfDeath: optional(form, "dateOfDeath"),
          placeOfDeath: optional(form, "placeOfDeath"),
          domicileState: optional(form, "domicileState"),
          customerId: optional(form, "customerId"),
          instructedBy: optional(form, "instructedBy"),
          openedOn: optional(form, "openedOn") ?? undefined,
          targetOn: optional(form, "targetOn"),
          engagementRef: optional(form, "engagementRef"),
          notes: optional(form, "notes"),
          leadEmployeeId: optional(form, "leadEmployeeId"),
        },
        context,
      ),
    );
  } catch (error) {
    return toFormState(error, "The matter could not be opened.");
  }
  revalidatePath("/cases");
  redirect(`/cases/${opened.id}/intake`);
}

export async function updateCaseAction(_prev: FormState, form: FormData): Promise<FormState> {
  const caseId = text(form, "caseId");
  try {
    const { principal, db, context } = await begin("case.edit");
    await db.transaction(async (tx) =>
      updateCase(
        tx,
        principal,
        caseId,
        {
          title: text(form, "title"),
          matterType: text(form, "matterType") as MatterType,
          deceasedName: text(form, "deceasedName"),
          dateOfDeath: optional(form, "dateOfDeath"),
          placeOfDeath: optional(form, "placeOfDeath"),
          domicileState: optional(form, "domicileState"),
          instructedBy: optional(form, "instructedBy"),
          targetOn: optional(form, "targetOn"),
          courtReference: optional(form, "courtReference"),
          registry: optional(form, "registry"),
          engagementRef: optional(form, "engagementRef"),
          notes: optional(form, "notes"),
          // Only sent when the field was filled in: an empty box means "leave it",
          // not "erase the identification we hold".
          deceasedId: text(form, "deceasedId") ? text(form, "deceasedId") : undefined,
          status: (optional(form, "status") ?? undefined) as
            | "intake"
            | "open"
            | "on_hold"
            | undefined,
        },
        context,
      ),
    );
  } catch (error) {
    return toFormState(error, "The matter could not be amended.");
  }
  refreshCase(caseId);
  return { notice: "Saved." };
}

export async function closeCaseAction(_prev: FormState, form: FormData): Promise<FormState> {
  const caseId = text(form, "caseId");
  try {
    const { principal, db, context } = await begin("case.close");
    const outcome = text(form, "outcome") === "withdrawn" ? "withdrawn" : "closed";
    await db.transaction(async (tx) =>
      closeCase(tx, principal, caseId, { outcome, reason: text(form, "reason") }, context),
    );
  } catch (error) {
    return toFormState(error, "The matter could not be closed.");
  }
  refreshCase(caseId);
  return { notice: "The matter is closed." };
}

export async function reopenCaseAction(_prev: FormState, form: FormData): Promise<FormState> {
  const caseId = text(form, "caseId");
  try {
    const { principal, db, context } = await begin("case.close");
    await db.transaction(async (tx) =>
      reopenCase(tx, principal, caseId, text(form, "reason"), context),
    );
  } catch (error) {
    return toFormState(error, "The matter could not be reopened.");
  }
  refreshCase(caseId);
  return { notice: "Reopened." };
}

export async function assignAction(_prev: FormState, form: FormData): Promise<FormState> {
  const caseId = text(form, "caseId");
  try {
    const { principal, db, context } = await begin("case.assign");
    await db.transaction(async (tx) => {
      if (text(form, "intent") === "remove") {
        await removeFromCase(
          tx,
          principal,
          { caseId, employeeId: text(form, "employeeId") },
          context,
        );
      } else {
        await assignToCase(
          tx,
          principal,
          {
            caseId,
            employeeId: text(form, "employeeId"),
            role: (text(form, "role") || "contributor") as CaseAssignmentView["role"],
          },
          context,
        );
      }
    });
  } catch (error) {
    return toFormState(error, "The assignment could not be changed.");
  }
  refreshCase(caseId);
  return { notice: "Saved." };
}

export async function recordMilestoneAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const caseId = text(form, "caseId");
  try {
    const { principal, db, context } = await begin("case.edit");
    await db.transaction(async (tx) =>
      recordCaseMilestone(
        tx,
        principal,
        {
          caseId,
          kind: text(form, "kind") || "note",
          summary: text(form, "summary"),
          occurredAt: text(form, "occurredAt"),
        },
        context,
      ),
    );
  } catch (error) {
    return toFormState(error, "The entry could not be recorded.");
  }
  refreshCase(caseId);
  return { notice: "Recorded." };
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

export async function recordPartyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const caseId = text(form, "caseId");
  try {
    const { principal, db, context } = await begin("case.edit");
    await db.transaction(async (tx) =>
      recordParty(
        tx,
        principal,
        {
          caseId,
          role: text(form, "role") as PartyRole,
          partyKind: text(form, "partyKind") === "organisation" ? "organisation" : "person",
          fullName: text(form, "fullName"),
          relationship: optional(form, "relationship"),
          identification: optional(form, "identification"),
          dateOfBirth: optional(form, "dateOfBirth"),
          isMinor: checked(form, "isMinor"),
          phone: optional(form, "phone"),
          email: optional(form, "email"),
          address: optional(form, "address"),
          shareNote: optional(form, "shareNote"),
          shareSource: optional(form, "shareSource"),
          consentStatus: optional(form, "consentStatus"),
          notes: optional(form, "notes"),
        },
        context,
      ),
    );
  } catch (error) {
    return toFormState(error, "The party could not be recorded.");
  }
  refreshCase(caseId);
  return { notice: "Recorded." };
}

export async function recordAssetAction(_prev: FormState, form: FormData): Promise<FormState> {
  const caseId = text(form, "caseId");
  const assetId = optional(form, "assetId");
  try {
    const { principal, db, context } = await begin("case.edit");
    await db.transaction(async (tx) => {
      const fields = {
        category: text(form, "category") as AssetCategory,
        description: text(form, "description"),
        reference: optional(form, "reference"),
        location: optional(form, "location"),
        holder: optional(form, "holder"),
        ownership: (text(form, "ownership") || "sole") as
          | "sole"
          | "joint"
          | "shared"
          | "trust"
          | "disputed",
        ownershipNote: optional(form, "ownershipNote"),
        valuationAmount: optional(form, "valuationAmount"),
        valuationBasis: optional(form, "valuationBasis"),
        valuationDate: optional(form, "valuationDate"),
        valuationSource: optional(form, "valuationSource"),
        notes: optional(form, "notes"),
      };
      if (assetId) await updateAsset(tx, principal, assetId, fields, context);
      else await recordAsset(tx, principal, { caseId, ...fields }, context);
    });
  } catch (error) {
    return toFormState(error, "The asset could not be recorded.");
  }
  refreshCase(caseId);
  return { notice: "Saved." };
}

export async function recordLiabilityAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const caseId = text(form, "caseId");
  try {
    const { principal, db, context } = await begin("case.edit");
    await db.transaction(async (tx) =>
      recordLiability(
        tx,
        principal,
        {
          caseId,
          category: text(form, "category") as LiabilityCategory,
          creditor: text(form, "creditor"),
          description: text(form, "description"),
          reference: optional(form, "reference"),
          amount: optional(form, "amount"),
          amountBasis: optional(form, "amountBasis"),
          amountAsAt: optional(form, "amountAsAt"),
          amountSource: optional(form, "amountSource"),
          isSecured: checked(form, "isSecured"),
          securityNote: optional(form, "securityNote"),
          notes: optional(form, "notes"),
        },
        context,
      ),
    );
  } catch (error) {
    return toFormState(error, "The liability could not be recorded.");
  }
  refreshCase(caseId);
  return { notice: "Saved." };
}

export async function verifyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const caseId = text(form, "caseId");
  try {
    const { principal, db, context } = await begin("case.view");
    await db.transaction(async (tx) =>
      setVerification(
        tx,
        principal,
        {
          kind: text(form, "kind") as VerifiableKind,
          recordId: text(form, "recordId"),
          status: text(form, "status") as "reported" | "verified" | "excluded",
          reason: optional(form, "reason"),
        },
        context,
      ),
    );
  } catch (error) {
    return toFormState(error, "That could not be changed.");
  }
  refreshCase(caseId);
  return { notice: "Saved." };
}

export async function registerDocumentAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const caseId = text(form, "caseId");
  try {
    const { principal, db, context } = await begin("case.document.upload");
    await db.transaction(async (tx) =>
      registerDocument(
        tx,
        principal,
        {
          caseId,
          title: text(form, "title"),
          docKind: optional(form, "docKind"),
          form: (text(form, "form") || "copy") as
            | "original"
            | "certified_copy"
            | "copy"
            | "electronic",
          receivedOn: optional(form, "receivedOn"),
          receivedFrom: optional(form, "receivedFrom"),
          filedAt: optional(form, "filedAt"),
          notes: optional(form, "notes"),
        },
        context,
      ),
    );
  } catch (error) {
    return toFormState(error, "The document could not be registered.");
  }
  refreshCase(caseId);
  return { notice: "Registered." };
}

export async function removeDocumentAction(_prev: FormState, form: FormData): Promise<FormState> {
  const caseId = text(form, "caseId");
  try {
    const { principal, db, context } = await begin("case.document.delete");
    await db.transaction(async (tx) =>
      removeDocument(tx, principal, text(form, "documentId"), text(form, "reason"), context),
    );
  } catch (error) {
    return toFormState(error, "The document could not be removed.");
  }
  refreshCase(caseId);
  return { notice: "Removed from the register." };
}

// ---------------------------------------------------------------------------
// Intake and the checklist
// ---------------------------------------------------------------------------

export async function answerFactAction(_prev: FormState, form: FormData): Promise<FormState> {
  const caseId = text(form, "caseId");
  try {
    const { principal, db, context } = await begin("case.edit");
    const unknown = text(form, "intent") === "unknown";
    await db.transaction(async (tx) =>
      answerFact(
        tx,
        principal,
        {
          caseId,
          factKey: text(form, "factKey"),
          value: unknown ? null : text(form, "value"),
          unknown,
          sourceNote: optional(form, "sourceNote"),
        },
        context,
      ),
    );
  } catch (error) {
    return toFormState(error, "The answer could not be recorded.");
  }
  refreshCase(caseId);
  return { notice: "Recorded." };
}

export async function recomputeChecklistAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const caseId = text(form, "caseId");
  try {
    const { principal, db, context } = await begin("case.checklist.manage");
    const report = await db.transaction(async (tx) =>
      recomputeChecklist(tx, principal, caseId, context),
    );
    refreshCase(caseId);

    if (report.rulesConsidered === 0) {
      return {
        notice:
          "No requirement rule has been approved for this kind of matter, so there is nothing to build a checklist from.",
      };
    }
    const parts = [
      `${report.rulesConsidered} rule(s) considered`,
      report.added.length > 0 ? `${report.added.length} added` : null,
      report.reopened.length > 0 ? `${report.reopened.length} reinstated` : null,
      report.droppedNowIrrelevant.length > 0
        ? `${report.droppedNowIrrelevant.length} no longer applicable`
        : null,
      report.undecided.length > 0
        ? `${report.undecided.length} waiting on an unanswered question`
        : null,
    ].filter(Boolean);
    return { notice: `${parts.join(", ")}.` };
  } catch (error) {
    return toFormState(error, "The checklist could not be rebuilt.");
  }
}

export async function requirementAction(_prev: FormState, form: FormData): Promise<FormState> {
  const caseId = text(form, "caseId");
  try {
    const { principal, db, context } = await begin("case.checklist.manage");
    await db.transaction(async (tx) => {
      if (text(form, "intent") === "add") {
        await addRequirement(
          tx,
          principal,
          {
            caseId,
            title: text(form, "title"),
            detail: optional(form, "detail"),
            kind: (text(form, "kind") || "action") as RequirementKind,
            sourceRef: optional(form, "sourceRef"),
            dueOn: optional(form, "dueOn"),
          },
          context,
        );
        return;
      }
      await setRequirementStatus(
        tx,
        principal,
        {
          requirementId: text(form, "requirementId"),
          status: text(form, "status") as RequirementStatus,
          documentId: optional(form, "documentId"),
          reason: optional(form, "reason"),
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "The checklist item could not be changed.");
  }
  refreshCase(caseId);
  return { notice: "Saved." };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function taskAction(_prev: FormState, form: FormData): Promise<FormState> {
  const caseId = text(form, "caseId");
  const intent = text(form, "intent");
  try {
    const db = await getDb();
    const context = await getRequestContext();

    if (intent === "complete") {
      // The assignee may finish their own work without the capability to manage
      // anybody else's, so this one gates on `case.task.view` and the core layer
      // checks whether the caller is the assignee.
      const principal = await requireCapability("case.task.view");
      await db.transaction(async (tx) => completeTask(tx, principal, text(form, "taskId"), context));
    } else if (intent === "cancel") {
      const principal = await requireCapability("case.task.manage");
      await db.transaction(async (tx) =>
        cancelTask(tx, principal, text(form, "taskId"), text(form, "reason"), context),
      );
    } else {
      const principal = await requireCapability("case.task.manage");
      await db.transaction(async (tx) =>
        createTask(
          tx,
          principal,
          {
            caseId,
            title: text(form, "title"),
            detail: optional(form, "detail"),
            requirementId: optional(form, "requirementId"),
            assigneeId: optional(form, "assigneeId"),
            dueOn: optional(form, "dueOn"),
            priority: (text(form, "priority") || "normal") as
              | "low"
              | "normal"
              | "high"
              | "urgent",
          },
          context,
        ),
      );
    }
  } catch (error) {
    return toFormState(error, "The task could not be changed.");
  }
  refreshCase(caseId);
  return { notice: "Saved." };
}

// ---------------------------------------------------------------------------
// Questions and rules
// ---------------------------------------------------------------------------

export async function saveFactDefinitionAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("case.rule.propose");
    await db.transaction(async (tx) =>
      saveFactDefinition(
        tx,
        principal,
        {
          key: text(form, "key"),
          label: text(form, "label"),
          kind: (text(form, "kind") || "boolean") as FactKind,
          options: text(form, "options")
            ? text(form, "options")
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean)
            : [],
          prompt: optional(form, "prompt"),
          helpText: optional(form, "helpText"),
          matterTypes: form.getAll("matterTypes").map(String),
          sortOrder: Number(text(form, "sortOrder") || "100"),
          isActive: !checked(form, "retire"),
        },
        context,
      ),
    );
  } catch (error) {
    return toFormState(error, "The question could not be saved.");
  }
  revalidatePath("/cases/rules");
  return { notice: "Saved." };
}

/**
 * Assembles a condition from the form rows.
 *
 * Every row is one test on one declared fact, and the rows are joined by the chosen
 * connective. That is less expressive than the language the evaluator accepts — no
 * nesting, no `not` — and deliberately so: this is the editor, not the format. A rule
 * needing more structure is a rule that should be split, and the validator in the core
 * layer will say so.
 */
function readCondition(form: FormData): unknown {
  const join = text(form, "join") === "any" ? "any" : "all";
  const tests: Record<string, unknown>[] = [];

  for (let index = 0; form.has(`tests[${index}].fact`); index += 1) {
    const at = (name: string) => String(form.get(`tests[${index}].${name}`) ?? "").trim();
    const fact = at("fact");
    if (!fact) continue;
    const operator = at("operator") || "is";
    const raw = at("value");

    if (operator === "answered") {
      tests.push({ fact, answered: true });
      continue;
    }
    if (operator === "atLeast" || operator === "atMost") {
      tests.push({ fact, [operator]: Number(raw) });
      continue;
    }
    if (operator === "oneOf") {
      tests.push({
        fact,
        oneOf: raw
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      });
      continue;
    }
    // is / isNot / onOrBefore / onOrAfter. Booleans arrive as the words, and the
    // validator refuses anything that does not suit the question's type.
    const value = raw === "true" ? true : raw === "false" ? false : raw;
    tests.push({ fact, [operator]: value });
  }

  return join === "all" ? { all: tests } : { any: tests };
}

export async function saveRuleAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("case.rule.propose");
    const saved = await db.transaction(async (tx) =>
      saveRequirementRule(
        tx,
        principal,
        {
          ruleId: optional(form, "ruleId") ?? undefined,
          code: text(form, "code"),
          title: text(form, "title"),
          detail: optional(form, "detail"),
          kind: (text(form, "kind") || "document") as RequirementKind,
          matterTypes: form.getAll("matterTypes").map(String),
          appliesWhen: readCondition(form),
          sourceRef: text(form, "sourceRef"),
          effectiveFrom: optional(form, "effectiveFrom"),
          effectiveTo: optional(form, "effectiveTo"),
          notes: optional(form, "notes"),
        },
        context,
      ),
    );
    revalidatePath("/cases/rules");
    return {
      notice: `${saved.code} v${saved.version} saved as a draft. Somebody else must approve it before it can appear on a checklist.`,
    };
  } catch (error) {
    return toFormState(error, "The rule could not be saved.");
  }
}

export async function approveRuleAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("case.rule.approve");
    await db.transaction(async (tx) => {
      if (text(form, "intent") === "retire") {
        await retireRequirementRule(
          tx,
          principal,
          text(form, "ruleId"),
          text(form, "reason"),
          context,
        );
      } else {
        await approveRequirementRule(tx, principal, text(form, "ruleId"), context);
      }
    });
  } catch (error) {
    return toFormState(error, "The rule could not be approved.");
  }
  revalidatePath("/cases/rules");
  revalidatePath("/cases");
  return { notice: "Saved." };
}
