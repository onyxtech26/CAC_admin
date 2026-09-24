import PDFDocument from "pdfkit";
import { formatDate, toParagraphs, type LetterView } from "@cac/core";
import type { CompanyDetails } from "./invoice-pdf";

/**
 * The letter as a PDF.
 *
 * The same stored text as the DOCX, laid out the same way. Neither re-renders the
 * template: the body was produced once when the letter was generated and both formats
 * print that. If either re-rendered, the Word file and the PDF of the same letter could
 * differ, which is the failure this phase exists to prevent.
 *
 * Unlike the invoice, this is laid out with pdfkit's own flow rather than in absolute
 * points: a letter's length depends on what it says, and a fixed grid would push the
 * signature off the page for a long one.
 */
export async function renderLetterPdf(
  letter: LetterView,
  company: CompanyDetails,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 64, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // ---- Letterhead ---------------------------------------------------------
  doc.fontSize(14).font("Helvetica-Bold").fillColor("#000000").text(company.name);
  if (company.address) {
    doc.fontSize(8).font("Helvetica").fillColor("#555555").text(company.address, { width: 300 });
  }
  doc.moveDown(1.2);

  if (letter.status !== "issued") {
    doc
      .fontSize(9)
      .font("Helvetica-Bold")
      .fillColor("#8a5a00")
      .text(
        `DRAFT — not issued. This letter is ${letter.status} and has not been given to anybody.`,
      );
    doc.moveDown(1);
  }

  // ---- Reference and date -------------------------------------------------
  doc.fontSize(9).font("Helvetica").fillColor("#333333");
  doc.text(letter.letterNo ?? "(unissued)", { continued: true });
  doc.text(formatDate(letter.letterDate), { align: "right" });
  doc.moveDown(1.2);

  // ---- Addressee ----------------------------------------------------------
  doc.fontSize(11).font("Helvetica").fillColor("#000000").text(letter.employeeName);
  const address = String(letter.valuesUsed.address ?? "").trim();
  if (address) {
    for (const line of address.split("\n")) doc.text(line.trim());
  }
  doc.moveDown(1);

  // ---- Subject ------------------------------------------------------------
  doc.fontSize(11).font("Helvetica-Bold").text(letter.subject);
  doc.moveDown(1);

  // ---- Body ---------------------------------------------------------------
  doc.fontSize(10.5).font("Helvetica");
  for (const block of toParagraphs(letter.bodyRendered)) {
    // Lines inside a block are line breaks within one paragraph, which is how somebody
    // typing into a text box means them.
    doc.text(block.join("\n"), { align: "left", lineGap: 2 });
    doc.moveDown(0.8);
  }

  // ---- Signature ----------------------------------------------------------
  doc.moveDown(2.5);
  doc.fontSize(10.5).text("_______________________________");
  doc.fontSize(9).fillColor("#555555").text(`for and on behalf of ${company.name}`);

  // ---- Provenance ---------------------------------------------------------
  doc.moveDown(2);
  doc
    .fontSize(7)
    .fillColor("#888888")
    .text(
      `Generated from template ${letter.templateCode} version ${letter.templateVersion}.` +
        (letter.supersedesLetterNo ? ` Supersedes ${letter.supersedesLetterNo}.` : "") +
        (letter.supersededByNo ? ` Superseded by ${letter.supersededByNo}.` : ""),
    );

  doc.end();
  return finished;
}
