import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { AUDIT, getReceipt, writeAudit } from "@cac/core";
import { getPrincipal, getRequestContext } from "@/lib/auth";
import { companyDetails } from "@/lib/company-details";
import { renderReceiptPdf } from "@/lib/sales-document-pdf";

/**
 * The receipt as a PDF: the customer's proof that the money arrived.
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
  if (!principal.mfaSatisfied || !principal.capabilities.has("accounting.receipt.view")) {
    return new NextResponse("You do not have permission to view this.", { status: 403 });
  }

  const { id } = await context.params;
  const db = await getDb();
  const document = await getReceipt(db, id);
  if (!document) return new NextResponse("No such document.", { status: 404 });

  if (document.status === "draft") {
    return new NextResponse(
      "This receipt has not been posted yet, so there is nothing to acknowledge.",
      { status: 409 },
    );
  }


  const pdf = await renderReceiptPdf(document, await companyDetails(db));

  await writeAudit(db, {
    ...(await getRequestContext()),
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.DOCUMENT_PRODUCED,
    entityType: "receipt",
    entityId: document.id,
    newValues: { reference: document.receiptNo ?? null, format: "pdf" },
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      // `inline` so it opens in the browser's viewer; the filename is still used when the reader
      // saves it.
      "content-disposition": `inline; filename="${document.receiptNo ?? "receipt"}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
