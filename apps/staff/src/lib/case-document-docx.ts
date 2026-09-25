import { Document, Packer, Paragraph, TextRun } from "docx";
import { formatDate, toParagraphs, type GeneratedCaseDocument } from "@cac/core";
import type { CompanyDetails } from "./invoice-pdf";

/**
 * A generated case document as a DOCX.
 *
 * Word while it is being worked on, because that is what gets signed, annotated and passed
 * across a desk — and because forcing somebody to retype an application is how a filed
 * document ends up differing from the one on the record.
 *
 * The rendered body is used exactly as stored. It was produced once, when the document was
 * generated, and nothing re-renders it: the Word file, the PDF and the screen all print the
 * same text, so they cannot disagree.
 *
 * A document that is not finalised carries a prominent line saying so, with its status and
 * its provenance. A Word file circulates, and a draft application that looks identical to a
 * finalised one will be treated as one.
 */
export async function renderCaseDocumentDocx(
  document: GeneratedCaseDocument,
  company: CompanyDetails,
): Promise<Buffer> {
  const paragraphs: Paragraph[] = [];

  paragraphs.push(
    new Paragraph({ children: [new TextRun({ text: company.name, bold: true, size: 28 })] }),
  );
  if (company.address) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: company.address, size: 18, color: "555555" })],
        spacing: { after: 240 },
      }),
    );
  }

  if (document.status !== "finalised") {
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text:
              `${document.status.toUpperCase()} — not finalised. ` +
              (document.status === "draft"
                ? "This document has not been reviewed by anybody."
                : document.status === "approved"
                  ? `Reviewed by ${document.reviewedByName ?? "—"}, and not yet finalised. The finalised version is a PDF with a recorded checksum.`
                  : `This document was cancelled: ${document.cancelReason ?? ""}`),
            bold: true,
            color: "8A5A00",
            size: 20,
          }),
        ],
        spacing: { after: 200 },
      }),
    );
  }

  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: document.title, bold: true, size: 26 })],
      spacing: { after: 160 },
    }),
  );

  // The stored rendered text, laid out. Nothing here re-renders the template.
  for (const runs of toParagraphs(document.bodyRendered)) {
    paragraphs.push(
      new Paragraph({
        children: runs.map((text) => new TextRun({ text, size: 22 })),
        spacing: { after: 160 },
      }),
    );
  }

  // Provenance, printed on the document rather than left to a covering note.
  paragraphs.push(
    new Paragraph({
      children: [
        new TextRun({
          text:
            `${document.documentNo} · matter ${document.caseNo} · produced from ` +
            `${document.templateCode} v${document.templateVersion}` +
            (document.sourceRef ? ` (${document.sourceRef})` : "") +
            ` on ${formatDate(document.createdAt.slice(0, 10))}` +
            (document.assistantUsed
              ? ` · drafted with the assistance of ${document.modelName} ${document.modelVersion}`
              : " · no model was involved in producing this text"),
          size: 16,
          color: "777777",
        }),
      ],
      spacing: { before: 400 },
    }),
  );

  const file = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBuffer(file);
}
