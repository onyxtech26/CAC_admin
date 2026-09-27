import Link from "next/link";
import { getDb } from "@cac/db";
import {
  formatAmount,
  formatDate,
  listSupplierInvoices,
  listSuppliers,
  payablesAging,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
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

const STATUS_TONE = {
  draft: "neutral",
  pending_approval: "warn",
  approved: "info",
  posted: "ok",
  settled: "ok",
  void: "danger",
} as const;

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  pending_approval: "Awaiting approval",
  approved: "Approved",
  posted: "Posted",
  settled: "Settled",
  void: "Void",
};

/**
 * Supplier bills — the A/P mirror of the invoices screen.
 *
 * The top answers what the person opening it actually wants to know: how much CAC owes, how much
 * of it is late, how much has been paid without anybody saying which bill it was for, and what is
 * waiting on them.
 *
 * The supplier's own document number is a column of its own, next to CAC's reference, because
 * that is the number a supplier quotes on the telephone.
 */
export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    supplierId?: string;
    q?: string;
    outstanding?: string;
  }>;
}) {
  const principal = await requireCapability("accounting.bill.view");
  const query = await searchParams;
  const db = await getDb();

  const [bills, suppliers, aging] = await Promise.all([
    listSupplierInvoices(db, {
      status: (query.status as "draft") || undefined,
      supplierId: query.supplierId || undefined,
      search: query.q,
      onlyOutstanding: query.outstanding === "1",
      limit: 200,
    }),
    listSuppliers(db),
    payablesAging(db),
  ]);

  const awaitingApproval = bills.filter((bill) => bill.status === "pending_approval").length;
  const overdue = aging.totals.total - aging.totals.current;

  return (
    <Shell
      principal={principal}
      title="Supplier bills"
      breadcrumbs={[{ label: "Purchases & payables" }, { label: "Bills" }]}
      actions={
        principal.capabilities.has("accounting.bill.create") ? (
          <LinkButton href="/accounting/bills/new" variant="primary">
            Enter a bill
          </LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {aging.difference !== null && aging.difference !== 0n && (
          <Alert tone="danger">
            Payables do not reconcile: the bills outstanding, net of credits and unmatched payments,
            come to {formatAmount(aging.totals.netOwing, { currency: "RM" })} but the trade payables
            control account holds{" "}
            {formatAmount(aging.controlAccountBalance ?? 0n, { currency: "RM" })}. Something has
            reached account 2110 without going through a bill or a payment.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Owed"
            value={formatAmount(aging.totals.total)}
            hint={`to ${aging.rows.length} supplier${aging.rows.length === 1 ? "" : "s"}`}
          />
          <StatTile
            label="Overdue"
            value={formatAmount(overdue)}
            hint={overdue > 0n ? "past the due date" : "nothing late"}
            tone={overdue > 0n ? "warn" : "neutral"}
          />
          <StatTile
            label="Paid, unmatched"
            value={formatAmount(aging.totals.paymentsOnAccount)}
            hint="money out, no bill named"
            tone={aging.totals.paymentsOnAccount > 0n ? "warn" : "neutral"}
          />
          <StatTile
            label="Awaiting approval"
            value={String(awaitingApproval)}
            hint={awaitingApproval > 0 ? "someone has to look at these" : "nothing waiting"}
            tone={awaitingApproval > 0 ? "warn" : "neutral"}
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
                className="control mt-1 w-auto"
              >
                <option value="">All</option>
                {Object.entries(STATUS_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="supplierId" className="block text-[12px] font-medium">
                Supplier
              </label>
              <select
                id="supplierId"
                name="supplierId"
                defaultValue={query.supplierId ?? ""}
                className="control mt-1 w-auto"
              >
                <option value="">All</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grow">
              <label htmlFor="q" className="block text-[12px] font-medium">
                Our reference, their reference, or supplier
              </label>
              <input
                id="q"
                name="q"
                type="search"
                defaultValue={query.q ?? ""}
                className="control mt-1"
              />
            </div>

            <label className="flex items-center gap-2 pb-2 text-[13px]">
              <input
                type="checkbox"
                name="outstanding"
                value="1"
                defaultChecked={query.outstanding === "1"}
              />
              Only what is still owed
            </label>

            <button type="submit" className="btn btn-primary px-3 py-2 text-[13px]">
              Apply
            </button>
            <Link
              href="/accounting/bills"
              className="pb-2 text-[13px] text-[var(--color-link)] hover:underline"
            >
              Clear
            </Link>
          </form>
        </Panel>

        {bills.length === 0 ? (
          <EmptyState
            title="Nothing matches"
            body="Change the filter, or enter a bill a supplier has sent."
            action={
              principal.capabilities.has("accounting.bill.create") ? (
                <LinkButton href="/accounting/bills/new" variant="primary">
                  Enter a bill
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <Panel title={`${bills.length} bill${bills.length === 1 ? "" : "s"}`}>
            <DataTable
              columns={[
                "Our ref",
                "Their ref",
                "Supplier",
                "Dated",
                "Due",
                "Status",
                "Total",
                "Outstanding",
              ]}
              caption="Supplier bills"
            >
              {bills.map((bill) => (
                <tr key={bill.id}>
                  <Td>
                    <Link
                      href={`/accounting/bills/${bill.id}`}
                      className="text-[var(--color-link)] hover:underline"
                    >
                      {bill.billNo ?? "draft"}
                    </Link>
                    {bill.kind === "credit_note" && (
                      <span className="ml-1.5 text-[10px] text-[var(--color-muted)]">credit</span>
                    )}
                  </Td>
                  <Td>
                    <span className="font-mono text-[12px]">{bill.supplierDocNo}</span>
                  </Td>
                  <Td>{bill.supplierName}</Td>
                  <Td>{formatDate(bill.billDate)}</Td>
                  <Td>
                    {formatDate(bill.dueDate)}
                    {bill.overdueDays > 0 && (
                      <span className="ml-1.5 text-[11px] text-[var(--color-warn)]">
                        {bill.overdueDays}d late
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[bill.status]}>{STATUS_LABEL[bill.status]}</Badge>
                  </Td>
                  <Td numeric>{formatAmount(bill.total)}</Td>
                  <Td numeric>
                    {bill.outstanding === 0n ? "—" : formatAmount(bill.outstanding)}
                  </Td>
                </tr>
              ))}
            </DataTable>
          </Panel>
        )}
      </div>
    </Shell>
  );
}
