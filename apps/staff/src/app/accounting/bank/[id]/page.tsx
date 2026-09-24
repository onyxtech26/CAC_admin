import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import {
  formatAmount,
  formatDate,
  getBankAccount,
  listReconciliations,
  listStatements,
  reconciliationPosition,
  today,
  toIsoDate,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, LinkButton, Panel, Td } from "@/components/ui";
import { ReconciliationControls, StatementActions } from "./BankAccountActions";

export default async function BankAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.bank.view");
  const { id } = await params;
  const db = await getDb();

  const account = await getBankAccount(db, id);
  if (!account) notFound();

  const asAt = toIsoDate(today());
  const [statements, reconciliations, position] = await Promise.all([
    listStatements(db, { bankAccountId: id, limit: 50 }),
    listReconciliations(db, { bankAccountId: id, limit: 20 }),
    reconciliationPosition(db, id, asAt),
  ]);

  const open = reconciliations.find((row) => row.status === "draft");

  return (
    <Shell
      principal={principal}
      title={`${account.accountCode} ${account.accountName}`}
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Bank", href: "/accounting/bank" },
        { label: account.bankName },
      ]}
      actions={
        <div className="flex gap-2">
          {principal.capabilities.has("accounting.bank.manage") && (
            <LinkButton href={`/accounting/bank/${id}/edit`}>Edit</LinkButton>
          )}
          {principal.capabilities.has("accounting.bank.import") && account.isActive && (
            <LinkButton href={`/accounting/bank/${id}/import`} variant="primary">
              Import a statement
            </LinkButton>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {!account.isActive && (
          <Alert tone="warn">
            This account is marked closed. Its history stays; nothing new can be imported.
          </Alert>
        )}
        {open && (
          <Alert tone="info">
            A reconciliation to {formatDate(open.asAt)} is in progress.{" "}
            <Link
              href={`/accounting/bank/${id}/reconcile`}
              className="font-medium text-[var(--color-info)] hover:underline"
            >
              Carry on with it
            </Link>
            .
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Panel title="Statements">
              {statements.length === 0 ? (
                <EmptyState
                  title="Nothing imported yet"
                  body="Download the statement from the bank as CSV and import it. Nothing is written until you have seen what was read."
                  action={
                    principal.capabilities.has("accounting.bank.import") ? (
                      <LinkButton href={`/accounting/bank/${id}/import`} variant="primary">
                        Import a statement
                      </LinkButton>
                    ) : undefined
                  }
                />
              ) : (
                <DataTable
                  columns={[
                    "Period",
                    "Reference",
                    "Opening",
                    "Closing",
                    "Lines",
                    "Unaccounted for",
                    "Imported",
                    "",
                  ]}
                  caption="Imported statements"
                >
                  {statements.map((statement) => (
                    <tr key={statement.id}>
                      <Td>
                        {formatDate(statement.periodFrom)} – {formatDate(statement.periodTo)}
                      </Td>
                      <Td>
                        {statement.statementRef ?? (
                          <span className="text-[var(--color-faint)]">—</span>
                        )}
                        {statement.sourceFilename && (
                          <span className="block font-mono text-[10px] text-[var(--color-muted)]">
                            {statement.sourceFilename}
                          </span>
                        )}
                      </Td>
                      <Td numeric>{formatAmount(statement.openingBalance)}</Td>
                      <Td numeric>{formatAmount(statement.closingBalance)}</Td>
                      <Td numeric>{statement.lineCount}</Td>
                      <Td numeric>
                        {statement.unmatchedCount > 0 ? (
                          <span className="text-[var(--color-warn)]">
                            {statement.unmatchedCount}
                          </span>
                        ) : (
                          <Badge tone="ok">all accounted for</Badge>
                        )}
                      </Td>
                      <Td>
                        <span className="text-[11px] text-[var(--color-muted)]">
                          {statement.importedByName ?? "—"}
                        </span>
                      </Td>
                      <Td>
                        {principal.capabilities.has("accounting.bank.import") && (
                          <StatementActions
                            bankAccountId={id}
                            statementId={statement.id}
                            periodTo={statement.periodTo}
                          />
                        )}
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>

            {reconciliations.length > 0 && (
              <Panel title="Reconciliation history">
                <DataTable
                  columns={["Number", "As at", "Per bank", "Per ledger", "Difference", "Signed off"]}
                  caption="Reconciliations"
                >
                  {reconciliations.map((row) => (
                    <tr key={row.id}>
                      <Td>
                        <span className="font-mono text-[12px]">
                          {row.reconciliationNo ?? "in progress"}
                        </span>
                      </Td>
                      <Td>{formatDate(row.asAt)}</Td>
                      <Td numeric>{formatAmount(row.statementBalance)}</Td>
                      <Td numeric>{formatAmount(row.ledgerBalance)}</Td>
                      <Td numeric>
                        {row.difference === 0n ? (
                          <Badge tone="ok">agreed</Badge>
                        ) : (
                          <span className="text-[var(--color-warn)]">
                            {formatAmount(row.difference)}
                          </span>
                        )}
                      </Td>
                      <Td>
                        {row.completedByName ?? <Badge tone="warn">open</Badge>}
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              </Panel>
            )}
          </div>

          <div className="space-y-4">
            <Panel title="Where it stands today">
              <dl className="space-y-2 text-[13px]">
                <Row label="Per the bank" value={formatAmount(position.statementBalance)} />
                <Row label="Per the ledger" value={formatAmount(position.ledgerBalance)} />
                <div className="border-t border-[var(--color-line)] pt-2">
                  <Row
                    label="On the statement, unexplained"
                    value={String(position.unmatchedStatementCount)}
                  />
                  <Row
                    label="In the ledger, unpresented"
                    value={String(position.unmatchedLedgerCount)}
                  />
                </div>
              </dl>
              <p className="mt-3 border-t border-[var(--color-line)] pt-2 text-[11px] text-[var(--color-muted)]">
                Drawn as at today. A reconciliation fixes these figures at a date and keeps them,
                so a journal posted later cannot rewrite a sign-off into agreement.
              </p>
            </Panel>

            <Panel title="The account">
              <dl className="space-y-2 text-[13px]">
                <Row label="Bank" value={account.bankName} />
                <Row label="Number" value={account.accountNo ?? "—"} />
                <Row label="Label" value={account.accountLabel ?? "—"} />
                <Row label="SWIFT" value={account.swiftCode ?? "—"} />
                <Row label="Currency" value={account.currency} />
                <Row
                  label="Last statement to"
                  value={account.lastStatementTo ? formatDate(account.lastStatementTo) : "—"}
                />
              </dl>
              {account.notes && (
                <p className="mt-2 border-t border-[var(--color-line)] pt-2 text-[12px] text-[var(--color-muted)]">
                  {account.notes}
                </p>
              )}
            </Panel>

            <Panel title="Reconcile">
              <ReconciliationControls
                bankAccountId={id}
                canReconcile={principal.capabilities.has("accounting.bank.reconcile")}
                openId={open?.id ?? null}
                openAsAt={open?.asAt ?? null}
                defaultAsAt={account.lastStatementTo ?? asAt}
                hasStatements={statements.length > 0}
              />
            </Panel>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="numeric">{value}</dd>
    </div>
  );
}
