import { today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { purchaseFormOptions } from "@/lib/accounting-options";
import { Shell } from "@/components/Shell";
import { EmptyState, LinkButton, Panel } from "@/components/ui";
import { PurchaseForm } from "../../PurchaseForm";
import { savePurchaseOrder } from "../../purchasing-actions";
import { OrderHeader } from "../OrderHeader";

export default async function NewPurchaseOrderPage() {
  const principal = await requireCapability("accounting.po.create");
  const options = await purchaseFormOptions();
  const date = toIsoDate(today());

  return (
    <Shell
      principal={principal}
      title="New purchase order"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Purchase orders", href: "/accounting/purchase-orders" },
        { label: "New" },
      ]}
    >
      {options.suppliers.length === 0 ? (
        <EmptyState
          title="There are no suppliers yet"
          body="An order is placed with a supplier, so add one first."
          action={<LinkButton href="/accounting/suppliers" variant="primary">Suppliers</LinkButton>}
        />
      ) : (
        <Panel title="What is being ordered">
          <PurchaseForm
            kind="order"
            action={savePurchaseOrder}
            accounts={options.accounts}
            taxCodes={options.taxCodes}
            costCentres={options.costCentres}
            defaultDate={date}
            header={<OrderHeader suppliers={options.suppliers} defaultDate={date} />}
            footnote="Nothing here reaches the ledger. The cost appears when a voucher is raised for what arrives."
          />
        </Panel>
      )}
    </Shell>
  );
}
