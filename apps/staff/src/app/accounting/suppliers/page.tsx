import { getDb } from "@cac/db";
import { listSuppliers, maskAccountNumber } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, Panel, Td } from "@/components/ui";
import { SupplierForm } from "./SupplierForm";

/**
 * Suppliers.
 *
 * Bank account numbers are shown as the last four digits only. Redirecting a
 * payment to a changed account is the commonest invoice fraud there is, and a
 * full account number on a screen anyone in accounts can open is how the details
 * get out. The last four are enough to check a payment against; they are not
 * enough to divert one. Every change to the field is flagged in the audit trail.
 */
export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; inactive?: string }>;
}) {
  const principal = await requireCapability("accounting.supplier.view");
  const query = await searchParams;
  const db = await getDb();

  const suppliers = await listSuppliers(db, {
    search: query.q,
    includeInactive: query.inactive === "1",
  });
  const canManage = principal.capabilities.has("accounting.supplier.manage");

  return (
    <Shell
      principal={principal}
      title="Suppliers"
      breadcrumbs={[{ label: "Accounting", href: "/accounting" }, { label: "Suppliers" }]}
    >
      <div className="space-y-4">
        <Panel title={`${suppliers.length} supplier${suppliers.length === 1 ? "" : "s"}`}>
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

          {suppliers.length === 0 ? (
            <EmptyState
              title="No suppliers yet"
              body={canManage ? "Add the first one below." : "An accounts executive can add them."}
            />
          ) : (
            <DataTable
              columns={["Code", "Name", "Contact", "Terms", "Bank", "Status"]}
              caption="Suppliers"
            >
              {suppliers.map((supplier) => (
                <tr key={supplier.id}>
                  <Td>
                    <span className="font-mono text-[12px]">{supplier.code}</span>
                  </Td>
                  <Td>
                    <p className="font-medium">{supplier.name}</p>
                    {supplier.registrationNo && (
                      <p className="text-[11px] text-[var(--color-muted)]">{supplier.registrationNo}</p>
                    )}
                  </Td>
                  <Td>
                    {supplier.contactPerson && <p>{supplier.contactPerson}</p>}
                    {supplier.email && (
                      <p className="font-mono text-[11px] text-[var(--color-muted)]">{supplier.email}</p>
                    )}
                    {supplier.phone && (
                      <p className="text-[11px] text-[var(--color-muted)]">{supplier.phone}</p>
                    )}
                  </Td>
                  <Td numeric>{supplier.paymentTermsDays} days</Td>
                  <Td>
                    {supplier.bankAccountNo ? (
                      <>
                        <p className="text-[12px]">{supplier.bankName}</p>
                        <p className="font-mono text-[11px] text-[var(--color-muted)]">
                          {maskAccountNumber(supplier.bankAccountNo)}
                        </p>
                      </>
                    ) : (
                      <span className="text-[var(--color-faint)]">—</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={supplier.isActive ? "ok" : "neutral"}>
                      {supplier.isActive ? "active" : "inactive"}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>

        {canManage && (
          <>
            <Alert tone="info">
              Before changing a supplier&rsquo;s bank details, confirm the request by a channel you
              already had — a call to a number you held before, not one in the email asking for the
              change. The change is recorded against your name either way.
            </Alert>
            <Panel title="Add a supplier">
              <SupplierForm />
            </Panel>
          </>
        )}
      </div>
    </Shell>
  );
}
