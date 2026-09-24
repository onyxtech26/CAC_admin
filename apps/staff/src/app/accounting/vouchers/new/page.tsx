import { today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { purchaseFormOptions } from "@/lib/accounting-options";
import { Shell } from "@/components/Shell";
import { EmptyState, LinkButton, Panel } from "@/components/ui";
import { PurchaseForm } from "../../PurchaseForm";
import { saveVoucher } from "../../purchasing-actions";
import { VoucherHeader } from "../VoucherHeader";

/**
 * Raise a payment voucher.
 *
 * A draft only. Nothing leaves the bank until somebody else approves it and
 * somebody posts it — three steps, because money going out is the single
 * easiest thing to get wrong.
 */
export default async function NewVoucherPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>;
}) {
  const principal = await requireCapability("accounting.voucher.create");
  const query = await searchParams;
  const options = await purchaseFormOptions();
  const date = toIsoDate(today());

  return (
    <Shell
      principal={principal}
      title="New payment voucher"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Payment vouchers", href: "/accounting/vouchers" },
        { label: "New" },
      ]}
    >
      {options.bankAccounts.length === 0 ? (
        <EmptyState
          title="There is nowhere to pay from"
          body="The chart of accounts has no bank or cash account."
          action={<LinkButton href="/accounting/accounts" variant="primary">Chart of accounts</LinkButton>}
        />
      ) : (
        <Panel title="What is being paid">
          <PurchaseForm
            kind="voucher"
            action={saveVoucher}
            accounts={options.accounts}
            taxCodes={options.taxCodes}
            costCentres={options.costCentres}
            defaultDate={date}
            header={
              <VoucherHeader
                suppliers={options.suppliers}
                bankAccounts={options.bankAccounts}
                defaultDate={date}
                taxNote={options.taxNote}
                purchaseOrderId={query.order}
              />
            }
            footnote="Saving creates a draft. The ledger is untouched until it is approved and posted."
          />
        </Panel>
      )}
    </Shell>
  );
}
