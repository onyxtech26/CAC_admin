import { notFound, redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import { amountToSql, getJournal, listPostableAccounts } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Panel } from "@/components/ui";
import { JournalForm } from "../../JournalForm";

/**
 * Edit a draft.
 *
 * Only a draft. A posted journal is redirected back to its detail page rather
 * than shown an editable form it would be refused on submit — offering an action
 * that cannot succeed is worse than not offering it.
 */
export default async function EditJournalPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.journal.create");
  const { id } = await params;
  const db = await getDb();

  const journal = await getJournal(db, id);
  if (!journal) notFound();
  if (journal.status !== "draft") redirect(`/accounting/journals/${id}`);

  const mayEdit =
    journal.createdBy === principal.userId ||
    principal.capabilities.has("accounting.journal.post");
  if (!mayEdit) redirect(`/accounting/journals/${id}`);

  const [accounts, centres] = await Promise.all([
    listPostableAccounts(db),
    db.execute<{ id: string; code: string; name: string }>(
      sql`SELECT id, code, name FROM org.cost_centre WHERE is_active ORDER BY code`,
    ),
  ]);

  return (
    <Shell
      principal={principal}
      title="Edit draft"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Journals", href: "/accounting/journals" },
        { label: "Draft", href: `/accounting/journals/${id}` },
        { label: "Edit" },
      ]}
    >
      <Panel
        title="Journal lines"
        description="Saving replaces the draft's lines entirely, so what you see here is exactly what will be stored."
      >
        <JournalForm
          journalId={journal.id}
          accounts={accounts.map((account) => ({
            id: account.id,
            code: account.code,
            name: account.name,
            type: account.type,
          }))}
          costCentres={centres.rows ?? []}
          defaultEntryDate={journal.entryDate}
          defaultMemo={journal.memo ?? undefined}
          defaultLines={journal.lines.map((line) => ({
            accountId: line.accountId,
            // Rendered at four decimal places, the precision actually stored:
            // showing 2 here and posting it back would silently round the value.
            debit: line.debit === 0n ? "" : amountToSql(line.debit),
            credit: line.credit === 0n ? "" : amountToSql(line.credit),
            description: line.description ?? "",
            costCentreId: line.costCentreId ?? "",
          }))}
          periodHint={`Currently in period ${journal.periodCode} (${journal.periodStatus}).`}
        />
      </Panel>
    </Shell>
  );
}
