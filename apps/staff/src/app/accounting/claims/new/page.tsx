import { today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { purchaseFormOptions } from "@/lib/accounting-options";
import { Shell } from "@/components/Shell";
import { Panel } from "@/components/ui";
import { PurchaseForm } from "../../PurchaseForm";
import { saveClaim } from "../../purchasing-actions";
import { ClaimHeader } from "../ClaimHeader";

/**
 * Claim what you have spent.
 *
 * A draft belonging to whoever is signed in. It becomes a liability of the firm
 * only once somebody else approves it and it is posted — the claimant cannot
 * approve their own claim, which is the whole point of the form existing rather
 * than money coming straight out of the tin.
 */
export default async function NewClaimPage() {
  const principal = await requireCapability("accounting.claim.create");
  const options = await purchaseFormOptions();
  const date = toIsoDate(today());

  return (
    <Shell
      principal={principal}
      title="New expense claim"
      breadcrumbs={[
        { label: "Accounting", href: "/accounting" },
        { label: "Expense claims", href: "/accounting/claims" },
        { label: "New" },
      ]}
    >
      <Panel title="What you spent">
        <PurchaseForm
          kind="claim"
          action={saveClaim}
          accounts={options.accounts}
          taxCodes={options.taxCodes}
          costCentres={options.costCentres}
          defaultDate={date}
          header={
            <ClaimHeader
              claimantName={principal.fullName}
              defaultDate={date}
              taxNote={options.taxNote}
            />
          }
          footnote="Put the date you actually spent the money on each line, and the receipt reference so the paper can be found. Saving creates a draft only you can see until you submit it."
        />
      </Panel>
    </Shell>
  );
}
