import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, listCustomers } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Badge, DataTable, EmptyState, Panel, Td } from "@/components/ui";
import { CustomerForm } from "./CustomerForm";

/**
 * Customers.
 *
 * The parties invoices will be raised against in phase 3. Nothing here touches
 * the ledger — a customer record is a name and terms, not a balance. Their
 * balance lives in account 1210 and is derived from postings, which is why there
 * is no "amount owed" column on this screen yet: it would be a second place for
 * the truth to live.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; inactive?: string }>;
}) {
  const principal = await requireCapability("accounting.customer.view");
  const query = await searchParams;
  const db = await getDb();

  const customers = await listCustomers(db, {
    search: query.q,
    includeInactive: query.inactive === "1",
  });
  const canManage = principal.capabilities.has("accounting.customer.manage");

  return (
    <Shell
      principal={principal}
      title="Customers"
      breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "Customers" }]}
    >
      <div className="space-y-4">
        <Panel title={`${customers.length} customer${customers.length === 1 ? "" : "s"}`}>
          <form method="get" className="mb-3 flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="q" className="block text-[12px] font-medium">
                Search
              </label>
              <input
                id="q"
                name="q"
                defaultValue={query.q ?? ""}
                placeholder="Name or code"
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              />
            </div>
            <label className="flex items-center gap-2 pb-2 text-[12px]">
              <input type="checkbox" name="inactive" value="1" defaultChecked={query.inactive === "1"} />
              Include inactive
            </label>
            <button
              type="submit"
              className="rounded-md bg-[var(--color-navy)] px-3 py-2 text-[13px] font-medium text-white"
            >
              Search
            </button>
          </form>

          {customers.length === 0 ? (
            <EmptyState
              title="No customers yet"
              body={canManage ? "Add the first one below." : "An accounts executive can add them."}
            />
          ) : (
            <DataTable
              columns={["Code", "Name", "Contact", "Terms", "Credit limit", "Status"]}
              caption="Customers"
            >
              {customers.map((customer) => (
                <tr key={customer.id}>
                  <Td>
                    <span className="font-mono text-[12px]">{customer.code}</span>
                  </Td>
                  <Td>
                    <Link
                      href={`/accounting/customers/${customer.id}`}
                      className="font-medium text-[var(--color-info)] hover:underline"
                    >
                      {customer.name}
                    </Link>
                    {customer.registrationNo && (
                      <p className="text-[11px] text-[var(--color-muted)]">{customer.registrationNo}</p>
                    )}
                  </Td>
                  <Td>
                    {customer.contactPerson && <p>{customer.contactPerson}</p>}
                    {customer.email && (
                      <p className="font-mono text-[11px] text-[var(--color-muted)]">{customer.email}</p>
                    )}
                    {customer.phone && (
                      <p className="text-[11px] text-[var(--color-muted)]">{customer.phone}</p>
                    )}
                  </Td>
                  <Td numeric>{customer.paymentTermsDays} days</Td>
                  <Td numeric>
                    {customer.creditLimit === null ? (
                      <span className="text-[var(--color-faint)]">none</span>
                    ) : (
                      formatAmount(customer.creditLimit)
                    )}
                  </Td>
                  <Td>
                    <Badge tone={customer.isActive ? "ok" : "neutral"}>
                      {customer.isActive ? "active" : "inactive"}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>

        {canManage && (
          <Panel title="Add a customer" description="The code is yours to choose and cannot be changed later.">
            <CustomerForm />
          </Panel>
        )}
      </div>
    </Shell>
  );
}
