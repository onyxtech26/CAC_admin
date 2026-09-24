import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { formatDate, toParagraphs, type LetterView } from "@cac/core";
import type { CompanyDetails } from "./invoice-pdf";

/**
 * The letter as a DOCX.
 *
 * DOCX as well as PDF, because these documents get edited. An appointment letter is
 * signed, sometimes annotated, occasionally adjusted before it goes out — and a PDF
 * forces whoever needs to do that to retype it, which is how a letter ends up differing
 * from what the system says was sent.
 *
 * The rendered body is used as-is. It was produced once, when the letter was generated,
 * and stored; this function lays out that text and does not re-render anything. If it
 * did, the Word document and the PDF could disagree, which is exactly the failure this
 * whole phase is arranged to prevent.
 *
 * A letter that has not been issued carries a DRAFT line. A Word file circulates, and a
 * draft that looks identical to the real thing will be treated as the real thing.
 */
export async function renderLetterDocx(
  letter: LetterView,
  company: CompanyDetails,
): Promise<Buffer> {
  const paragraphs: Paragraph[] = [];

  // ---- Letterhead ---------------------------------------------------------
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: company.name, bold: true, size: 28 })],
    }),
  );

  if (company.address) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: company.address, size: 18, color: "555555" })],
        spacing: { after: 240 },
      }),
    );
  }

  if (letter.status !== "issued") {
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `DRAFT — not issued. This letter is ${letter.status} and has not been given to anybody.`,
            bold: true,
            color: "8A5A00",
            size: 20,
          }),
        ],
        spacing: { after: 240 },
      }),
    );
  }

  // ---- Reference and date -------------------------------------------------
  paragraphs.push(
    new Paragraph({
      children: [
        new TextRun({ text: letter.letterNo ?? "(unissued)", size: 20 }),
        new TextRun({ text: `\t${formatDate(letter.letterDate)}`, size: 20 }),
      ],
      alignment: AlignmentType.LEFT,
      spacing: { after: 240 },
    }),
  );

  // ---- Addressee ----------------------------------------------------------
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: letter.employeeName, size: 22 })],
    }),
  );

  const address = String(letter.valuesUsed.address ?? "").trim();
  if (address) {
    for (const line of address.split("\n")) {
      paragraphs.push(
        new Paragraph({ children: [new TextRun({ text: line.trim(), size: 22 })] }),
      );
    }
  }

  paragraphs.push(new Paragraph({ text: "", spacing: { after: 120 } }));

  // ---- Subject ------------------------------------------------------------
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: letter.subject, bold: true, size: 22 })],
      heading: HeadingLevel.HEADING_3,
      spacing: { after: 240 },
    }),
  );

  // ---- Body ---------------------------------------------------------------
  // `toParagraphs` splits on blank lines, so what somebody typed as paragraphs comes
  // out as paragraphs rather than one long run.
  for (const block of toParagraphs(letter.bodyRendered)) {
    paragraphs.push(
      new Paragraph({
        children: block.flatMap((line, index) =>
          index === 0
            ? [new TextRun({ text: line, size: 22 })]
            : [new TextRun({ text: line, size: 22, break: 1 })],
        ),
        spacing: { after: 200 },
      }),
    );
  }

  // ---- Signature ----------------------------------------------------------
  paragraphs.push(new Paragraph({ text: "", spacing: { after: 480 } }));
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: "_______________________________", size: 22 })],
    }),
  );
  paragraphs.push(
    new Paragraph({
      children: [
        new TextRun({ text: "for and on behalf of ", size: 20, color: "555555" }),
        new TextRun({ text: company.name, size: 20, color: "555555" }),
      ],
    }),
  );

  // ---- Provenance ---------------------------------------------------------
  // Which template version produced this, printed on the document. When a letter is
  // produced in a dispute, "which wording was this" is the first question.
  paragraphs.push(
    new Paragraph({
      children: [
        new TextRun({
          text:
            `Generated from template ${letter.templateCode} version ${letter.templateVersion}.` +
            (letter.supersedesLetterNo
              ? ` Supersedes ${letter.supersedesLetterNo}.`
              : "") +
            (letter.supersededByNo ? ` Superseded by ${letter.supersededByNo}.` : ""),
          size: 14,
          color: "888888",
        }),
      ],
      spacing: { before: 480 },
    }),
  );

  const document = new Document({
    creator: company.name,
    title: letter.subject,
    description: `${letter.templateCode} v${letter.templateVersion} — ${letter.employeeName}`,
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 },
          },
        },
        children: paragraphs,
      },
    ],
  });

  return Packer.toBuffer(document);
}
