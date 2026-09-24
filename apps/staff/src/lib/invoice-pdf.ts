import PDFDocument from "pdfkit";
import { formatAmount, formatDate, type InvoiceView } from "@cac/core";

/**
 * The invoice as a PDF.
 *
 * Drawn with pdfkit rather than printed from the browser, because this document
 * gets emailed and filed: it has to look the same whoever produces it, and it has
 * to exist as a file rather than as whatever a print dialogue happened to do.
 *
 * Deliberately not marked `server-only`: it is a pure function of an invoice and
 * the company details, with no session or request access, and the development
 * script that renders a sample to a file imports it outside Next.js. It cannot
 * reach the browser regardless — it requires pdfkit, which is Node-only.
 *
 * Only the built-in Helvetica family is used, so nothing depends on fonts being
 * installed on the server. Everything is laid out in points from the top, because
 * a table that reflows is a table that overlaps its own footer.
 */

export interface CompanyDetails {
  name: string;
  address: string;
  email: string;
  phone: string;
  registrationNo?: string | null;
  sstNumber?: string | null;
}

const PAGE_MARGIN = 48;
const PAGE_WIDTH = 595.28; // A4 portrait
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

const COLUMNS = {
  description: PAGE_MARGIN,
  quantity: PAGE_MARGIN + 250,
  unitPrice: PAGE_MARGIN + 310,
  discount: PAGE_MARGIN + 385,
  total: PAGE_MARGIN + 455,
};

