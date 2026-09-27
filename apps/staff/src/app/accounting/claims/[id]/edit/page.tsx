import { notFound, redirect } from "next/navigation";
import { getDb } from "@cac/db";
import { amountToSql, getClaim, today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { purchaseFormOptions } from "@/lib/accounting-options";
import { Shell } from "@/components/Shell";
import { Panel } from "@/components/ui";
import { PurchaseForm } from "../../../PurchaseForm";
import { saveClaim } from "../../../purchasing-actions";
import { ClaimHeader } from "../../ClaimHeader";

/**
 * Edit a draft claim.
 *
 * Only the claimant's own draft: somebody else's draft is redirected to the
 * detail page, which will refuse to show it at all unless they can approve
 * claims. The server applies the same rule, so this is convenience rather than
 * the control.
 */
export default async function EditClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("accounting.claim.create");
  const { id } = await params;
  const db = await getDb();

  const claim = await getClaim(db, id);
  if (!claim) notFound();
  if (claim.status !== "draft" || claim.claimantId !== principal.userId) {
    redirect(`/accounting/claims/${id}`);
  }

  const options = await purchaseFormOptions();

  return (
    <Shell
      principal={principal}
      title="Edit draft claim"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Expense claims", href: "/accounting/claims" },
        { label: "Draft", href: `/accounting/claims/${id}` },
        { label: "Edit" },
      ]}
    >
      <Panel title="What you spent" description="Saving replaces the draft's lines entirely.">
        <PurchaseForm
          kind="claim"
          action={saveClaim}
          documentId={claim.id}
          accounts={options.accounts}
          taxCodes={options.taxCodes}
          costCentres={options.costCentres}
          defaultDate={toIsoDate(today())}
          defaultLines={claim.lines.map((line) => ({
            description: line.description,
            quantity: line.quantity,
            unit: line.unit ?? "",
            unitPrice: amountToSql(line.unitPrice),
            taxCodeId: line.taxCodeId ?? "",
            accountId: line.accountId,
            costCentreId: line.costCentreId ?? "",
            caseId: line.caseId ?? "",
            spentOn: line.spentOn ?? "",
            receiptRef: line.receiptRef ?? "",
          }))}
          header={
            <ClaimHeader
              claimantName={claim.claimantName}
              defaultDate={claim.claimDate}
              taxNote={options.taxNote}
              defaults={{
                claimDate: claim.claimDate,
                periodFrom: claim.periodFrom,
                periodTo: claim.periodTo,
                subject: claim.subject,
                notes: claim.notes,
              }}
            />
          }
        />
      </Panel>
    </Shell>
  );
}
