import { notFound, redirect } from "next/navigation";
import { getDb } from "@cac/db";
import { amountToSql, getVoucher, today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { purchaseFormOptions } from "@/lib/accounting-options";
import { Shell } from "@/components/Shell";
import { Panel } from "@/components/ui";
import { PurchaseForm } from "../../../PurchaseForm";
import { saveVoucher } from "../../../purchasing-actions";
import { VoucherHeader } from "../../VoucherHeader";

export default async function EditVoucherPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.voucher.create");
  const { id } = await params;
  const db = await getDb();

  const voucher = await getVoucher(db, id);
  if (!voucher) notFound();
  if (voucher.status !== "draft") redirect(`/accounting/vouchers/${id}`);

  const options = await purchaseFormOptions();

  return (
    <Shell
      principal={principal}
      title="Edit draft"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Payment vouchers", href: "/accounting/vouchers" },
        { label: "Draft", href: `/accounting/vouchers/${id}` },
        { label: "Edit" },
      ]}
    >
      <Panel title="What is being paid" description="Saving replaces the draft's lines entirely.">
        <PurchaseForm
          kind="voucher"
          action={saveVoucher}
          documentId={voucher.id}
          accounts={options.accounts}
          taxCodes={options.taxCodes}
          costCentres={options.costCentres}
          defaultDate={toIsoDate(today())}
          defaultLines={voucher.lines.map((line) => ({
            description: line.description,
            quantity: line.quantity,
            unit: line.unit ?? "",
            unitPrice: amountToSql(line.unitPrice),
            taxCodeId: line.taxCodeId ?? "",
            accountId: line.accountId,
            costCentreId: line.costCentreId ?? "",
            caseId: line.caseId ?? "",
            spentOn: "",
            receiptRef: "",
          }))}
          header={
            <VoucherHeader
              suppliers={options.suppliers}
              bankAccounts={options.bankAccounts}
              defaultDate={voucher.voucherDate}
              taxNote={options.taxNote}
              defaults={{
                supplierId: voucher.supplierId ?? "",
                payeeName: voucher.payeeName ?? "",
                voucherDate: voucher.voucherDate,
                reference: voucher.reference ?? "",
                subject: voucher.subject ?? "",
                kind: voucher.kind,
                settlement: voucher.settlement,
                method: voucher.method,
                paymentAccountId: voucher.paymentAccountId ?? "",
                notes: voucher.notes ?? "",
              }}
            />
          }
        />
      </Panel>
    </Shell>
  );
}
