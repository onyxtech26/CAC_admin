import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, getVoucher, voucherApprovalCapabilityFor } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, LinkButton, Panel, Td, TotalRow } from "@/components/ui";
import { VoucherActions } from "./VoucherActions";

const TONE = {
  draft: "neutral",
  pending_approval: "warn",
  approved: "info",
  posted: "ok",
  void: "danger",
} as const;

const LABEL: Record<string, string> = {
  draft: "Draft",
  pending_approval: "Awaiting approval",
  approved: "Approved, not yet paid",
  posted: "Posted",
  void: "Void",
};

export default async function VoucherPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.voucher.view");
  const { id } = await params;
  const db = await getDb();

  const voucher = await getVoucher(db, id);
  if (!voucher) notFound();

  const approval = await voucherApprovalCapabilityFor(db, voucher.total);
  const canEdit =
    voucher.status === "draft" && principal.capabilities.has("accounting.voucher.create");

  const approvalHint =
    approval.threshold === null
      ? "The approval limit has not been agreed yet, so every payment needs director-level " +
        "authority. Setting accounting.approval_threshold_myr will route smaller ones to an accountant."
      : `${formatAmount(voucher.total, { currency: "RM" })} against a limit of ` +
        `${formatAmount(approval.threshold, { currency: "RM" })}: this needs ` +
        `${approval.capability.endsWith("high_value") ? "a director" : "an accountant or above"}.`;

  return (
    <Shell
      principal={principal}
      title={voucher.voucherNo ?? `${LABEL[voucher.status]} voucher`}
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Payment vouchers", href: "/accounting/vouchers" },
        { label: voucher.voucherNo ?? LABEL[voucher.status] },
      ]}
      actions={
        canEdit ? (
          <LinkButton href={`/accounting/vouchers/${voucher.id}/edit`}>Edit draft</LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {voucher.status === "void" && (
          <Alert tone="danger">
            Voided. The ledger entry was reversed and both entries remain visible. Reason:{" "}
            {voucher.voidReason}
          </Alert>
        )}
        {voucher.status === "draft" && (
          <Alert tone="info">
            A draft. Nothing has been approved, and no money has moved.
          </Alert>
        )}
        {voucher.settlement === "payable" && voucher.kind === "expense" && voucher.status === "posted" && (
          <Alert tone="info">
            Recorded on account: the cost is in the books and the amount sits in trade payables.
            Raise a settlement voucher when it is paid.
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Panel title="Details">
              <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
                <Detail label="Status">
                  <Badge tone={TONE[voucher.status]}>{LABEL[voucher.status]}</Badge>
                </Detail>
                <Detail label="Payee">
                  {voucher.supplierId ? (
                    <>
                      {voucher.supplierName}
                      <span className="block text-[11px] text-[var(--color-muted)]">supplier</span>
                    </>
                  ) : (
                    <>
                      {voucher.payeeName}
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        not a registered supplier
                      </span>
                    </>
                  )}
                </Detail>
                <Detail label="Date">{formatDate(voucher.voucherDate)}</Detail>
                <Detail label="Kind">
                  {voucher.kind === "settlement" ? "Paying off an account" : "Buying something"}
                </Detail>
                <Detail label="Settlement">
                  {voucher.settlement === "paid" ? "Paid at once" : "On account"}
                </Detail>
                <Detail label="Method">{voucher.method}</Detail>
                <Detail label="Paid from">
                  {voucher.paymentAccountCode ? (
                    <Link
                      href={`/accounting/accounts/${voucher.paymentAccountCode}`}
                      className="text-[var(--color-info)] hover:underline"
                    >
                      <span className="font-mono text-[11px]">{voucher.paymentAccountCode}</span>{" "}
                      {voucher.paymentAccountName}
                    </Link>
                  ) : (
                    <span className="text-[var(--color-faint)]">nothing paid yet</span>
                  )}
                </Detail>
                <Detail label="Reference">
                  {voucher.reference ?? <span className="text-[var(--color-faint)]">—</span>}
                </Detail>
                <Detail label="Against order">
                  {voucher.purchaseOrderNo ? (
                    <Link
                      href={`/accounting/purchase-orders/${voucher.purchaseOrderId}`}
                      className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                    >
                      {voucher.purchaseOrderNo}
                    </Link>
                  ) : (
                    <span className="text-[var(--color-faint)]">—</span>
                  )}
                </Detail>
                <Detail label="Prepared by">{voucher.createdByName}</Detail>
                <Detail label="Approved by">
                  {voucher.approvedByName ?? <span className="text-[var(--color-faint)]">—</span>}
                </Detail>
                <Detail label="Posted by">
                  {voucher.postedByName ?? <span className="text-[var(--color-faint)]">—</span>}
                </Detail>
                {voucher.subject && (
                  <div className="sm:col-span-3">
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
                      Subject
                    </dt>
                    <dd className="mt-0.5">{voucher.subject}</dd>
                  </div>
                )}
              </dl>
            </Panel>

            <Panel title="Lines">
              <DataTable
                columns={["#", "Description", "Account", "Cost centre", "Qty", "Unit price", "Tax", "Total"]}
                caption="Voucher lines"
              >
                {voucher.lines.map((line) => (
                  <tr key={line.id}>
                    <Td>{line.lineNo}</Td>
                    <Td>{line.description}</Td>
                    <Td>
                      <Link
                        href={`/accounting/accounts/${line.accountCode}`}
                        className="text-[var(--color-info)] hover:underline"
                      >
                        <span className="font-mono text-[11px]">{line.accountCode}</span>
                      </Link>
                    </Td>
                    <Td>{line.costCentreCode ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                    <Td numeric>{Number.parseFloat(line.quantity)}</Td>
                    <Td numeric>{formatAmount(line.unitPrice)}</Td>
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
                  <Td>{""}</Td>
                  <Td numeric>{formatAmount(voucher.taxTotal, { zeroAs: "—" })}</Td>
                  <Td numeric>{formatAmount(voucher.total)}</Td>
                </TotalRow>
              </DataTable>
              {voucher.notes && (
                <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-[12px] text-[var(--color-muted)]">
                  {voucher.notes}
                </p>
              )}
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel title="Amount">
              <dl className="space-y-2 text-[13px]">
                <Row label="Subtotal" value={formatAmount(voucher.subtotal)} />
                {voucher.taxTotal > 0n && <Row label="Tax" value={formatAmount(voucher.taxTotal)} />}
                <div className="border-t border-[var(--color-line)] pt-2">
                  <Row label="Total" value={formatAmount(voucher.total)} strong />
                </div>
              </dl>
            </Panel>

            {voucher.journalNo && (
              <Panel title="In the ledger">
                <p className="text-[12px]">
                  Posted as{" "}
                  <Link
                    href={`/accounting/journals/${voucher.journalId}`}
                    className="font-mono text-[var(--color-info)] hover:underline"
                  >
                    {voucher.journalNo}
                  </Link>
                  .
                </p>
                {voucher.voidJournalId && (
                  <p className="mt-1 text-[12px]">
                    Reversed by{" "}
                    <Link
                      href={`/accounting/journals/${voucher.voidJournalId}`}
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
              <VoucherActions
                voucherId={voucher.id}
                status={voucher.status}
                isPreparer={voucher.createdBy === principal.userId}
                canSubmit={principal.capabilities.has("accounting.voucher.create")}
                canPost={principal.capabilities.has("accounting.voucher.pay")}
                canVoid={principal.capabilities.has("accounting.voucher.approve")}
                approvalHint={approvalHint}
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
