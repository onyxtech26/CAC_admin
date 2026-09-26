import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { AUDIT, getPayslip, getSetting, writeAudit } from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";
import { renderPayslipPdf } from "@/lib/payslip-pdf";

/**
 * The payslip as a PDF.
 *
 * `getPayslip` applies the own-record scope, so somebody with only
 * `hr.payslip.view_own` cannot fetch a colleague's by changing the id — the guard is
 * in the data layer rather than in this route, which means it holds however the
 * payslip is reached.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const principal = await requireCapability("hr.payslip.view_own");
  const { id } = await params;
  const db = await getDb();

  const payslip = await getPayslip(db, principal, id);
  if (!payslip) return new NextResponse("Not found", { status: 404 });

  const [name, address, email, phone, registrationNo] = await Promise.all([
    getSetting<string>(db, "company.name", "Conglomerate Appraisal Consultancy"),
    getSetting<string>(db, "company.address", ""),
    getSetting<string>(db, "company.email", ""),
    getSetting<string>(db, "company.phone", ""),
    getSetting<string>(db, "company.registration_no", ""),
  ]);

  const pdf = await renderPayslipPdf(payslip, {
    name: name || "Conglomerate Appraisal Consultancy",
    address: address || "",
    email: email || "",
    phone: phone || "",
    registrationNo: registrationNo || null,
  });


  /**
   * Producing a copy is recorded.
   *
   * The invoice route did this and said why — "the point at which figures leave the system" — and
   * five of the six document routes did not, including this one. The reasoning does not stop at
   * invoices: the question asked later is "who took a copy, and when", and it is asked of exactly
   * the documents that carry somebody's affairs.
   *
   * The contents are not in the row. The document is identified and the trail is append-only, so
   * copying the contents into it would be the opposite of careful.
   */
  await writeAudit(db, {
    ...(await getRequestContext()),
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.DOCUMENT_PRODUCED,
    entityType: "payslip",
    entityId: payslip.id,
    // Whose payslip and for when. Not what it says: the figures are in the payslip, and the audit
    // trail is the one table they must not be duplicated into.
    newValues: {
      employeeNo: payslip.employeeNo,
      period: `${payslip.periodFrom} to ${payslip.periodTo}`,
      format: "pdf",
    },
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="payslip-${payslip.employeeNo}-${payslip.periodFrom}.pdf"`,
      // A payslip is personal data: no intermediary should keep a copy.
      "cache-control": "private, no-store",
    },
  });
}
