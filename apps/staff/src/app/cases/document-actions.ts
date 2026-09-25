"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@cac/db";
import {
  approveCaseDocument,
  approveCaseDocumentTemplate,
  cancelCaseDocument,
  finaliseCaseDocument,
  generateCaseDocument,
  getGeneratedDocument,
  getSetting,
  saveCaseDocumentTemplate,
  type CaseDocumentKind,
  type TemplateVariable,
  type VariableType,
} from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";
import { renderCaseDocumentPdf } from "@/lib/case-document-pdf";
import { toFormState, type FormState } from "../accounting/action-errors";

export type { FormState };

/**
 * Server actions for documents generated on a matter.
 *
 * The one worth reading is `finaliseDocumentAction`. Finalising renders the PDF *here*, on the
 * server, and hands those exact bytes to the core layer to store — so the file that is kept is
 * the file that was produced, checksummed as it was stored. Re-rendering at download time
 * would mean the document served next year is a fresh rendering that might differ from the one
 * whose checksum is on the record.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string) => text(form, key) || null;

async function begin(capability: string) {
  const principal = await requireCapability(capability);
  const db = await getDb();
  const context = await getRequestContext();
  return { principal, db, context };
}

function refresh(caseId: string, documentId?: string) {
  revalidatePath(`/cases/${caseId}/documents`);
  revalidatePath(`/cases/${caseId}`);
  if (documentId) revalidatePath(`/cases/${caseId}/documents/${documentId}`);
}

/**
 * Reads the declared variables from repeated form rows.
 *
 * By index until the rows run out, rather than from a count field: a stale or forged count
 * cannot make the server read rows that were not submitted.
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

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function saveCaseTemplateAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("case.document.generate");
    const saved = await db.transaction(async (tx) =>
      saveCaseDocumentTemplate(
        tx,
        principal,
        {
          templateId: optional(form, "templateId") ?? undefined,
          code: text(form, "code"),
          name: text(form, "name"),
          kind: (text(form, "kind") || "other") as CaseDocumentKind,
          matterTypes: form.getAll("matterTypes").map(String),
          title: text(form, "title"),
          body: String(form.get("body") ?? ""),
          variables: readVariables(form),
          sourceRef: optional(form, "sourceRef"),
          notes: optional(form, "notes"),
        },
        context,
      ),
    );
    revalidatePath("/cases/templates");
    return {
      notice: `${saved.code} v${saved.version} saved as a draft. Somebody else must approve it before any document can be produced from it.`,
    };
  } catch (error) {
    return toFormState(error, "The template could not be saved.");
  }
}

export async function approveCaseTemplateAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("case.document.approve");
    await db.transaction(async (tx) =>
      approveCaseDocumentTemplate(tx, principal, text(form, "templateId"), context),
    );
  } catch (error) {
    return toFormState(error, "The template could not be approved.");
  }
  revalidatePath("/cases/templates");
  return { notice: "Approved. It can now produce documents." };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export async function generateDocumentAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const caseId = text(form, "caseId");
  let generated: { id: string } | null = null;
  try {
    const { principal, db, context } = await begin("case.document.generate");

    // The values arrive as values[key]; read by the template's declared keys on the server
    // rather than trusting whatever the form sent.
    const values: Record<string, unknown> = {};
    for (const [field, value] of form.entries()) {
      const match = /^values\[(.+)\]$/.exec(field);
      if (match) values[match[1]] = typeof value === "string" ? value : "";
    }

    generated = await db.transaction(async (tx) =>
      generateCaseDocument(
        tx,
        principal,
        {
          caseId,
          templateId: text(form, "templateId"),
          values,
          supersedesId: optional(form, "supersedesId"),
          notes: optional(form, "notes"),
        },
        context,
      ),
    );
  } catch (error) {
    return toFormState(error, "The document could not be produced.");
  }
  refresh(caseId, generated.id);
  redirect(`/cases/${caseId}/documents/${generated.id}`);
}

export async function approveDocumentAction(_prev: FormState, form: FormData): Promise<FormState> {
  const caseId = text(form, "caseId");
  const documentId = text(form, "documentId");
  try {
    const { principal, db, context } = await begin("case.document.approve");
    await db.transaction(async (tx) =>
      approveCaseDocument(tx, principal, documentId, optional(form, "note"), context),
    );
  } catch (error) {
    return toFormState(error, "The document could not be approved.");
  }
  refresh(caseId, documentId);
  return { notice: "Reviewed and approved. Finalising will produce the PDF that is kept." };
}

/**
 * Finalises the document against the PDF produced from it.
 *
 * The PDF is rendered here and handed to the core layer, which stores those exact bytes in the
 * document library and records their checksum. The file kept is the file produced.
 */
export async function finaliseDocumentAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const caseId = text(form, "caseId");
  const documentId = text(form, "documentId");
  try {
    const { principal, db, context } = await begin("case.document.approve");

    const document = await getGeneratedDocument(db, principal, documentId);
    if (!document) return { error: "That document no longer exists." };

    const [name, address] = await Promise.all([
      getSetting<string>(db, "company.name", "Conglomerate Appraisal Consultancy"),
      getSetting<string>(db, "company.address", ""),
    ]);

    // Rendered as finalised, because that is what is being stored: the banner on a draft
    // preview must not end up on the filed document.
    const pdf = await renderCaseDocumentPdf(
      { ...document, status: "finalised" },
      {
        name: name || "Conglomerate Appraisal Consultancy",
        address: address || "",
        email: "",
        phone: "",
      },
    );

    const result = await db.transaction(async (tx) =>
      finaliseCaseDocument(tx, principal, documentId, new Uint8Array(pdf), context),
    );

    refresh(caseId, documentId);
    revalidatePath("/documents");
    return {
      notice: `Finalised. The PDF is stored and cannot be altered; its checksum is ${result.sha256.slice(
        0,
        12,
      )}…`,
    };
  } catch (error) {
    return toFormState(error, "The document could not be finalised.");
  }
}

export async function cancelDocumentAction(_prev: FormState, form: FormData): Promise<FormState> {
  const caseId = text(form, "caseId");
  const documentId = text(form, "documentId");
  try {
    const { principal, db, context } = await begin("case.document.generate");
    await db.transaction(async (tx) =>
      cancelCaseDocument(tx, principal, documentId, text(form, "reason"), context),
    );
  } catch (error) {
    return toFormState(error, "The document could not be cancelled.");
  }
  refresh(caseId, documentId);
  return { notice: "Cancelled." };
}
