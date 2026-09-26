import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import {
  amountToSql,
  formatAmount,
  formatDate,
  getReceipt,
  listInvoices,
  parseAmount,
  suggestAllocation,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { salesFormOptions } from "@/lib/accounting-options";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, LinkButton, Panel, Td } from "@/components/ui";
import { AllocationForm, ReceiptActions, ReceiptForm, RemoveAllocation } from "../ReceiptForms";

const TONE = { draft: "warn", posted: "ok", void: "danger" } as const;

/**
 * One receipt, and what it pays for.
 *
 * A draft shows the edit form, because until it is posted the only useful thing
 * to do with it is correct it. A posted receipt shows the allocation table, which
 * is the actual work: deciding which invoices this money settles.
 */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.receipt.view");
  const { id } = await params;
  const db = await getDb();

  const receipt = await getReceipt(db, id);
  if (!receipt) notFound();

  const canAllocate = principal.capabilities.has("accounting.receipt.allocate");

  // Invoices this receipt could settle: the same customer's, still owing, plus
  // any it is already applied to so the amounts can be adjusted downwards.
  const open = receipt.status === "posted" && canAllocate
    ? await listInvoices(db, {
        customerId: receipt.customerId,
        kind: "invoice",
        outstandingOnly: true,
        limit: 200,
      })
    : [];

  // Oldest first, worked out by the core rather than in the browser: the client copy sorted on the
  // formatted date, so it ordered by month name.
  const suggestion =
    receipt.status === "posted" && canAllocate ? await suggestAllocation(db, receipt.id) : [];
  const suggested: Record<string, string> = {};
  for (const line of suggestion) suggested[line.invoiceId] = line.amount;

  const existing: Record<string, string> = {};
  for (const allocation of receipt.allocations) {
    existing[allocation.invoiceId] = amountToSql(allocation.amount);
  }
  const openIds = new Set(open.map((invoice) => invoice.id));
  const allocatedElsewhere = receipt.allocations.filter(
    (allocation) => !openIds.has(allocation.invoiceId),
  );

  const options = receipt.status === "draft" ? await salesFormOptions() : null;

  return (
    <Shell
      principal={principal}
      title={receipt.receiptNo ?? "Draft receipt"}
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Receipts", href: "/accounting/receipts" },
        { label: receipt.receiptNo ?? "Draft" },
      ]}
      actions={
        // The customer's proof that the money arrived, and which invoices it was put against.
        receipt.status !== "draft" ? (
          <LinkButton href={`/accounting/receipts/${receipt.id}/pdf`}>Open PDF</LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {receipt.status === "void" && (
          <Alert tone="danger">
            Voided. The ledger entry was reversed. Reason: {receipt.voidReason}
          </Alert>
        )}
        {receipt.status === "draft" && (
          <Alert tone="info">
            A draft. The money is recorded but not in the ledger, and it cannot settle anything until
            it is posted.
          </Alert>
        )}
        {receipt.status === "posted" && receipt.unallocated > 0n && (
          <Alert tone="warn">
            {formatAmount(receipt.unallocated, { currency: "RM" })} of this receipt has not been
            matched to an invoice. It reduces what the customer owes either way, but their statement
            will not show which invoice it paid until it is applied.
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            {receipt.status === "draft" && options ? (
              <Panel title="Details">
                <ReceiptForm
                  receiptId={receipt.id}
                  customers={options.customers}
                  bankAccounts={options.bankAccounts}
                  defaults={{
                    customerId: receipt.customerId,
                    receiptDate: receipt.receiptDate,
                    method: receipt.method,
                    reference: receipt.reference ?? "",
                    depositAccountId: receipt.depositAccountId,
                    amount: amountToSql(receipt.amount),
                    notes: receipt.notes ?? "",
                  }}
                />
              </Panel>
            ) : (
              <Panel title="Details">
                <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
                  <Detail label="Status">
                    <Badge tone={TONE[receipt.status]}>{receipt.status}</Badge>
                  </Detail>
                  <Detail label="Customer">
                    <Link
                      href={`/accounting/customers/${receipt.customerId}`}
                      className="text-[var(--color-info)] hover:underline"
                    >
                      {receipt.customerName}
                    </Link>
                  </Detail>
                  <Detail label="Date">{formatDate(receipt.receiptDate)}</Detail>
                  <Detail label="Method">{receipt.method}</Detail>
                  <Detail label="Reference">{receipt.reference ?? "—"}</Detail>
                  <Detail label="Into">
                    <Link
                      href={`/accounting/accounts/${receipt.depositAccountCode}`}
                      className="text-[var(--color-info)] hover:underline"
                    >
                      <span className="font-mono text-[11px]">{receipt.depositAccountCode}</span>{" "}
                      {receipt.depositAccountName}
                    </Link>
                  </Detail>
                  <Detail label="Recorded by">{receipt.createdByName}</Detail>
                  <Detail label="Posted by">{receipt.postedByName ?? "—"}</Detail>
                  <Detail label="Ledger entry">
                    {receipt.journalNo ? (
                      <Link
                        href={`/accounting/journals/${receipt.journalId}`}
                        className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                      >
                        {receipt.journalNo}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </Detail>
                  {receipt.notes && (
                    <div className="sm:col-span-3">
                      <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
                        Notes
                      </dt>
                      <dd className="mt-0.5">{receipt.notes}</dd>
                    </div>
                  )}
                </dl>
              </Panel>
            )}

            {receipt.status === "posted" && canAllocate && (
              <Panel
                title="What this pays for"
                description="Enter how much of this receipt settles each invoice."
              >
                <AllocationForm
                  receiptId={receipt.id}
                  available={amountToSql(receipt.amount)}
                  openInvoices={open.map((invoice) => ({
                    id: invoice.id,
                    invoiceNo: invoice.invoiceNo ?? "",
                    invoiceDate: formatDate(invoice.invoiceDate),
                    dueDate: formatDate(invoice.dueDate),
                    total: amountToSql(invoice.total),
                    // What is outstanding *excluding* this receipt's own
                    // allocation, added back — otherwise an invoice this receipt
                    // already pays would show nothing left to apply and the
                    // amount could only ever be reduced.
                    outstanding: amountToSql(
                      invoice.outstanding + parseAmount(existing[invoice.id] ?? "0"),
                    ),
                    daysOverdue: invoice.daysOverdue,
                  }))}
                  existing={existing}
                  suggested={suggested}
                />
              </Panel>
            )}

            {allocatedElsewhere.length > 0 && (
              <Panel
                title="Applied to settled invoices"
                description="These are already paid in full, so they are not in the table above."
              >
                <DataTable columns={["Invoice", "Date", "Applied", ""]} caption="Allocations">
                  {allocatedElsewhere.map((allocation) => (
                    <tr key={allocation.id}>
                      <Td>
                        <Link
                          href={`/accounting/invoices/${allocation.invoiceId}`}
                          className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                        >
                          {allocation.invoiceNo}
                        </Link>
                      </Td>
                      <Td>{formatDate(allocation.invoiceDate)}</Td>
                      <Td numeric>{formatAmount(allocation.amount)}</Td>
                      <Td>{canAllocate && <RemoveAllocation allocationId={allocation.id} />}</Td>
                    </tr>
                  ))}
                </DataTable>
              </Panel>
            )}
          </div>

          <div className="space-y-4">
            <Panel title="Amount">
              <dl className="space-y-2 text-[13px]">
                <Row label="Received" value={formatAmount(receipt.amount)} strong />
                <Row label="Applied" value={formatAmount(receipt.amountAllocated)} />
                <Row
                  label="Unmatched"
                  value={formatAmount(receipt.unallocated)}
                  strong
                  tone={receipt.unallocated > 0n ? "warn" : "ok"}
                />
              </dl>
            </Panel>

            <Panel title="What happens next">
              <ReceiptActions
                receiptId={receipt.id}
                status={receipt.status}
                canPost={principal.capabilities.has("accounting.receipt.approve")}
                canDelete={principal.capabilities.has("accounting.receipt.create")}
              />
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

function Row({
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
