import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { AUDIT, getQuotation, writeAudit } from "@cac/core";
import { getPrincipal, getRequestContext } from "@/lib/auth";
import { companyDetails } from "@/lib/company-details";
import { renderQuotationPdf } from "@/lib/sales-document-pdf";

/**
 * The quotation as a PDF, which is the thing the client is actually sent.
 *
 * A route handler rather than a page, because the useful artefact is a file that can be attached to
 * an email or filed. The capability is checked here exactly as it is on the page: a route handler is
 * not a side door.
 *
 * Producing a copy is audited. It is the point at which the firm's figures leave the system, and
 * "who sent whom what, and when" is a question that gets asked during a dispute.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const principal = await getPrincipal();
  if (!principal) {
    return new NextResponse("Sign in to continue.", { status: 401 });
  }
  if (!principal.mfaSatisfied || !principal.capabilities.has("accounting.quotation.view")) {
    return new NextResponse("You do not have permission to view this.", { status: 403 });
  }

  const { id } = await context.params;
  const db = await getDb();
  const document = await getQuotation(db, id);
  if (!document) return new NextResponse("No such document.", { status: 404 });

  if (document.status === "draft") {
    // Before it is sent the quotation has no number and nobody has committed to it. Producing a file
    // at that point invites its being sent.
    return new NextResponse(
      "This quotation has not been sent yet, so there is no document to produce.",
      { status: 409 },
    );
  }


  const pdf = await renderQuotationPdf(document, await companyDetails(db));

  await writeAudit(db, {
    ...(await getRequestContext()),
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.DOCUMENT_PRODUCED,
    entityType: "quotation",
    entityId: document.id,
    newValues: { reference: document.quotationNo ?? null, format: "pdf" },
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      // `inline` so it opens in the browser's viewer; the filename is still used when the reader
      // saves it.
      "content-disposition": `inline; filename="${document.quotationNo ?? "quotation"}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
