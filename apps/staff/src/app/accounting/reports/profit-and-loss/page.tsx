import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, listPeriods, profitAndLoss, today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { DataTable, EmptyState, Panel, StatTile, Td, TotalRow } from "@/components/ui";

/**
 * Profit and loss.
 *
 * Direct costs sit above the line and overheads below it, so gross margin means
 * something: for a fee practice, what a job costs to deliver is the number that
 * decides whether the fee was right.
 *
 * Every figure links back to the account it came from, and from there to the
 * individual entries. A report you cannot drill into is a report you have to take
 * on trust.
 */
export default async function ProfitAndLossPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const principal = await requireCapability("accounting.report.view");
  const query = await searchParams;
  const db = await getDb();

  const to = query.to || toIsoDate(today());
  const from = query.from || `${to.slice(0, 4)}-01-01`;

  const [report, periods] = await Promise.all([profitAndLoss(db, { from, to }), listPeriods(db)]);

  const hasAnything =
    report.revenue.lines.length > 0 ||
    report.directCosts.lines.length > 0 ||
    report.expenses.length > 0;

  const section = (heading: string, lines: typeof report.revenue.lines, total: bigint) => (
    <div className="mb-5" key={heading}>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-faint)]">
        {heading}
      </h3>
      <DataTable columns={["Code", "Account", "Amount"]} caption={heading}>
        {lines.map((line) => (
          <tr key={line.accountId}>
            <Td>
              <Link
                href={`/accounting/accounts/${line.code}?from=${from}&to=${to}`}
                className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
              >
                {line.code}
              </Link>
            </Td>
            <Td>{line.name}</Td>
            <Td numeric>{formatAmount(line.amount)}</Td>
          </tr>
        ))}
        <TotalRow>
          <Td>{""}</Td>
          <Td>{heading} total</Td>
          <Td numeric>{formatAmount(total)}</Td>
        </TotalRow>
      </DataTable>
    </div>
  );

  return (
    <Shell
      principal={principal}
      title="Profit and loss"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Reports" },
        { label: "Profit and loss" },
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
                defaultValue={from}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              />
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
                  href={`/accounting/reports/profit-and-loss?from=${period.startsOn}&to=${period.endsOn}`}
                  className="rounded border border-[var(--color-line-strong)] px-2 py-1 font-mono text-[11px] hover:bg-[var(--color-canvas)]"
                >
                  {period.code}
                </Link>
              ))}
            </div>
          )}
        </Panel>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Revenue"
            value={formatAmount(report.revenue.total)}
            hint={`${formatDate(from)} to ${formatDate(to)}`}
          />
          <StatTile
            label="Gross profit"
            value={formatAmount(report.grossProfit)}
            hint={
              report.grossMargin === null
                ? "no revenue in this window"
                : `${report.grossMargin.toFixed(1)}% margin`
            }
          />
          <StatTile label="Overheads" value={formatAmount(report.totalExpenses)} />
          <StatTile
            label="Net profit"
            value={formatAmount(report.netProfit, { accounting: true })}
            hint={report.netProfit < 0n ? "a loss for this period" : "before any closing entries"}
            tone={report.netProfit < 0n ? "warn" : "neutral"}
          />
        </div>

        {!hasAnything ? (
          <EmptyState
            title="Nothing posted in this window"
            body="Either no journals fall between those dates, or none of them touched a revenue or expense account."
          />
        ) : (
          <Panel title="Detail">
            {report.revenue.lines.length > 0 &&
              section("Revenue", report.revenue.lines, report.revenue.total)}
            {report.directCosts.lines.length > 0 &&
              section("Direct costs", report.directCosts.lines, report.directCosts.total)}

            <div className="mb-5 border-y-2 border-[var(--color-line-strong)] py-2">
              <div className="flex items-baseline justify-between text-[14px] font-semibold">
                <span>Gross profit</span>
                <span className="numeric">{formatAmount(report.grossProfit)}</span>
              </div>
            </div>

            {report.expenses.map((group) => section(group.heading, group.lines, group.total))}

            <div className="border-t-2 border-[var(--color-line-strong)] pt-3">
              <div className="flex items-baseline justify-between text-[13px]">
                <span className="text-[var(--color-muted)]">Total overheads</span>
                <span className="numeric">{formatAmount(report.totalExpenses)}</span>
              </div>
              <div className="mt-2 flex items-baseline justify-between text-[16px] font-semibold">
                <span>{report.netProfit < 0n ? "Net loss" : "Net profit"}</span>
                <span className="numeric">
                  {formatAmount(report.netProfit, { accounting: true })}
                </span>
              </div>
            </div>
          </Panel>
        )}

        <p className="text-[11px] text-[var(--color-muted)]">
          Posted and reversed journals, on an accruals basis: revenue counts when the invoice is
          issued, not when it is paid. Figures are before any year-end closing entry.
        </p>
      </div>
    </Shell>
  );
}
