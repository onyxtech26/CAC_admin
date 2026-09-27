import { addDays, today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { purchaseFormOptions } from "@/lib/accounting-options";
import { Shell } from "@/components/Shell";
import { Alert, EmptyState, LinkButton, Panel } from "@/components/ui";
import { PurchaseForm } from "../../PurchaseForm";
import { saveBill } from "../../bills-actions";
import { BillHeader } from "../BillHeader";

/**
 * Enter a bill a supplier has sent.
 *
 * A draft only. It carries no reference of CAC's own, appears in no aging report and touches no
 * ledger account until somebody who did not enter it confirms it is genuine and somebody posts it.
 *
 * The one field that is not optional is the supplier's own document number. It is what they will
 * quote, and it is the only thing that catches the same invoice being entered twice — which is
 * how a small company pays a supplier twice.
 */
export default async function NewBillPage({
  searchParams,
}: {
  searchParams: Promise<{ supplierId?: string }>;
}) {
  const principal = await requireCapability("accounting.bill.create");
  const query = await searchParams;
  const options = await purchaseFormOptions(principal);

  const date = toIsoDate(today());

  return (
    <Shell
      principal={principal}
      title="Enter a bill"
      breadcrumbs={[
        { label: "Purchases & payables" },
        { label: "Bills", href: "/accounting/bills" },
        { label: "New" },
      ]}
    >
      {options.suppliers.length === 0 ? (
        <EmptyState
          title="There are no suppliers yet"
          body="A bill is entered against a supplier, so add one first."
          action={
            <LinkButton href="/accounting/suppliers" variant="primary">
              Suppliers
            </LinkButton>
          }
        />
      ) : (
        <div className="space-y-4">
          <Alert tone="info">
            This records what the supplier says CAC owes. It does not authorise paying it — that is
            a payment voucher, and a different pair of hands.
          </Alert>

          <Panel
            title="The bill"
            description="Every figure is computed on the server from the quantity and the unit price. What you see here is the same arithmetic, run as you type."
          >
            <PurchaseForm
              kind="bill"
              action={saveBill}
              accounts={options.accounts}
              taxCodes={options.taxCodes}
              costCentres={options.costCentres}
              cases={options.cases}
              defaultDate={date}
              submitLabel="Save draft"
              footnote={options.taxNote}
              header={
                <BillHeader
                  suppliers={options.suppliers}
                  defaultSupplierId={query.supplierId}
                  defaultBillDate={date}
                  defaultDueDate={toIsoDate(addDays(today(), 30))}
                  defaultReceivedDate={date}
                />
              }
            />
          </Panel>
        </div>
      )}
    </Shell>
  );
}
