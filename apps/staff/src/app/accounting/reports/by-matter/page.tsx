import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, matterRevenue, today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, Panel, StatTile, Td, TotalRow } from "@/components/ui";

/**
 * Revenue by matter.
 *
 * The report that joins the two halves of the platform. `invoice_line.case_id` had been accepted,
 * computed, persisted and carried through conversions and credit notes since Phase 3, and no form
 * ever set one and nothing ever read one — so for a firm that bills per matter, the case management
 * and the money were two systems in one database.
 *
 * "Outstanding" is a share, not a debt: a receipt pays an invoice rather than a line, so an invoice
 * split across two matters and half paid cannot say which half. The column is apportioned by each
 * matter's share of the invoice, which is the only honest answer, and the note below says so.
 */
export default async function ByMatterPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const principal = await requireCapability("accounting.report.view");
  const query = await searchParams;
  const db = await getDb();

  const to = query.to || toIsoDate(today());
  const from = query.from || `${to.slice(0, 4)}-01-01`;
  const report = await matterRevenue(db, { from, to });

  const canSeeCases =
    principal.capabilities.has("case.view") || principal.capabilities.has("case.view_all");

  return (
    <Shell
      principal={principal}
      title="Revenue by matter"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Reports" },
        { label: "By matter" },
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
                defaultValue={report.from}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
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
                defaultValue={report.to}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
              />
            </div>
            <button
              type="submit"
              className="rounded-md border border-[var(--color-navy)] bg-[var(--color-navy)] px-3 py-2 text-[13px] text-white"
            >
              Show
            </button>
          </form>
        </Panel>

        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile label="Billed" value={formatAmount(report.totals.billed, { currency: "RM" })} />
          <StatTile
            label="Outstanding share"
            value={formatAmount(report.totals.outstanding, { currency: "RM" })}
            tone={report.totals.outstanding > 0n ? "warn" : "neutral"}
          />
          <StatTile
            label="Accepted, not yet billed"
            value={formatAmount(report.totals.quoted, { currency: "RM" })}
            hint="quotations the client accepted that have not become invoices"
          />
        </div>

        {report.unattributed > 0n && (
          <Alert tone="info">
            {formatAmount(report.unattributed, { currency: "RM" })} of issued revenue in this period
            names no matter. That is not wrong — not every invoice belongs to a file — but if the
            figure is large, the matter column on the invoice form is how it comes down.
          </Alert>
        )}

        <Panel
          title="Matters"
          description="Billed is issued invoices net of credit notes. Outstanding is each matter's share of what its invoices still owe, apportioned by line value — a receipt pays an invoice, not a line, so a split invoice half paid cannot say which half."
        >
          {report.rows.length === 0 ? (
            <EmptyState
              title="Nothing attributed to a matter yet"
              body="Invoice and quotation lines carry a matter. Choose one on the line and this report fills in."
            />
          ) : (
            <DataTable
              columns={["Matter", "Client", "Status", "Invoices", "Billed", "Outstanding", "Accepted"]}
              caption="Revenue by matter"
            >
              {report.rows.map((row) => (
                <tr key={row.caseId}>
                  <Td>
                    {canSeeCases ? (
                      <Link href={`/cases/${row.caseId}`} className="underline">
                        {row.caseNo}
                      </Link>
                    ) : (
                      row.caseNo
                    )}
                    <span className="block text-[11px] text-[var(--color-muted)]">{row.title}</span>
                  </Td>
                  <Td>{row.customerName ?? "—"}</Td>
                  <Td>
                    <Badge tone={row.status === "closed" ? "neutral" : "info"}>{row.status}</Badge>
                  </Td>
                  <Td numeric>{row.invoices}</Td>
                  <Td numeric>{formatAmount(row.billed)}</Td>
                  <Td numeric>{formatAmount(row.outstanding, { zeroAs: "—" })}</Td>
                  <Td numeric>{formatAmount(row.quoted, { zeroAs: "—" })}</Td>
                </tr>
              ))}
              <TotalRow>
                <Td>Total</Td>
                <Td>{""}</Td>
                <Td>{""}</Td>
                <Td numeric>{report.rows.reduce((sum, row) => sum + row.invoices, 0)}</Td>
                <Td numeric>{formatAmount(report.totals.billed)}</Td>
                <Td numeric>{formatAmount(report.totals.outstanding, { zeroAs: "—" })}</Td>
                <Td numeric>{formatAmount(report.totals.quoted, { zeroAs: "—" })}</Td>
              </TotalRow>
            </DataTable>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
