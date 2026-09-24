import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, listQuotations, today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Badge, DataTable, EmptyState, LinkButton, Panel, Td } from "@/components/ui";

const TONE = {
  draft: "neutral",
  sent: "info",
  accepted: "ok",
  declined: "danger",
  expired: "warn",
  converted: "ok",
} as const;

/**
 * Quotations.
 *
 * An offer, not a transaction: nothing here touches the ledger. The lifecycle
 * exists so that what was quoted stays readable after the invoice has moved on.
 */
export default async function QuotationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const principal = await requireCapability("accounting.quotation.view");
  const query = await searchParams;
  const db = await getDb();

  const quotations = await listQuotations(db, {
    status: (query.status as "draft") || undefined,
    search: query.q,
    limit: 200,
  });

  const asOf = toIsoDate(today());

  return (
    <Shell
      principal={principal}
      title="Quotations"
      breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "Quotations" }]}
      actions={
        principal.capabilities.has("accounting.quotation.create") ? (
          <LinkButton href="/accounting/quotations/new" variant="primary">
            New quotation
          </LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <Panel title="Filter">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="status" className="block text-[12px] font-medium">Status</label>
              <select
                id="status"
                name="status"
                defaultValue={query.status ?? ""}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              >
                <option value="">All</option>
                {["draft", "sent", "accepted", "declined", "expired", "converted"].map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="q" className="block text-[12px] font-medium">Number, subject or customer</label>
              <input
                id="q"
                name="q"
                defaultValue={query.q ?? ""}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              />
            </div>
            <button type="submit" className="rounded-md bg-[var(--color-navy)] px-3 py-2 text-[13px] font-medium text-white">
              Apply
            </button>
            <Link href="/accounting/quotations" className="pb-2 text-[12px] text-[var(--color-info)]">Clear</Link>
          </form>
        </Panel>

        <Panel title={`${quotations.length} quotation${quotations.length === 1 ? "" : "s"}`}>
          {quotations.length === 0 ? (
            <EmptyState
              title="No quotations yet"
              body="A quotation becomes an invoice once the client accepts it, carrying its lines across."
            />
          ) : (
            <DataTable
              columns={["Number", "Date", "Customer", "Subject", "Valid until", "Total", "Status"]}
              caption="Quotations"
            >
              {quotations.map((quotation) => {
                const lapsed =
                  quotation.status === "sent" && quotation.validUntil !== null && quotation.validUntil < asOf;
                return (
                  <tr key={quotation.id}>
                    <Td>
                      <Link
                        href={`/accounting/quotations/${quotation.id}`}
                        className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                      >
                        {quotation.quotationNo ?? "draft"}
                      </Link>
                    </Td>
                    <Td>{formatDate(quotation.quotationDate)}</Td>
                    <Td>{quotation.customerName}</Td>
                    <Td>{quotation.subject ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                    <Td>
                      {quotation.validUntil ? formatDate(quotation.validUntil) : "—"}
                      {lapsed && (
                        <span className="ml-1 text-[11px] text-[var(--color-warn)]">lapsed</span>
                      )}
                    </Td>
                    <Td numeric>{formatAmount(quotation.total)}</Td>
                    <Td><Badge tone={TONE[quotation.status]}>{quotation.status}</Badge></Td>
                  </tr>
                );
              })}
            </DataTable>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
