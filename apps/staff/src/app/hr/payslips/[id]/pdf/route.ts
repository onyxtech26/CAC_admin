import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { getPayslip, getSetting } from "@cac/core";
import { requireCapability } from "@/lib/auth";
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

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="payslip-${payslip.employeeNo}-${payslip.periodFrom}.pdf"`,
      // A payslip is personal data: no intermediary should keep a copy.
      "cache-control": "private, no-store",
    },
  });
}
