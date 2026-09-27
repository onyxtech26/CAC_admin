import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, receivablesAging, today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, DataTable, EmptyState, Panel, StatTile, Td, TotalRow } from "@/components/ui";

/**
 * Accounts receivable, aged.
 *
 * The reconciliation line at the top is what makes the rest worth reading. An
 * aging report that does not agree with the trade receivables control account is
 * two different answers to the same question, and this one says so rather than
 * letting the reader pick.
 */
export default async function AgingPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const principal = await requireCapability("accounting.report.view");
  const query = await searchParams;
  const db = await getDb();

  const asOf = query.asOf || toIsoDate(today());
  const aging = await receivablesAging(db, { asOf });
  const reconciled = aging.difference === null || aging.difference === 0n;

  return (
    <Shell
      principal={principal}
      title="Receivables aging"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Reports" },
        { label: "Aging" },
      ]}
    >
      <div className="space-y-4">
        <Panel title="As at">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="asOf" className="block text-[12px] font-medium">Date</label>
              <input
                id="asOf"
                name="asOf"
                type="date"
                defaultValue={asOf}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[13px]"
              />
            </div>
            <button type="submit" className="btn btn-primary px-3 py-2 text-[13px]">
              Run
            </button>
            <a
              href={`/accounting/reports/aging/csv?asOf=${asOf}`}
              className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] hover:bg-[var(--color-canvas)]"
            >
              Download CSV
            </a>
          </form>
        </Panel>

        {aging.difference !== null && !reconciled && (
          <Alert tone="danger">
            <strong>Receivables do not reconcile.</strong> The invoices outstanding, less unmatched
            receipts, come to {formatAmount(aging.totals.netOwing, { currency: "RM" })}, but the
            trade receivables control account holds{" "}
            {formatAmount(aging.controlAccountBalance ?? 0n, { currency: "RM" })} — a difference of{" "}
            {formatAmount(aging.difference ?? 0n, { currency: "RM" })}. Something has reached account 1210
            without going through an invoice or a receipt.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Outstanding" value={formatAmount(aging.totals.total)} hint={`at ${formatDate(asOf)}`} />
          <StatTile label="Not yet due" value={formatAmount(aging.totals.current)} />
          <StatTile
            label="Unmatched receipts"
            value={formatAmount(aging.totals.unallocatedReceipts)}
            hint="paid, not yet applied"
            tone={aging.totals.unallocatedReceipts > 0n ? "warn" : "neutral"}
          />
          <StatTile
            label="Control account"
            value={
              aging.controlAccountBalance === null
                ? "n/a"
                : formatAmount(aging.controlAccountBalance)
            }
            hint={
              aging.controlAccountBalance === null
                ? "not compared for a single customer"
                : reconciled
                  ? "agrees with this report"
                  : "does not agree"
            }
            tone={reconciled ? "neutral" : "danger"}
          />
        </div>

        {aging.rows.length === 0 ? (
          <EmptyState title="Nothing outstanding" body="Every issued invoice has been settled." />
        ) : (
          <Panel title={`${aging.rows.length} customer${aging.rows.length === 1 ? "" : "s"}`}>
            <DataTable
              columns={[
                "Customer",
                "Not due",
                ...aging.rows[0]!.buckets.map((bucket) => bucket.label),
                "Total",
                "On account",
                "Net owing",
              ]}
              caption="Receivables aging"
            >
              {aging.rows.map((row) => (
                <tr key={row.customerId}>
                  <Td>
                    <Link
                      href={`/accounting/customers/${row.customerId}`}
                      className="text-[var(--color-link)] hover:underline"
                    >
                      {row.customerName}
                    </Link>
                    <span className="block font-mono text-[11px] text-[var(--color-muted)]">
                      {row.customerCode}
                    </span>
                  </Td>
                  <Td numeric>{formatAmount(row.current, { zeroAs: "—" })}</Td>
                  {row.buckets.map((bucket) => (
                    <Td key={bucket.label} numeric>
                      <span className={bucket.to === null && bucket.amount > 0n ? "text-[var(--color-danger)]" : ""}>
                        {formatAmount(bucket.amount, { zeroAs: "—" })}
                      </span>
                    </Td>
                  ))}
                  <Td numeric>{formatAmount(row.total)}</Td>
                  <Td numeric>{formatAmount(row.unallocatedReceipts, { zeroAs: "—" })}</Td>
                  <Td numeric>{formatAmount(row.netOwing)}</Td>
                </tr>
              ))}
              <TotalRow>
                <Td>Total</Td>
                <Td numeric>{formatAmount(aging.totals.current, { zeroAs: "—" })}</Td>
                {aging.totals.buckets.map((amount, index) => (
                  <Td key={index} numeric>{formatAmount(amount, { zeroAs: "—" })}</Td>
                ))}
                <Td numeric>{formatAmount(aging.totals.total)}</Td>
                <Td numeric>{formatAmount(aging.totals.unallocatedReceipts, { zeroAs: "—" })}</Td>
                <Td numeric>{formatAmount(aging.totals.netOwing)}</Td>
              </TotalRow>
            </DataTable>
          </Panel>
        )}

        <p className="text-[11px] text-[var(--color-muted)]">
          Buckets come from the setting <span className="font-mono">accounting.aging_buckets</span>,
          currently {aging.boundaries.join(", ")} days.{" "}
          {!aging.boundariesConfirmed && (
            <strong>
              Nobody at CAC has confirmed those boundaries — they are the common convention, not the
              firm&rsquo;s policy, so which column an invoice falls into is the platform&rsquo;s
              suggestion. Confirm them under Settings and this note goes.
            </strong>
          )}{" "}
          &ldquo;On account&rdquo; is money received and not yet matched to an invoice; it reduces
          what the customer really owes.
        </p>
      </div>
    </Shell>
  );
}
