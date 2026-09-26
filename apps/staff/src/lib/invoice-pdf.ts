import { formatAmount, formatDate, type InvoiceView } from "@cac/core";
import {
  LINE_COLUMNS,
  renderDocumentPdf,
  trimQuantity,
  type CompanyDetails,
} from "./document-pdf";

export type { CompanyDetails };

/**
 * The invoice as a PDF.
 *
 * An adapter now rather than a layout: `document-pdf.ts` draws every document this firm sends, and
 * this maps an invoice onto it. It was the only one that existed, which is how a quotation came to
 * be marked "sent" with nothing to send.
 */
export async function renderInvoicePdf(
  invoice: InvoiceView,
  company: CompanyDetails,
): Promise<Buffer> {
  const isCredit = invoice.kind === "credit_note";

  const totals: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: "Subtotal", value: formatAmount(invoice.subtotal) },
  ];
  if (invoice.discountTotal > 0n) {
    totals.push({ label: "Discount", value: `-${formatAmount(invoice.discountTotal)}` });
  }
  if (invoice.taxTotal > 0n) {
    totals.push({ label: "Service tax", value: formatAmount(invoice.taxTotal) });
  }
  totals.push({
    label: `Total ${invoice.currency}`,
    value: formatAmount(invoice.total),
    bold: true,
  });
  if (!isCredit && invoice.amountAllocated > 0n) {
    totals.push({ label: "Received", value: `-${formatAmount(invoice.amountAllocated)}` });
    totals.push({ label: "Balance due", value: formatAmount(invoice.outstanding), bold: true });
  }

  return renderDocumentPdf(
    {
      title: isCredit ? "CREDIT NOTE" : "TAX INVOICE",
      reference: invoice.invoiceNo ?? "DRAFT",
      watermark: invoice.status === "void" ? "VOID" : null,
      party: {
        label: "BILL TO",
        name: invoice.customerName,
        address: invoice.customerAddress,
        taxId: invoice.customerTaxId,
      },
      meta: [
        [isCredit ? "Credit note date" : "Invoice date", formatDate(invoice.invoiceDate)],
        isCredit
          ? ["Against invoice", invoice.creditsInvoiceNo ?? "—"]
          : ["Due date", formatDate(invoice.dueDate)],
        ["Your reference", invoice.reference ?? "—"],
      ],
      subject: invoice.subject,
      columns: LINE_COLUMNS,
      rows: invoice.lines.map((line) => [
        line.description,
        trimQuantity(line.quantity) + (line.unit ? ` ${line.unit}` : ""),
        formatAmount(line.unitPrice),
        line.discountAmount > 0n ? formatAmount(line.discountAmount) : "—",
        formatAmount(line.lineTotal),
      ]),
      totals,
      notes: invoice.notes,
      terms: invoice.terms,
      footerNote:
        invoice.taxTotal === 0n && !isCredit ? "no service tax charged on this invoice" : null,
    },
    company,
  );
}
