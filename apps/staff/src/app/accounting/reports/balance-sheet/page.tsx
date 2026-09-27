import Link from "next/link";
import { getDb } from "@cac/db";
import { balanceSheet, formatAmount, formatDate, today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, DataTable, EmptyState, Panel, StatTile, Td, TotalRow } from "@/components/ui";

/**
 * Balance sheet.
 *
 * Current-year earnings appear as a line in equity because revenue and expenses
 * are not closed to reserves until the year end. Without it a balance sheet drawn
 * in June does not balance, and the reader concludes the software is wrong. That
 * figure comes from the profit and loss for the year to date and is deliberately
 * not posted anywhere — the closing entry at year end is a real journal, made
 * once, visible and reversible.
 */
export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const principal = await requireCapability("accounting.report.view");
  const query = await searchParams;
  const db = await getDb();

  const asOf = query.asOf || toIsoDate(today());
  const sheet = await balanceSheet(db, { asOf });
  const balanced = sheet.difference === 0n;

  const section = (heading: string, lines: typeof sheet.equity.lines, total: bigint) => (
    <div className="mb-5" key={heading}>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-faint)]">
        {heading}
      </h3>
      <DataTable columns={["Code", "Account", "Amount"]} caption={heading}>
        {lines.map((line) => (
          <tr key={line.accountId}>
            <Td>
              <Link
                href={`/accounting/accounts/${line.code}?to=${asOf}`}
                className="font-mono text-[12px] text-[var(--color-link)] hover:underline"
              >
                {line.code}
              </Link>
            </Td>
            <Td>{line.name}</Td>
            <Td numeric>{formatAmount(line.amount, { accounting: true })}</Td>
          </tr>
        ))}
        <TotalRow>
          <Td>{""}</Td>
          <Td>{heading} total</Td>
          <Td numeric>{formatAmount(total, { accounting: true })}</Td>
        </TotalRow>
      </DataTable>
    </div>
  );

  const hasAnything =
    sheet.assets.length > 0 || sheet.liabilities.length > 0 || sheet.equity.lines.length > 0;

  return (
    <Shell
      principal={principal}
      title="Balance sheet"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Reports" },
        { label: "Balance sheet" },
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
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[13px]"
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary px-3 py-2 text-[13px]"
            >
              Run
            </button>
          </form>
        </Panel>

        {!balanced && (
          <Alert tone="danger">
            <strong>This does not balance.</strong> Assets come to{" "}
            {formatAmount(sheet.totalAssets, { currency: "RM" })} against liabilities and equity of{" "}
            {formatAmount(sheet.totalLiabilities + sheet.totalEquity, { currency: "RM" })}, a
            difference of {formatAmount(sheet.difference, { currency: "RM" })}. Check the trial
            balance before relying on anything here.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Total assets"
            value={formatAmount(sheet.totalAssets)}
            hint={`at ${formatDate(asOf)}`}
          />
          <StatTile label="Total liabilities" value={formatAmount(sheet.totalLiabilities)} />
          <StatTile
            label="Total equity"
            value={formatAmount(sheet.totalEquity, { accounting: true })}
            hint={balanced ? "assets less liabilities" : "does not agree"}
            tone={balanced ? "neutral" : "danger"}
          />
        </div>

        {!hasAnything ? (
          <EmptyState
            title="Nothing posted yet"
            body="No journal has touched a balance sheet account."
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Assets">
              {sheet.assets.map((group) => section(group.heading, group.lines, group.total))}
              <div className="border-t-2 border-[var(--color-line-strong)] pt-2">
                <div className="flex items-baseline justify-between text-[15px] font-semibold">
                  <span>Total assets</span>
                  <span className="numeric">{formatAmount(sheet.totalAssets)}</span>
                </div>
              </div>
            </Panel>

            <Panel title="Liabilities and equity">
              {sheet.liabilities.map((group) => section(group.heading, group.lines, group.total))}
              {sheet.equity.lines.length > 0 &&
                section("Equity", sheet.equity.lines, sheet.equity.total)}

              <div className="mb-3 flex items-baseline justify-between text-[13px]">
                <span>
                  Profit for the year to date
                  <span className="block text-[11px] text-[var(--color-muted)]">
                    {sheet.fiscalYearStart
                      ? `since ${formatDate(sheet.fiscalYearStart)}; not yet closed to reserves`
                      : "no fiscal year covers this date"}
                  </span>
                </span>
                <span className="numeric">
                  {formatAmount(sheet.currentYearEarnings, { accounting: true })}
                </span>
              </div>

              <div className="border-t-2 border-[var(--color-line-strong)] pt-2">
                <div className="flex items-baseline justify-between text-[15px] font-semibold">
                  <span>Total liabilities and equity</span>
                  <span className="numeric">
                    {formatAmount(sheet.totalLiabilities + sheet.totalEquity)}
                  </span>
                </div>
              </div>
            </Panel>
          </div>
        )}
      </div>
    </Shell>
  );
}
