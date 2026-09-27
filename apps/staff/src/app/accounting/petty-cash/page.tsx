import Link from "next/link";
import { getDb } from "@cac/db";
import {
  amountToSql,
  formatAmount,
  formatDate,
  listPettyCash,
  pettyCashPosition,
  today,
  toIsoDate,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { purchaseFormOptions } from "@/lib/accounting-options";
import { Shell } from "@/components/Shell";
import {
  Alert,
  Badge,
  DataTable,
  EmptyState,
  LinkButton,
  Panel,
  StatTile,
  Td,
} from "@/components/ui";
import { PettyCashCountForm, PettyCashEntryForm, PettyCashRowActions } from "./PettyCashForms";

const TONE = { draft: "warn", posted: "ok", void: "danger" } as const;

const KIND: Record<string, string> = {
  top_up: "Top-up",
  expense: "Spent",
  adjustment: "Count adjustment",
};

/**
 * The petty cash float.
 *
 * One screen, because the float is one tin: what the ledger says is in it, what
 * has moved, and the count that proves the two agree. Splitting the count onto
 * its own page would make it the thing nobody does.
 */
export default async function PettyCashPage() {
  const principal = await requireCapability("accounting.pettycash.view");
  const db = await getDb();

  const [position, entries, options] = await Promise.all([
    pettyCashPosition(db),
    listPettyCash(db, { limit: 200 }),
    purchaseFormOptions(),
  ]);

  if (!position) {
    return (
      <Shell
        principal={principal}
        title="Petty cash"
        breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "Petty cash" }]}
      >
        <EmptyState
          title="There is no float account"
          body="The chart of accounts has no petty cash account (1255), so there is nothing to keep a float in."
          action={
            <LinkButton href="/accounting/accounts" variant="primary">
              Chart of accounts
            </LinkButton>
          }
        />
      </Shell>
    );
  }

  const canRecord = principal.capabilities.has("accounting.pettycash.create");
  const canApprove = principal.capabilities.has("accounting.pettycash.approve");
  const canCount = principal.capabilities.has("accounting.pettycash.reconcile");

  const unposted = entries.filter((entry) => entry.status === "draft");
  const spentThisMonth = entries
    .filter(
      (entry) =>
        entry.status === "posted" &&
        entry.kind !== "top_up" &&
        entry.txnDate.slice(0, 7) === toIsoDate(today()).slice(0, 7),
    )
    .reduce((sum, entry) => sum + entry.amount, 0n);

  // A top-up cannot come from the float itself, so the tin is not offered as a
  // source of its own money.
  const sources = options.bankAccounts.filter(
    (account) => account.code !== position.floatAccountCode,
  );

  return (
    <Shell
      principal={principal}
      title="Petty cash"
      breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "Petty cash" }]}
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="In the tin, per the ledger"
            value={formatAmount(position.bookBalance)}
            hint={
              position.bookBalance < 0n
                ? "negative — something has been posted the wrong way round"
                : `${position.floatAccountCode} ${position.floatAccountName}`
            }
            tone={position.bookBalance < 0n ? "danger" : "neutral"}
          />
          <StatTile
            label="Not yet posted"
            value={String(position.unpostedCount)}
            hint={
              unposted.length > 0
                ? formatAmount(unposted.reduce((sum, entry) => sum + entry.amount, 0n), {
                    currency: "RM",
                  })
                : "nothing waiting"
            }
            tone={position.unpostedCount > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Last counted"
            value={position.lastCountedOn ? formatDate(position.lastCountedOn) : "never"}
            hint={
              position.lastCountedOn
                ? position.lastDifference === 0n
                  ? "agreed exactly"
                  : `difference ${formatAmount(position.lastDifference ?? 0n)}`
                : "the float has never been counted"
            }
            tone={
              !position.lastCountedOn
                ? "warn"
                : position.lastDifference === 0n
                  ? "ok"
                  : "warn"
            }
          />
        </div>

        {!position.lastCountedOn && (
          <Alert tone="warn">
            This float has never been counted. A float that is never counted is a float nobody can
            say is right.
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            {canRecord && (
              <Panel title="Record a movement">
                <PettyCashEntryForm
                  expenseAccounts={options.accounts}
                  bankAccounts={sources}
                  taxCodes={options.taxCodes}
                  defaultDate={toIsoDate(today())}
                />
              </Panel>
            )}

            <Panel title={`${entries.length} entr${entries.length === 1 ? "y" : "ies"}`}>
              {entries.length === 0 ? (
                <EmptyState
                  title="Nothing has moved yet"
                  body="Top the float up from the bank, and record what is spent out of it."
                />
              ) : (
                <DataTable
                  columns={[
                    "Number",
                    "Date",
                    "What",
                    "Account",
                    "Amount",
                    "Status",
                    canApprove ? "Action" : "",
                  ]}
                  caption="Petty cash entries"
                >
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <Td>
                        <span className="font-mono text-[12px]">{entry.txnNo ?? "—"}</span>
                        {entry.kind !== "expense" && (
                          <span className="ml-1">
                            <Badge tone={entry.kind === "top_up" ? "info" : "warn"}>
                              {KIND[entry.kind]}
                            </Badge>
                          </span>
                        )}
                      </Td>
                      <Td>{formatDate(entry.txnDate)}</Td>
                      <Td>
                        {entry.description}
                        {entry.receiptRef && (
                          <span className="block text-[11px] text-[var(--color-muted)]">
                            receipt {entry.receiptRef}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <Link
                          href={`/accounting/accounts/${entry.counterpartCode}`}
                          className="font-mono text-[11px] text-[var(--color-link)] hover:underline"
                        >
                          {entry.counterpartCode}
                        </Link>
                      </Td>
                      <Td numeric>
                        <span className={entry.kind === "top_up" ? "text-[var(--color-ok)]" : ""}>
                          {entry.kind === "top_up" ? "+" : "−"}
                          {formatAmount(entry.amount)}
                        </span>
                      </Td>
                      <Td>
                        <Badge tone={TONE[entry.status]}>{entry.status}</Badge>
                        {entry.journalNo && (
                          <Link
                            href={`/accounting/journals/${entry.journalId}`}
                            className="ml-1 font-mono text-[11px] text-[var(--color-link)] hover:underline"
                          >
                            {entry.journalNo}
                          </Link>
                        )}
                      </Td>
                      <Td>
                        {canApprove ? (
                          <PettyCashRowActions
                            txnId={entry.id}
                            status={entry.status}
                            canApprove={canApprove}
                          />
                        ) : (
                          ""
                        )}
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel title="Count the tin">
              {canCount ? (
                <PettyCashCountForm
                  bookBalance={amountToSql(position.bookBalance)}
                  defaultDate={toIsoDate(today())}
                  blocked={position.unpostedCount}
                />
              ) : (
                <p className="text-[12px] text-[var(--color-muted)]">
                  Counting the float is reserved to the people who can reconcile it.
                </p>
              )}
            </Panel>

            <Panel title="This month">
              <dl className="space-y-2 text-[13px]">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-[var(--color-muted)]">Spent from the tin</dt>
                  <dd className="numeric">{formatAmount(spentThisMonth)}</dd>
                </div>
              </dl>
              <p className="mt-2 text-[11px] text-[var(--color-muted)]">
                Posted entries only. A draft is somebody&rsquo;s note, not a cost.
              </p>
            </Panel>

            <Panel title="How this works">
              <ul className="space-y-2 text-[12px] text-[var(--color-muted)]">
                <li>
                  A top-up debits {position.floatAccountCode} and credits the bank. The money has
                  moved, not been spent.
                </li>
                <li>
                  An expense debits the cost account and credits {position.floatAccountCode}.
                </li>
                <li>
                  A count that disagrees posts the difference as an expense, dated and attributed.
                  Nothing is quietly adjusted to fit.
                </li>
              </ul>
            </Panel>
          </div>
        </div>
      </div>
    </Shell>
  );
}
