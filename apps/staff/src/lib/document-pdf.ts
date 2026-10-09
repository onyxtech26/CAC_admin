import PDFDocument from "pdfkit";

/**
 * One layout, for every document this firm sends out.
 *
 * There was one of these and it rendered invoices. A quotation advanced to "sent" and a purchase
 * order committed the firm to a supplier with nothing to attach to an email — and the quotation
 * screen said in as many words "attach the PDF to your own message", which there was no way to do.
 *
 * Rather than four near-copies of two hundred lines of layout, this takes a description of a
 * document — who it is to, what the meta rows say, a table, some totals — and draws it. The callers
 * are adapters: `renderInvoicePdf` is one of them, so the invoice is not a special case that drifts
 * away from the rest.
 *
 * Deliberately not marked `server-only`: it is a pure function of its inputs with no session or
 * request access, and the sample script imports it outside Next.js. It cannot reach the browser
 * regardless, because it requires pdfkit, which is Node-only.
 *
 * Only the built-in Helvetica family is used, so nothing depends on fonts being installed on the
 * server. Everything is laid out in points from the top, because a table that reflows is a table
 * that overlaps its own footer.
 */

export interface CompanyDetails {
  name: string;
  address: string;
  email: string;
  phone: string;
  registrationNo?: string | null;
  sstNumber?: string | null;
}

export interface DocumentColumn {
  heading: string;
  /** Points from the left margin. */
  offset: number;
  width: number;
  align?: "left" | "right";
  /** The first column wraps; the others are single-line figures. */
  wraps?: boolean;
}

export interface DocumentSpec {
  /** "TAX INVOICE", "QUOTATION", "OFFICIAL RECEIPT" … */
  title: string;
  /** The document's number, or "DRAFT". */
  reference: string;
  /** Drawn across the middle in red: "VOID", "CANCELLED". */
  watermark?: string | null;
  party: {
    /** "BILL TO", "TO", "RECEIVED FROM", "PAY TO". */
    label: string;
    name: string;
    address?: string | null;
    taxId?: string | null;
  };
  /** Right-hand block: dates, references, terms. */
  meta: Array<[string, string]>;
  subject?: string | null;
  /** Omitted for a document that has no line items, such as a receipt. */
  columns?: DocumentColumn[];
  rows?: string[][];
  totals?: Array<{ label: string; value: string; bold?: boolean }>;
  notes?: string | null;
  terms?: string | null;
  /** Appended to the footer of every page. */
  footerNote?: string | null;
}

const PAGE_MARGIN = 48;
const PAGE_WIDTH = 595.28; // A4 portrait
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

/** The column set a line-item document uses: description, quantity, unit price, discount, amount. */
export const LINE_COLUMNS: DocumentColumn[] = [
  { heading: "DESCRIPTION", offset: 0, width: 220, wraps: true },
  { heading: "QTY", offset: 225, width: 40, align: "right" },
  { heading: "UNIT PRICE", offset: 270, width: 70, align: "right" },
  { heading: "DISCOUNT", offset: 345, width: 55, align: "right" },
  { heading: "AMOUNT", offset: 405, width: 94, align: "right" },
];

