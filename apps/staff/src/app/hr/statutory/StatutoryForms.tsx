"use client";

import { useActionState, useState } from "react";
import { approveRule, saveRule } from "../payroll/payroll-actions";
import type { FormState } from "../../accounting/action-errors";
import { Alert, Button, Field } from "@/components/ui";

const initial: FormState = {};

const KINDS = [
  { value: "epf_employee", label: "EPF — employee's share", shape: "rate" },
  { value: "epf_employer", label: "EPF — employer's share", shape: "rate" },
  { value: "socso", label: "SOCSO", shape: "contribution" },
  { value: "eis", label: "EIS", shape: "contribution" },
  { value: "pcb", label: "PCB (monthly tax deduction)", shape: "rate" },
  { value: "hrd_levy", label: "HRD levy", shape: "levy" },
] as const;

/**
 * The shape of each table, shown as a worked example.
 *
 * Deliberately using obviously-invented numbers. Somebody entering the real table
 * should be reading it off the official document beside them, and a realistic-looking
 * example is an invitation to accept it as a default.
 */
const EXAMPLES: Record<string, string> = {
  rate: `{
  "bands": [
    { "wageFrom": "0", "wageTo": "5000", "ratePercent": "0.00", "ageFrom": 0, "ageTo": 59 },
    { "wageFrom": "5000", "wageTo": null, "ratePercent": "0.00", "ageFrom": 0, "ageTo": 59 }
  ],
  "roundTo": "1.00"
}`,
  contribution: `{
  "bands": [
    { "wageFrom": "0", "wageTo": "30", "employee": "0.00", "employer": "0.00" },
    { "wageFrom": "30", "wageTo": null, "employee": "0.00", "employer": "0.00" }
  ]
}`,
  levy: `{ "ratePercent": "0.00", "minimumEmployees": 10 }`,
};

/**
 * Entering a statutory rule.
 *
 * The table is entered as JSON, and that is a considered choice rather than
 * laziness: these are band schedules with tens of rows, the number of rows differs
 * per scheme and per year, and a form with a fixed number of boxes would quietly
 * truncate a table. The official documents are themselves tables, so transcribing one
 * into a structured text field is the closest thing to copying it.
 *
 * The citation is required. A statutory figure with no source is somebody's
 * recollection, and this one decides what people are paid.
 */
export function RuleForm({ defaultEffectiveFrom }: { defaultEffectiveFrom: string }) {
  const [state, action, pending] = useActionState(saveRule, initial);
  const [kind, setKind] = useState<string>("epf_employee");

  const shape = KINDS.find((row) => row.value === kind)?.shape ?? "rate";

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div>
        <label htmlFor="kind" className="block text-[12px] font-medium">
          Which contribution
        </label>
        <select
          id="kind"
          name="kind"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
        >
          {KINDS.map((row) => (
            <option key={row.value} value={row.value}>
              {row.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          {shape === "contribution"
            ? "A contribution table: the amount is read from the band, not calculated from the wage."
            : shape === "levy"
              ? "A single rate applied to the payroll."
              : "A rate table: which percentage applies depends on the wage band and the age."}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="In force from"
          name="effectiveFrom"
          type="date"
          required
          defaultValue={defaultEffectiveFrom}
          hint="Approving this closes off the previous version the day before."
        />
        <Field
          label="In force until"
          name="effectiveTo"
          type="date"
          hint="Leave blank if it is the current one."
        />
      </div>

      <Field
        label="Where it comes from"
        name="sourceRef"
        required
        hint="The gazette, the KWSP schedule, the PERKESO contribution table — whatever you are copying it out of."
      />
      <Field label="Link, if there is one" name="sourceUrl" />

      <div>
        <label htmlFor="tableJson" className="block text-[12px] font-medium">
          The table
        </label>
        <textarea
          id="tableJson"
          name="tableJson"
          rows={12}
          required
          defaultValue={EXAMPLES[shape]}
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[11px]"
        />
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          Bands have to be contiguous and the last one open-ended, or some wage would fall between
          two bands or off the end of the table. The figures above are zeros on purpose — copy the
          real ones from the official document rather than adjusting a plausible-looking default.
        </p>
      </div>

      <Field label="Notes" name="notes" />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Save as a draft"}
      </Button>
      <p className="text-[11px] text-[var(--color-muted)]">
        A draft has no effect. Somebody other than you approves it, and from then on it cannot be
        edited — which is what lets a past payslip be recomputed and come out the same.
      </p>
    </form>
  );
}

export function ApproveRule({ ruleId, label }: { ruleId: string; label: string }) {
  const [state, action, pending] = useActionState(approveRule, initial);

  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="ruleId" value={ruleId} />
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-[var(--color-navy)] bg-[var(--color-navy)] px-2 py-1 text-[11px] text-white disabled:opacity-50"
      >
        {pending ? "…" : `Approve ${label}`}
      </button>
    </form>
  );
}
