import PDFDocument from "pdfkit";
import { formatAmount, formatDate, type PayslipView } from "@cac/core";
import type { CompanyDetails } from "./invoice-pdf";

/**
 * The payslip as a PDF.
 *
 * Three decisions about this document are worth stating, because a payslip is read
 * by somebody checking their own pay and has to answer their questions without
 * anybody being asked.
 *
 * **Each figure shows how it was arrived at.** The `basis` recorded on every line —
 * "10% of 4500.00", or "contribution table band 3000–above" — is printed beside the
 * amount. Somebody who wants to know why their EPF is what it is can read it off the
 * page.
 *
 * **The source of each statutory figure is printed too.** Not the rate: the citation
 * the rate came from. That is what makes a disputed deduction a matter of looking
 * something up rather than of who remembers hardest.
 *
 * **The employer's contributions are shown separately and marked as not part of net
 * pay.** People reasonably assume every figure on a payslip is theirs; the employer's
 * EPF share is a real cost and belongs on the document, but showing it without saying
 * what it is invites the wrong conclusion.
 *
 * Built-in Helvetica only, so nothing depends on fonts being installed, and laid out
 * in points from the top, because a table that reflows is a table that overlaps its
 * own footer.
 */

const PAGE_MARGIN = 48;
const PAGE_WIDTH = 595.28; // A4 portrait
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

const COLUMN = {
  description: PAGE_MARGIN,
  basis: PAGE_MARGIN + 180,
  amount: PAGE_MARGIN + 430,
};

