import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import { getBankAccount } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Panel } from "@/components/ui";
import { BankAccountForm } from "../../BankAccountForm";

export default async function EditBankAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const principal = await requireCapability("accounting.bank.manage");
  const { id } = await params;
  const db = await getDb();

  const account = await getBankAccount(db, id);
  if (!account) notFound();

  return (
    <Shell
      principal={principal}
      title="Edit bank account"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Bank", href: "/accounting/bank" },
        { label: account.bankName, href: `/accounting/bank/${id}` },
        { label: "Edit" },
      ]}
    >
      <Panel title="The account">
        <BankAccountForm
          accounts={[]}
          defaults={{
            bankAccountId: account.id,
            accountLabelCode: `${account.accountCode} ${account.accountName}`,
            bankName: account.bankName,
            accountNo: account.accountNo ?? "",
            accountLabel: account.accountLabel ?? "",
            swiftCode: account.swiftCode ?? "",
            notes: account.notes ?? "",
            isActive: account.isActive,
          }}
        />
      </Panel>
    </Shell>
  );
}
