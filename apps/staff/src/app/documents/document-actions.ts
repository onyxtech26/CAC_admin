"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@cac/db";
import {
  archiveDocument,
  deleteDocument,
  embedDocument,
  embeddingProviderFromEnv,
  extractAndIndex,
  ocrFromEnv,
  registerUpload,
  releaseQuarantine,
  scanDocument,
  scannerFromEnv,
  setDocumentKind,
} from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";
import { toFormState, type FormState } from "../accounting/action-errors";

export type { FormState };

/**
 * Server actions for the document library.
 *
 * The scanner, the OCR engine and the embedding model are all read from the environment
 * here and passed in, rather than being reached for inside the core layer. That keeps the
 * pipeline testable and keeps one honest fact visible in one place: in this deployment all
 * three are absent, each of them refuses, and none of them pretends.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string) => text(form, key) || null;

async function begin(capability: string) {
  const principal = await requireCapability(capability);
  const db = await getDb();
  const context = await getRequestContext();
  return { principal, db, context };
}

function refresh(documentId?: string) {
  revalidatePath("/documents");
  if (documentId) revalidatePath(`/documents/${documentId}`);
}

/**
 * Takes an uploaded file.
 *
 * The bytes are read here and checksummed in the core layer before anything else happens
 * to them. Then the scanner is asked — and when, as now, there is none, the document stays
 * in quarantine and the message says so rather than reporting a successful upload.
 */
export async function uploadDocumentAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("doc.upload");

    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { error: "Choose a file to upload.", field: "file" };
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const registered = await db.transaction(async (tx) =>
      registerUpload(
        tx,
        principal,
        {
          title: optional(form, "title") ?? undefined,
          filename: file.name,
          mediaType: file.type,
          bytes,
          caseId: optional(form, "caseId"),
          confidentiality: (text(form, "confidentiality") || "internal") as
            | "internal"
            | "client"
            | "restricted",
          notes: optional(form, "notes"),
        },
        context,
      ),
    );

    // Scan, extract and index in sequence, each stage reporting for itself. Separate
    // transactions on purpose: a document that was stored and then could not be scanned
    // must stay stored, in quarantine, rather than rolling the upload back.
    const scan = await db.transaction(async (tx) =>
      scanDocument(tx, principal, registered.id, scannerFromEnv(), context),
    );

    let extraction: string | null = null;
    if (scan.status === "clean") {
      const report = await db.transaction(async (tx) =>
        extractAndIndex(tx, principal, registered.id, { ocr: ocrFromEnv(), context }),
      );
      extraction =
        report.status === "extracted"
          ? `Indexed as ${report.chunkCount} searchable passage(s).`
          : report.detail;
    }

    refresh(registered.id);

    const duplicate = registered.duplicateOf
      ? ` The same file is already held as ${registered.duplicateOf}.`
      : "";

    return {
      notice:
        `${registered.documentNo} stored.` +
        (scan.status === "clean"
          ? ` Scanned clean. ${extraction ?? ""}`
          : ` ${scan.detail}`) +
        duplicate,
    };
  } catch (error) {
    return toFormState(error, "The file could not be stored.");
  }
}

export async function scanDocumentAction(_prev: FormState, form: FormData): Promise<FormState> {
  const documentId = text(form, "documentId");
  try {
    const { principal, db, context } = await begin("doc.upload");
    const report = await db.transaction(async (tx) =>
      scanDocument(tx, principal, documentId, scannerFromEnv(), context),
    );
    refresh(documentId);
    return report.status === "clean"
      ? { notice: "Scanned; no threat found." }
      : { error: report.detail };
  } catch (error) {
    return toFormState(error, "The file could not be scanned.");
  }
}

export async function releaseAction(_prev: FormState, form: FormData): Promise<FormState> {
  const documentId = text(form, "documentId");
  try {
    const { principal, db, context } = await begin("doc.archive");
    await db.transaction(async (tx) =>
      releaseQuarantine(tx, principal, documentId, text(form, "reason"), context),
    );
    refresh(documentId);
    return {
      notice:
        "Released without a scan. The document is recorded as unscanned — not as clean — and stays that way.",
    };
  } catch (error) {
    return toFormState(error, "The document could not be released.");
  }
}

export async function extractAction(_prev: FormState, form: FormData): Promise<FormState> {
  const documentId = text(form, "documentId");
  try {
    const { principal, db, context } = await begin("doc.upload");
    const report = await db.transaction(async (tx) =>
      extractAndIndex(tx, principal, documentId, { ocr: ocrFromEnv(), context }),
    );
    refresh(documentId);
    return report.status === "extracted"
      ? {
          notice: `Read by ${report.method}: ${report.textChars} characters over ${report.pageCount} page(s), indexed as ${report.chunkCount} passage(s).`,
        }
      : { error: report.detail };
  } catch (error) {
    return toFormState(error, "The document could not be read.");
  }
}

export async function embedAction(_prev: FormState, form: FormData): Promise<FormState> {
  const documentId = text(form, "documentId");
  try {
    const { principal, db, context } = await begin("doc.upload");
    const report = await db.transaction(async (tx) =>
      embedDocument(tx, principal, documentId, embeddingProviderFromEnv(), context),
    );
    refresh(documentId);
    return report.status === "embedded" ? { notice: report.detail } : { error: report.detail };
  } catch (error) {
    return toFormState(error, "The document could not be embedded.");
  }
}

export async function classifyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const documentId = text(form, "documentId");
  try {
    const { principal, db, context } = await begin("doc.upload");
    await db.transaction(async (tx) =>
      setDocumentKind(
        tx,
        principal,
        documentId,
        {
          kind: text(form, "kind"),
          title: optional(form, "title") ?? undefined,
          confidentiality: (optional(form, "confidentiality") ?? undefined) as
            | "internal"
            | "client"
            | "restricted"
            | undefined,
          notes: form.has("notes") ? optional(form, "notes") : undefined,
        },
        context,
      ),
    );
    refresh(documentId);
    return { notice: "Saved." };
  } catch (error) {
    return toFormState(error, "That could not be saved.");
  }
}

export async function archiveAction(_prev: FormState, form: FormData): Promise<FormState> {
  const documentId = text(form, "documentId");
  try {
    const { principal, db, context } = await begin("doc.archive");
    await db.transaction(async (tx) =>
      archiveDocument(tx, principal, documentId, text(form, "reason"), context),
    );
    refresh(documentId);
    return { notice: "Archived. The original is kept; it no longer appears in search." };
  } catch (error) {
    return toFormState(error, "The document could not be archived.");
  }
}

export async function deleteDocumentAction(_prev: FormState, form: FormData): Promise<FormState> {
  const documentId = text(form, "documentId");
  try {
    const { principal, db, context } = await begin("doc.delete");
    await db.transaction(async (tx) =>
      deleteDocument(tx, principal, documentId, text(form, "reason"), context),
    );
    revalidatePath("/documents");
    return { notice: "The original has been destroyed." };
  } catch (error) {
    return toFormState(error, "The document could not be destroyed.");
  }
}