export async function renderDocumentPdf(
  spec: DocumentSpec,
  company: CompanyDetails,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

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
    .text(spec.title, PAGE_MARGIN, PAGE_MARGIN, { width: CONTENT_WIDTH, align: "right" });
  doc
    .fontSize(10)
    .font("Helvetica")
    .text(spec.reference, { width: CONTENT_WIDTH, align: "right" });

  if (spec.watermark) {
    doc
      .fontSize(28)
      .fillColor("#c0392b")
      .font("Helvetica-Bold")
      .text(spec.watermark, PAGE_MARGIN, 150, { width: CONTENT_WIDTH, align: "center" })
      .fillColor("#000000");
  }

  // ---- Parties and dates --------------------------------------------------
  const detailsTop = 150;
  doc.fontSize(8).fillColor("#555555").text(spec.party.label, PAGE_MARGIN, detailsTop);
  doc
    .fontSize(10)
    .fillColor("#000000")
    .font("Helvetica-Bold")
    .text(spec.party.name, PAGE_MARGIN, detailsTop + 12, { width: 260 });
  doc.font("Helvetica").fontSize(9).fillColor("#333333");
  if (spec.party.address) doc.text(spec.party.address, { width: 260 });
  if (spec.party.taxId) doc.text(`TIN ${spec.party.taxId}`, { width: 260 });

  let metaY = detailsTop;
  for (const [label, value] of spec.meta) {
    doc.fontSize(8).fillColor("#555555").text(label, PAGE_MARGIN + 280, metaY, { width: 110 });
    doc
      .fontSize(9)
      .fillColor("#000000")
      .text(value, PAGE_MARGIN + 395, metaY, {
        width: CONTENT_WIDTH - 395,
        align: "right",
      });
    metaY += 16;
  }

  if (spec.subject) {
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .fillColor("#000000")
      .text(spec.subject, PAGE_MARGIN, 240, { width: CONTENT_WIDTH });
  }

  // ---- The table ----------------------------------------------------------
  let y = 270;

  if (spec.columns && spec.rows) {
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#555555");
    for (const column of spec.columns) {
      doc.text(column.heading, PAGE_MARGIN + column.offset, y, {
        width: column.width,
        align: column.align ?? "left",
      });
    }

    y += 12;
    doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_WIDTH - PAGE_MARGIN, y).strokeColor("#cccccc").stroke();
    y += 8;

    doc.font("Helvetica").fontSize(9).fillColor("#000000");
    for (const row of spec.rows) {
      // Start a new page before a row would run off the bottom, rather than after.
      if (y > 640) {
        doc.addPage();
        y = PAGE_MARGIN;
      }

      let height = 12;
      spec.columns.forEach((column, index) => {
        const value = row[index] ?? "";
        if (column.wraps) {
          height = Math.max(height, doc.heightOfString(value, { width: column.width }));
        }
        doc.text(value, PAGE_MARGIN + column.offset, y, {
          width: column.width,
          align: column.align ?? "left",
        });
      });
      y += height + 6;
    }

    doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_WIDTH - PAGE_MARGIN, y).strokeColor("#cccccc").stroke();
    y += 10;
  }

  // ---- Totals -------------------------------------------------------------
  for (const total of spec.totals ?? []) {
    doc.font(total.bold ? "Helvetica-Bold" : "Helvetica").fontSize(total.bold ? 11 : 9);
    doc.text(total.label, PAGE_MARGIN + 250, y, { width: 145, align: "right" });
    doc.text(total.value, PAGE_MARGIN + 405, y, { width: 94, align: "right" });
    y += total.bold ? 18 : 14;
  }

  // ---- Notes and terms ----------------------------------------------------
  y += 10;
  for (const [heading, body] of [
    ["NOTES", spec.notes],
    ["TERMS", spec.terms],
  ] as Array<[string, string | null | undefined]>) {
    if (!body) continue;
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#555555").text(heading, PAGE_MARGIN, y);
    y += 11;
    doc.font("Helvetica").fontSize(9).fillColor("#000000").text(body, PAGE_MARGIN, y, {
      width: CONTENT_WIDTH,
    });
    y = doc.y + 8;
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
        `${company.name} · ${spec.reference} · page ${page - range.start + 1} of ${range.count}` +
          (spec.footerNote ? ` · ${spec.footerNote}` : ""),
        PAGE_MARGIN,
        800,
        { width: CONTENT_WIDTH, align: "center" },
      );
  }

  doc.end();
  return finished;
}

/** "2.0000" → "2", but "2.5000" → "2.5". A quantity reads as somebody would say it. */
export function trimQuantity(quantity: string): string {
  const asNumber = Number.parseFloat(quantity);
  return Number.isFinite(asNumber) ? String(asNumber) : quantity;
}
