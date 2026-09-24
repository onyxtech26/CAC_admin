"use client";

import { useActionState, useState } from "react";
import { periodAction, saveAttendance } from "../hr-actions";
import type { FormState } from "../../accounting/action-errors";
import { Alert, Button } from "@/components/ui";

const initial: FormState = {};

export interface EmployeeOption {
  id: string;
  employeeNo: string;
  fullName: string;
}

/**
 * Recording or correcting one day by hand.
 *
 * A correction needs a reason, and the reason is kept with the record. The
 * difference between what the device said and what a person decided is the first
 * thing queried when a payslip is disputed, and it is only answerable if the reason
 * was captured at the time.
 */
export function AttendanceDayForm({
  employees,
  defaultDate,
}: {
  employees: EmployeeOption[];
  defaultDate: string;
}) {
  const [state, action, pending] = useActionState(saveAttendance, initial);
  const [absent, setAbsent] = useState(false);

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="employeeId" className="block text-[12px] font-medium">
            Who
          </label>
          <select
            id="employeeId"
            name="employeeId"
            required
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          >
            <option value="">Choose…</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.employeeNo} — {employee.fullName}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="workDate" className="block text-[12px] font-medium">
            Day
          </label>
          <input
            id="workDate"
            name="workDate"
            type="date"
            required
            defaultValue={defaultDate}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          name="isAbsent"
          checked={absent}
          onChange={(event) => setAbsent(event.target.checked)}
        />
        Absent all day
      </label>

      {!absent && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="clockIn" className="block text-[12px] font-medium">
              In
            </label>
            <input
              id="clockIn"
              name="clockIn"
              type="time"
              className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
            />
          </div>
          <div>
            <label htmlFor="clockOut" className="block text-[12px] font-medium">
              Out
            </label>
            <input
              id="clockOut"
              name="clockOut"
              type="time"
              className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
            />
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">
              Leave blank if the scan is genuinely missing, and say so in the remark. Inventing a
              time is worse than recording that one is absent.
            </p>
          </div>
        </div>
      )}

      <div>
        <label htmlFor="onLeaveType" className="block text-[12px] font-medium">
          On leave
        </label>
        <input
          id="onLeaveType"
          name="onLeaveType"
          placeholder="annual, sick, unpaid…"
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
        />
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          Free text for now. Leave types and balances arrive with the leave module.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="remarks" className="block text-[12px] font-medium">
            Remark
          </label>
          <input
            id="remarks"
            name="remarks"
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
        </div>
        <div>
          <label htmlFor="reason" className="block text-[12px] font-medium">
            Reason, if this changes a day already recorded
          </label>
          <input
            id="reason"
            name="reason"
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
        </div>
      </div>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Save the day"}
      </Button>
    </form>
  );
}

export function OpenPeriodForm({ defaultFrom, defaultTo }: { defaultFrom: string; defaultTo: string }) {
  const [state, action, pending] = useActionState(periodAction, initial);

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <input type="hidden" name="action" value="open" />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="periodFrom" className="block text-[12px] font-medium">
            From
          </label>
          <input
            id="periodFrom"
            name="periodFrom"
            type="date"
            required
            defaultValue={defaultFrom}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
        </div>
        <div>
          <label htmlFor="periodTo" className="block text-[12px] font-medium">
            To
          </label>
          <input
            id="periodTo"
            name="periodTo"
            type="date"
            required
            defaultValue={defaultTo}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
        </div>
      </div>

      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Opening…" : "Open the period"}
      </Button>
    </form>
  );
}

/**
 * Closing or reopening a period.
 *
 * Closing turns every draft day inside it into evidence: payroll reads final rows
 * only, and once closed nothing in the period can be edited or inserted. Reopening
 * needs a reason because payroll may already have been run against it.
 */
export function PeriodActions({
  periodId,
  status,
  draftCount,
}: {
  periodId: string;
  status: "open" | "finalised";
  draftCount: number;
}) {
  const [state, action, pending] = useActionState(periodAction, initial);
  const [reopening, setReopening] = useState(false);

  if (status === "open") {
    return (
      <form action={action} className="space-y-1">
        <input type="hidden" name="periodId" value={periodId} />
        <input type="hidden" name="action" value="finalise" />
        {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
        {state.notice && <p className="text-[11px] text-[var(--color-ok)]">{state.notice}</p>}
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-[var(--color-navy)] bg-[var(--color-navy)] px-2 py-1 text-[11px] text-white disabled:opacity-50"
        >
          {pending ? "…" : `Finalise ${draftCount} day${draftCount === 1 ? "" : "s"}`}
        </button>
      </form>
    );
  }

  if (!reopening) {
    return (
      <div className="space-y-1">
        {state.notice && <p className="text-[11px] text-[var(--color-ok)]">{state.notice}</p>}
        <button
          type="button"
          onClick={() => setReopening(true)}
          className="text-[11px] text-[var(--color-muted)] hover:underline"
        >
          Reopen
        </button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="periodId" value={periodId} />
      <input type="hidden" name="action" value="reopen" />
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      <input
        name="reason"
        required
        placeholder="Why"
        aria-label="Reason for reopening"
        className="w-32 rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[11px]"
      />
      <p className="text-[10px] text-[var(--color-muted)]">
        Payroll may already have been run against this period.
      </p>
      <div className="flex gap-1">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-[var(--color-warn)] px-2 py-1 text-[11px] text-white disabled:opacity-50"
        >
          {pending ? "…" : "Reopen"}
        </button>
        <button
          type="button"
          onClick={() => setReopening(false)}
          className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
        >
          Leave closed
        </button>
      </div>
    </form>
  );
}
