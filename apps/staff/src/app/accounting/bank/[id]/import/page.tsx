import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import { getBankAccount } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Panel } from "@/components/ui";
import { ImportWizard } from "./ImportWizard";

export default async function ImportStatementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const principal = await requireCapability("accounting.bank.import");
  const { id } = await params;
  const db = await getDb();

  const account = await getBankAccount(db, id);
  if (!account) notFound();

  return (
    <Shell
      principal={principal}
      title="Import a statement"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Bank", href: "/accounting/bank" },
        { label: account.bankName, href: `/accounting/bank/${id}` },
        { label: "Import" },
      ]}
    >
      <div className="space-y-4">
        <Alert tone="info">
          Importing writes what the bank says happened. It changes no ledger balance on its own —
          the ledger only moves when a statement line is posted from here, deliberately, against an
          account somebody chooses.
        </Alert>

        <Panel
          title={`${account.accountCode} ${account.accountName}`}
          description={`${account.bankName}${account.accountNo ? ` · ${account.accountNo}` : ""}`}
        >
          <ImportWizard bankAccountId={id} />
        </Panel>
      </div>
    </Shell>
  );
}
