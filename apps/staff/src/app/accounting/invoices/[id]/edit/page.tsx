import { notFound, redirect } from "next/navigation";
import { getDb } from "@cac/db";
import { amountToSql, getInvoice } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { salesFormOptions } from "@/lib/accounting-options";
import { Shell } from "@/components/Shell";
import { Panel } from "@/components/ui";
import { DocumentForm } from "../../../DocumentForm";
import { saveInvoice } from "../../../sales-actions";

/**
 * Edit a draft invoice.
 *
 * Only a draft. Anything further along is redirected back to its detail page
 * rather than shown a form that would be refused on submit.
 */
export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.invoice.create");
  const { id } = await params;
  const db = await getDb();

  const invoice = await getInvoice(db, id);
  if (!invoice) notFound();
  if (invoice.status !== "draft") redirect(`/accounting/invoices/${id}`);

  const options = await salesFormOptions();

  return (
    <Shell
      principal={principal}
      title="Edit draft"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Invoices", href: "/accounting/invoices" },
        { label: "Draft", href: `/accounting/invoices/${id}` },
        { label: "Edit" },
      ]}
    >
      <Panel title="Lines" description="Saving replaces the draft's lines entirely.">
        <DocumentForm
          kind="invoice"
          action={saveInvoice}
          documentId={invoice.id}
          customers={options.customers}
          accounts={options.accounts}
          taxCodes={options.taxCodes}
          defaultCustomerId={invoice.customerId}
          defaultDate={invoice.invoiceDate}
          defaultDueDate={invoice.dueDate}
          defaultReference={invoice.reference ?? undefined}
          defaultSubject={invoice.subject ?? undefined}
          defaultNotes={invoice.notes ?? undefined}
          defaultTerms={invoice.terms ?? undefined}
          defaultLines={invoice.lines.map((line) => ({
            description: line.description,
            quantity: line.quantity,
            unit: line.unit ?? "",
            unitPrice: amountToSql(line.unitPrice),
            discountPercent: line.discountPercent ?? "",
            taxCodeId: line.taxCodeId ?? "",
            accountId: line.accountId,
          }))}
          dueDateLabel="Due date"
          taxNote={options.taxNote}
        />
      </Panel>
    </Shell>
  );
}
