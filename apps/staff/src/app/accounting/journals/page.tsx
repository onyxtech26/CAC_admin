import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, listJournals, listPeriods } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Badge, DataTable, EmptyState, LinkButton, Panel, Td } from "@/components/ui";

const STATUS_TONE = {
  draft: "warn",
  posted: "ok",
  reversed: "neutral",
} as const;

/**
 * Every journal, newest first.
 *
 * Filters are plain query parameters on a GET form: they survive a refresh, can
 * be bookmarked and shared, and work without JavaScript. A client-side filter
 * would lose all three.
 */
export default async function JournalsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; period?: string; q?: string }>;
}) {
  const principal = await requireCapability("accounting.journal.view");
  const query = await searchParams;
  const db = await getDb();

  const status =
    query.status === "draft" || query.status === "posted" || query.status === "reversed"
      ? query.status
      : undefined;

  const [journals, periods] = await Promise.all([
    listJournals(db, { status, periodId: query.period || undefined, search: query.q, limit: 200 }),
    listPeriods(db),
  ]);

  return (
    <Shell
      principal={principal}
      title="Journals"
      breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "Journals" }]}
      actions={
        principal.capabilities.has("accounting.journal.create") ? (
          <LinkButton href="/accounting/journals/new" variant="primary">
            New journal
          </LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <Panel title="Filter">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="status" className="block text-[12px] font-medium">
                Status
              </label>
              <select
                id="status"
                name="status"
                defaultValue={query.status ?? ""}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              >
                <option value="">All</option>
                <option value="draft">Draft</option>
                <option value="posted">Posted</option>
                <option value="reversed">Reversed</option>
              </select>
            </div>
            <div>
              <label htmlFor="period" className="block text-[12px] font-medium">
                Period
              </label>
              <select
                id="period"
                name="period"
                defaultValue={query.period ?? ""}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              >
                <option value="">All</option>
                {periods.map((period) => (
                  <option key={period.id} value={period.id}>
                    {period.code} — {period.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="q" className="block text-[12px] font-medium">
                Number or memo
              </label>
              <input
                id="q"
                name="q"
                defaultValue={query.q ?? ""}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              />
            </div>
            <button
              type="submit"
              className="rounded-md bg-[var(--color-navy)] px-3 py-2 text-[13px] font-medium text-white"
            >
              Apply
            </button>
            <Link href="/accounting/journals" className="pb-2 text-[12px] text-[var(--color-info)]">
              Clear
            </Link>
          </form>
        </Panel>

        <Panel
          title={`${journals.length} journal${journals.length === 1 ? "" : "s"}`}
          description="A draft has no number and is not in the ledger. A posted journal is numbered and immutable."
        >
          {journals.length === 0 ? (
            <EmptyState
              title="No journals match"
              body="Change the filter, or prepare a new journal."
            />
          ) : (
            <DataTable
              columns={["Number", "Date", "Period", "Memo", "Source", "Amount", "Status", "By"]}
              caption="Journals"
            >
              {journals.map((journal) => (
                <tr key={journal.id}>
                  <Td>
                    <Link
                      href={`/accounting/journals/${journal.id}`}
                      className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                    >
                      {journal.journalNo ?? "draft"}
                    </Link>
                  </Td>
                  <Td>{formatDate(journal.entryDate)}</Td>
                  <Td>
                    <span className="font-mono text-[11px] text-[var(--color-muted)]">
                      {journal.periodCode}
                    </span>
                  </Td>
                  <Td>{journal.memo ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                  <Td>
                    <span className="text-[11px] text-[var(--color-muted)]">{journal.sourceType}</span>
                  </Td>
                  <Td numeric>{formatAmount(journal.total)}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[journal.status]}>{journal.status}</Badge>
                  </Td>
                  <Td>
                    <span className="text-[11px]">
                      {journal.postedByName ?? journal.createdByName}
                    </span>
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
