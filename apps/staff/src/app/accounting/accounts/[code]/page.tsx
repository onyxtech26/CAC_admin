import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import { accountLedger, formatAmount, formatDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Badge, DataTable, EmptyState, Panel, StatTile, Td, TotalRow } from "@/components/ui";

/**
 * One account's ledger.
 *
 * The running balance is in the account's own normal direction, so a bank
 * account reads positive when there is money in it and revenue reads positive
 * when it has been earned. Signing everything debit-minus-credit is simpler
 * arithmetic and makes half the chart look negative, which is how people
 * conclude the software is broken.
 */
export default async function AccountLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const principal = await requireCapability("accounting.journal.view");
  const { code } = await params;
  const query = await searchParams;
  const db = await getDb();

  const ledger = await accountLedger(db, decodeURIComponent(code), {
    from: query.from ?? null,
    to: query.to,
  });
  if (!ledger) notFound();

  const totalDebit = ledger.entries.reduce((sum, entry) => sum + entry.debit, 0n);
  const totalCredit = ledger.entries.reduce((sum, entry) => sum + entry.credit, 0n);

  return (
    <Shell
      principal={principal}
      title={`${ledger.code} ${ledger.name}`}
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Chart of accounts", href: "/accounting/accounts" },
        { label: ledger.code },
      ]}
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Type" value={ledger.type.toLowerCase()} hint={`${ledger.normalSide}-normal`} />
          <StatTile
            label="Opening"
            value={formatAmount(ledger.openingBalance, { accounting: true })}
            hint={ledger.from ? `at ${formatDate(ledger.from)}` : "from the beginning"}
          />
          <StatTile label="Entries" value={String(ledger.entries.length)} hint={`to ${formatDate(ledger.to)}`} />
          <StatTile
            label="Closing"
            value={formatAmount(ledger.closingBalance, { accounting: true })}
            hint={`${ledger.normalSide} balance`}
          />
        </div>

        <Panel
          title="Movements"
          description="Posted entries only. Drafts are not part of the ledger until they are posted."
        >
          {ledger.entries.length === 0 ? (
            <EmptyState
              title="Nothing posted to this account"
              body="It will appear here as soon as a journal that uses it is posted."
            />
          ) : (
            <DataTable
              columns={["Date", "Journal", "Source", "Narrative", "Debit", "Credit", "Balance"]}
              caption={`Ledger for ${ledger.code}`}
            >
              {ledger.entries.map((entry, index) => (
                <tr key={`${entry.journalId}-${index}`}>
                  <Td>{formatDate(entry.entryDate)}</Td>
                  <Td>
                    <Link
                      href={`/accounting/journals/${entry.journalId}`}
                      className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                    >
                      {entry.journalNo}
                    </Link>
                    {entry.status === "reversed" && (
                      <Badge tone="warn">
                        <span className="text-[10px]">reversed</span>
                      </Badge>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[11px] text-[var(--color-muted)]">{entry.sourceType}</span>
                  </Td>
                  <Td>
                    {entry.description ?? entry.memo ?? (
                      <span className="text-[var(--color-faint)]">—</span>
                    )}
                  </Td>
                  <Td numeric>{formatAmount(entry.debit, { zeroAs: "—" })}</Td>
                  <Td numeric>{formatAmount(entry.credit, { zeroAs: "—" })}</Td>
                  <Td numeric>{formatAmount(entry.balance, { accounting: true })}</Td>
                </tr>
              ))}
              <TotalRow>
                <Td>Totals</Td>
                <Td>{""}</Td>
                <Td>{""}</Td>
                <Td>{""}</Td>
                <Td numeric>{formatAmount(totalDebit)}</Td>
                <Td numeric>{formatAmount(totalCredit)}</Td>
                <Td numeric>{formatAmount(ledger.closingBalance, { accounting: true })}</Td>
              </TotalRow>
            </DataTable>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
