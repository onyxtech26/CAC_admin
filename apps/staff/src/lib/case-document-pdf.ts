import PDFDocument from "pdfkit";
import { formatDate, toParagraphs, type GeneratedCaseDocument } from "@cac/core";
import type { CompanyDetails } from "./invoice-pdf";

/**
 * A generated case document as a PDF.
 *
 * The same function produces the draft preview and the bytes that get stored at
 * finalisation, and that is deliberate: what somebody reviewed and what was filed have to be
 * the same document. The only difference between the two is the DRAFT banner, which is
 * present exactly when the document is not finalised.
 *
 * The rendered body is printed as stored — nothing re-renders the template — so this PDF, the
 * Word file and the screen cannot disagree about what the document says.
 *
 * Built-in Helvetica only, so nothing depends on fonts being installed on the server.
 */

const PAGE_MARGIN = 56;
const PAGE_WIDTH = 595.28; // A4 portrait
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const BOTTOM = PAGE_HEIGHT - PAGE_MARGIN - 44;

export async function renderCaseDocumentPdf(
  document: GeneratedCaseDocument,
  company: CompanyDetails,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  let y = PAGE_MARGIN;
  const room = (needed: number) => {
    if (y + needed > BOTTOM) {
      doc.addPage();
      y = PAGE_MARGIN;
    }
  };

  doc.fontSize(13).font("Helvetica-Bold").fillColor("#0f172a").text(company.name, PAGE_MARGIN, y);
  y += 17;
  if (company.address) {
    doc.fontSize(8).font("Helvetica").fillColor("#5b6472").text(company.address, PAGE_MARGIN, y, {
      width: CONTENT_WIDTH * 0.62,
    });
    y += 22;
  }

  if (document.status !== "finalised") {
    const banner =
      document.status === "draft"
        ? "DRAFT — not reviewed by anybody."
        : document.status === "approved"
          ? `APPROVED, NOT FINALISED — reviewed by ${document.reviewedByName ?? "—"}.`
          : `CANCELLED — ${document.cancelReason ?? ""}`;
    const height = doc.fontSize(10).font("Helvetica-Bold").heightOfString(banner, {
      width: CONTENT_WIDTH,
    });
    doc.fillColor("#8a5a00").text(banner, PAGE_MARGIN, y, { width: CONTENT_WIDTH });
    y += height + 12;
  }

  doc.fontSize(15).font("Helvetica-Bold").fillColor("#0f172a").text(document.title, PAGE_MARGIN, y, {
    width: CONTENT_WIDTH,
  });
  y += doc.heightOfString(document.title, { width: CONTENT_WIDTH }) + 14;

  // The stored rendered text. Nothing re-renders the template here.
  doc.fontSize(10.5).font("Helvetica").fillColor("#101418");
  for (const runs of toParagraphs(document.bodyRendered)) {
    const text = runs.join("");
    const height = doc.heightOfString(text, { width: CONTENT_WIDTH, lineGap: 2 });
    room(height + 8);
    doc.text(text, PAGE_MARGIN, y, { width: CONTENT_WIDTH, lineGap: 2 });
    y += height + 9;
  }

  // ---- Provenance, on every page -------------------------------------------
  const provenance =
    `${document.documentNo} · matter ${document.caseNo} · from ${document.templateCode} ` +
    `v${document.templateVersion}` +
    (document.sourceRef ? ` (${document.sourceRef})` : "") +
    ` · produced ${formatDate(document.createdAt.slice(0, 10))}` +
    (document.reviewedByName ? ` · reviewed by ${document.reviewedByName}` : "") +
    (document.assistantUsed
      ? ` · drafted with ${document.modelName} ${document.modelVersion}`
      : " · no model involved");

  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    doc
      .fontSize(7)
      .font("Helvetica")
      .fillColor("#7a838f")
      .text(
        `${provenance} — page ${index - range.start + 1} of ${range.count}`,
        PAGE_MARGIN,
        PAGE_HEIGHT - PAGE_MARGIN - 20,
        { width: CONTENT_WIDTH, align: "center" },
      );
  }

  doc.end();
  return finished;
}
