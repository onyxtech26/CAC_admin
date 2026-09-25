import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { getGeneratedDocument, getSetting, isUserFacingError } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { renderCaseDocumentDocx } from "@/lib/case-document-docx";

/**
 * The document as a Word file.
 *
 * Available at every stage, because a Word file is what gets signed, annotated and passed
 * across a desk — and forcing somebody to retype an application is how a filed document ends up
 * differing from the one on the record.
 *
 * The body is not re-rendered: it was produced once when the document was generated and stored,
 * so the Word file and the PDF of the same document cannot disagree. Anything not finalised
 * carries a line on its face saying so.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  const principal = await requireCapability("case.document.generate");
  const { id, docId } = await params;
  const db = await getDb();

  try {
    const document = await getGeneratedDocument(db, principal, docId);
    if (!document || document.caseId !== id) {
      return new NextResponse("Not found", { status: 404 });
    }

    const [name, address] = await Promise.all([
      getSetting<string>(db, "company.name", "Conglomerate Appraisal Consultancy"),
      getSetting<string>(db, "company.address", ""),
    ]);

    const docx = await renderCaseDocumentDocx(document, {
      name: name || "Conglomerate Appraisal Consultancy",
      address: address || "",
      email: "",
      phone: "",
    });

    return new NextResponse(new Uint8Array(docx), {
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": `attachment; filename="${document.documentNo}.docx"`,
        // A family's affairs; no intermediary keeps a copy.
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (isUserFacingError(error)) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 : 409;
      return new NextResponse(error.message, { status });
    }
    console.error("[cases] unexpected error producing a Word document:", error);
    return new NextResponse("That document could not be produced.", { status: 500 });
  }
}
