import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, listReceipts } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Badge, DataTable, EmptyState, LinkButton, Panel, StatTile, Td } from "@/components/ui";

const TONE = { draft: "warn", posted: "ok", void: "danger" } as const;

/**
 * Money received.
 *
 * The figure worth watching is the unmatched total: money that has arrived and
 * has not been told which invoice it pays. It makes a customer's statement wrong
 * in both directions until somebody applies it.
 */
export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; unallocated?: string }>;
}) {
  const principal = await requireCapability("accounting.receipt.view");
  const query = await searchParams;
  const db = await getDb();

  const receipts = await listReceipts(db, {
    status: (query.status as "draft") || undefined,
    search: query.q,
    unallocatedOnly: query.unallocated === "1",
    limit: 200,
  });

  const posted = receipts.filter((receipt) => receipt.status === "posted");
  const unmatched = posted.reduce((sum, receipt) => sum + receipt.unallocated, 0n);
  const drafts = receipts.filter((receipt) => receipt.status === "draft").length;

  return (
    <Shell
      principal={principal}
      title="Receipts"
      breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "Receipts" }]}
      actions={
        principal.capabilities.has("accounting.receipt.create") ? (
          <LinkButton href="/accounting/receipts/new" variant="primary">Record a receipt</LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Received"
            value={formatAmount(posted.reduce((sum, receipt) => sum + receipt.amount, 0n))}
            hint={`${posted.length} posted receipt${posted.length === 1 ? "" : "s"}`}
          />
          <StatTile
            label="Not yet matched"
            value={formatAmount(unmatched)}
            hint={unmatched > 0n ? "apply these to invoices" : "everything is applied"}
            tone={unmatched > 0n ? "warn" : "neutral"}
          />
          <StatTile
            label="Unposted drafts"
            value={String(drafts)}
            hint={drafts > 0 ? "not in the ledger yet" : "nothing waiting"}
            tone={drafts > 0 ? "warn" : "neutral"}
          />
        </div>

        <Panel title="Filter">
          <form method="get" className="flex flex-wrap items-end gap-3.5">
            <div>
              <label htmlFor="status" className="block text-[12px] font-semibold text-slate-700">Status</label>
              <select
                id="status"
                name="status"
                defaultValue={query.status ?? ""}
                className="control mt-1.5 min-w-[140px]"
              >
                <option value="">All</option>
                <option value="draft">Draft</option>
                <option value="posted">Posted</option>
                <option value="void">Void</option>
              </select>
            </div>
            <div>
              <label htmlFor="q" className="block text-[12px] font-semibold text-slate-700">Number, reference or customer</label>
              <input
                id="q"
                name="q"
                placeholder="Search receipts..."
                defaultValue={query.q ?? ""}
                className="control mt-1.5 min-w-[240px]"
              />
            </div>
            <label className="flex items-center gap-2 pb-2 text-[12.5px] text-slate-700 font-medium cursor-pointer">
              <input
                type="checkbox"
                name="unallocated"
                value="1"
                defaultChecked={query.unallocated === "1"}
                className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
              />
              Only what is unmatched
            </label>
            <div className="flex items-center gap-2 pb-0.5">
              <button type="submit" className="btn btn-primary px-4 py-2 text-[13px] font-semibold shadow-xs">
                Apply
              </button>
              <Link
                href="/accounting/receipts"
                className="btn btn-ghost px-3 py-2 text-[12.5px] font-medium text-slate-500 hover:text-slate-800"
              >
                Clear
              </Link>
            </div>
          </form>
        </Panel>

        <Panel title={`${receipts.length} receipt${receipts.length === 1 ? "" : "s"}`}>
          {receipts.length === 0 ? (
            <EmptyState title="Nothing matches" body="Change the filter, or record a receipt." />
          ) : (
            <DataTable
              columns={["Number", "Date", "Customer", "Method", "Reference", "Amount", "Unmatched", "Status"]}
              caption="Receipts"
            >
              {receipts.map((receipt) => (
                <tr key={receipt.id}>
                  <Td>
                    <Link
                      href={`/accounting/receipts/${receipt.id}`}
                      className="font-mono text-[12px] text-[var(--color-link)] hover:underline"
                    >
                      {receipt.receiptNo ?? "draft"}
                    </Link>
                  </Td>
                  <Td>{formatDate(receipt.receiptDate)}</Td>
                  <Td>{receipt.customerName}</Td>
                  <Td>{receipt.method}</Td>
                  <Td>{receipt.reference ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                  <Td numeric>{formatAmount(receipt.amount)}</Td>
                  <Td numeric>{formatAmount(receipt.unallocated, { zeroAs: "—" })}</Td>
                  <Td><Badge tone={TONE[receipt.status]}>{receipt.status}</Badge></Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
