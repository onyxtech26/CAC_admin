import { notFound, redirect } from "next/navigation";
import { getDb } from "@cac/db";
import { amountToSql, getPurchaseOrder, today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { purchaseFormOptions } from "@/lib/accounting-options";
import { Shell } from "@/components/Shell";
import { Panel } from "@/components/ui";
import { PurchaseForm } from "../../../PurchaseForm";
import { savePurchaseOrder } from "../../../purchasing-actions";
import { OrderHeader } from "../../OrderHeader";

export default async function EditPurchaseOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const principal = await requireCapability("accounting.po.create");
  const { id } = await params;
  const db = await getDb();

  const order = await getPurchaseOrder(db, id);
  if (!order) notFound();
  if (order.status !== "draft") redirect(`/accounting/purchase-orders/${id}`);

  const options = await purchaseFormOptions();

  return (
    <Shell
      principal={principal}
      title="Edit draft"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Purchase orders", href: "/accounting/purchase-orders" },
        { label: "Draft", href: `/accounting/purchase-orders/${id}` },
        { label: "Edit" },
      ]}
    >
      <Panel title="What is being ordered" description="Saving replaces the draft's lines entirely.">
        <PurchaseForm
          kind="order"
          action={savePurchaseOrder}
          documentId={order.id}
          accounts={options.accounts}
          taxCodes={options.taxCodes}
          costCentres={options.costCentres}
          defaultDate={toIsoDate(today())}
          defaultLines={order.lines.map((line) => ({
            description: line.description,
            quantity: line.quantity,
            unit: line.unit ?? "",
            unitPrice: amountToSql(line.unitPrice),
            taxCodeId: line.taxCodeId ?? "",
            accountId: line.accountId,
            costCentreId: line.costCentreId ?? "",
            spentOn: "",
            receiptRef: "",
          }))}
          header={
            <OrderHeader
              suppliers={options.suppliers}
              defaultDate={order.orderDate}
              defaults={{
                supplierId: order.supplierId,
                orderDate: order.orderDate,
                requiredBy: order.requiredBy ?? "",
                reference: order.reference ?? "",
                subject: order.subject ?? "",
                deliveryNote: order.deliveryNote ?? "",
                notes: order.notes ?? "",
              }}
            />
          }
        />
      </Panel>
    </Shell>
  );
}
