import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { getLetter, getSetting } from "@cac/core";
import { requireAnyCapability } from "@/lib/auth";
import { renderLetterDocx } from "@/lib/letter-docx";

/**
 * The letter as a Word document.
 *
 * DOCX as well as PDF because these documents get signed, annotated and filed. Without
 * an editable form, whoever needs to adjust one retypes it — and a retyped letter is a
 * letter that differs from what the system says was sent.
 *
 * The body is not re-rendered here: it was produced once when the letter was generated
 * and stored, so the Word file and the PDF of the same letter cannot disagree.
 */
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

  const docx = await renderLetterDocx(letter, {
    name: name || "Conglomerate Appraisal Consultancy",
    address: address || "",
    email: "",
    phone: "",
  });

  const reference = letter.letterNo ?? "draft";

  return new NextResponse(new Uint8Array(docx), {
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": `attachment; filename="${reference}-${letter.employeeNo}.docx"`,
      // A letter about somebody's employment is personal data; no intermediary keeps a copy.
      "cache-control": "private, no-store",
    },
  });
}
