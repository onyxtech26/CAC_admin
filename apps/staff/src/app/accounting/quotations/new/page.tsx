import { getDb } from "@cac/db";
import { today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { salesFormOptions } from "@/lib/accounting-options";
import { Shell } from "@/components/Shell";
import { EmptyState, LinkButton, Panel } from "@/components/ui";
import { DocumentForm } from "../../DocumentForm";
import { saveQuotation } from "../../sales-actions";

export default async function NewQuotationPage() {
  const principal = await requireCapability("accounting.quotation.create");
  await getDb();
  const options = await salesFormOptions(principal);
  const date = toIsoDate(today());

  return (
    <Shell
      principal={principal}
      title="New quotation"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Quotations", href: "/accounting/quotations" },
        { label: "New" },
      ]}
    >
      {options.customers.length === 0 ? (
        <EmptyState
          title="There are no customers yet"
          body="A quotation is addressed to a customer, so add one first."
          action={<LinkButton href="/accounting/customers" variant="primary">Customers</LinkButton>}
        />
      ) : (
        <Panel title="Lines" description="Nothing here reaches the ledger. A quotation is an offer.">
          <DocumentForm
            kind="quotation"
            action={saveQuotation}
            customers={options.customers}
            accounts={options.accounts}
            taxCodes={options.taxCodes}
            cases={options.cases}
            defaultDate={date}
            dueDateLabel="Valid until"
            taxNote={options.taxNote}
          />
        </Panel>
      )}
    </Shell>
  );
}
