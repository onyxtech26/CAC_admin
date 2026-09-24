"use client";

import { useActionState } from "react";
import { changePeriodStatus, closeYear, setUpFiscalYear, type FormState } from "../actions";
import { Alert, Button, Field, Select } from "@/components/ui";

const initial: FormState = {};

export function FiscalYearForm({ suggestedStart }: { suggestedStart: string }) {
  const [state, action, pending] = useActionState(setUpFiscalYear, initial);

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="First day of the year"
          name="startsOn"
          type="date"
          required
          defaultValue={suggestedStart}
          hint="Must be the first of a month."
        />
        <Select
          label="Periods"
          name="periods"
          defaultValue="12"
          options={[
            { value: "12", label: "12 — monthly" },
            { value: "4", label: "4 — quarterly" },
            { value: "1", label: "1 — the whole year" },
          ]}
        />
        <Field label="Name" name="name" hint="Left blank, it is named from the dates." />
      </div>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Creating…" : "Create fiscal year"}
      </Button>
    </form>
  );
}

/**
 * One button per allowed transition.
 *
 * Reopening a closed period asks for a reason before it will submit, because the
 * reason is stored on the audit row and an empty one makes the trail useless.
 * The server refuses a blank reason as well — this is only so the user is asked
 * before the round trip.
 */
export function PeriodActions({
  periodId,
  status,
  code,
  canLock,
  canClose,
}: {
  periodId: string;
  status: "open" | "locked" | "closed";
  code: string;
  canLock: boolean;
  canClose: boolean;
}) {
  const [state, action, pending] = useActionState(changePeriodStatus, initial);

  const available: Array<{ transition: string; label: string; needsReason: boolean; allowed: boolean }> = [
    { transition: "lock", label: "Lock", needsReason: false, allowed: status === "open" && canLock },
    { transition: "unlock", label: "Unlock", needsReason: false, allowed: status === "locked" && canLock },
    { transition: "close", label: "Close", needsReason: false, allowed: status !== "closed" && canClose },
    { transition: "reopen", label: "Reopen", needsReason: true, allowed: status === "closed" && canClose },
  ].filter((option) => option.allowed);

  if (available.length === 0) {
    return <span className="text-[12px] text-[var(--color-faint)]">—</span>;
  }

  return (
    <div className="space-y-1">
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      <div className="flex flex-wrap gap-1.5">
        {available.map((option) => (
          <form
            key={option.transition}
            action={action}
            onSubmit={(event) => {
              if (!option.needsReason) return;
              const reason = window.prompt(
                `Reopening ${code} is recorded against your name. Why is it being reopened?`,
              );
              if (!reason?.trim()) {
                event.preventDefault();
                return;
              }
              const field = event.currentTarget.elements.namedItem("reason");
              if (field instanceof HTMLInputElement) field.value = reason;
            }}
          >
            <input type="hidden" name="periodId" value={periodId} />
            <input type="hidden" name="transition" value={option.transition} />
            <input type="hidden" name="reason" value="" />
            <button
              type="submit"
              disabled={pending}
              className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px] hover:bg-[var(--color-canvas)] disabled:opacity-50"
            >
              {option.label}
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}

export function CloseYearForm({ fiscalYearId, name }: { fiscalYearId: string; name: string }) {
  const [state, action, pending] = useActionState(closeYear, initial);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="fiscalYearId" value={fiscalYearId} />
      {state.error && (
        <p className="w-full text-[11px] text-[var(--color-danger)]">{state.error}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px] hover:bg-[var(--color-canvas)] disabled:opacity-50"
        title={`Close ${name}. Every period in it must already be closed.`}
      >
        {pending ? "Closing…" : "Close year"}
      </button>
    </form>
  );
}
