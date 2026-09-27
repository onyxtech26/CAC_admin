import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, payablesAging, today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, DataTable, EmptyState, Panel, StatTile, Td, TotalRow } from "@/components/ui";

/**
 * Accounts payable, aged — the mirror of the receivables screen, and read for a different reason.
 *
 * On the receivables side an old balance is a collections problem. Here it is either a cash-flow
 * problem or a supplier about to stop working with CAC, so the oldest column is the one that
 * matters and it is the one the eye should land on.
 *
 * The reconciliation line at the top is what makes the rest worth reading. An aging report that
 * does not agree with the trade payables control account is two different answers to the same
 * question, and this one says so rather than letting the reader pick.
 */
export default async function PayablesAgingPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const principal = await requireCapability("accounting.report.view");
  const query = await searchParams;
  const db = await getDb();

  const asOf = query.asOf || toIsoDate(today());
  const aging = await payablesAging(db, { asOf });
  const reconciled = aging.difference === null || aging.difference === 0n;

  const overdue = aging.totals.total - aging.totals.current;

  return (
    <Shell
      principal={principal}
      title="Payables aging"
      breadcrumbs={[
        { label: "Purchases & payables" },
        { label: "Reports" },
        { label: "Payables aging" },
      ]}
    >
      <div className="space-y-4">
        <Panel title="As at">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="asOf" className="block text-[12px] font-medium">
                Date
              </label>
              <input
                id="asOf"
                name="asOf"
                type="date"
                defaultValue={asOf}
                className="control mt-1 w-auto"
              />
            </div>
            <button type="submit" className="btn btn-primary px-3 py-2 text-[13px]">
              Run
            </button>
          </form>
        </Panel>

        {aging.difference !== null && !reconciled && (
          <Alert tone="danger">
            <strong>Payables do not reconcile.</strong> The bills outstanding, less credit notes and
            payments not yet matched to a bill, come to{" "}
            {formatAmount(aging.totals.netOwing, { currency: "RM" })}, but the trade payables control
            account holds {formatAmount(aging.controlAccountBalance ?? 0n, { currency: "RM" })} — a
            difference of {formatAmount(aging.difference ?? 0n, { currency: "RM" })}. Something has
            reached account 2110 without going through a bill or a payment.
          </Alert>
        )}

        {!aging.boundariesConfirmed && (
          <Alert tone="warn">
            The 30/60/90 boundaries are the platform&rsquo;s suggestion, not CAC&rsquo;s policy. The
            figures do not change either way; which supplier appears in which column does.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Owed"
            value={formatAmount(aging.totals.total)}
            hint={`at ${formatDate(asOf)}`}
          />
          <StatTile
            label="Overdue"
            value={formatAmount(overdue)}
            hint={overdue > 0n ? "past its due date" : "nothing late"}
            tone={overdue > 0n ? "warn" : "neutral"}
          />
          <StatTile
            label="Paid, unmatched"
            value={formatAmount(aging.totals.paymentsOnAccount)}
            hint="money out, no bill named"
            tone={aging.totals.paymentsOnAccount > 0n ? "warn" : "neutral"}
          />
          <StatTile
            label="Control account"
            value={
              aging.controlAccountBalance === null
                ? "n/a"
                : formatAmount(aging.controlAccountBalance)
            }
            hint={reconciled ? "agrees with this report" : "does not agree"}
            tone={reconciled ? "neutral" : "danger"}
          />
        </div>

        {aging.rows.length === 0 ? (
          <EmptyState
            title="Nothing owed"
            body="Every posted bill has been settled, and nothing is sitting unmatched."
          />
        ) : (
          <Panel title={`${aging.rows.length} supplier${aging.rows.length === 1 ? "" : "s"}`}>
            <DataTable
              columns={[
                "Supplier",
                "Not due",
                ...aging.rows[0]!.buckets.map((bucket) => bucket.label),
                "Total",
                "Credits",
                "On account",
                "Net owing",
                "Oldest due",
              ]}
              caption="Payables aging"
            >
              {aging.rows.map((row) => (
                <tr key={row.supplierId}>
                  <Td>
                    <Link
                      href={`/accounting/bills?supplierId=${row.supplierId}&outstanding=1`}
                      className="text-[var(--color-link)] hover:underline"
                    >
                      {row.supplierName}
                    </Link>
                  </Td>
                  <Td numeric>{formatAmount(row.current)}</Td>
                  {row.buckets.map((bucket) => (
                    <Td key={bucket.from} numeric>
                      {bucket.amount === 0n ? "—" : formatAmount(bucket.amount)}
                    </Td>
                  ))}
                  <Td numeric>{formatAmount(row.total)}</Td>
                  <Td numeric>
                    {row.unappliedCredits === 0n ? "—" : formatAmount(row.unappliedCredits)}
                  </Td>
                  <Td numeric>
                    {row.paymentsOnAccount === 0n ? "—" : formatAmount(row.paymentsOnAccount)}
                  </Td>
                  <Td numeric>{formatAmount(row.netOwing)}</Td>
                  <Td>{row.oldestDueDate ? formatDate(row.oldestDueDate) : "—"}</Td>
                </tr>
              ))}
              <TotalRow>
                <Td>Total</Td>
                <Td numeric>{formatAmount(aging.totals.current)}</Td>
                {aging.totals.buckets.map((amount, index) => (
                  <Td key={index} numeric>
                    {formatAmount(amount)}
                  </Td>
                ))}
                <Td numeric>{formatAmount(aging.totals.total)}</Td>
                <Td numeric>{formatAmount(aging.totals.unappliedCredits)}</Td>
                <Td numeric>{formatAmount(aging.totals.paymentsOnAccount)}</Td>
                <Td numeric>{formatAmount(aging.totals.netOwing)}</Td>
                <Td>&nbsp;</Td>
              </TotalRow>
            </DataTable>
          </Panel>
        )}

        <p className="text-[11px] text-[var(--color-muted)]">
          Bills entered but not yet posted are left out. Nobody has confirmed them, so they are not
          liabilities — and including them would make this report disagree with the balance sheet by
          whatever is sitting in somebody&rsquo;s drafts.
        </p>
      </div>
    </Shell>
  );
}
