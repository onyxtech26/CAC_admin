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
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import {
  Alert,
  Badge,
  DataTable,
  EmptyState,
  LinkButton,
  Panel,
  StatTile,
  Td,
} from "@/components/ui";
import { WorkflowNavigator } from "@/components/WorkflowNavigator";
import {
  IconAccounting,
  IconBill,
  IconJournal,
  IconQuote,
} from "@/components/icons";

/**
 * AutoCount Accounting Command Center.
 *
 * Full double-entry ledger aligned with AutoCount Accounting 2.0 & Cloud:
 * - Interactive visual workflow maps for Sales (A/R), Purchases (A/P), and G/L
 * - Real-time ledger balance check (balanced vs. out-of-balance)
 * - Maker-checker draft journals awaiting posting
 * - Complete AutoCount categorised module directory
 */
export default async function AccountingPage() {
  const principal = await requireCapability("accounting.journal.view");
  const db = await getDb();

  const [totals, years, periods, drafts] = await Promise.all([
    ledgerTotals(db),
    listFiscalYears(db),
    listPeriods(db),
    listJournals(db, { status: "draft", limit: 8 }),
  ]);

  const now = toIsoDate(today());
  const currentPeriod = periods.find((p) => p.startsOn <= now && p.endsOn >= now);
  const openPeriods = periods.filter((p) => p.status === "open").length;
  const balanced = totals.outOfBalance === 0n;

  if (years.length === 0) {
    return (
      <Shell
        principal={principal}
        title="AutoCount Accounting"
        breadcrumbs={[{ label: "Accounting" }]}
        currentSuite="accounting"
      >
        <EmptyState
          title="No fiscal year has been set up"
          body="The ledger needs a fiscal calendar before transactions can be posted: every entry belongs to an accounting period."
          action={
            principal.capabilities.has("accounting.period.manage") ? (
              <LinkButton href="/accounting/periods" variant="primary">
                Set up fiscal calendar
              </LinkButton>
            ) : (
              <span className="text-[12px] text-[var(--color-muted)]">
                Ask an accountant or administrator to configure the fiscal calendar.
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
      title="AutoCount Accounting"
      breadcrumbs={[{ label: "Accounting" }]}
      currentSuite="accounting"
      actions={
        <div className="flex items-center gap-2">
          {principal.capabilities.has("accounting.journal.create") && (
            <LinkButton href="/accounting/journals/new" variant="primary">
              New journal
            </LinkButton>
          )}
          {principal.capabilities.has("accounting.invoice.create") && (
            <LinkButton href="/accounting/invoices/new">
              New invoice
            </LinkButton>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        {/* Ledger Balance Alert */}
        {!balanced && (
          <Alert tone="danger">
            <strong>The general ledger does not balance.</strong> Posted debits exceed credits by{" "}
            {formatAmount(totals.outOfBalance, { currency: "RM" })}. Investigate immediately in the{" "}
            <Link href="/accounting/reports/trial-balance" className="underline font-semibold">
              Trial Balance
            </Link>
            .
          </Alert>
        )}

        {/* Accounting Key Stat Tiles */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Current active period"
            value={currentPeriod?.code ?? "None"}
            hint={
              currentPeriod
                ? `${currentPeriod.status.toUpperCase()} · ${formatDate(currentPeriod.startsOn)} to ${formatDate(currentPeriod.endsOn)}`
                : `No period covers ${formatDate(now)}`
            }
            tone={currentPeriod?.status === "open" ? "neutral" : "warn"}
          />
          <StatTile
            label="Posted transactions"
            value={totals.postedJournals.toLocaleString("en-GB")}
            hint={`${formatAmount(totals.totalPosted, { currency: "RM" })} through ledger`}
          />
          <StatTile
            label="Awaiting posting (Drafts)"
            value={totals.draftJournals.toLocaleString("en-GB")}
            hint={totals.draftJournals > 0 ? "Requires maker-checker sign-off" : "All drafts posted"}
            tone={totals.draftJournals > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Trial balance status"
            value={balanced ? "BALANCED" : "OUT OF BALANCE"}
            hint={balanced ? `Nil difference as at ${formatDate(today())}` : "Discrepancy detected"}
            tone={balanced ? "ok" : "danger"}
          />
        </div>

        {/* AutoCount Process Flow Navigator */}
        <WorkflowNavigator defaultTab="sales" />

        {/* Operational Section: Drafts & Periods */}
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Drafts waiting for checker */}
          <Panel
            title="Draft Journals Awaiting Posting"
            description="Maker-checker control: drafts affect neither balances nor reports until verified."
            action={
              <Link
                href="/accounting/journals?status=draft"
                className="text-[12px] text-[var(--color-gold-2)] hover:underline"
              >
                View all drafts
              </Link>
            }
          >
            {drafts.length === 0 ? (
              <EmptyState
                title="No draft journals waiting"
                body="Every prepared journal transaction has been posted to the general ledger."
              />
            ) : (
              <DataTable
                columns={["Date", "Memo", "Amount", "Prepared by", "Action"]}
                caption="Draft journals"
              >
                {drafts.map((journal) => (
                  <tr key={journal.id}>
                    <Td>
                      <Link
                        href={`/accounting/journals/${journal.id}`}
                        className="text-[var(--color-gold-2)] hover:underline font-mono text-[12px]"
                      >
                        {formatDate(journal.entryDate)}
                      </Link>
                    </Td>
                    <Td>{journal.memo ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                    <Td numeric>{formatAmount(journal.total)}</Td>
                    <Td>{journal.createdByName}</Td>
                    <Td>
                      <Link
                        href={`/accounting/journals/${journal.id}`}
                        className="text-[12px] text-[var(--color-gold-2)] hover:underline"
                      >
                        Review
                      </Link>
                    </Td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Panel>

          {/* Periods Overview */}
          <Panel
            title="Fiscal Periods Calendar"
            description={`${openPeriods} of ${periods.length} period(s) open for entry.`}
            action={
              <Link
                href="/accounting/periods"
                className="text-[12px] text-[var(--color-gold-2)] hover:underline"
              >
                Manage calendar
              </Link>
            }
          >
            <DataTable columns={["Code", "Dates", "Status"]} caption="Accounting periods">
              {periods.slice(0, 6).map((period) => (
                <tr key={period.id}>
                  <Td>
                    <span className="font-mono text-[12px] text-[var(--color-body)] font-medium">
                      {period.code}
                    </span>
                  </Td>
                  <Td>
                    {formatDate(period.startsOn)} – {formatDate(period.endsOn)}
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        period.status === "open"
                          ? "ok"
                          : period.status === "locked"
                            ? "warn"
                            : "neutral"
                      }
                    >
                      {period.status.toUpperCase()}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </DataTable>
          </Panel>
        </div>

        {/* Full AutoCount Module Directory Matrix */}
        <Panel
          title="AutoCount Accounting Module Matrix"
          description="Structured according to AutoCount 2.0 standard layout: A/R, A/P, G/L, and Statutory Reports."
        >
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {/* Sales & A/R */}
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3.5 space-y-2 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] transition shadow-xs">
              <div className="flex items-center gap-2 border-b border-[var(--color-line)] pb-2">
                <IconQuote size={16} className="text-[var(--color-gold-2)]" />
                <h4 className="text-[13px] font-semibold text-[var(--color-ivory)]">
                  Sales & Receivables (A/R)
                </h4>
              </div>
              <ul className="space-y-1 text-[12.5px]">
                <li>
                  <Link
                    href="/accounting/quotations"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Quotations</span>
                    <span className="text-[10px] text-[var(--color-faint)]">A/R</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/invoices"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Invoices</span>
                    <span className="text-[10px] text-[var(--color-faint)]">A/R</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/receipts"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Official Receipts</span>
                    <span className="text-[10px] text-[var(--color-faint)]">A/R</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/customers"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Customer Master</span>
                    <span className="text-[10px] text-[var(--color-faint)]">Debtors</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/einvoice"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>e-Invoice (MyInvois)</span>
                    <Badge tone="info">LHDN</Badge>
                  </Link>
                </li>
              </ul>
            </div>

            {/* Purchases & A/P */}
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3.5 space-y-2 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] transition shadow-xs">
              <div className="flex items-center gap-2 border-b border-[var(--color-line)] pb-2">
                <IconBill size={16} className="text-[var(--color-gold-2)]" />
                <h4 className="text-[13px] font-semibold text-[var(--color-ivory)]">
                  Purchases & Payables (A/P)
                </h4>
              </div>
              <ul className="space-y-1 text-[12.5px]">
                <li>
                  <Link
                    href="/accounting/purchase-orders"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Purchase Orders</span>
                    <span className="text-[10px] text-[var(--color-faint)]">A/P</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/bills"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Supplier Bills</span>
                    <span className="text-[10px] text-[var(--color-faint)]">A/P</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/vouchers"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Payment Vouchers</span>
                    <span className="text-[10px] text-[var(--color-faint)]">A/P</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/claims"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Expense Claims</span>
                    <span className="text-[10px] text-[var(--color-faint)]">Claims</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/petty-cash"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Petty Cash</span>
                    <span className="text-[10px] text-[var(--color-faint)]">Float</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/suppliers"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Supplier Master</span>
                    <span className="text-[10px] text-[var(--color-faint)]">Creditors</span>
                  </Link>
                </li>
              </ul>
            </div>

            {/* General Ledger (G/L) */}
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3.5 space-y-2 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] transition shadow-xs">
              <div className="flex items-center gap-2 border-b border-[var(--color-line)] pb-2">
                <IconJournal size={16} className="text-[var(--color-info)]" />
                <h4 className="text-[13px] font-semibold text-[var(--color-ivory)]">
                  General Ledger (G/L)
                </h4>
              </div>
              <ul className="space-y-1 text-[12.5px]">
                <li>
                  <Link
                    href="/accounting/accounts"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Chart of Accounts</span>
                    <span className="text-[10px] text-[var(--color-faint)]">COA</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/journals"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Journal Entries</span>
                    <span className="text-[10px] text-[var(--color-faint)]">Postings</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/bank"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Bank Reconciliation</span>
                    <span className="text-[10px] text-[var(--color-faint)]">Bank</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/periods"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Fiscal Calendar</span>
                    <span className="text-[10px] text-[var(--color-faint)]">Years</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/tax"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Tax Codes</span>
                    <span className="text-[10px] text-[var(--color-faint)]">SST</span>
                  </Link>
                </li>
              </ul>
            </div>

            {/* Financial Statements */}
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3.5 space-y-2 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] transition shadow-xs">
              <div className="flex items-center gap-2 border-b border-[var(--color-line)] pb-2">
                <IconAccounting size={16} className="text-[var(--color-ok)]" />
                <h4 className="text-[13px] font-semibold text-[var(--color-ivory)]">
                  Financial Statements
                </h4>
              </div>
              <ul className="space-y-1 text-[12.5px]">
                <li>
                  <Link
                    href="/accounting/reports/trial-balance"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Trial Balance</span>
                    <span className="text-[10px] text-[var(--color-faint)]">Audit</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/reports/profit-and-loss"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Profit & Loss</span>
                    <span className="text-[10px] text-[var(--color-faint)]">Income</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/reports/balance-sheet"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Balance Sheet</span>
                    <span className="text-[10px] text-[var(--color-faint)]">Position</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/reports/aging"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Receivables Aging</span>
                    <span className="text-[10px] text-[var(--color-faint)]">A/R</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/reports/payables-aging"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Payables Aging</span>
                    <span className="text-[10px] text-[var(--color-faint)]">A/P</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/accounting/reports/by-matter"
                    className="flex items-center justify-between text-[var(--color-muted)] hover:text-[var(--color-gold-2)] py-1 transition-colors"
                  >
                    <span>Revenue by Matter</span>
                    <span className="text-[10px] text-[var(--color-faint)]">CAC</span>
                  </Link>
                </li>
              </ul>
            </div>
          </div>
        </Panel>
      </div>
    </Shell>
  );
}
