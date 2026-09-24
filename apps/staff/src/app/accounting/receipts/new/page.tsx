import { getDb } from "@cac/db";
import { today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { salesFormOptions } from "@/lib/accounting-options";
import { Shell } from "@/components/Shell";
import { EmptyState, LinkButton, Panel } from "@/components/ui";
import { ReceiptForm } from "../ReceiptForms";

export default async function NewReceiptPage() {
  const principal = await requireCapability("accounting.receipt.create");
  await getDb();
  const options = await salesFormOptions();

  return (
    <Shell
      principal={principal}
      title="Record a receipt"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Receipts", href: "/accounting/receipts" },
        { label: "New" },
      ]}
    >
      {options.bankAccounts.length === 0 ? (
        <EmptyState
          title="There is nowhere to put the money"
          body="The chart of accounts has no bank or cash account. Add one before recording receipts."
          action={<LinkButton href="/accounting/accounts" variant="primary">Chart of accounts</LinkButton>}
        />
      ) : (
        <Panel title="What arrived">
          <ReceiptForm
            customers={options.customers}
            bankAccounts={options.bankAccounts}
            defaults={{
              customerId: "",
              receiptDate: toIsoDate(today()),
              method: "transfer",
              reference: "",
              depositAccountId: options.bankAccounts[0]?.id ?? "",
              amount: "",
              notes: "",
            }}
          />
        </Panel>
      )}
    </Shell>
  );
}
