import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, listBankAccounts, listReconciliations } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Badge, DataTable, EmptyState, LinkButton, Panel, StatTile, Td } from "@/components/ui";

/**
 * The bank accounts, and how long since each was proved right.
 *
 * "Last reconciled" is the number on this page that matters. A bank account that
 * has not been reconciled for three months is not an account whose balance
 * anybody should be relying on, and the only way that fact becomes visible is if
 * something says so.
 */
export default async function BankPage() {
  const principal = await requireCapability("accounting.bank.view");
  const db = await getDb();

  const [accounts, recent] = await Promise.all([
    listBankAccounts(db, { includeInactive: true }),
    listReconciliations(db, { limit: 10 }),
  ]);

  const today = new Date();
  const staleness = (date: string | null): number | null => {
    if (!date) return null;
    return Math.floor((today.getTime() - new Date(`${date}T00:00:00Z`).getTime()) / 86_400_000);
  };

  const neverReconciled = accounts.filter((account) => account.isActive && !account.lastReconciledOn);
  const outstanding = accounts.reduce((sum, account) => sum + account.unmatchedLines, 0);

  return (
    <Shell
      principal={principal}
      title="Bank reconciliation"
      breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "Bank" }]}
      actions={
        principal.capabilities.has("accounting.bank.manage") ? (
          <LinkButton href="/accounting/bank/new" variant="primary">
            Add a bank account
          </LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {accounts.length === 0 ? (
          <EmptyState
            title="No bank accounts yet"
            body="A bank account attaches to a ledger account and carries what the ledger cannot: which bank, which number, and the statements themselves."
            action={
              principal.capabilities.has("accounting.bank.manage") ? (
                <LinkButton href="/accounting/bank/new" variant="primary">
                  Add a bank account
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile
                label="Accounts"
                value={String(accounts.filter((account) => account.isActive).length)}
                hint={`${formatAmount(
                  accounts
                    .filter((account) => account.isActive)
                    .reduce((sum, account) => sum + account.ledgerBalance, 0n),
                )} per the ledger`}
              />
              <StatTile
                label="Statement lines unaccounted for"
                value={String(outstanding)}
                hint={outstanding > 0 ? "the bank has reported these and nobody has said what they are" : "nothing outstanding"}
                tone={outstanding > 0 ? "warn" : "neutral"}
              />
              <StatTile
                label="Never reconciled"
                value={String(neverReconciled.length)}
                hint={
                  neverReconciled.length > 0
                    ? neverReconciled.map((account) => account.accountCode).join(", ")
                    : "every account has been proved at least once"
                }
                tone={neverReconciled.length > 0 ? "warn" : "ok"}
              />
            </div>

            <Panel title="Accounts">
              <DataTable
                columns={[
                  "Ledger account",
                  "Bank",
                  "Number",
                  "Balance per ledger",
                  "Unaccounted for",
                  "Last reconciled",
                  "",
                ]}
                caption="Bank accounts"
              >
                {accounts.map((account) => {
                  const days = staleness(account.lastReconciledOn);
                  return (
                    <tr key={account.id} className={account.isActive ? "" : "opacity-60"}>
                      <Td>
                        <Link
                          href={`/accounting/bank/${account.id}`}
                          className="text-[var(--color-info)] hover:underline"
                        >
                          <span className="font-mono text-[12px]">{account.accountCode}</span>{" "}
                          {account.accountName}
                        </Link>
                        {!account.isActive && (
                          <span className="ml-1">
                            <Badge tone="neutral">closed</Badge>
                          </span>
                        )}
                      </Td>
                      <Td>{account.bankName}</Td>
                      <Td>
                        <span className="font-mono text-[11px]">
                          {account.accountNo ?? <span className="text-[var(--color-faint)]">—</span>}
                        </span>
                      </Td>
                      <Td numeric>{formatAmount(account.ledgerBalance)}</Td>
                      <Td numeric>
                        {account.unmatchedLines > 0 ? (
                          <span className="text-[var(--color-warn)]">{account.unmatchedLines}</span>
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td>
                        {account.lastReconciledOn ? (
                          <>
                            {formatDate(account.lastReconciledOn)}
                            {days !== null && days > 45 && (
                              <span className="ml-1">
                                <Badge tone="warn">{days} days ago</Badge>
                              </span>
                            )}
                          </>
                        ) : (
                          <Badge tone="warn">never</Badge>
                        )}
                      </Td>
                      <Td>
                        {account.openReconciliationId ? (
                          <Link
                            href={`/accounting/bank/${account.id}/reconcile`}
                            className="text-[12px] text-[var(--color-info)] hover:underline"
                          >
                            Reconciliation in progress
                          </Link>
                        ) : (
                          ""
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </DataTable>
            </Panel>
          </>
        )}

        {recent.length > 0 && (
          <Panel title="Recent reconciliations">
            <DataTable
              columns={["Number", "Account", "As at", "Per bank", "Per ledger", "Signed off by"]}
              caption="Reconciliations"
            >
              {recent.map((row) => (
                <tr key={row.id}>
                  <Td>
                    <span className="font-mono text-[12px]">
                      {row.reconciliationNo ?? "in progress"}
                    </span>
                  </Td>
                  <Td>
                    <span className="font-mono text-[11px]">{row.accountCode}</span> {row.bankName}
                  </Td>
                  <Td>{formatDate(row.asAt)}</Td>
                  <Td numeric>{formatAmount(row.statementBalance)}</Td>
                  <Td numeric>{formatAmount(row.ledgerBalance)}</Td>
                  <Td>
                    {row.completedByName ?? (
                      <Badge tone="warn">open</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </DataTable>
          </Panel>
        )}
      </div>
    </Shell>
  );
}
