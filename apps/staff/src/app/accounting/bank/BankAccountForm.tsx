"use client";

import { useActionState } from "react";
import { saveBankAccount } from "./banking-actions";
import type { FormState } from "../action-errors";
import { Alert, Button, Field, Select } from "@/components/ui";

const initial: FormState = {};

export function BankAccountForm({
  accounts,
  defaults,
}: {
  /** Empty when editing: the ledger account a bank account points at does not change. */
  accounts: Array<{ id: string; code: string; name: string }>;
  defaults?: {
    bankAccountId: string;
    accountLabelCode: string;
    bankName: string;
    accountNo: string;
    accountLabel: string;
    swiftCode: string;
    notes: string;
    isActive: boolean;
  };
}) {
  const [state, action, pending] = useActionState(saveBankAccount, initial);

  return (
    <form action={action} className="space-y-4">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {defaults && <input type="hidden" name="bankAccountId" value={defaults.bankAccountId} />}

      {defaults ? (
        <div>
          <span className="block text-[12px] font-medium">Ledger account</span>
          <p className="mt-1 rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-[14px]">
            <span className="font-mono text-[12px]">{defaults.accountLabelCode}</span>
          </p>
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            This does not change. Moving a bank account to a different ledger account would
            strand every reconciliation already signed off against the old one.
          </p>
        </div>
      ) : (
        <Select
          label="Ledger account"
          name="accountId"
          required
          placeholder="Choose…"
          options={accounts.map((account) => ({
            value: account.id,
            label: `${account.code} ${account.name}`,
          }))}
          hint="Only bank and cash accounts that are not already attached."
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bank" name="bankName" required defaultValue={defaults?.bankName} />
        <Field
          label="Account number"
          name="accountNo"
          defaultValue={defaults?.accountNo}
          hint="Printed on invoices. Masked to the last four digits in the audit trail."
        />
        <Field
          label="Label"
          name="accountLabel"
          defaultValue={defaults?.accountLabel}
          hint="How people refer to it: “operating current account”."
        />
        <Field label="SWIFT / BIC" name="swiftCode" defaultValue={defaults?.swiftCode} />
      </div>

      <Field label="Notes" name="notes" defaultValue={defaults?.notes} />

      {defaults && (
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" name="isActive" defaultChecked={defaults.isActive} />
          Still in use
        </label>
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : defaults ? "Save changes" : "Add the account"}
      </Button>
    </form>
  );
}
