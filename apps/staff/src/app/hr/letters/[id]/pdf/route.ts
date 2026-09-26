import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { AUDIT, getLetter, getSetting, writeAudit } from "@cac/core";
import { getRequestContext, requireAnyCapability } from "@/lib/auth";
import { renderLetterPdf } from "@/lib/letter-pdf";

/** The letter as a PDF, for sending and for the file. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Either capability opens the file: the person who generated the letter, and the person who has to
  // approve it. Gating on `generate` alone meant a director approving an appointment letter could not
  // read it, and `hr.letter.approve` is precisely the capability that says they should.
  const principal = await requireAnyCapability(["hr.letter.generate", "hr.letter.approve"]);
  const { id } = await params;
  const db = await getDb();

  const letter = await getLetter(db, id);
  if (!letter) return new NextResponse("Not found", { status: 404 });

  const [name, address] = await Promise.all([
    getSetting<string>(db, "company.name", "Conglomerate Appraisal Consultancy"),
    getSetting<string>(db, "company.address", ""),
  ]);

  const pdf = await renderLetterPdf(letter, {
    name: name || "Conglomerate Appraisal Consultancy",
    address: address || "",
    email: "",
    phone: "",
  });

  const reference = letter.letterNo ?? "draft";

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
    entityType: "letter",
    entityId: letter.id,
    newValues: { reference, kind: letter.kind, format: "pdf" },
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${reference}-${letter.employeeNo}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
