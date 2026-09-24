import { getDb } from "@cac/db";
import { listBankAccounts, listPostableAccounts } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { EmptyState, LinkButton, Panel } from "@/components/ui";
import { BankAccountForm } from "../BankAccountForm";

/**
 * Attach a real bank account to a ledger account.
 *
 * Only ledger accounts that could hold money, and only those not already spoken
 * for: one ledger account holds one real account, or its balance could never be
 * reconciled against anything.
 */
export default async function NewBankAccountPage() {
  const principal = await requireCapability("accounting.bank.manage");
  const db = await getDb();

  const [accounts, existing] = await Promise.all([
    listPostableAccounts(db),
    listBankAccounts(db, { includeInactive: true }),
  ]);

  const taken = new Set(existing.map((account) => account.accountId));
  const available = accounts.filter(
    (account) =>
      (account.subtype === "bank" || account.subtype === "cash") && !taken.has(account.id),
  );

  return (
    <Shell
      principal={principal}
      title="Add a bank account"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Bank", href: "/accounting/bank" },
        { label: "New" },
      ]}
    >
      {available.length === 0 ? (
        <EmptyState
          title="Every bank and cash account is already attached"
          body="Add a bank or cash account to the chart of accounts first, and it will appear here."
          action={
            <LinkButton href="/accounting/accounts" variant="primary">
              Chart of accounts
            </LinkButton>
          }
        />
      ) : (
        <Panel title="Which account">
          <BankAccountForm
            accounts={available.map((account) => ({
              id: account.id,
              code: account.code,
              name: account.name,
            }))}
          />
        </Panel>
      )}
    </Shell>
  );
}
