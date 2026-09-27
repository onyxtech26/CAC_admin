"use client";

import { useActionState } from "react";
import { addTaxRateAction } from "../sales-actions";
import type { FormState } from "../action-errors";
import { Alert, Button, Field, Select } from "@/components/ui";

const initial: FormState = {};

/**
 * Recording a tax rate.
 *
 * The citation field is not decoration. Entering a rate here is asserting a
 * statutory fact that will appear on real invoices and be collected from real
 * customers; whoever enters it should be able to say where it came from, and the
 * next person should be able to check. The server refuses a rate whose source is
 * a single word.
 */
export function TaxRateForm({
  taxCodes,
}: {
  taxCodes: Array<{ id: string; code: string; name: string }>;
}) {
  const [state, action, pending] = useActionState(addTaxRateAction, initial);

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          label="Tax code"
          name="taxCodeId"
          required
          placeholder="Choose…"
          options={taxCodes.map((code) => ({ value: code.id, label: `${code.code} — ${code.name}` }))}
        />
        <Field
          label="Rate"
          name="rate"
          required
          hint="Either 6% or 0.06 — both are read the same way."
        />
        <Field label="In force from" name="effectiveFrom" type="date" required />
        <Field
          label="Until (optional)"
          name="effectiveTo"
          type="date"
          hint="Blank means until further notice."
        />
      </div>

      <div>
        <label htmlFor="sourceRef" className="block text-[12px] font-medium">
          Where does this rate come from?
        </label>
        <input
          id="sourceRef"
          name="sourceRef"
          required
          minLength={12}
          placeholder="e.g. Service Tax (Rate of Tax) Order, per our tax agent's letter of 12 March 2026"
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
        />
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          Name the order, guide or written advice, with its date. This is stored with the rate and
          shown against every invoice that used it. A rate nobody can trace cannot be checked by an
          auditor, and cannot be defended.
        </p>
      </div>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Recording…" : "Record this rate"}
      </Button>
      <p className="text-[11px] text-[var(--color-muted)]">
        Any earlier open-ended rate for the same code is closed off the day before this one starts,
        so two rates can never both be in force.
      </p>
    </form>
  );
}
