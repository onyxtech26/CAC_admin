import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { AUDIT, getPurchaseOrder, writeAudit } from "@cac/core";
import { getPrincipal, getRequestContext } from "@/lib/auth";
import { companyDetails } from "@/lib/company-details";
import { renderPurchaseOrderPdf } from "@/lib/sales-document-pdf";

/**
 * The purchase order as a PDF: the document that commits the firm to a supplier.
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
  if (!principal.mfaSatisfied || !principal.capabilities.has("accounting.po.view")) {
    return new NextResponse("You do not have permission to view this.", { status: 403 });
  }

  const { id } = await context.params;
  const db = await getDb();
  const document = await getPurchaseOrder(db, id);
  if (!document) return new NextResponse("No such document.", { status: 404 });

  if (document.status === "draft" || document.status === "pending_approval") {
    return new NextResponse(
      "This order has not been approved yet, so there is nothing to send a supplier.",
      { status: 409 },
    );
  }


  const pdf = await renderPurchaseOrderPdf(document, await companyDetails(db));

  await writeAudit(db, {
    ...(await getRequestContext()),
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.DOCUMENT_PRODUCED,
    entityType: "purchase_order",
    entityId: document.id,
    newValues: { reference: document.orderNo ?? null, format: "pdf" },
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      // `inline` so it opens in the browser's viewer; the filename is still used when the reader
      // saves it.
      "content-disposition": `inline; filename="${document.orderNo ?? "purchase-order"}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