export async function renderInvoicePdf(
  invoice: InvoiceView,
  company: CompanyDetails,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const isCredit = invoice.kind === "credit_note";
  const title = isCredit ? "CREDIT NOTE" : "TAX INVOICE";

  // ---- Header -------------------------------------------------------------
  doc.fontSize(16).font("Helvetica-Bold").text(company.name, PAGE_MARGIN, PAGE_MARGIN);
  doc
    .fontSize(8)
    .font("Helvetica")
    .fillColor("#555555")
    .text(company.address, PAGE_MARGIN, doc.y + 2, { width: 280 })
    .text(`${company.email}   ${company.phone}`, { width: 280 });
  if (company.registrationNo) doc.text(`Company no. ${company.registrationNo}`, { width: 280 });
  if (company.sstNumber) doc.text(`SST no. ${company.sstNumber}`, { width: 280 });

  doc
    .fillColor("#000000")
    .fontSize(18)
    .font("Helvetica-Bold")
    .text(title, PAGE_MARGIN, PAGE_MARGIN, { width: CONTENT_WIDTH, align: "right" });
  doc
    .fontSize(10)
    .font("Helvetica")
    .text(invoice.invoiceNo ?? "DRAFT", { width: CONTENT_WIDTH, align: "right" });

  if (invoice.status === "void") {
    doc
      .fontSize(28)
      .fillColor("#c0392b")
      .font("Helvetica-Bold")
      .text("VOID", PAGE_MARGIN, 150, { width: CONTENT_WIDTH, align: "center" })
      .fillColor("#000000");
  }

  // ---- Parties and dates --------------------------------------------------
  const detailsTop = 150;
  doc.fontSize(8).fillColor("#555555").text("BILL TO", PAGE_MARGIN, detailsTop);
  doc
    .fontSize(10)
    .fillColor("#000000")
    .font("Helvetica-Bold")
    .text(invoice.customerName, PAGE_MARGIN, detailsTop + 12, { width: 260 });
  doc.font("Helvetica").fontSize(9).fillColor("#333333");
  if (invoice.customerAddress) doc.text(invoice.customerAddress, { width: 260 });
  if (invoice.customerTaxId) doc.text(`TIN ${invoice.customerTaxId}`, { width: 260 });

  const meta: Array<[string, string]> = [
    [isCredit ? "Credit note date" : "Invoice date", formatDate(invoice.invoiceDate)],
    ...(isCredit
      ? ([["Against invoice", invoice.creditsInvoiceNo ?? "—"]] as Array<[string, string]>)
      : ([["Due date", formatDate(invoice.dueDate)]] as Array<[string, string]>)),
    ["Your reference", invoice.reference ?? "—"],
  ];

  let metaY = detailsTop;
  for (const [label, value] of meta) {
    doc.fontSize(8).fillColor("#555555").text(label, PAGE_MARGIN + 320, metaY, { width: 100 });
    doc
      .fontSize(9)
      .fillColor("#000000")
      .text(value, PAGE_MARGIN + 420, metaY, { width: CONTENT_WIDTH - 420 + PAGE_MARGIN, align: "right" });
    metaY += 16;
  }

  if (invoice.subject) {
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .fillColor("#000000")
      .text(invoice.subject, PAGE_MARGIN, 240, { width: CONTENT_WIDTH });
  }

  // ---- Lines --------------------------------------------------------------
  let y = 270;
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#555555");
  doc.text("DESCRIPTION", COLUMNS.description, y);
  doc.text("QTY", COLUMNS.quantity, y, { width: 50, align: "right" });
  doc.text("UNIT PRICE", COLUMNS.unitPrice, y, { width: 65, align: "right" });
  doc.text("DISCOUNT", COLUMNS.discount, y, { width: 60, align: "right" });
  doc.text("AMOUNT", COLUMNS.total, y, { width: 92, align: "right" });

  y += 12;
  doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_WIDTH - PAGE_MARGIN, y).strokeColor("#cccccc").stroke();
  y += 8;

  doc.font("Helvetica").fontSize(9).fillColor("#000000");
  for (const line of invoice.lines) {
    // Start a new page before a line would run off the bottom, rather than after.
    if (y > 640) {
      doc.addPage();
      y = PAGE_MARGIN;
    }

    const height = doc.heightOfString(line.description, { width: 240 });
    doc.text(line.description, COLUMNS.description, y, { width: 240 });
    doc.text(trimQuantity(line.quantity) + (line.unit ? ` ${line.unit}` : ""), COLUMNS.quantity, y, {
      width: 50,
      align: "right",
    });
    doc.text(formatAmount(line.unitPrice), COLUMNS.unitPrice, y, { width: 65, align: "right" });
    doc.text(
      line.discountAmount > 0n ? formatAmount(line.discountAmount) : "—",
      COLUMNS.discount,
      y,
      { width: 60, align: "right" },
    );
    doc.text(formatAmount(line.lineTotal), COLUMNS.total, y, { width: 92, align: "right" });
    y += Math.max(height, 12) + 6;
  }

  doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_WIDTH - PAGE_MARGIN, y).strokeColor("#cccccc").stroke();
  y += 10;

  // ---- Totals -------------------------------------------------------------
  const totalRow = (label: string, value: string, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9);
    doc.text(label, COLUMNS.discount - 80, y, { width: 140, align: "right" });
    doc.text(value, COLUMNS.total, y, { width: 92, align: "right" });
    y += bold ? 18 : 14;
  };

  totalRow("Subtotal", formatAmount(invoice.subtotal));
  if (invoice.discountTotal > 0n) totalRow("Discount", `-${formatAmount(invoice.discountTotal)}`);
  if (invoice.taxTotal > 0n) totalRow("Service tax", formatAmount(invoice.taxTotal));
  totalRow(`Total ${invoice.currency}`, formatAmount(invoice.total), true);

  if (!isCredit && invoice.amountAllocated > 0n) {
    totalRow("Received", `-${formatAmount(invoice.amountAllocated)}`);
    totalRow("Balance due", formatAmount(invoice.outstanding), true);
  }

  // ---- Notes and terms ----------------------------------------------------
  y += 10;
  if (invoice.notes) {
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#555555").text("NOTES", PAGE_MARGIN, y);
    y += 11;
    doc.font("Helvetica").fontSize(9).fillColor("#000000").text(invoice.notes, PAGE_MARGIN, y, {
      width: CONTENT_WIDTH,
    });
    y = doc.y + 8;
  }
  if (invoice.terms) {
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#555555").text("TERMS", PAGE_MARGIN, y);
    y += 11;
    doc.font("Helvetica").fontSize(9).fillColor("#000000").text(invoice.terms, PAGE_MARGIN, y, {
      width: CONTENT_WIDTH,
    });
  }

  // ---- Footer on every page ----------------------------------------------
  const range = doc.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page += 1) {
    doc.switchToPage(page);
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor("#888888")
      .text(
        `${company.name} · ${invoice.invoiceNo ?? "draft"} · page ${page - range.start + 1} of ${range.count}` +
          (invoice.taxTotal === 0n && !isCredit ? " · no service tax charged on this invoice" : ""),
        PAGE_MARGIN,
        800,
        { width: CONTENT_WIDTH, align: "center" },
      );
  }

  doc.end();
  return finished;
}

function trimQuantity(quantity: string): string {
  const asNumber = Number.parseFloat(quantity);
  return Number.isFinite(asNumber) ? String(asNumber) : quantity;
}
