import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, getPurchaseOrder, listVouchers } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, LinkButton, Panel, Td, TotalRow } from "@/components/ui";
import { OrderActions } from "./OrderActions";

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

export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.po.view");
  const { id } = await params;
  const db = await getDb();

  const order = await getPurchaseOrder(db, id);
  if (!order) notFound();

  // Vouchers raised against this order, so the commitment and what was actually
  // paid sit on the same screen.
  const related = await listVouchers(db, { purchaseOrderId: id, limit: 100 });

  const canEdit = order.status === "draft" && principal.capabilities.has("accounting.po.create");

  return (
    <Shell
      principal={principal}
      title={order.orderNo ?? `${LABEL[order.status]} order`}
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Purchase orders", href: "/accounting/purchase-orders" },
        { label: order.orderNo ?? LABEL[order.status] },
      ]}
      actions={
        <div className="flex gap-2">
          {canEdit && (
            <LinkButton href={`/accounting/purchase-orders/${order.id}/edit`}>Edit draft</LinkButton>
          )}
          {/* The document the supplier is actually sent. An issued order commits the firm, and it
              used to commit it on the strength of a row in a table. */}
          {order.status !== "draft" && order.status !== "pending_approval" && (
            <LinkButton href={`/accounting/purchase-orders/${order.id}/pdf`}>Open PDF</LinkButton>
          )}
          {(order.status === "issued" || order.status === "received") &&
            principal.capabilities.has("accounting.voucher.create") && (
              <LinkButton href={`/accounting/vouchers/new?order=${order.id}`} variant="primary">
                Raise a voucher
              </LinkButton>
            )}
        </div>
      }
    >
      <div className="space-y-4">
        {order.status === "cancelled" && (
          <Alert tone="danger">Cancelled. Reason: {order.cancelReason}</Alert>
        )}
        {order.status === "draft" && (
          <Alert tone="info">A draft. Nothing has been committed to the supplier.</Alert>
        )}
        {(order.status === "issued" || order.status === "received") && (
          <Alert tone="info">
            This order commits the firm to a purchase but posts nothing to the ledger. The cost
            appears when a payment voucher is raised for what arrived.
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Panel title="Details">
              <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
                <Detail label="Status">
                  <Badge tone={TONE[order.status]}>{LABEL[order.status]}</Badge>
                </Detail>
                <Detail label="Supplier">
                  {order.supplierName}
                  <span className="block font-mono text-[11px] text-[var(--color-muted)]">
                    {order.supplierCode}
                  </span>
                </Detail>
                <Detail label="Order date">{formatDate(order.orderDate)}</Detail>
                <Detail label="Required by">
                  {order.requiredBy ? formatDate(order.requiredBy) : "—"}
                </Detail>
                <Detail label="Reference">
                  {order.reference ?? <span className="text-[var(--color-faint)]">—</span>}
                </Detail>
                <Detail label="Raised by">{order.createdByName}</Detail>
                <Detail label="Approved by">
                  {order.approvedByName ?? <span className="text-[var(--color-faint)]">—</span>}
                </Detail>
                <Detail label="Sent by">
                  {order.issuedByName ?? <span className="text-[var(--color-faint)]">—</span>}
                </Detail>
                <Detail label="Received by">
                  {order.receivedByName ?? <span className="text-[var(--color-faint)]">—</span>}
                </Detail>
                {order.subject && (
                  <div className="sm:col-span-3">
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
                      Subject
                    </dt>
                    <dd className="mt-0.5">{order.subject}</dd>
                  </div>
                )}
                {order.deliveryNote && (
                  <div className="sm:col-span-3">
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
                      Delivery
                    </dt>
                    <dd className="mt-0.5">{order.deliveryNote}</dd>
                  </div>
                )}
              </dl>
            </Panel>

            <Panel title="Lines">
              <DataTable
                columns={["#", "Description", "Account", "Ordered", "Received", "Unit price", "Total"]}
                caption="Order lines"
              >
                {order.lines.map((line) => {
                  const ordered = Number.parseFloat(line.quantity);
                  const received = Number.parseFloat(line.quantityReceived ?? "0");
                  const outstanding = received < ordered;
                  return (
                    <tr key={line.id}>
                      <Td>{line.lineNo}</Td>
                      <Td>{line.description}</Td>
                      <Td>
                        <Link
                          href={`/accounting/accounts/${line.accountCode}`}
                          className="text-[var(--color-link)] hover:underline"
                        >
                          <span className="font-mono text-[11px]">{line.accountCode}</span>
                        </Link>
                      </Td>
                      <Td numeric>
                        {ordered}
                        {line.unit && (
                          <span className="ml-1 text-[11px] text-[var(--color-muted)]">{line.unit}</span>
                        )}
                      </Td>
                      <Td numeric>
                        <span className={outstanding ? "text-[var(--color-warn)]" : ""}>{received}</span>
                      </Td>
                      <Td numeric>{formatAmount(line.unitPrice)}</Td>
                      <Td numeric>{formatAmount(line.lineTotal)}</Td>
                    </tr>
                  );
                })}
                <TotalRow>
                  <Td>{""}</Td>
                  <Td>Total</Td>
                  <Td>{""}</Td>
                  <Td>{""}</Td>
                  <Td>{""}</Td>
                  <Td numeric>{formatAmount(order.taxTotal, { zeroAs: "—" })}</Td>
                  <Td numeric>{formatAmount(order.total)}</Td>
                </TotalRow>
              </DataTable>
              {order.notes && (
                <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-[12px] text-[var(--color-muted)]">
                  {order.notes}
                </p>
              )}
            </Panel>

            {related.length > 0 && (
              <Panel title="Paid against this order">
                <DataTable columns={["Voucher", "Date", "Amount", "Status"]} caption="Vouchers">
                  {related.map((voucher) => (
                    <tr key={voucher.id}>
                      <Td>
                        <Link
                          href={`/accounting/vouchers/${voucher.id}`}
                          className="font-mono text-[12px] text-[var(--color-link)] hover:underline"
                        >
                          {voucher.voucherNo}
                        </Link>
                      </Td>
                      <Td>{formatDate(voucher.voucherDate)}</Td>
                      <Td numeric>{formatAmount(voucher.total)}</Td>
                      <Td>{voucher.status}</Td>
                    </tr>
                  ))}
                </DataTable>
              </Panel>
            )}
          </div>

          <div className="space-y-4">
            <Panel title="Committed">
              <dl className="space-y-2 text-[13px]">
                <Row label="Subtotal" value={formatAmount(order.subtotal)} />
                {order.taxTotal > 0n && <Row label="Tax" value={formatAmount(order.taxTotal)} />}
                <div className="border-t border-[var(--color-line)] pt-2">
                  <Row label="Total" value={formatAmount(order.total)} strong />
                </div>
              </dl>
              <p className="mt-2 text-[11px] text-[var(--color-muted)]">
                Not in the ledger. A commitment is not a cost.
              </p>
            </Panel>

            <Panel title="What happens next">
              <OrderActions
                orderId={order.id}
                status={order.status}
                isPreparer={order.createdBy === principal.userId}
                canCreate={principal.capabilities.has("accounting.po.create")}
                canApprove={principal.capabilities.has("accounting.po.approve")}
                canReceive={principal.capabilities.has("accounting.po.receive")}
                canClose={principal.capabilities.has("accounting.po.close")}
                lines={order.lines.map((line) => ({
                  id: line.id,
                  description: line.description,
                  quantity: line.quantity,
                  quantityReceived: line.quantityReceived ?? "0",
                }))}
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

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className={`numeric ${strong ? "text-[15px] font-semibold" : ""}`}>{value}</dd>
    </div>
  );
}
