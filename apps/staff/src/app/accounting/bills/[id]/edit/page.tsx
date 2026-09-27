import { notFound, redirect } from "next/navigation";
import { getDb } from "@cac/db";
import { amountToSql, getSupplierInvoice } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { purchaseFormOptions } from "@/lib/accounting-options";
import { Shell } from "@/components/Shell";
import { Panel } from "@/components/ui";
import { PurchaseForm } from "../../../PurchaseForm";
import { saveBill } from "../../../bills-actions";
import { BillHeader } from "../../BillHeader";

export default async function EditBillPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.bill.create");
  const { id } = await params;
  const db = await getDb();

  const bill = await getSupplierInvoice(db, id);
  if (!bill) notFound();
  // Only a draft is editable. Everything past it has been confirmed by somebody or is in the
  // ledger, and the database refuses the change anyway — redirecting is the courteous version of
  // the same rule.
  if (bill.status !== "draft") redirect(`/accounting/bills/${id}`);

  const options = await purchaseFormOptions(principal);

  return (
    <Shell
      principal={principal}
      title="Edit draft bill"
      breadcrumbs={[
        { label: "Purchases & payables" },
        { label: "Bills", href: "/accounting/bills" },
        { label: bill.supplierDocNo, href: `/accounting/bills/${id}` },
        { label: "Edit" },
      ]}
    >
      <Panel title="The bill" description="Saving replaces the draft's lines entirely.">
        <PurchaseForm
          kind="bill"
          action={saveBill}
          documentId={bill.id}
          accounts={options.accounts}
          taxCodes={options.taxCodes}
          costCentres={options.costCentres}
          cases={options.cases}
          defaultDate={bill.billDate}
          submitLabel="Save draft"
          footnote={options.taxNote}
          defaultLines={bill.lines.map((line) => ({
            description: line.description,
            quantity: String(line.quantity),
            unit: line.unit ?? "",
            unitPrice: amountToSql(line.unitPrice),
            taxCodeId: line.taxCodeId ?? "",
            accountId: line.accountId,
            costCentreId: "",
            caseId: line.caseId ?? "",
            spentOn: "",
            receiptRef: "",
          }))}
          header={
            <BillHeader
              suppliers={options.suppliers}
              defaultSupplierId={bill.supplierId}
              defaultSupplierDocNo={bill.supplierDocNo}
              defaultBillDate={bill.billDate}
              defaultDueDate={bill.dueDate}
              defaultReceivedDate={bill.receivedDate}
              defaultSubject={bill.subject}
              defaultNotes={bill.notes}
            />
          }
        />
      </Panel>
    </Shell>
  );
}
