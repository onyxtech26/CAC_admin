import { notFound, redirect } from "next/navigation";
import { getDb } from "@cac/db";
import { amountToSql, getQuotation } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { salesFormOptions } from "@/lib/accounting-options";
import { Shell } from "@/components/Shell";
import { Panel } from "@/components/ui";
import { DocumentForm } from "../../../DocumentForm";
import { saveQuotation } from "../../../sales-actions";

/**
 * Edit a draft quotation.
 *
 * `updateQuotation` and the update branch of `saveQuotation` both existed and nothing reached
 * either: the detail screen offered "send" and nothing else, so a draft with a wrong figure could
 * only be sent. Every comparable document — invoice, voucher, purchase order, claim, journal — had
 * an edit route.
 *
 * Only a draft. Anything further along is redirected back to its detail page rather than shown a
 * form that would be refused on submit; a quotation the client has seen is what the client saw.
 */
export default async function EditQuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.quotation.create");
  const { id } = await params;
  const db = await getDb();

  const quotation = await getQuotation(db, id);
  if (!quotation) notFound();
  if (quotation.status !== "draft") redirect(`/accounting/quotations/${id}`);

  const options = await salesFormOptions(principal);

  return (
    <Shell
      principal={principal}
      title="Edit draft"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Quotations", href: "/accounting/quotations" },
        { label: "Draft", href: `/accounting/quotations/${id}` },
        { label: "Edit" },
      ]}
    >
      <Panel title="Lines" description="Saving replaces the draft's lines entirely.">
        <DocumentForm
          kind="quotation"
          action={saveQuotation}
          documentId={quotation.id}
          customers={options.customers}
          accounts={options.accounts}
          taxCodes={options.taxCodes}
          cases={options.cases}
          defaultCustomerId={quotation.customerId}
          defaultDate={quotation.quotationDate}
          defaultDueDate={quotation.validUntil ?? undefined}
          dueDateLabel="Valid until"
          defaultReference={quotation.reference ?? undefined}
          defaultSubject={quotation.subject ?? undefined}
          defaultNotes={quotation.notes ?? undefined}
          defaultTerms={quotation.terms ?? undefined}
          defaultLines={quotation.lines.map((line) => ({
            description: line.description,
            quantity: line.quantity,
            unit: line.unit ?? "",
            unitPrice: amountToSql(line.unitPrice),
            discountPercent: line.discountPercent ?? "",
            taxCodeId: line.taxCodeId ?? "",
            accountId: line.accountId,
            caseId: line.caseId ?? "",
          }))}
          taxNote={options.taxNote}
        />
      </Panel>
    </Shell>
  );
}
