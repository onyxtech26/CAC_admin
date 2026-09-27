import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, listPurchaseOrders } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, LinkButton, Panel, Td } from "@/components/ui";

const TONE = {
  draft: "neutral",
  pending_approval: "warn",
  approved: "info",
  issued: "ok",
  received: "ok",
  closed: "neutral",
  cancelled: "danger",
} as const;

const LABEL: Record<string, string> = {
  draft: "Draft",
  pending_approval: "Awaiting approval",
  approved: "Approved, not yet sent",
  issued: "With the supplier",
  received: "Received in full",
  closed: "Closed",
  cancelled: "Cancelled",
};

/**
 * Purchase orders.
 *
 * A commitment, not a cost. Nothing on this screen has touched a ledger account:
 * the expense appears when a payment voucher is raised against what arrived.
 */
export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const principal = await requireCapability("accounting.po.view");
  const query = await searchParams;
  const db = await getDb();

  const orders = await listPurchaseOrders(db, {
    status: (query.status as "draft") || undefined,
    search: query.q,
    limit: 200,
  });

  return (
    <Shell
      principal={principal}
      title="Purchase orders"
      breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "Purchase orders" }]}
      actions={
        principal.capabilities.has("accounting.po.create") ? (
          <LinkButton href="/accounting/purchase-orders/new" variant="primary">New order</LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <Alert tone="info">
          A purchase order commits the firm to a purchase; it does not post anything to the ledger.
          The cost appears when a payment voucher is raised for what actually arrived.
        </Alert>

        <Panel title="Filter">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="status" className="block text-[12px] font-medium">Status</label>
              <select
                id="status"
                name="status"
                defaultValue={query.status ?? ""}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[13px]"
              >
                <option value="">All</option>
                {Object.entries(LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="q" className="block text-[12px] font-medium">Number, subject or supplier</label>
              <input
                id="q"
                name="q"
                defaultValue={query.q ?? ""}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[13px]"
              />
            </div>
            <button type="submit" className="btn btn-primary px-3 py-2 text-[13px]">
              Apply
            </button>
            <Link href="/accounting/purchase-orders" className="pb-2 text-[12px] text-[var(--color-info)]">Clear</Link>
          </form>
        </Panel>

        <Panel title={`${orders.length} order${orders.length === 1 ? "" : "s"}`}>
          {orders.length === 0 ? (
            <EmptyState title="Nothing matches" body="Change the filter, or raise an order." />
          ) : (
            <DataTable
              columns={["Number", "Date", "Supplier", "Subject", "Required by", "Total", "Outstanding", "Status"]}
              caption="Purchase orders"
            >
              {orders.map((order) => (
                <tr key={order.id}>
                  <Td>
                    <Link
                      href={`/accounting/purchase-orders/${order.id}`}
                      className="font-mono text-[12px] text-[var(--color-link)] hover:underline"
                    >
                      {order.orderNo ?? "draft"}
                    </Link>
                  </Td>
                  <Td>{formatDate(order.orderDate)}</Td>
                  <Td>{order.supplierName}</Td>
                  <Td>{order.subject ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                  <Td>{order.requiredBy ? formatDate(order.requiredBy) : "—"}</Td>
                  <Td numeric>{formatAmount(order.total)}</Td>
                  <Td numeric>
                    {order.outstandingLines === 0 ? (
                      <span className="text-[var(--color-faint)]">—</span>
                    ) : (
                      <span className="text-[var(--color-warn)]">{order.outstandingLines} line(s)</span>
                    )}
                  </Td>
                  <Td><Badge tone={TONE[order.status]}>{LABEL[order.status]}</Badge></Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