export async function renderPayslipPdf(
  payslip: PayslipView,
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
  doc.fontSize(15).font("Helvetica-Bold").text(company.name, PAGE_MARGIN, PAGE_MARGIN);
  doc
    .fontSize(8)
    .font("Helvetica")
    .fillColor("#555555")
    .text(company.address, PAGE_MARGIN, PAGE_MARGIN + 20, { width: 260 });

  doc
    .fontSize(15)
    .font("Helvetica-Bold")
    .fillColor("#000000")
    .text("PAYSLIP", PAGE_MARGIN + 340, PAGE_MARGIN, { width: 160, align: "right" });

  doc
    .fontSize(9)
    .font("Helvetica")
    .text(
      `${formatDate(payslip.periodFrom)} to ${formatDate(payslip.periodTo)}`,
      PAGE_MARGIN + 300,
      PAGE_MARGIN + 22,
      { width: 200, align: "right" },
    )
    .text(`Paid ${formatDate(payslip.payDate)}`, PAGE_MARGIN + 300, PAGE_MARGIN + 34, {
      width: 200,
      align: "right",
    })
    .text(payslip.runNo ?? "", PAGE_MARGIN + 300, PAGE_MARGIN + 46, {
      width: 200,
      align: "right",
    });

  // A payslip from a run that is not yet finalised is not a document anybody should
  // rely on, and it says so rather than looking identical to one that is.
  let top = PAGE_MARGIN + 74;
  if (payslip.runStatus !== "finalised" && payslip.runStatus !== "posted") {
    doc
      .fontSize(9)
      .font("Helvetica-Bold")
      .fillColor("#8a5a00")
      .text(
        `DRAFT — this payroll run is ${payslip.runStatus} and the figures may still change.`,
        PAGE_MARGIN,
        top,
        { width: CONTENT_WIDTH },
      );
    doc.fillColor("#000000");
    top += 18;
  }

  // ---- Who ----------------------------------------------------------------
  doc.fontSize(10).font("Helvetica-Bold").text(payslip.employeeName, PAGE_MARGIN, top);
  doc
    .fontSize(8)
    .font("Helvetica")
    .fillColor("#555555")
    .text(
      [
        payslip.employeeNo,
        payslip.positionTitle,
        payslip.departmentName,
        payslip.bankName && payslip.bankAccountLast4
          ? `${payslip.bankName} ···${payslip.bankAccountLast4}`
          : null,
      ]
        .filter(Boolean)
        .join("  ·  "),
      PAGE_MARGIN,
      top + 14,
      { width: CONTENT_WIDTH },
    );

  if (payslip.payableDays && payslip.periodDays && payslip.payableDays !== payslip.periodDays) {
    doc.text(
      `Paid for ${payslip.payableDays} of ${payslip.periodDays} days in the period.`,
      PAGE_MARGIN,
      top + 26,
      { width: CONTENT_WIDTH },
    );
    top += 12;
  }

  doc.fillColor("#000000");
  top += 42;

  // ---- Lines --------------------------------------------------------------
  const section = (title: string, kind: "earning" | "deduction" | "employer", startAt: number) => {
    const lines = payslip.lines.filter((line) => line.kind === kind);
    if (lines.length === 0) return startAt;

    let y = startAt;
    doc.fontSize(9).font("Helvetica-Bold").text(title, COLUMN.description, y);
    y += 14;

    doc
      .moveTo(PAGE_MARGIN, y - 3)
      .lineTo(PAGE_WIDTH - PAGE_MARGIN, y - 3)
      .strokeColor("#dddddd")
      .lineWidth(0.5)
      .stroke();

    for (const line of lines) {
      doc.fontSize(9).font("Helvetica").fillColor("#000000");
      doc.text(line.description, COLUMN.description, y, { width: 170 });

      if (line.basis) {
        doc
          .fontSize(7.5)
          .fillColor("#666666")
          .text(line.basis, COLUMN.basis, y + 1, { width: 240 });

        // The citation, where the figure came from a statutory table. This is the
        // line that turns a disputed deduction into something lookupable.
        if (line.statutorySource) {
          doc.text(line.statutorySource, COLUMN.basis, y + 11, { width: 240 });
        }
      }

      doc
        .fontSize(9)
        .fillColor("#000000")
        .text(formatAmount(line.amount), COLUMN.amount, y, { width: 68, align: "right" });

      y += line.statutorySource ? 24 : line.basis ? 18 : 14;
    }

    return y + 8;
  };

  top = section("Earnings", "earning", top);
  top = section("Deductions", "deduction", top);

  // ---- Totals -------------------------------------------------------------
  doc
    .moveTo(PAGE_MARGIN, top)
    .lineTo(PAGE_WIDTH - PAGE_MARGIN, top)
    .strokeColor("#000000")
    .lineWidth(0.8)
    .stroke();

  top += 8;

  const total = (label: string, amount: string, bold = false) => {
    doc
      .fontSize(bold ? 11 : 9)
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .text(label, COLUMN.basis, top, { width: 240, align: "right" })
      .text(amount, COLUMN.amount, top, { width: 68, align: "right" });
    top += bold ? 18 : 14;
  };

  total("Gross pay", formatAmount(payslip.grossPay));
  total("Total deductions", formatAmount(payslip.totalDeductions));
  total("Net pay", formatAmount(payslip.netPay), true);

  // ---- The employer's own contributions -----------------------------------
  const employerLines = payslip.lines.filter((line) => line.kind === "employer");
  if (employerLines.length > 0) {
    top += 12;
    doc
      .fontSize(8)
      .font("Helvetica-Bold")
      .fillColor("#000000")
      .text("Paid by the employer on your behalf", COLUMN.description, top);
    top += 12;

    doc
      .fontSize(7.5)
      .font("Helvetica")
      .fillColor("#666666")
      .text(
        "These are the company's own contributions. They are not deducted from your pay and are " +
          "not part of the net figure above.",
        COLUMN.description,
        top,
        { width: CONTENT_WIDTH },
      );
    top += 20;

    for (const line of employerLines) {
      doc
        .fontSize(8.5)
        .fillColor("#000000")
        .text(line.description, COLUMN.description, top, { width: 170 });
      if (line.basis) {
        doc.fontSize(7).fillColor("#666666").text(line.basis, COLUMN.basis, top + 1, { width: 240 });
      }
      doc
        .fontSize(8.5)
        .fillColor("#000000")
        .text(formatAmount(line.amount), COLUMN.amount, top, { width: 68, align: "right" });
      top += 14;
    }

    doc
      .fontSize(8.5)
      .font("Helvetica-Bold")
      .text("Employer total", COLUMN.basis, top + 2, { width: 240, align: "right" })
      .text(formatAmount(payslip.employerCost), COLUMN.amount, top + 2, {
        width: 68,
        align: "right",
      });
  }

  // ---- Footer -------------------------------------------------------------
  const footerTop = 760;
  doc
    .fontSize(7)
    .font("Helvetica")
    .fillColor("#777777")
    .text(
      "This payslip is issued by " +
        company.name +
        ". Every statutory figure above names the schedule it was calculated from. If anything " +
        "here is not what you expected, raise it with HR — the calculation is recorded and can be " +
        "shown to you line by line.",
      PAGE_MARGIN,
      footerTop,
      { width: CONTENT_WIDTH },
    );

  if (payslip.problem) {
    doc
      .fontSize(8)
      .font("Helvetica-Bold")
      .fillColor("#a11")
      .text(`Not computed: ${payslip.problem}`, PAGE_MARGIN, footerTop - 24, {
        width: CONTENT_WIDTH,
      });
  }

  doc.end();
  return finished;
}
