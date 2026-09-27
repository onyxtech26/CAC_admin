import Link from "next/link";
import { getDb } from "@cac/db";
import {
  formatAmount,
  formatDate,
  ledgerTotals,
  listFiscalYears,
  listJournals,
  listPeriods,
  today,
  toIsoDate,
  trialBalance,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, LinkButton, Panel, StatTile, Td } from "@/components/ui";

/**
 * The accounting overview.
 *
 * Shows the state of the ledger rather than a set of vanity figures: which
 * period is open, what is waiting to be posted, and whether the books balance.
 * The last of those is the point — a trial balance that does not total to zero is
 * shown in red at the top of the page instead of being discovered at year end.
 */
export default async function AccountingPage() {
  const principal = await requireCapability("accounting.journal.view");
  const db = await getDb();

  const [totals, years, periods, drafts, tb] = await Promise.all([
    ledgerTotals(db),
    listFiscalYears(db),
    listPeriods(db),
    listJournals(db, { status: "draft", limit: 10 }),
    trialBalance(db),
  ]);

  const now = toIsoDate(today());
  const currentPeriod = periods.find((p) => p.startsOn <= now && p.endsOn >= now);
  const openPeriods = periods.filter((p) => p.status === "open").length;
  const balanced = totals.outOfBalance === 0n;

  if (years.length === 0) {
    return (
      <Shell principal={principal} title="Accounting" breadcrumbs={[{ label: "Accounting" }]}>
        <EmptyState
          title="No fiscal year has been set up"
          body="The ledger needs a fiscal calendar before anything can be posted: every entry belongs to an accounting period, and a period cannot be invented at the moment of posting."
          action={
            principal.capabilities.has("accounting.period.manage") ? (
              <LinkButton href="/accounting/periods" variant="primary">
                Set up the fiscal year
              </LinkButton>
            ) : (
              <span className="text-[12px] text-[var(--color-muted)]">
                Ask an accountant to set one up.
              </span>
            )
          }
        />
      </Shell>
    );
  }

  return (
    <Shell
      principal={principal}
      title="Accounting"
      breadcrumbs={[{ label: "Accounting" }]}
      actions={
        principal.capabilities.has("accounting.journal.create") ? (
          <LinkButton href="/accounting/journals/new" variant="primary">
            New journal
          </LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {!balanced && (
          <Alert tone="danger">
            <strong>The ledger does not balance.</strong> Posted debits exceed credits by{" "}
            {formatAmount(totals.outOfBalance, { currency: "RM" })}. Every posting goes through one
            engine that cannot produce this, so something has written to the ledger directly. Stop
            entering transactions and raise it.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Current period"
            value={currentPeriod?.code ?? "None"}
            hint={
              currentPeriod
                ? `${currentPeriod.status} · ${formatDate(currentPeriod.startsOn)} to ${formatDate(currentPeriod.endsOn)}`
                : `No period covers ${formatDate(now)}`
            }
            tone={currentPeriod?.status === "open" ? "neutral" : "warn"}
          />
          <StatTile
            label="Posted journals"
            value={totals.postedJournals.toLocaleString("en-GB")}
            hint={`${formatAmount(totals.totalPosted, { currency: "RM" })} through the ledger`}
          />
          <StatTile
            label="Awaiting posting"
            value={totals.draftJournals.toLocaleString("en-GB")}
            hint={totals.draftJournals > 0 ? "Drafts are not in the ledger yet" : "Nothing outstanding"}
            tone={totals.draftJournals > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Trial balance"
            value={balanced ? "Balanced" : "Out"}
            hint={balanced ? `Nil difference at ${formatDate(tb.to)}` : "Investigate immediately"}
            tone={balanced ? "neutral" : "danger"}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="Drafts awaiting posting"
            description="A draft changes nothing until someone posts it."
            action={<Link href="/accounting/journals?status=draft" className="text-[12px] text-[var(--color-info)]">All journals</Link>}
          >
            {drafts.length === 0 ? (
              <EmptyState title="Nothing waiting" body="Every journal prepared has been posted." />
            ) : (
              <DataTable columns={["Date", "Memo", "Amount", "Prepared by"]} caption="Draft journals">
                {drafts.map((journal) => (
                  <tr key={journal.id}>
                    <Td>
                      <Link
                        href={`/accounting/journals/${journal.id}`}
                        className="text-[var(--color-link)] hover:underline"
                      >
                        {formatDate(journal.entryDate)}
                      </Link>
                    </Td>
                    <Td>{journal.memo ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                    <Td numeric>{formatAmount(journal.total)}</Td>
                    <Td>{journal.createdByName}</Td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Panel>

          <Panel
            title="Periods"
            description={`${openPeriods} of ${periods.length} open.`}
            action={<Link href="/accounting/periods" className="text-[12px] text-[var(--color-info)]">Manage</Link>}
          >
            <DataTable columns={["Period", "Dates", "Status"]} caption="Accounting periods">
              {periods.slice(0, 8).map((period) => (
                <tr key={period.id}>
                  <Td>
                    <span className="font-mono text-[12px]">{period.code}</span>
                  </Td>
                  <Td>
                    {formatDate(period.startsOn)} – {formatDate(period.endsOn)}
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        period.status === "open" ? "ok" : period.status === "locked" ? "warn" : "neutral"
                      }
                    >
                      {period.status}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </DataTable>
          </Panel>
        </div>

        <Panel
          title="Where to go"
          description="Purchasing, petty cash and claims are the remaining part of this phase."
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <LinkButton href="/accounting/quotations">Quotations</LinkButton>
            <LinkButton href="/accounting/invoices">Invoices</LinkButton>
            <LinkButton href="/accounting/receipts">Receipts</LinkButton>
            <LinkButton href="/accounting/customers">Customers</LinkButton>
            <LinkButton href="/accounting/journals">Journals</LinkButton>
            <LinkButton href="/accounting/accounts">Chart of accounts</LinkButton>
            <LinkButton href="/accounting/reports/trial-balance">Trial balance</LinkButton>
            <LinkButton href="/accounting/reports/profit-and-loss">Profit and loss</LinkButton>
            <LinkButton href="/accounting/reports/balance-sheet">Balance sheet</LinkButton>
            <LinkButton href="/accounting/reports/aging">Receivables aging</LinkButton>
            <LinkButton href="/accounting/periods">Fiscal calendar</LinkButton>
            <LinkButton href="/accounting/tax">Tax</LinkButton>
          </div>
        </Panel>
      </div>
    </Shell>
  );
}
