import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, getClaim, listVouchers } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, LinkButton, Panel, Td, TotalRow } from "@/components/ui";
import { ClaimActions } from "./ClaimActions";

const TONE = {
  draft: "neutral",
  submitted: "warn",
  approved: "info",
  posted: "info",
  reimbursed: "ok",
  rejected: "danger",
} as const;

const LABEL: Record<string, string> = {
  draft: "Draft",
  submitted: "Awaiting approval",
  approved: "Approved, not yet posted",
  posted: "Owed to the claimant",
  reimbursed: "Reimbursed",
  rejected: "Rejected",
};

export default async function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.claim.view");
  const { id } = await params;
  const db = await getDb();

  const claim = await getClaim(db, id);
  if (!claim) notFound();

  // One person's expenses are not another person's business. Without the
  // capability to approve or pay claims, a claim that is not yours does not
  // exist as far as this page is concerned.
  const canApprove = principal.capabilities.has("accounting.claim.approve");
  const canReimburse = principal.capabilities.has("accounting.claim.reimburse");
  const isClaimant = claim.claimantId === principal.userId;
  if (!isClaimant && !canApprove && !canReimburse) notFound();

  const canEdit =
    claim.status === "draft" && isClaimant && principal.capabilities.has("accounting.claim.create");

  // Vouchers that could plausibly be the reimbursement: posted, and for at least
  // what was claimed, which is the rule the server applies.
  const candidates =
    claim.status === "posted" && canReimburse
      ? (await listVouchers(db, { status: "posted", limit: 200 })).filter(
          (voucher) => voucher.total >= claim.total,
        )
      : [];

  return (
    <Shell
      principal={principal}
      title={claim.claimNo ?? "Draft claim"}
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Expense claims", href: "/accounting/claims" },
        { label: claim.claimNo ?? "Draft" },
      ]}
      actions={
        canEdit ? (
          <LinkButton href={`/accounting/claims/${claim.id}/edit`}>Edit draft</LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {claim.status === "rejected" && (
          <Alert tone="danger">Rejected. Reason: {claim.rejectReason}</Alert>
        )}
        {claim.status === "draft" && isClaimant && (
          <Alert tone="info">
            A draft. Nobody else sees it until you submit it, and nothing is owed to you yet.
          </Alert>
        )}
        {claim.status === "posted" && (
          <Alert tone="info">
            Posted to the ledger: the firm owes {claim.claimantName}{" "}
            {formatAmount(claim.total, { currency: "RM" })}, held in staff claims payable (2155)
            until a voucher pays it.
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Panel title="Details">
              <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
                <Detail label="Status">
                  <Badge tone={TONE[claim.status]}>{LABEL[claim.status]}</Badge>
                </Detail>
                <Detail label="Claimant">
                  {claim.claimantName}
                  {isClaimant && (
                    <span className="ml-1 text-[11px] text-[var(--color-muted)]">(you)</span>
                  )}
                </Detail>
                <Detail label="Claim date">{formatDate(claim.claimDate)}</Detail>
                <Detail label="Spending covered">
                  {claim.periodFrom || claim.periodTo
                    ? `${claim.periodFrom ? formatDate(claim.periodFrom) : "—"} to ${
                        claim.periodTo ? formatDate(claim.periodTo) : "—"
                      }`
                    : "—"}
                </Detail>
                <Detail label="Approved by">
                  {claim.approvedByName ?? <span className="text-[var(--color-faint)]">—</span>}
                </Detail>
                <Detail label="Posted by">
                  {claim.postedByName ?? <span className="text-[var(--color-faint)]">—</span>}
                </Detail>
                <Detail label="Journal">
                  {claim.journalNo ? (
                    <Link
                      href={`/accounting/journals/${claim.journalId}`}
                      className="font-mono text-[12px] text-[var(--color-link)] hover:underline"
                    >
                      {claim.journalNo}
                    </Link>
                  ) : (
                    <span className="text-[var(--color-faint)]">not posted</span>
                  )}
                </Detail>
                <Detail label="Paid by">
                  {claim.reimbursementVoucherNo ? (
                    <Link
                      href={`/accounting/vouchers/${claim.reimbursementVoucherId}`}
                      className="font-mono text-[12px] text-[var(--color-link)] hover:underline"
                    >
                      {claim.reimbursementVoucherNo}
                    </Link>
                  ) : (
                    <span className="text-[var(--color-faint)]">—</span>
                  )}
                </Detail>
                {claim.subject && (
                  <div className="sm:col-span-3">
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
                      What it is for
                    </dt>
                    <dd className="mt-0.5">{claim.subject}</dd>
                  </div>
                )}
              </dl>
            </Panel>

            <Panel title="What was spent">
              <DataTable
                columns={["#", "Spent on", "Description", "Account", "Receipt", "Tax", "Total"]}
                caption="Claim lines"
              >
                {claim.lines.map((line) => (
                  <tr key={line.id}>
                    <Td>{line.lineNo}</Td>
                    <Td>
                      {line.spentOn ? (
                        formatDate(line.spentOn)
                      ) : (
                        <span className="text-[var(--color-faint)]">—</span>
                      )}
                    </Td>
                    <Td>
                      {line.description}
                      {line.costCentreCode && (
                        <span className="block text-[11px] text-[var(--color-muted)]">
                          {line.costCentreCode}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <Link
                        href={`/accounting/accounts/${line.accountCode}`}
                        className="font-mono text-[11px] text-[var(--color-link)] hover:underline"
                      >
                        {line.accountCode}
                      </Link>
                    </Td>
                    <Td>
                      {line.receiptRef ?? (
                        <span className="text-[var(--color-warn)]" title="No receipt reference">
                          none
                        </span>
                      )}
                    </Td>
                    <Td numeric>{formatAmount(line.taxAmount, { zeroAs: "—" })}</Td>
                    <Td numeric>{formatAmount(line.lineTotal)}</Td>
                  </tr>
                ))}
                <TotalRow>
                  <Td>{""}</Td>
                  <Td>{""}</Td>
                  <Td>Total</Td>
                  <Td>{""}</Td>
                  <Td>{""}</Td>
                  <Td numeric>{formatAmount(claim.taxTotal, { zeroAs: "—" })}</Td>
                  <Td numeric>{formatAmount(claim.total)}</Td>
                </TotalRow>
              </DataTable>
              {claim.notes && (
                <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-[12px] text-[var(--color-muted)]">
                  {claim.notes}
                </p>
              )}
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel title="Claimed">
              <dl className="space-y-2 text-[13px]">
                <Row label="Subtotal" value={formatAmount(claim.subtotal)} />
                {claim.taxTotal > 0n && <Row label="Tax" value={formatAmount(claim.taxTotal)} />}
                <div className="border-t border-[var(--color-line)] pt-2">
                  <Row label="Total" value={formatAmount(claim.total)} strong />
                </div>
              </dl>
            </Panel>

            <Panel title="What happens next">
              <ClaimActions
                claimId={claim.id}
                status={claim.status}
                isClaimant={isClaimant}
                canCreate={principal.capabilities.has("accounting.claim.create")}
                canApprove={canApprove}
                canReimburse={canReimburse}
                vouchers={candidates.map((voucher) => ({
                  id: voucher.id,
                  voucherNo: voucher.voucherNo,
                  total: formatAmount(voucher.total, { currency: "RM" }),
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
