"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@cac/db";
import {
  approveLetter,
  approveTemplate,
  cancelLetter,
  generateLetter,
  issueLetter,
  saveTemplate,
  type LetterKind,
  type TemplateVariable,
  type VariableType,
} from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";
import { toFormState, type FormState } from "../../accounting/action-errors";

export type { FormState };

/**
 * Server actions for employment letters.
 *
 * The variable declarations arrive as repeated form rows rather than as JSON, because
 * somebody writing a template should not have to write JSON to say "salary is a money
 * figure and it is required". The template *body* is free text with `{{placeholders}}`,
 * which is what people already write in Word.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string) => text(form, key) || null;

async function begin(capability: string) {
  const principal = await requireCapability(capability);
  const db = await getDb();
  const context = await getRequestContext();
  return { principal, db, context };
}

/**
 * Reads the declared variables.
 *
 * Read by index until the rows run out, rather than from a count field — a stale or
 * forged count cannot make the server read rows that were not submitted.
 */
function readVariables(form: FormData): TemplateVariable[] {
  const variables: TemplateVariable[] = [];

  for (let index = 0; form.has(`variables[${index}].key`); index += 1) {
    const at = (name: string) => String(form.get(`variables[${index}].${name}`) ?? "").trim();
    const key = at("key");
    if (key === "") continue;

    variables.push({
      key,
      label: at("label") || key,
      type: (at("type") || "text") as VariableType,
      required: form.get(`variables[${index}].required`) !== null,
      hint: at("hint") || undefined,
    });
  }

  return variables;
}

export async function saveTemplateAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("hr.letter.generate");
    await db.transaction(async (tx) => {
      await saveTemplate(
        tx,
        principal,
        {
          templateId: optional(form, "templateId") ?? undefined,
          code: text(form, "code"),
          name: text(form, "name"),
          kind: (text(form, "kind") || "custom") as LetterKind,
          subject: text(form, "subject"),
          body: String(form.get("body") ?? ""),
          variables: readVariables(form),
          sourceRef: optional(form, "sourceRef"),
          notes: optional(form, "notes"),
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "The template could not be saved.");
  }

  revalidatePath("/hr/letters/templates");
  return {
    notice:
      "Saved as a draft. It cannot be used to write to anybody until it has been approved — the " +
      "wording of an appointment letter is a commitment by the firm.",
  };
}

export async function approveTemplateAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("hr.letter.approve");
    await db.transaction(async (tx) => {
      await approveTemplate(tx, principal, text(form, "templateId"), context);
    });
  } catch (error) {
    return toFormState(error, "The template could not be approved.");
  }

  revalidatePath("/hr/letters/templates");
  revalidatePath("/hr/letters");
  return {
    notice:
      "Approved, and the wording is now fixed. Any previous approved version of the same code has " +
      "been retired, so there is exactly one current version.",
  };
}

/**
 * Generates a letter.
 *
 * Values arrive as `value.<key>` fields, built from the template's own declarations, so
 * the form is whatever the template asks for and nothing else.
 */
export async function generateLetterAction(_prev: FormState, form: FormData): Promise<FormState> {
  let id: string | null = null;

  const values: Record<string, unknown> = {};
  for (const [key, raw] of form.entries()) {
    const match = /^value\.(.+)$/.exec(key);
    if (match) values[match[1]!] = String(raw);
  }

  try {
    const { principal, db, context } = await begin("hr.letter.generate");
    await db.transaction(async (tx) => {
      const created = await generateLetter(
        tx,
        principal,
        {
          employeeId: text(form, "employeeId"),
          templateCode: text(form, "templateCode"),
          letterDate: optional(form, "letterDate") ?? undefined,
          values,
          supersedesLetterId: optional(form, "supersedesLetterId"),
          notes: optional(form, "notes"),
        },
        context,
      );
      id = created.id;
    });
  } catch (error) {
    return toFormState(error, "The letter could not be generated.");
  }

  revalidatePath("/hr/letters");
  redirect(`/hr/letters/${id}`);
}

export async function letterAction(_prev: FormState, form: FormData): Promise<FormState> {
  const letterId = text(form, "letterId");
  const action = text(form, "action");
  let notice = "Done.";

  try {
    const { principal, db, context } = await begin(
      action === "approve" ? "hr.letter.approve" : "hr.letter.generate",
    );
    await db.transaction(async (tx) => {
      switch (action) {
        case "approve":
          await approveLetter(tx, principal, letterId, context);
          notice = "Approved. It can now be issued.";
          break;
        case "issue": {
          const issued = await issueLetter(tx, principal, letterId, {
            deliveryNote: optional(form, "deliveryNote"),
            context,
          });
          notice =
            `Issued as ${issued.letterNo}. It is now a document somebody has, and nothing about ` +
            "it can change — a correction would be a new letter that supersedes it.";
          break;
        }
        case "cancel":
          await cancelLetter(tx, principal, letterId, text(form, "reason"), context);
          notice = "Cancelled. Nothing was issued.";
          break;
        default:
          throw new Error(`Unknown letter action: ${action}`);
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  revalidatePath(`/hr/letters/${letterId}`);
  revalidatePath("/hr/letters");
  return { notice };
}
