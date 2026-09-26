import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, getQuotation } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, LinkButton, Panel, Td, TotalRow } from "@/components/ui";
import { QuotationActions } from "./QuotationActions";

const TONE = {
  draft: "neutral",
  sent: "info",
  accepted: "ok",
  declined: "danger",
  expired: "warn",
  converted: "ok",
} as const;

export default async function QuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.quotation.view");
  const { id } = await params;
  const db = await getDb();

  const quotation = await getQuotation(db, id);
  if (!quotation) notFound();

  const canEdit = principal.capabilities.has("accounting.quotation.create");

  return (
    <Shell
      principal={principal}
      title={quotation.quotationNo ?? "Draft quotation"}
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Quotations", href: "/accounting/quotations" },
        { label: quotation.quotationNo ?? "Draft" },
      ]}
      actions={
        <div className="flex gap-2">
          {quotation.status === "draft" && canEdit && (
            <LinkButton href={`/accounting/quotations/${quotation.id}/edit`}>Edit draft</LinkButton>
          )}
          {/* Only once it has been sent. Before that there is no number, and a document with DRAFT
              across it is not one to hand a client. The route refuses the same case. */}
          {quotation.status !== "draft" && (
            <LinkButton href={`/accounting/quotations/${quotation.id}/pdf`}>Open PDF</LinkButton>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {quotation.convertedInvoiceId && (
          <Alert tone="ok">
            Converted to{" "}
            <Link href={`/accounting/invoices/${quotation.convertedInvoiceId}`} className="underline">
              an invoice
            </Link>
            . This quotation stays as it was quoted.
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Panel title="Details">
              <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
                <Detail label="Status"><Badge tone={TONE[quotation.status]}>{quotation.status}</Badge></Detail>
                <Detail label="Customer">
                  {quotation.customerName}
                  <span className="block font-mono text-[11px] text-[var(--color-muted)]">
                    {quotation.customerCode}
                  </span>
                </Detail>
                <Detail label="Date">{formatDate(quotation.quotationDate)}</Detail>
                <Detail label="Valid until">
                  {quotation.validUntil ? formatDate(quotation.validUntil) : "—"}
                </Detail>
                <Detail label="Your reference">{quotation.reference ?? "—"}</Detail>
                <Detail label="Prepared by">{quotation.createdByName}</Detail>
                {quotation.subject && (
                  <div className="sm:col-span-3">
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
                      Subject
                    </dt>
                    <dd className="mt-0.5">{quotation.subject}</dd>
                  </div>
                )}
              </dl>
            </Panel>

            <Panel title="Lines">
              <DataTable
                columns={["#", "Description", "Account", "Qty", "Unit price", "Discount", "Total"]}
                caption="Quotation lines"
              >
                {quotation.lines.map((line) => (
                  <tr key={line.id}>
                    <Td>{line.lineNo}</Td>
                    <Td>{line.description}</Td>
                    <Td><span className="font-mono text-[11px]">{line.accountCode}</span></Td>
                    <Td numeric>{Number.parseFloat(line.quantity)}</Td>
                    <Td numeric>{formatAmount(line.unitPrice)}</Td>
                    <Td numeric>{formatAmount(line.discountAmount, { zeroAs: "—" })}</Td>
                    <Td numeric>{formatAmount(line.lineTotal)}</Td>
                  </tr>
                ))}
                <TotalRow>
                  <Td>{""}</Td>
                  <Td>Total</Td>
                  <Td>{""}</Td>
                  <Td>{""}</Td>
                  <Td>{""}</Td>
                  <Td numeric>{formatAmount(quotation.discountTotal, { zeroAs: "—" })}</Td>
                  <Td numeric>{formatAmount(quotation.total)}</Td>
                </TotalRow>
              </DataTable>
              {quotation.notes && (
                <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-[12px] text-[var(--color-muted)]">
                  {quotation.notes}
                </p>
              )}
            </Panel>
          </div>

          <Panel title="What happens next">
            <QuotationActions
              quotationId={quotation.id}
              status={quotation.status}
              canEdit={principal.capabilities.has("accounting.quotation.create")}
              canConvert={
                principal.capabilities.has("accounting.quotation.convert") &&
                principal.capabilities.has("accounting.invoice.create")
              }
            />
          </Panel>
        </div>
      </div>
    </Shell>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
        {label}
      </dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
