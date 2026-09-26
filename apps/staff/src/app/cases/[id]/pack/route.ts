import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { AUDIT, buildCasePack, isUserFacingError, writeAudit } from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";
import { companyDetails } from "@/lib/company-details";
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

    const pdf = await renderCasePackPdf(pack, await companyDetails(db));

    /**
     * Producing a pack is recorded.
     *
     * Every other document route audits itself and this one did not, which is the wrong way round:
     * the pack is the most complete thing the platform assembles — the deceased, the parties, every
     * figure with its basis, the gaps and the contradictions — and it leaves as a file somebody
     * carries into a meeting. "Who took a copy of this matter, and when" is the question asked
     * after it turns up somewhere it should not have.
     *
     * The contents are not in the row: the matter is identified and the audit trail is append-only,
     * so copying a family's affairs into it would be the opposite of careful.
     */
    await writeAudit(db, {
      ...(await getRequestContext()),
      actorUserId: principal.userId,
      actorLabel: principal.email,
      action: AUDIT.DOCUMENT_PRODUCED,
      entityType: "estate.case",
      entityId: id,
      newValues: {
        caseNo: pack.caseNo,
        document: "case preparation pack",
        format: "pdf",
        requirements: pack.requirements.length,
        gaps: pack.gaps.length,
      },
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
