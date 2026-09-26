import {
  formatAmount,
  formatDate,
  type PurchaseOrderView,
  type QuotationView,
  type ReceiptView,
  type VoucherView,
} from "@cac/core";
import {
  LINE_COLUMNS,
  renderDocumentPdf,
  trimQuantity,
  type CompanyDetails,
} from "./document-pdf";

/**
 * The documents that leave the firm, other than the invoice.
 *
 * Only invoices, payslips, letters and case documents had a PDF. A quotation advanced to "sent" with
 * nothing to send — the screen told the user to "attach the PDF to your own message" — and an issued
 * purchase order committed the firm to a supplier on the strength of a row in a table. A receipt and
 * a payment voucher are both proof somebody asks for later.
 *
 * Each of these is an adapter onto one layout. The differences that matter are here, in the mapping,
 * rather than in four copies of the drawing code: who the party is and what they are called, which
 * dates go in the meta block, whether there is a table of lines at all, and what has to be said in
 * the footer.
 */

/**
 * A quotation.
 *
 * Titled an offer rather than a demand, and the validity is stated only when there is one to state —
 * a quotation carries no `valid_until` until CAC confirms the setting, and printing "valid until:
 * none" would be worse than saying nothing.
 */
export async function renderQuotationPdf(
  quotation: QuotationView,
  company: CompanyDetails,
): Promise<Buffer> {
  const totals: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: "Subtotal", value: formatAmount(quotation.subtotal) },
  ];
  if (quotation.discountTotal > 0n) {
    totals.push({ label: "Discount", value: `-${formatAmount(quotation.discountTotal)}` });
  }
  if (quotation.taxTotal > 0n) {
    totals.push({ label: "Service tax", value: formatAmount(quotation.taxTotal) });
  }
  totals.push({
    label: `Total ${quotation.currency}`,
    value: formatAmount(quotation.total),
    bold: true,
  });

  const meta: Array<[string, string]> = [["Date", formatDate(quotation.quotationDate)]];
  if (quotation.validUntil) meta.push(["Valid until", formatDate(quotation.validUntil)]);
  meta.push(["Your reference", quotation.reference ?? "—"]);

  return renderDocumentPdf(
    {
      title: "QUOTATION",
      reference: quotation.quotationNo ?? "DRAFT",
      watermark:
        quotation.status === "declined"
          ? "DECLINED"
          : quotation.status === "expired"
            ? "EXPIRED"
            : null,
      party: {
        label: "TO",
        name: quotation.customerName,
        address: quotation.customerAddress,
      },
      meta,
      subject: quotation.subject,
      columns: LINE_COLUMNS,
      rows: quotation.lines.map((line) => [
        line.description,
        trimQuantity(line.quantity) + (line.unit ? ` ${line.unit}` : ""),
        formatAmount(line.unitPrice),
        line.discountAmount > 0n ? formatAmount(line.discountAmount) : "—",
        formatAmount(line.lineTotal),
      ]),
      totals,
      notes: quotation.notes,
      terms: quotation.terms,
      footerNote: quotation.validUntil
        ? "this is an offer, not an invoice"
        : "this is an offer, not an invoice · no validity period is stated",
    },
    company,
  );
}

/**
 * A receipt.
 *
 * No line items: a receipt says money arrived and what it was put against. The table is the
 * allocation, which is the part the customer queries — "you had RM 5,000 from us, which invoice did
 * it pay?" — and money not yet matched is shown as such rather than omitted.
 */
export async function renderReceiptPdf(
  receipt: ReceiptView,
  company: CompanyDetails,
): Promise<Buffer> {
  const rows = receipt.allocations.map((allocation) => [
    allocation.invoiceNo ?? "—",
    formatDate(allocation.invoiceDate),
    formatAmount(allocation.invoiceTotal),
    formatAmount(allocation.amount),
  ]);

  const totals: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: "Received", value: formatAmount(receipt.amount), bold: true },
  ];
  if (receipt.amountAllocated > 0n) {
    totals.push({ label: "Applied to invoices", value: formatAmount(receipt.amountAllocated) });
  }
  if (receipt.unallocated > 0n) {
    totals.push({ label: "On account", value: formatAmount(receipt.unallocated) });
  }

  return renderDocumentPdf(
    {
      title: "OFFICIAL RECEIPT",
      reference: receipt.receiptNo ?? "DRAFT",
      watermark: receipt.status === "void" ? "VOID" : null,
      party: {
        label: "RECEIVED FROM",
        name: receipt.customerName,
      },
      meta: [
        ["Date", formatDate(receipt.receiptDate)],
        ["Method", receipt.method.replace(/_/g, " ")],
        ["Reference", receipt.reference ?? "—"],
      ],
      columns:
        rows.length > 0
          ? [
              { heading: "INVOICE", offset: 0, width: 240, wraps: true },
              { heading: "DATED", offset: 250, width: 110, align: "right" },
              { heading: "INVOICE TOTAL", offset: 370, width: 75, align: "right" },
              { heading: "APPLIED", offset: 455, width: 92, align: "right" },
            ]
          : undefined,
      rows: rows.length > 0 ? rows : undefined,
      totals,
      notes: receipt.notes,
      footerNote:
        receipt.unallocated > 0n
          ? "part of this receipt is not yet matched to an invoice"
          : null,
    },
    company,
  );
}

