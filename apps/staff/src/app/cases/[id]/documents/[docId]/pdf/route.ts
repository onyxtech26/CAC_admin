import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import {
  AUDIT,
  documentBytes,
  getGeneratedDocument,
  getSetting,
  isUserFacingError,
  writeAudit,
} from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";
import { renderCaseDocumentPdf } from "@/lib/case-document-pdf";

/**
 * The document as a PDF.
 *
 * Two different things depending on the stage, and the difference matters.
 *
 * **Before finalisation** the PDF is rendered on the fly, as a preview, and carries a banner
 * saying what it is.
 *
 * **After finalisation** the stored file is served — the exact bytes whose checksum is on the
 * record, held immutably in the document library. It is *not* re-rendered. A fresh rendering
 * could differ by a hair from the one that was approved, and then the checksum on the record
 * would describe a file nobody has.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  // Reading a document is not generating one.
  //
  // This gated on `case.document.generate`, so the director asked to approve a generated application
  // was sent to /denied for a capability they have no business holding — the approver could not open
  // the thing they were approving. `case.document.download` exists for exactly this and gated
  // nothing at all; now it gates this, and the approving roles hold it.
  const principal = await requireCapability("case.document.download");
  const { id, docId } = await params;
  const db = await getDb();

  try {
    const document = await getGeneratedDocument(db, principal, docId);
    if (!document || document.caseId !== id) {
      return new NextResponse("Not found", { status: 404 });
    }

    if (document.status === "finalised" && document.pdfDocumentId) {
      const context = await getRequestContext();
      const stored = await documentBytes(db, principal, document.pdfDocumentId, {
        reason: `Serving the finalised ${document.documentNo}.`,
        context,
      });
      return new NextResponse(new Uint8Array(stored.bytes), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `inline; filename="${document.documentNo}.pdf"`,
          "cache-control": "private, no-store",
        },
      });
    }

    const [name, address] = await Promise.all([
      getSetting<string>(db, "company.name", "Conglomerate Appraisal Consultancy"),
      getSetting<string>(db, "company.address", ""),
    ]);

    const pdf = await renderCaseDocumentPdf(document, {
      name: name || "Conglomerate Appraisal Consultancy",
      address: address || "",
      email: "",
      phone: "",
    });


    /**
     * Producing a copy is recorded.
     *
     * For a finalised document the stored file is served and `documentBytes` audits that read; this
     * covers the other path, the preview of something still in draft or under review. A draft of a
     * court application leaving as a file is worth the same row as a final one — arguably more,
     * since it is the version that has not been approved.
     */
    await writeAudit(db, {
      ...(await getRequestContext()),
      actorUserId: principal.userId,
      actorLabel: principal.email,
      action: AUDIT.DOCUMENT_PRODUCED,
      entityType: "estate.generated_document",
      entityId: document.id,
      newValues: {
        documentNo: document.documentNo,
        status: document.status,
        format: "pdf",
      },
    });

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${document.documentNo}-draft.pdf"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (isUserFacingError(error)) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 : 409;
      return new NextResponse(error.message, { status });
    }
    console.error("[cases] unexpected error producing a PDF:", error);
    return new NextResponse("That document could not be produced.", { status: 500 });
  }
}
