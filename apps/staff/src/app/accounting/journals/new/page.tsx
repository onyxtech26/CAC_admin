import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import { findPeriodForDate, listPostableAccounts, today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, EmptyState, LinkButton, Panel } from "@/components/ui";
import { JournalForm } from "../JournalForm";

/**
 * Prepare a manual journal.
 *
 * Manual journals are the exception, not the rule: accruals, corrections,
 * depreciation, opening balances. Everything routine should arrive from a
 * document. That is why this screen is plain and the entry date defaults to
 * today rather than to the last date used.
 */
export default async function NewJournalPage() {
  const principal = await requireCapability("accounting.journal.create");
  const db = await getDb();

  const [accounts, centres] = await Promise.all([
    listPostableAccounts(db),
    db.execute<{ id: string; code: string; name: string }>(
      sql`SELECT id, code, name FROM org.cost_centre WHERE is_active ORDER BY code`,
    ),
  ]);

  const entryDate = toIsoDate(today());
  const period = await findPeriodForDate(db, entryDate);

  return (
    <Shell
      principal={principal}
      title="New journal"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Journals", href: "/accounting/journals" },
        { label: "New" },
      ]}
    >
      <div className="space-y-4">
        {!period && (
          <Alert tone="warn">
            No accounting period covers today. Set up the fiscal year that contains it, or date the
            entry within a period that exists.
          </Alert>
        )}
        {period && period.status !== "open" && (
          <Alert tone="warn">
            Period {period.code} is {period.status}. Choose a date in an open period, or ask for the
            period to be unlocked.
          </Alert>
        )}

        {accounts.length === 0 ? (
          <EmptyState
            title="There are no postable accounts"
            body="The chart of accounts has no accounts that entries can be made to."
            action={<LinkButton href="/accounting/accounts">Chart of accounts</LinkButton>}
          />
        ) : (
          <Panel
            title="Journal lines"
            description="Every line takes a debit or a credit, and the two sides must agree exactly before the entry can be posted."
          >
            <JournalForm
              accounts={accounts.map((account) => ({
                id: account.id,
                code: account.code,
                name: account.name,
                type: account.type,
              }))}
              costCentres={centres.rows ?? []}
              defaultEntryDate={entryDate}
              periodHint={period ? `Falls in period ${period.code} (${period.status}).` : undefined}
            />
          </Panel>
        )}
      </div>
    </Shell>
  );
}
