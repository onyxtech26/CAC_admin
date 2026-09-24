import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { AUDIT, getInvoice, getSettings, writeAudit } from "@cac/core";
import { getPrincipal, getRequestContext } from "@/lib/auth";
import { renderInvoicePdf } from "@/lib/invoice-pdf";

/**
 * The invoice as a downloadable PDF.
 *
 * A route handler rather than a page, because the useful artefact is a file that
 * can be attached to an email or filed. The capability is checked here exactly as
 * it is on the page: a route handler is not a side door.
 *
 * Producing a copy of a customer document is audited. It is the point at which
 * figures leave the system, and "who sent the customer what, and when" is a
 * question that gets asked during a dispute.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const principal = await getPrincipal();
  if (!principal) {
    return new NextResponse("Sign in to continue.", { status: 401 });
  }
  if (!principal.mfaSatisfied || !principal.capabilities.has("accounting.invoice.view")) {
    return new NextResponse("You do not have permission to view invoices.", { status: 403 });
  }

  const { id } = await context.params;
  const db = await getDb();
  const invoice = await getInvoice(db, id);
  if (!invoice) return new NextResponse("No such invoice.", { status: 404 });

  if (!["issued", "paid", "void"].includes(invoice.status)) {
    // Before it is issued the document has no number and nobody has committed to
    // it. Producing a file at that point invites it being sent.
    return new NextResponse(
      "This invoice has not been issued yet, so there is no document to produce.",
      { status: 409 },
    );
  }

  const settings = await getSettings(db, [
    "company.name",
    "company.address",
    "company.email",
    "company.phone",
    "company.registration_no",
    "tax.sst_registration_no",
  ]);

  const pdf = await renderInvoicePdf(invoice, {
    name: String(settings["company.name"] ?? "Conglomerate Appraisal Consultancy"),
    address: String(settings["company.address"] ?? ""),
    email: String(settings["company.email"] ?? ""),
    phone: String(settings["company.phone"] ?? ""),
    registrationNo: (settings["company.registration_no"] as string) ?? null,
    sstNumber: (settings["tax.sst_registration_no"] as string) ?? null,
  });

  await writeAudit(db, {
    ...(await getRequestContext()),
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.DOCUMENT_PRODUCED,
    entityType: "invoice",
    entityId: invoice.id,
    newValues: { invoiceNo: invoice.invoiceNo, format: "pdf" },
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      // `inline` so it opens in the browser's viewer; the filename is still used
      // when the reader saves it.
      "content-disposition": `inline; filename="${invoice.invoiceNo ?? "invoice"}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
