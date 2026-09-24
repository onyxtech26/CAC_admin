import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, listVouchers } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Badge, DataTable, EmptyState, LinkButton, Panel, StatTile, Td } from "@/components/ui";

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

/**
 * Payments out.
 *
 * The number at the top that matters is what is waiting for approval: an
 * unapproved payment is somebody blocked, and an approved one that has not been
 * posted is money the ledger does not yet know has gone.
 */
export default async function VouchersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const principal = await requireCapability("accounting.voucher.view");
  const query = await searchParams;
  const db = await getDb();

  const vouchers = await listVouchers(db, {
    status: (query.status as "draft") || undefined,
    search: query.q,
    limit: 200,
  });

  const awaiting = vouchers.filter((v) => v.status === "pending_approval");
  const approvedNotPaid = vouchers.filter((v) => v.status === "approved");
  const posted = vouchers.filter((v) => v.status === "posted");

  return (
    <Shell
      principal={principal}
      title="Payment vouchers"
      breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "Payment vouchers" }]}
      actions={
        principal.capabilities.has("accounting.voucher.create") ? (
          <LinkButton href="/accounting/vouchers/new" variant="primary">
            New voucher
          </LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Awaiting approval"
            value={String(awaiting.length)}
            hint={
              awaiting.length > 0
                ? formatAmount(awaiting.reduce((sum, v) => sum + v.total, 0n), { currency: "RM" })
                : "nothing waiting"
            }
            tone={awaiting.length > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Approved, not yet paid"
            value={String(approvedNotPaid.length)}
            hint={
              approvedNotPaid.length > 0
                ? formatAmount(approvedNotPaid.reduce((sum, v) => sum + v.total, 0n), { currency: "RM" })
                : "nothing outstanding"
            }
            tone={approvedNotPaid.length > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Paid"
            value={formatAmount(posted.reduce((sum, v) => sum + v.total, 0n))}
            hint={`${posted.length} posted voucher${posted.length === 1 ? "" : "s"}`}
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
                {Object.entries(LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="q" className="block text-[12px] font-medium">
                Number, subject or payee
              </label>
              <input
                id="q"
                name="q"
                defaultValue={query.q ?? ""}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              />
            </div>
            <button
              type="submit"
              className="rounded-md bg-[var(--color-navy)] px-3 py-2 text-[13px] font-medium text-white"
            >
              Apply
            </button>
            <Link href="/accounting/vouchers" className="pb-2 text-[12px] text-[var(--color-info)]">
              Clear
            </Link>
          </form>
        </Panel>

        <Panel title={`${vouchers.length} voucher${vouchers.length === 1 ? "" : "s"}`}>
          {vouchers.length === 0 ? (
            <EmptyState title="Nothing matches" body="Change the filter, or raise a voucher." />
          ) : (
            <DataTable
              columns={["Number", "Date", "Payee", "Subject", "Method", "Amount", "Status"]}
              caption="Payment vouchers"
            >
              {vouchers.map((voucher) => (
                <tr key={voucher.id}>
                  <Td>
                    <Link
                      href={`/accounting/vouchers/${voucher.id}`}
                      className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                    >
                      {voucher.voucherNo ?? "draft"}
                    </Link>
                    {voucher.kind === "settlement" && (
                      <span className="ml-1">
                        <Badge tone="info">settlement</Badge>
                      </span>
                    )}
                    {voucher.settlement === "payable" && voucher.kind === "expense" && (
                      <span className="ml-1">
                        <Badge tone="neutral">on account</Badge>
                      </span>
                    )}
                  </Td>
                  <Td>{formatDate(voucher.voucherDate)}</Td>
                  <Td>{voucher.payee}</Td>
                  <Td>{voucher.subject ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                  <Td>{voucher.method}</Td>
                  <Td numeric>{formatAmount(voucher.total)}</Td>
                  <Td>
                    <Badge tone={TONE[voucher.status]}>{LABEL[voucher.status]}</Badge>
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