/**
 * A payment voucher.
 *
 * The firm's own record of money going out, and what the payee signs. It carries the account it was
 * paid from, because that is the question asked when the bank statement is reconciled months later.
 */
export async function renderVoucherPdf(
  voucher: VoucherView,
  company: CompanyDetails,
): Promise<Buffer> {
  const totals: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: "Subtotal", value: formatAmount(voucher.subtotal) },
  ];
  if (voucher.taxTotal > 0n) {
    totals.push({ label: "Service tax", value: formatAmount(voucher.taxTotal) });
  }
  totals.push({ label: "Total MYR", value: formatAmount(voucher.total), bold: true });

  const meta: Array<[string, string]> = [
    ["Date", formatDate(voucher.voucherDate)],
    ["Method", voucher.method.replace(/_/g, " ")],
    ["Reference", voucher.reference ?? "—"],
  ];
  if (voucher.paymentAccountName) {
    meta.push(["Paid from", `${voucher.paymentAccountCode} ${voucher.paymentAccountName}`]);
  }
  if (voucher.purchaseOrderNo) meta.push(["Against order", voucher.purchaseOrderNo]);

  return renderDocumentPdf(
    {
      title: "PAYMENT VOUCHER",
      reference: voucher.voucherNo ?? "DRAFT",
      watermark: voucher.status === "void" ? "VOID" : null,
      party: {
        label: "PAY TO",
        name: voucher.supplierName ?? voucher.payeeName ?? voucher.payee,
      },
      meta,
      subject: voucher.subject,
      columns: LINE_COLUMNS,
      rows: voucher.lines.map((line) => [
        line.description,
        trimQuantity(line.quantity) + (line.unit ? ` ${line.unit}` : ""),
        formatAmount(line.unitPrice),
        "—",
        formatAmount(line.lineTotal),
      ]),
      totals,
      notes: voucher.notes,
      terms:
        voucher.settlement === "payable"
          ? "Recorded as payable: this voucher authorises the payment, it does not evidence it."
          : null,
      footerNote: voucher.status === "posted" ? null : "not yet posted to the ledger",
    },
    company,
  );
}

/**
 * A purchase order.
 *
 * The one document here that commits the firm to somebody else, which is why it says so in the
 * terms: a supplier who delivers against it expects to be paid.
 */
export async function renderPurchaseOrderPdf(
  order: PurchaseOrderView,
  company: CompanyDetails,
): Promise<Buffer> {
  const totals: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: "Subtotal", value: formatAmount(order.subtotal) },
  ];
  if (order.taxTotal > 0n) {
    totals.push({ label: "Service tax", value: formatAmount(order.taxTotal) });
  }
  totals.push({ label: "Total MYR", value: formatAmount(order.total), bold: true });

  const meta: Array<[string, string]> = [["Date", formatDate(order.orderDate)]];
  if (order.requiredBy) meta.push(["Required by", formatDate(order.requiredBy)]);
  meta.push(["Our reference", order.reference ?? "—"]);

  return renderDocumentPdf(
    {
      title: "PURCHASE ORDER",
      reference: order.orderNo ?? "DRAFT",
      watermark: order.status === "cancelled" ? "CANCELLED" : null,
      party: {
        label: "TO",
        name: order.supplierName,
      },
      meta,
      subject: order.subject,
      columns: LINE_COLUMNS,
      rows: order.lines.map((line) => [
        line.description,
        trimQuantity(line.quantity) + (line.unit ? ` ${line.unit}` : ""),
        formatAmount(line.unitPrice),
        "—",
        formatAmount(line.lineTotal),
      ]),
      totals,
      notes: order.notes,
      terms:
        order.deliveryNote ??
        "Please quote this order number on your delivery note and invoice.",
      footerNote: "this order commits the firm; quote the number on your invoice",
    },
    company,
  );
}
