import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import {
  customerStatement,
  formatAmount,
  formatDate,
  listCustomers,
  listInvoices,
  listReceipts,
  receivablesAging,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Badge, DataTable, EmptyState, LinkButton, Panel, StatTile, Td, TotalRow } from "@/components/ui";

/**
 * One customer: what they owe, and how it got there.
 *
 * The statement is built from the documents rather than the ledger, because it is
 * what gets sent to the customer and they need to see their own invoice and
 * receipt numbers, not journal references.
 */
export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const principal = await requireCapability("accounting.customer.view");
  const { id } = await params;
  const query = await searchParams;
  const db = await getDb();

  const customers = await listCustomers(db, { includeInactive: true });
  const customer = customers.find((row) => row.id === id);
  if (!customer) notFound();

  const [statement, aging, openInvoices, unmatched] = await Promise.all([
    customerStatement(db, id, { from: query.from ?? null, to: query.to }),
    receivablesAging(db, { customerId: id }),
    listInvoices(db, { customerId: id, outstandingOnly: true, limit: 100 }),
    listReceipts(db, { customerId: id, unallocatedOnly: true, limit: 50 }),
  ]);

  const summary = aging.rows[0];

  return (
    <Shell
      principal={principal}
      title={customer.name}
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Customers", href: "/accounting/customers" },
        { label: customer.code },
      ]}
      actions={
        principal.capabilities.has("accounting.invoice.create") ? (
          <LinkButton href={`/accounting/invoices/new?customer=${customer.id}`} variant="primary">
            New invoice
          </LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Outstanding"
            value={formatAmount(summary?.total ?? 0n)}
            hint={`${openInvoices.length} open invoice${openInvoices.length === 1 ? "" : "s"}`}
          />
          <StatTile
            label="On account"
            value={formatAmount(summary?.unallocatedReceipts ?? 0n)}
            hint="received, not yet applied"
            tone={(summary?.unallocatedReceipts ?? 0n) > 0n ? "warn" : "neutral"}
          />
          <StatTile
            label="Net owing"
            value={formatAmount(summary?.netOwing ?? 0n)}
            hint={summary?.oldestDueDate ? `oldest due ${formatDate(summary.oldestDueDate)}` : "nothing overdue"}
          />
          <StatTile
            label="Payment terms"
            value={`${customer.paymentTermsDays} days`}
            hint={
              customer.creditLimit === null
                ? "no credit limit recorded"
                : `limit ${formatAmount(customer.creditLimit)}`
            }
            tone={
              customer.creditLimit !== null && (summary?.netOwing ?? 0n) > customer.creditLimit
                ? "danger"
                : "neutral"
            }
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Details">
            <dl className="space-y-2 text-[13px]">
              <Row label="Code" value={customer.code} mono />
              <Row label="Status" value={customer.isActive ? "Active" : "Inactive"} />
              {customer.contactPerson && <Row label="Contact" value={customer.contactPerson} />}
              {customer.email && <Row label="Email" value={customer.email} mono />}
              {customer.phone && <Row label="Phone" value={customer.phone} />}
              {customer.registrationNo && <Row label="Registration" value={customer.registrationNo} />}
              {customer.taxIdentifier && <Row label="TIN" value={customer.taxIdentifier} mono />}
            </dl>
            {customer.address && (
              <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-[12px] text-[var(--color-muted)]">
                {customer.address}
              </p>
            )}
          </Panel>

          <div className="space-y-4 lg:col-span-2">
            {unmatched.length > 0 && (
              <Panel
                title="Money on account"
                description="Received and not yet matched to an invoice."
              >
                <DataTable columns={["Receipt", "Date", "Amount", "Unmatched"]} caption="Unmatched receipts">
                  {unmatched.map((receipt) => (
                    <tr key={receipt.id}>
                      <Td>
                        <Link
                          href={`/accounting/receipts/${receipt.id}`}
                          className="font-mono text-[12px] text-[var(--color-link)] hover:underline"
                        >
                          {receipt.receiptNo}
                        </Link>
                      </Td>
                      <Td>{formatDate(receipt.receiptDate)}</Td>
                      <Td numeric>{formatAmount(receipt.amount)}</Td>
                      <Td numeric>{formatAmount(receipt.unallocated)}</Td>
                    </tr>
                  ))}
                </DataTable>
              </Panel>
            )}

            <Panel
              title="Statement"
              description="Invoices and receipts in date order, with the running balance."
            >
              {!statement || statement.entries.length === 0 ? (
                <EmptyState
                  title="Nothing on the account yet"
                  body="Issued invoices and posted receipts appear here."
                />
              ) : (
                <DataTable
                  columns={["Date", "Reference", "Description", "Charge", "Payment", "Balance"]}
                  caption="Customer statement"
                >
                  {statement.entries.map((entry) => (
                    <tr key={`${entry.documentId}-${entry.kind}`}>
                      <Td>{formatDate(entry.date)}</Td>
                      <Td>
                        <Link
                          href={
                            entry.kind === "receipt"
                              ? `/accounting/receipts/${entry.documentId}`
                              : `/accounting/invoices/${entry.documentId}`
                          }
                          className="font-mono text-[12px] text-[var(--color-link)] hover:underline"
                        >
                          {entry.reference}
                        </Link>
                        {entry.kind === "credit_note" && (
                          <span className="ml-1">
                            <Badge tone="info">credit</Badge>
                          </span>
                        )}
                      </Td>
                      <Td>{entry.description ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                      <Td numeric>{formatAmount(entry.charge, { zeroAs: "—" })}</Td>
                      <Td numeric>{formatAmount(entry.payment, { zeroAs: "—" })}</Td>
                      <Td numeric>{formatAmount(entry.balance)}</Td>
                    </tr>
                  ))}
                  <TotalRow>
                    <Td>{""}</Td>
                    <Td>Balance</Td>
                    <Td>{""}</Td>
                    <Td>{""}</Td>
                    <Td>{""}</Td>
                    <Td numeric>{formatAmount(statement.closingBalance)}</Td>
                  </TotalRow>
                </DataTable>
              )}
            </Panel>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className={mono ? "font-mono text-[12px]" : ""}>{value}</dd>
    </div>
  );
}
