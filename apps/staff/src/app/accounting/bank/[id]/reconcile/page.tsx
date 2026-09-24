import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@cac/db";
import {
  formatAmount,
  formatDate,
  getBankAccount,
  getReconciliation,
  listPostableAccounts,
  listReconciliations,
  listStatementLines,
  listUnexplainedLedgerLines,
  suggestMatches,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, DataTable, Panel, Td } from "@/components/ui";
import { CompleteReconciliation, StatementLineRow } from "./MatchingWorkspace";

/**
 * The workspace where a reconciliation is actually done.
 *
 * Statement lines on the left with what they might be, ledger entries nothing
 * explains on the right, and the two balances above. Candidates are computed per
 * unmatched line, which is a query each — acceptable because a month's statement
 * is tens of lines, and the alternative (one clever query for everything) would
 * be far harder to be sure was right about direction.
 */
export default async function ReconcilePage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.bank.match");
  const { id } = await params;
  const db = await getDb();

  const account = await getBankAccount(db, id);
  if (!account) notFound();

  const open = (await listReconciliations(db, { bankAccountId: id, status: "draft", limit: 1 }))[0];
  if (!open) redirect(`/accounting/bank/${id}`);

  const view = await getReconciliation(db, open.id);
  if (!view) redirect(`/accounting/bank/${id}`);

  const [lines, unexplained, accounts] = await Promise.all([
    listStatementLines(db, { bankAccountId: id, upTo: view.asAt, limit: 1000 }),
    listUnexplainedLedgerLines(db, id, view.asAt),
    listPostableAccounts(db),
  ]);

  // Candidates only for the lines that still need a decision.
  const needing = lines.filter((line) => line.status === "unmatched");
  const candidates = new Map(
    await Promise.all(
      needing.map(
        async (line) => [line.id, await suggestMatches(db, line.id)] as const,
      ),
    ),
  );

  const postable = accounts
    .filter((account) => account.id !== undefined)
    .map((account) => ({ id: account.id, code: account.code, name: account.name }));

  const outstanding = needing.length;

  return (
    <Shell
      principal={principal}
      title={`Reconciling ${account.accountCode} to ${formatDate(view.asAt)}`}
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Bank", href: "/accounting/bank" },
        { label: account.bankName, href: `/accounting/bank/${id}` },
        { label: "Reconcile" },
      ]}
    >
      <div className="space-y-4">
        <Panel title="Where the two records stand">
          <div className="grid gap-4 text-[13px] sm:grid-cols-2">
            <dl className="space-y-1">
              <Line label="Balance per the bank" value={formatAmount(view.statementBalance)} />
              <Line
                label="add: in the ledger, not yet on the statement"
                value={formatAmount(view.unmatchedLedger)}
              />
              <div className="border-t border-[var(--color-line)] pt-1">
                <Line
                  label="Adjusted"
                  value={formatAmount(view.statementBalance + view.unmatchedLedger)}
                  strong
                />
              </div>
            </dl>
            <dl className="space-y-1">
              <Line label="Balance per the ledger" value={formatAmount(view.ledgerBalance)} />
              <Line
                label="add: on the statement, not yet in the ledger"
                value={formatAmount(view.unmatchedStatement)}
              />
              <div className="border-t border-[var(--color-line)] pt-1">
                <Line
                  label="Adjusted"
                  value={formatAmount(view.ledgerBalance + view.unmatchedStatement)}
                  strong
                />
              </div>
            </dl>
          </div>

          <div className="mt-3 border-t border-[var(--color-line)] pt-3">
            {view.difference === 0n ? (
              <p className="text-[13px] font-medium text-[var(--color-ok)]">
                The two sides agree.
                {outstanding > 0 && (
                  <span className="font-normal text-[var(--color-body)]">
                    {" "}
                    {outstanding} statement line{outstanding === 1 ? "" : "s"} still need
                    {outstanding === 1 ? "s" : ""} accounting for before this can be signed off —
                    the arithmetic agreeing is not the same as somebody having looked.
                  </span>
                )}
              </p>
            ) : (
              <Alert tone="danger">
                Out by {formatAmount(view.difference, { currency: "RM" })}. The two records do not
                start from the same balance: either the opening position was never recorded in the
                ledger, or a statement is missing between this one and the last.
              </Alert>
            )}
          </div>
        </Panel>

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            <Panel
              title="What the bank reported"
              description="Match each line to the ledger entry that is the same movement of money, post it if the ledger has never heard of it, or set it aside with a reason."
            >
              {lines.length === 0 ? (
                <p className="text-[13px] text-[var(--color-muted)]">
                  No statement lines up to {formatDate(view.asAt)}.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--color-line)]">
                  {lines.map((line) => (
                    <StatementLineRow
                      key={line.id}
                      bankAccountId={id}
                      line={{
                        id: line.id,
                        lineNo: line.lineNo,
                        txnDate: line.txnDate,
                        description: line.description,
                        reference: line.reference,
                        paidIn: formatAmount(line.paidIn, { zeroAs: "—" }),
                        paidOut: formatAmount(line.paidOut, { zeroAs: "—" }),
                        status: line.status,
                        ignoreReason: line.ignoreReason,
                        journalNo: line.journalNo,
                        journalId: line.journalId,
                        matchMethod: line.matchMethod,
                        matchedByName: line.matchedByName,
                      }}
                      candidates={(candidates.get(line.id) ?? []).map((candidate) => ({
                        journalLineId: candidate.journalLineId,
                        journalNo: candidate.journalNo,
                        entryDate: candidate.entryDate,
                        memo: candidate.memo ?? candidate.lineDescription ?? "",
                        amount: formatAmount(
                          candidate.debit > 0n ? candidate.debit : candidate.credit,
                        ),
                        reasons: candidate.reasons,
                        sourceType: candidate.sourceType,
                      }))}
                      accounts={postable}
                    />
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel
              title="In the ledger, not on the statement"
              description="Unpresented cheques and deposits in transit. Normal, and they do not stop a reconciliation — they are carried as outstanding."
            >
              {unexplained.length === 0 ? (
                <p className="text-[13px] text-[var(--color-muted)]">
                  Nothing outstanding. Every ledger entry on this account has appeared on a
                  statement.
                </p>
              ) : (
                <DataTable columns={["Journal", "Date", "Out", "In"]} caption="Outstanding items">
                  {unexplained.map((row) => (
                    <tr key={row.journalLineId}>
                      <Td>
                        <Link
                          href={`/accounting/journals/${row.journalId}`}
                          className="font-mono text-[11px] text-[var(--color-info)] hover:underline"
                        >
                          {row.journalNo ?? "—"}
                        </Link>
                        <span className="block text-[11px] text-[var(--color-muted)]">
                          {row.memo ?? row.description ?? ""}
                        </span>
                      </Td>
                      <Td>{formatDate(row.entryDate)}</Td>
                      <Td numeric>{formatAmount(row.credit, { zeroAs: "—" })}</Td>
                      <Td numeric>{formatAmount(row.debit, { zeroAs: "—" })}</Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>

            <Panel title="Sign it off">
              <CompleteReconciliation
                bankAccountId={id}
                reconciliationId={view.id}
                canReconcile={principal.capabilities.has("accounting.bank.reconcile")}
                balanced={view.difference === 0n}
                outstanding={outstanding}
                ignored={view.ignoredCount}
                asAt={view.asAt}
              />
            </Panel>

            <Panel title="What signing off means">
              <ul className="space-y-2 text-[12px] text-[var(--color-muted)]">
                <li>
                  The figures above are stored as they are now. A journal posted later with a date
                  inside this period will not change them.
                </li>
                <li>
                  The matches become permanent: they cannot be undone afterwards, and the
                  statements they rest on cannot be deleted.
                </li>
                <li>
                  If it later turns out to have been wrong, the answer is a new reconciliation at a
                  later date. This one stays on the record having been signed.
                </li>
              </ul>
            </Panel>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? "font-medium" : "text-[var(--color-muted)]"}>{label}</dt>
      <dd className={`numeric ${strong ? "font-semibold" : ""}`}>{value}</dd>
    </div>
  );
}
