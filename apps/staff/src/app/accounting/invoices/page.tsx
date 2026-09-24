import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, listCustomers, listInvoices, receivablesAging } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, LinkButton, Panel, StatTile, Td } from "@/components/ui";

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
  approved: "Approved",
  issued: "Issued",
  paid: "Paid",
  void: "Void",
};

/**
 * Invoices and credit notes.
 *
 * The top of the page answers the question the person opening it actually has:
 * how much is owed, how much of it is late, and what is waiting on me.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; customer?: string; q?: string; outstanding?: string }>;
}) {
  const principal = await requireCapability("accounting.invoice.view");
  const query = await searchParams;
  const db = await getDb();

  const [invoices, customers, aging] = await Promise.all([
    listInvoices(db, {
      status: (query.status as "draft") || undefined,
      customerId: query.customer || undefined,
      search: query.q,
      outstandingOnly: query.outstanding === "1",
      limit: 200,
    }),
    listCustomers(db),
    receivablesAging(db),
  ]);

  const awaitingApproval = invoices.filter((invoice) => invoice.status === "pending_approval").length;
  const overdue = aging.totals.total - aging.totals.current;

  return (
    <Shell
      principal={principal}
      title="Invoices"
      breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "Invoices" }]}
      actions={
        principal.capabilities.has("accounting.invoice.create") ? (
          <LinkButton href="/accounting/invoices/new" variant="primary">
            New invoice
          </LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {aging.difference !== null && aging.difference !== 0n && (
          <Alert tone="danger">
            Receivables do not reconcile: the outstanding invoices come to{" "}
            {formatAmount(aging.totals.netOwing, { currency: "RM" })} but the trade receivables
            control account holds {formatAmount(aging.controlAccountBalance ?? 0n, { currency: "RM" })}.
            Something has reached account 1210 without going through an invoice or a receipt.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Outstanding"
            value={formatAmount(aging.totals.total)}
            hint={`across ${aging.rows.length} customer${aging.rows.length === 1 ? "" : "s"}`}
          />
          <StatTile
            label="Overdue"
            value={formatAmount(overdue)}
            hint={overdue > 0n ? "past the due date" : "nothing late"}
            tone={overdue > 0n ? "warn" : "neutral"}
          />
          <StatTile
            label="Unmatched receipts"
            value={formatAmount(aging.totals.unallocatedReceipts)}
            hint="paid but not yet applied"
            tone={aging.totals.unallocatedReceipts > 0n ? "warn" : "neutral"}
          />
          <StatTile
            label="Awaiting approval"
            value={String(awaitingApproval)}
            hint={awaitingApproval > 0 ? "someone has to look at these" : "nothing waiting"}
            tone={awaitingApproval > 0 ? "warn" : "neutral"}
          />
        </div>

        <Panel title="Filter">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="status" className="block text-[12px] font-medium">
                Status
              </label>
              <select
                id="status"
                name="status"
                defaultValue={query.status ?? ""}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              >
                <option value="">All</option>
                {Object.entries(STATUS_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="customer" className="block text-[12px] font-medium">
                Customer
              </label>
              <select
                id="customer"
                name="customer"
                defaultValue={query.customer ?? ""}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              >
                <option value="">All</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="q" className="block text-[12px] font-medium">
                Number, subject or customer
              </label>
              <input
                id="q"
                name="q"
                defaultValue={query.q ?? ""}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              />
            </div>
            <label className="flex items-center gap-2 pb-2 text-[12px]">
              <input
                type="checkbox"
                name="outstanding"
                value="1"
                defaultChecked={query.outstanding === "1"}
              />
              Only what is still owed
            </label>
            <button
              type="submit"
              className="rounded-md bg-[var(--color-navy)] px-3 py-2 text-[13px] font-medium text-white"
            >
              Apply
            </button>
            <Link href="/accounting/invoices" className="pb-2 text-[12px] text-[var(--color-info)]">
              Clear
            </Link>
          </form>
        </Panel>

        <Panel title={`${invoices.length} document${invoices.length === 1 ? "" : "s"}`}>
          {invoices.length === 0 ? (
            <EmptyState
              title="Nothing matches"
              body="Change the filter, or raise a new invoice."
              action={
                principal.capabilities.has("accounting.invoice.create") ? (
                  <LinkButton href="/accounting/invoices/new" variant="primary">
                    New invoice
                  </LinkButton>
                ) : undefined
              }
            />
          ) : (
            <DataTable
              columns={["Number", "Date", "Customer", "Subject", "Total", "Outstanding", "Due", "Status"]}
              caption="Invoices"
            >
              {invoices.map((invoice) => {
                const late = invoice.daysOverdue !== null && invoice.daysOverdue > 0;
                return (
                  <tr key={invoice.id}>
                    <Td>
                      <Link
                        href={`/accounting/invoices/${invoice.id}`}
                        className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                      >
                        {invoice.invoiceNo ?? "draft"}
                      </Link>
                      {invoice.kind === "credit_note" && (
                        <span className="ml-1">
                          <Badge tone="info">credit</Badge>
                        </span>
                      )}
                    </Td>
                    <Td>{formatDate(invoice.invoiceDate)}</Td>
                    <Td>{invoice.customerName}</Td>
                    <Td>{invoice.subject ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                    <Td numeric>{formatAmount(invoice.total)}</Td>
                    <Td numeric>{formatAmount(invoice.outstanding, { zeroAs: "—" })}</Td>
                    <Td>
                      {formatDate(invoice.dueDate)}
                      {late && (
                        <span className="ml-1 text-[11px] text-[var(--color-danger)]">
                          {invoice.daysOverdue}d late
                        </span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[invoice.status]}>{STATUS_LABEL[invoice.status]}</Badge>
                    </Td>
                  </tr>
                );
              })}
            </DataTable>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
