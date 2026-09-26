import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { getLetter, getSetting } from "@cac/core";
import { requireAnyCapability } from "@/lib/auth";
import { renderLetterPdf } from "@/lib/letter-pdf";

/** The letter as a PDF, for sending and for the file. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Either capability opens the file: the person who generated the letter, and the person who has to
  // approve it. Gating on `generate` alone meant a director approving an appointment letter could not
  // read it, and `hr.letter.approve` is precisely the capability that says they should.
  await requireAnyCapability(["hr.letter.generate", "hr.letter.approve"]);
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

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${reference}-${letter.employeeNo}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
