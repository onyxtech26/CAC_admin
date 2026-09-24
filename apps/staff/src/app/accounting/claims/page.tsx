import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, listClaims } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Badge, DataTable, EmptyState, LinkButton, Panel, StatTile, Td } from "@/components/ui";

const TONE = {
  draft: "neutral",
  submitted: "warn",
  approved: "info",
  posted: "info",
  reimbursed: "ok",
  rejected: "danger",
} as const;

const LABEL: Record<string, string> = {
  draft: "Draft",
  submitted: "Awaiting approval",
  approved: "Approved, not yet posted",
  posted: "Owed to the claimant",
  reimbursed: "Reimbursed",
  rejected: "Rejected",
};

/**
 * What staff have spent from their own pockets.
 *
 * Whoever can only see their own claims sees only their own: the list is
 * narrowed by the session rather than by a filter the user could change, because
 * one person's expenses are not another person's business.
 */
export default async function ClaimsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; mine?: string }>;
}) {
  const principal = await requireCapability("accounting.claim.view");
  const query = await searchParams;
  const db = await getDb();

  // Approving or paying claims means seeing everybody's. Without either, a person
  // sees their own and nothing else.
  const seesEveryone =
    principal.capabilities.has("accounting.claim.approve") ||
    principal.capabilities.has("accounting.claim.reimburse");
  const onlyMine = !seesEveryone || query.mine === "1";

  const claims = await listClaims(db, {
    status: (query.status as "draft") || undefined,
    claimantId: onlyMine ? principal.userId : undefined,
    limit: 200,
  });

  const awaiting = claims.filter((claim) => claim.status === "submitted");
  const owed = claims.filter((claim) => claim.status === "posted");

  return (
    <Shell
      principal={principal}
      title="Expense claims"
      breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "Expense claims" }]}
      actions={
        principal.capabilities.has("accounting.claim.create") ? (
          <LinkButton href="/accounting/claims/new" variant="primary">
            New claim
          </LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Awaiting approval"
            value={String(awaiting.length)}
            hint={
              awaiting.length > 0
                ? formatAmount(awaiting.reduce((sum, claim) => sum + claim.total, 0n), {
                    currency: "RM",
                  })
                : "nothing waiting"
            }
            tone={awaiting.length > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Owed to staff"
            value={formatAmount(owed.reduce((sum, claim) => sum + claim.total, 0n))}
            hint={`${owed.length} posted, not yet reimbursed`}
            tone={owed.length > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label={onlyMine ? "Your claims" : "All claims"}
            value={String(claims.length)}
            hint={
              seesEveryone
                ? onlyMine
                  ? "narrowed to you"
                  : "everybody's"
                : "you can see your own claims"
            }
          />
        </div>

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
                {Object.entries(LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            {seesEveryone && (
              <label className="flex items-center gap-2 pb-2 text-[13px]">
                <input type="checkbox" name="mine" value="1" defaultChecked={onlyMine} />
                Only mine
              </label>
            )}
            <button
              type="submit"
              className="rounded-md bg-[var(--color-navy)] px-3 py-2 text-[13px] font-medium text-white"
            >
              Apply
            </button>
            <Link href="/accounting/claims" className="pb-2 text-[12px] text-[var(--color-info)]">
              Clear
            </Link>
          </form>
        </Panel>

        <Panel title={`${claims.length} claim${claims.length === 1 ? "" : "s"}`}>
          {claims.length === 0 ? (
            <EmptyState
              title="Nothing matches"
              body="Change the filter, or claim what you have spent."
              action={
                principal.capabilities.has("accounting.claim.create") ? (
                  <LinkButton href="/accounting/claims/new" variant="primary">
                    New claim
                  </LinkButton>
                ) : undefined
              }
            />
          ) : (
            <DataTable
              columns={["Number", "Date", "Claimant", "What for", "Amount", "Status"]}
              caption="Expense claims"
            >
              {claims.map((claim) => (
                <tr key={claim.id}>
                  <Td>
                    <Link
                      href={`/accounting/claims/${claim.id}`}
                      className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                    >
                      {claim.claimNo ?? "draft"}
                    </Link>
                  </Td>
                  <Td>{formatDate(claim.claimDate)}</Td>
                  <Td>
                    {claim.claimantName}
                    {claim.claimantId === principal.userId && (
                      <span className="ml-1 text-[11px] text-[var(--color-muted)]">(you)</span>
                    )}
                  </Td>
                  <Td>{claim.subject ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                  <Td numeric>{formatAmount(claim.total)}</Td>
                  <Td>
                    <Badge tone={TONE[claim.status]}>{LABEL[claim.status]}</Badge>
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
