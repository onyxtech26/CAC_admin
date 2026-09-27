"use client";

import { useActionState, useState } from "react";
import { deleteHoliday, saveHoliday } from "../hr-actions";
import type { FormState } from "../../accounting/action-errors";
import { Alert, Button, Field } from "@/components/ui";

const initial: FormState = {};

/**
 * Adding a public holiday.
 *
 * The source reference is required, and that is the point of the form. A holiday
 * somebody half-remembers makes a present employee absent and an absent one
 * present, and both end up in a payslip. Naming the gazette or circular it came
 * from is the difference between a fact and a recollection.
 */
export function HolidayForm({ defaultYear }: { defaultYear: number }) {
  const [state, action, pending] = useActionState(saveHoliday, initial);

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Date"
          name="holidayOn"
          type="date"
          required
          defaultValue={`${defaultYear}-01-01`}
        />
        <Field label="Name" name="name" required />
      </div>

      <Field
        label="Where it comes from"
        name="sourceRef"
        required
        hint="The federal gazette, a state circular, or the company's own declaration. Required: a holiday nobody can source is one nobody can defend."
      />

      <Field
        label="States it applies to"
        name="appliesTo"
        hint="Comma-separated codes such as JHR, SGR. Leave blank for everywhere the company operates."
      />

      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" name="isHalfDay" />
        Half day only
      </label>

      <Field label="Notes" name="notes" />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Adding…" : "Add the holiday"}
      </Button>
    </form>
  );
}

export function RemoveHoliday({ holidayId, name }: { holidayId: string; name: string }) {
  const [state, action, pending] = useActionState(deleteHoliday, initial);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-danger)] hover:underline"
      >
        Remove
      </button>
    );
  }

  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="holidayId" value={holidayId} />
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      <input
        name="reason"
        required
        placeholder="Why"
        aria-label={`Reason for removing ${name}`}
        className="w-28 rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[11px]"
      />
      <div className="flex gap-1">
        <button
          type="submit"
          disabled={pending}
          className="btn btn-danger px-2 py-1 text-[11px]"
        >
          {pending ? "…" : "Remove"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
        >
          Keep
        </button>
      </div>
    </form>
  );
}
