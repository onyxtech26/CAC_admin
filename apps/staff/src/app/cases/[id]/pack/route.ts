import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { buildCasePack, getSetting, isUserFacingError } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { renderCasePackPdf } from "@/lib/case-pack-pdf";

/**
 * The case preparation pack.
 *
 * Built fresh on every request rather than stored: it is a snapshot of a matter that is
 * still moving, and a cached pack is a pack that says something was true when it no longer
 * is. The date it was prepared, and by whom, are printed on it.
 *
 * `case.agent.run` rather than `case.view`, because assembling the pack runs the whole
 * deterministic agent — and the pack is the thing somebody walks into a meeting with.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("case.agent.run");
  const { id } = await params;
  const db = await getDb();

  try {
    const pack = await buildCasePack(db, principal, id);

    const [name, address] = await Promise.all([
      getSetting<string>(db, "company.name", "Conglomerate Appraisal Consultancy"),
      getSetting<string>(db, "company.address", ""),
    ]);

    const pdf = await renderCasePackPdf(pack, {
      name: name || "Conglomerate Appraisal Consultancy",
      address: address || "",
      email: "",
      phone: "",
    });

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${pack.caseNo}-preparation-pack.pdf"`,
        // A family's affairs; no intermediary keeps a copy.
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (isUserFacingError(error)) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 : 409;
      return new NextResponse(error.message, { status });
    }
    console.error("[cases] unexpected error building a preparation pack:", error);
    return new NextResponse("The pack could not be produced.", { status: 500 });
  }
}
