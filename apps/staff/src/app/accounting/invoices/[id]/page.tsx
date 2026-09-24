import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import {
  approvalCapabilityFor,
  formatAmount,
  formatDate,
  getInvoice,
  listAllocations,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import {
  Alert,
  Badge,
  DataTable,
  LinkButton,
  Panel,
  Td,
  TotalRow,
} from "@/components/ui";
import { DeleteInvoiceDraft, InvoiceActions } from "./InvoiceActions";

const STATUS_TONE = {
  draft: "neutral",
  pending_approval: "warn",
  approved: "info",
  issued: "ok",
  paid: "ok",
  void: "danger",
} as const;

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  pending_approval: "Awaiting approval",
  approved: "Approved, not yet issued",
  issued: "Issued",
  paid: "Paid in full",
  void: "Void",
};

/**
 * One invoice or credit note.
 *
 * The header is arranged the way an auditor reads it: what it is, who prepared
 * it, who approved it, who issued it, and what has settled it since.
 */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.invoice.view");
  const { id } = await params;
  const db = await getDb();

  const invoice = await getInvoice(db, id);
  if (!invoice) notFound();

  const [allocations, approval] = await Promise.all([
    listAllocations(db, { invoiceId: id }),
    approvalCapabilityFor(db, invoice.total),
  ]);

  const noun = invoice.kind === "credit_note" ? "credit note" : "invoice";
  const permissions = {
    canEdit: invoice.status === "draft" && principal.capabilities.has("accounting.invoice.create"),
    canSubmit: principal.capabilities.has("accounting.invoice.create"),
    canApprove: principal.capabilities.has(approval.capability),
    canIssue: principal.capabilities.has("accounting.invoice.issue"),
    canVoid: principal.capabilities.has("accounting.invoice.void"),
    isPreparer: invoice.createdBy === principal.userId,
  };

  const approvalHint =
    approval.threshold === null
      ? "The approval limit has not been agreed yet, so every invoice needs director-level authority. " +
        "Setting accounting.approval_threshold_myr will route smaller ones to an accountant."
      : `${formatAmount(invoice.total, { currency: "RM" })} against a limit of ` +
        `${formatAmount(approval.threshold, { currency: "RM" })}: this needs ` +
        `${approval.capability.endsWith("high_value") ? "a director" : "an accountant or above"}.`;

  return (
    <Shell
      principal={principal}
      title={invoice.invoiceNo ?? `${STATUS_LABEL[invoice.status]} ${noun}`}
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Invoices", href: "/accounting/invoices" },
        { label: invoice.invoiceNo ?? STATUS_LABEL[invoice.status] },
      ]}
      actions={
        <div className="flex gap-2">
          {permissions.canEdit && (
            <LinkButton href={`/accounting/invoices/${invoice.id}/edit`}>Edit draft</LinkButton>
          )}
          {/* Only once it has been issued. Before that there is no number, and a
              document that says DRAFT across it is not one to hand anybody. The
              route refuses the same cases. */}
          {(invoice.status === "issued" || invoice.status === "paid" || invoice.status === "void") && (
            <LinkButton href={`/accounting/invoices/${invoice.id}/pdf`}>Open PDF</LinkButton>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {invoice.status === "void" && (
          <Alert tone="danger">
            Voided. The ledger entry was reversed, and both entries remain visible. Reason:{" "}
            {invoice.voidReason}
          </Alert>
        )}
        {invoice.kind === "credit_note" && invoice.creditsInvoiceId && (
          <Alert tone="info">
            This credits{" "}
            <Link href={`/accounting/invoices/${invoice.creditsInvoiceId}`} className="font-mono underline">
              {invoice.creditsInvoiceNo}
            </Link>
            .
          </Alert>
        )}
        {invoice.status === "draft" && (
          <Alert tone="info">
            A draft. It has no number, nothing has been sent to the customer, and no ledger account
            has moved.
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <Panel title="Details">
              <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
                <Detail label="Status">
                  <Badge tone={STATUS_TONE[invoice.status]}>{STATUS_LABEL[invoice.status]}</Badge>
                </Detail>
                <Detail label="Customer">
                  <Link
                    href={`/accounting/customers/${invoice.customerId}`}
                    className="text-[var(--color-info)] hover:underline"
                  >
                    {invoice.customerName}
                  </Link>
                  <span className="block font-mono text-[11px] text-[var(--color-muted)]">
                    {invoice.customerCode}
                  </span>
                </Detail>
                <Detail label="Date">{formatDate(invoice.invoiceDate)}</Detail>
                <Detail label="Due">{formatDate(invoice.dueDate)}</Detail>
                <Detail label="Your reference">
                  {invoice.reference ?? <span className="text-[var(--color-faint)]">—</span>}
                </Detail>
                <Detail label="From quotation">
                  {invoice.quotationNo ? (
                    <Link
                      href={`/accounting/quotations/${invoice.quotationId}`}
                      className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                    >
                      {invoice.quotationNo}
                    </Link>
                  ) : (
                    <span className="text-[var(--color-faint)]">—</span>
                  )}
                </Detail>
                <Detail label="Prepared by">{invoice.createdByName}</Detail>
                <Detail label="Approved by">
                  {invoice.approvedByName ?? <span className="text-[var(--color-faint)]">—</span>}
                </Detail>
                <Detail label="Issued by">
                  {invoice.issuedByName ?? <span className="text-[var(--color-faint)]">—</span>}
                </Detail>
                {invoice.subject && (
                  <div className="sm:col-span-3">
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
                      Subject
                    </dt>
                    <dd className="mt-0.5">{invoice.subject}</dd>
                  </div>
                )}
              </dl>
            </Panel>

            <Panel title="Lines">
              <DataTable
                columns={["#", "Description", "Account", "Qty", "Unit price", "Discount", "Tax", "Total"]}
                caption="Invoice lines"
              >
                {invoice.lines.map((line) => (
                  <tr key={line.id}>
                    <Td>{line.lineNo}</Td>
                    <Td>
                      {line.description}
                      {line.unit && (
                        <span className="block text-[11px] text-[var(--color-muted)]">{line.unit}</span>
                      )}
                    </Td>
                    <Td>
                      <Link
                        href={`/accounting/accounts/${line.accountCode}`}
                        className="text-[var(--color-info)] hover:underline"
                      >
                        <span className="font-mono text-[11px]">{line.accountCode}</span>
                      </Link>
                    </Td>
                    <Td numeric>{trimQuantity(line.quantity)}</Td>
                    <Td numeric>{formatAmount(line.unitPrice)}</Td>
                    <Td numeric>{formatAmount(line.discountAmount, { zeroAs: "—" })}</Td>
                    <Td numeric>{formatAmount(line.taxAmount, { zeroAs: "—" })}</Td>
                    <Td numeric>{formatAmount(line.lineTotal)}</Td>
                  </tr>
                ))}
                <TotalRow>
                  <Td>{""}</Td>
                  <Td>Total</Td>
                  <Td>{""}</Td>
                  <Td>{""}</Td>
                  <Td>{""}</Td>
                  <Td numeric>{formatAmount(invoice.discountTotal, { zeroAs: "—" })}</Td>
                  <Td numeric>{formatAmount(invoice.taxTotal, { zeroAs: "—" })}</Td>
                  <Td numeric>{formatAmount(invoice.total)}</Td>
                </TotalRow>
              </DataTable>

              {invoice.notes && (
                <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-[12px] text-[var(--color-muted)]">
                  {invoice.notes}
                </p>
              )}
            </Panel>

            {allocations.length > 0 && (
              <Panel
                title="Settled by"
                description="Receipts and credit notes applied to this invoice."
              >
                <DataTable columns={["Source", "Date", "Amount"]} caption="Allocations">
                  {allocations.map((allocation) => (
                    <tr key={allocation.id}>
                      <Td>{allocation.sourceType === "receipt" ? "Receipt" : "Credit note"}</Td>
                      <Td>{new Date(allocation.allocatedAt).toLocaleDateString("en-GB")}</Td>
                      <Td numeric>{formatAmount(allocation.amount)}</Td>
                    </tr>
                  ))}
                </DataTable>
              </Panel>
            )}

            {invoice.creditNotes.length > 0 && (
              <Panel title="Credit notes against this invoice">
                <DataTable columns={["Number", "Amount", "Status"]} caption="Credit notes">
                  {invoice.creditNotes.map((note) => (
                    <tr key={note.id}>
                      <Td>
                        <Link
                          href={`/accounting/invoices/${note.id}`}
                          className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                        >
                          {note.invoiceNo ?? "draft"}
                        </Link>
                      </Td>
                      <Td numeric>{formatAmount(note.total)}</Td>
                      <Td>
                        <Badge tone={STATUS_TONE[note.status]}>{STATUS_LABEL[note.status]}</Badge>
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              </Panel>
            )}
          </div>

          <div className="space-y-4">
            <Panel title="Amounts">
              <dl className="space-y-2 text-[13px]">
                <Money label="Subtotal" value={formatAmount(invoice.subtotal)} />
                {invoice.discountTotal > 0n && (
                  <Money label="Discount" value={`-${formatAmount(invoice.discountTotal)}`} />
                )}
                {invoice.taxTotal > 0n && <Money label="Tax" value={formatAmount(invoice.taxTotal)} />}
                <div className="border-t border-[var(--color-line)] pt-2">
                  <Money label="Total" value={formatAmount(invoice.total)} strong />
                </div>
                {(invoice.status === "issued" || invoice.status === "paid") && (
                  <>
                    <Money label="Settled" value={formatAmount(invoice.amountAllocated)} />
                    <Money
                      label="Outstanding"
                      value={formatAmount(invoice.outstanding)}
                      strong
                      tone={invoice.outstanding > 0n ? "warn" : "ok"}
                    />
                  </>
                )}
              </dl>
            </Panel>

            {invoice.journalNo && (
              <Panel title="In the ledger">
                <p className="text-[12px]">
                  Posted as{" "}
                  <Link
                    href={`/accounting/journals/${invoice.journalId}`}
                    className="font-mono text-[var(--color-info)] hover:underline"
                  >
                    {invoice.journalNo}
                  </Link>
                  .
                </p>
                {invoice.voidJournalId && (
                  <p className="mt-1 text-[12px]">
                    Reversed by{" "}
                    <Link
                      href={`/accounting/journals/${invoice.voidJournalId}`}
                      className="font-mono text-[var(--color-info)] hover:underline"
                    >
                      the void entry
                    </Link>
                    .
                  </p>
                )}
              </Panel>
            )}

            <Panel title="What happens next">
              <InvoiceActions
                invoiceId={invoice.id}
                status={invoice.status}
                kind={invoice.kind}
                permissions={permissions}
                approvalHint={approvalHint}
              />
              {permissions.canEdit && (
                <div className="mt-3 border-t border-[var(--color-line)] pt-3">
                  <DeleteInvoiceDraft invoiceId={invoice.id} />
                </div>
              )}
            </Panel>
          </div>
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

function Money({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "warn" | "ok";
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd
        className={`numeric ${strong ? "text-[15px] font-semibold" : ""} ${
          tone === "warn" ? "text-[var(--color-warn)]" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

/** "3.000000" reads better as "3". */
function trimQuantity(quantity: string): string {
  const asNumber = Number.parseFloat(quantity);
  return Number.isFinite(asNumber) ? String(asNumber) : quantity;
}
