import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, listPeriods, today, toIsoDate, trialBalance } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, DataTable, EmptyState, Panel, StatTile, Td, TotalRow } from "@/components/ui";

const TYPE_ORDER = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const;

/**
 * The trial balance.
 *
 * The one report that has to be right before any other report means anything:
 * if debits and credits do not agree, the profit and loss is fiction. The
 * difference is shown at the top as its own figure rather than being left for the
 * reader to work out from two columns.
 */
export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; zero?: string }>;
}) {
  const principal = await requireCapability("accounting.report.view");
  const query = await searchParams;
  const db = await getDb();

  const to = query.to || toIsoDate(today());
  const from = query.from || null;
  const includeZero = query.zero === "1";

  const [tb, periods] = await Promise.all([
    trialBalance(db, { from, to, includeZero }),
    listPeriods(db),
  ]);

  const balanced = tb.difference === 0n;
  const grouped = TYPE_ORDER.map((type) => ({
    type,
    rows: tb.rows.filter((row) => row.type === type),
  })).filter((group) => group.rows.length > 0);

  return (
    <Shell
      principal={principal}
      title="Trial balance"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Reports" },
        { label: "Trial balance" },
      ]}
    >
      <div className="space-y-4">
        <Panel title="Period">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="from" className="block text-[12px] font-medium">
                From
              </label>
              <input
                id="from"
                name="from"
                type="date"
                defaultValue={query.from ?? ""}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              />
              <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                Blank gives cumulative balances.
              </p>
            </div>
            <div>
              <label htmlFor="to" className="block text-[12px] font-medium">
                To
              </label>
              <input
                id="to"
                name="to"
                type="date"
                defaultValue={to}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              />
            </div>
            <label className="flex items-center gap-2 pb-2 text-[12px]">
              <input type="checkbox" name="zero" value="1" defaultChecked={includeZero} />
              Show accounts with no movement
            </label>
            <button
              type="submit"
              className="rounded-md bg-[var(--color-navy)] px-3 py-2 text-[13px] font-medium text-white"
            >
              Run
            </button>
          </form>

          {periods.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {periods.slice(0, 12).map((period) => (
                <Link
                  key={period.id}
                  href={`/accounting/reports/trial-balance?from=${period.startsOn}&to=${period.endsOn}`}
                  className="rounded border border-[var(--color-line-strong)] px-2 py-1 font-mono text-[11px] hover:bg-[var(--color-canvas)]"
                >
                  {period.code}
                </Link>
              ))}
            </div>
          )}
        </Panel>

        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Total debits"
            value={formatAmount(tb.totalDebit)}
            hint={from ? `${formatDate(from)} to ${formatDate(to)}` : `to ${formatDate(to)}`}
          />
          <StatTile label="Total credits" value={formatAmount(tb.totalCredit)} />
          <StatTile
            label="Difference"
            value={formatAmount(tb.difference)}
            hint={balanced ? "The books balance" : "Investigate before relying on any report"}
            tone={balanced ? "neutral" : "danger"}
          />
        </div>

        {!balanced && (
          <Alert tone="danger">
            <strong>Out of balance by {formatAmount(tb.difference, { currency: "RM" })}.</strong> Every
            posting is made by one engine that cannot produce an unbalanced entry, and the database
            constraints refuse one. A difference here means the ledger has been written to directly.
          </Alert>
        )}

        {tb.rows.length === 0 ? (
          <EmptyState
            title="Nothing posted in this window"
            body="Either no journals have been posted yet, or none fall between those dates."
          />
        ) : (
          <Panel
            title={`${tb.rows.length} accounts`}
            description="Movement over the window, and the resulting balance on the side it falls."
          >
            {grouped.map((group) => {
              const debitTotal = group.rows.reduce((sum, row) => sum + row.balanceDebit, 0n);
              const creditTotal = group.rows.reduce((sum, row) => sum + row.balanceCredit, 0n);
              return (
                <div key={group.type} className="mb-5">
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-faint)]">
                    {group.type}
                  </h3>
                  <DataTable
                    columns={["Code", "Account", "Debits", "Credits", "Balance Dr", "Balance Cr"]}
                    caption={`${group.type} accounts`}
                  >
                    {group.rows.map((row) => (
                      <tr key={row.accountId}>
                        <Td>
                          <Link
                            href={`/accounting/accounts/${row.code}?${from ? `from=${from}&` : ""}to=${to}`}
                            className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                          >
                            {row.code}
                          </Link>
                        </Td>
                        <Td>{row.name}</Td>
                        <Td numeric>{formatAmount(row.debit, { zeroAs: "—" })}</Td>
                        <Td numeric>{formatAmount(row.credit, { zeroAs: "—" })}</Td>
                        <Td numeric>{formatAmount(row.balanceDebit, { zeroAs: "—" })}</Td>
                        <Td numeric>{formatAmount(row.balanceCredit, { zeroAs: "—" })}</Td>
                      </tr>
                    ))}
                    <TotalRow>
                      <Td>{""}</Td>
                      <Td>{group.type.toLowerCase()} total</Td>
                      <Td>{""}</Td>
                      <Td>{""}</Td>
                      <Td numeric>{formatAmount(debitTotal, { zeroAs: "—" })}</Td>
                      <Td numeric>{formatAmount(creditTotal, { zeroAs: "—" })}</Td>
                    </TotalRow>
                  </DataTable>
                </div>
              );
            })}

            <div className="border-t-2 border-[var(--color-line-strong)] pt-3">
              <DataTable columns={["", "Total", "Balance Dr", "Balance Cr"]} caption="Grand total">
                <TotalRow>
                  <Td>{""}</Td>
                  <Td>Grand total</Td>
                  <Td numeric>{formatAmount(tb.totalDebit)}</Td>
                  <Td numeric>{formatAmount(tb.totalCredit)}</Td>
                </TotalRow>
              </DataTable>
            </div>
          </Panel>
        )}

        <p className="text-[11px] text-[var(--color-muted)]">
          Includes posted and reversed journals. A reversed journal stays in the ledger alongside its
          reversal and the pair nets to nothing; excluding it would leave the reversal unmatched and
          put this report out by twice the amount. Drafts are excluded entirely.
        </p>
      </div>
    </Shell>
  );
}
