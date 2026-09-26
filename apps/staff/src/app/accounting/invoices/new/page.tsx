import { getDb } from "@cac/db";
import { today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { salesFormOptions } from "@/lib/accounting-options";
import { Shell } from "@/components/Shell";
import { EmptyState, LinkButton, Panel } from "@/components/ui";
import { DocumentForm } from "../../DocumentForm";
import { saveInvoice } from "../../sales-actions";

/**
 * Raise an invoice.
 *
 * A draft only. It carries no number, appears in no report and touches no ledger
 * account until somebody approves it and somebody issues it.
 */
export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const principal = await requireCapability("accounting.invoice.create");
  const query = await searchParams;
  await getDb();
  const options = await salesFormOptions(principal);

  const date = toIsoDate(today());

  return (
    <Shell
      principal={principal}
      title="New invoice"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Invoices", href: "/accounting/invoices" },
        { label: "New" },
      ]}
    >
      {options.customers.length === 0 ? (
        <EmptyState
          title="There are no customers yet"
          body="An invoice is raised against a customer, so add one first."
          action={<LinkButton href="/accounting/customers" variant="primary">Customers</LinkButton>}
        />
      ) : (
        <Panel
          title="Lines"
          description="Every figure is computed on the server from the quantity and the unit price. What you see here is the same arithmetic, run as you type."
        >
          <DocumentForm
            kind="invoice"
            action={saveInvoice}
            customers={options.customers}
            accounts={options.accounts}
            taxCodes={options.taxCodes}
          cases={options.cases}
            defaultCustomerId={query.customer}
            defaultDate={date}
            dueDateLabel="Due date"
            taxNote={options.taxNote}
          />
        </Panel>
      )}
    </Shell>
  );
}
