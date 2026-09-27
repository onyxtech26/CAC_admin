import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, listAccounts, trialBalance } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Badge, DataTable, Panel, StatTile, Td } from "@/components/ui";
import { AccountToggle, NewAccountForm } from "./AccountForms";

/**
 * The chart of accounts.
 *
 * Presented as the tree it is, indented by depth, rather than sorted purely by
 * code — the structure is what the reports follow, and a flat list of numbers
 * hides which heading an account rolls up into.
 *
 * Each account shows its current balance, so the chart doubles as a summary of
 * where the money is. Clicking one opens its ledger.
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ inactive?: string }>;
}) {
  const principal = await requireCapability("accounting.coa.view");
  const params = await searchParams;
  const includeInactive = params.inactive === "1";
  const db = await getDb();

  const [accounts, tb] = await Promise.all([
    listAccounts(db, { includeInactive }),
    trialBalance(db, { includeZero: true }),
  ]);

  const balances = new Map(tb.rows.map((row) => [row.accountId, row]));
  const canManage = principal.capabilities.has("accounting.coa.manage");
  const headings = accounts
    .filter((account) => !account.isPostable)
    .map((account) => ({ code: account.code, name: account.name, type: account.type }));

  const byType = new Map<string, number>();
  for (const account of accounts) {
    if (account.isPostable) byType.set(account.type, (byType.get(account.type) ?? 0) + 1);
  }

  return (
    <Shell
      principal={principal}
      title="Chart of accounts"
      breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "Chart of accounts" }]}
      actions={
        <Link
          href={includeInactive ? "/accounting/accounts" : "/accounting/accounts?inactive=1"}
          className="text-[12px] text-[var(--color-link)] hover:underline"
        >
          {includeInactive ? "Hide retired accounts" : "Show retired accounts"}
        </Link>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const).map((type) => (
            <StatTile
              key={type}
              label={type.toLowerCase()}
              value={String(byType.get(type) ?? 0)}
              hint="postable accounts"
            />
          ))}
        </div>

        <Panel
          title={`${accounts.length} accounts`}
          description="Headings group; postable accounts carry the entries. A heading cannot be posted to, which is what keeps the trial balance adding up."
        >
          <DataTable
            columns={["Code", "Account", "Type", "Side", "Balance", "Entries", ""]}
            caption="Chart of accounts"
          >
            {accounts.map((account) => {
              const balance = balances.get(account.id);
              const net = balance ? balance.balanceDebit - balance.balanceCredit : 0n;
              const natural = account.normalSide === "debit" ? net : -net;

              return (
                <tr key={account.id} className={account.isPostable ? "" : "bg-[var(--color-canvas)]"}>
                  <Td>
                    <span
                      className="font-mono text-[12px]"
                      style={{ paddingLeft: `${account.depth * 14}px` }}
                    >
                      {account.code}
                    </span>
                  </Td>
                  <Td>
                    {account.isPostable ? (
                      <Link
                        href={`/accounting/accounts/${account.code}`}
                        className="text-[var(--color-link)] hover:underline"
                      >
                        {account.name}
                      </Link>
                    ) : (
                      <span className="font-semibold">{account.name}</span>
                    )}
                    <span className="ml-2 inline-flex gap-1">
                      {account.isSystem && <Badge tone="info">system</Badge>}
                      {account.isContra && <Badge tone="neutral">contra</Badge>}
                      {!account.isActive && <Badge tone="warn">retired</Badge>}
                    </span>
                    {account.description && (
                      <p className="mt-0.5 max-w-xl text-[11px] text-[var(--color-muted)]">
                        {account.description}
                      </p>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
                      {account.type.toLowerCase()}
                    </span>
                  </Td>
                  <Td>{account.normalSide}</Td>
                  <Td numeric>
                    {account.isPostable ? (
                      formatAmount(natural, { zeroAs: "—", accounting: true })
                    ) : (
                      <span className="text-[var(--color-faint)]" />
                    )}
                  </Td>
                  <Td numeric>
                    {account.postings === 0 ? (
                      <span className="text-[var(--color-faint)]">—</span>
                    ) : (
                      account.postings
                    )}
                  </Td>
                  <Td>
                    {canManage && !account.isSystem ? (
                      <AccountToggle
                        accountId={account.id}
                        isActive={account.isActive}
                        code={account.code}
                        name={account.name}
                      />
                    ) : (
                      <span className="text-[var(--color-faint)]">—</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </DataTable>
        </Panel>

        {canManage && (
          <Panel
            title="Add an account"
            description="Type, side and parent are fixed once an account exists: changing them would restate reports that have already been produced. A wrongly-typed account is retired and replaced."
          >
            <NewAccountForm headings={headings} />
          </Panel>
        )}
      </div>
    </Shell>
  );
}
