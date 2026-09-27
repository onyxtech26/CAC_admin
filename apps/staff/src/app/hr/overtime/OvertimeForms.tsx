"use client";

import { useActionState, useState } from "react";
import {
  decideOvertimeAction,
  decideTimeoffAction,
  rateOvertimeAction,
  recalculate,
  requestOvertimeAction,
  requestTimeoffAction,
} from "../workflow-actions";
import type { FormState } from "../../accounting/action-errors";
import { Alert, Button, Field } from "@/components/ui";

const initial: FormState = {};

/**
 * How a day kind reads in a sentence.
 *
 * `normal` is the stored value and "A normal." is not English; the table column says "working day"
 * and these now agree with it.
 */
const DAY_KIND: Record<string, string> = {
  normal: "working day",
  rest_day: "rest day",
  public_holiday: "public holiday",
};

function dayKindLabel(kind: string): string {
  return DAY_KIND[kind] ?? kind.replace(/_/g, " ");
}

export interface EmployeeOption {
  id: string;
  employeeNo: string;
  fullName: string;
}

export function OvertimeRequestForm({
  employees,
  ownEmployeeId,
  defaultDate,
}: {
  employees: EmployeeOption[];
  ownEmployeeId: string | null;
  defaultDate: string;
}) {
  const [state, action, pending] = useActionState(requestOvertimeAction, initial);
  const forOthers = employees.length > 0;

  if (!ownEmployeeId && !forOthers) {
    return (
      <p className="text-[12px] text-[var(--color-muted)]">
        Your account is not linked to an employee record, so there is nobody to claim overtime for.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      {forOthers ? (
        <div>
          <label htmlFor="ot-employeeId" className="block text-[12px] font-medium">
            Who worked it
          </label>
          <select
            id="ot-employeeId"
            name="employeeId"
            required
            defaultValue={ownEmployeeId ?? ""}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          >
            <option value="">Choose…</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.employeeNo} — {employee.fullName}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <input type="hidden" name="employeeId" value={ownEmployeeId ?? ""} />
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Day" name="workDate" type="date" required defaultValue={defaultDate} />
        <div>
          <label htmlFor="startsAt" className="block text-[12px] font-medium">
            From
          </label>
          <input
            id="startsAt"
            name="startsAt"
            type="time"
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          />
        </div>
        <div>
          <label htmlFor="endsAt" className="block text-[12px] font-medium">
            To
          </label>
          <input
            id="endsAt"
            name="endsAt"
            type="time"
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          />
        </div>
      </div>

      <Field
        label="Hours claimed"
        name="requestedHours"
        required
        inputMode="decimal"
        hint="What you are asking to be paid for, which may be less than the clock shows."
      />

      <Field
        label="What it was for"
        name="reason"
        required
        hint="This is what the approver decides on."
      />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Submitting…" : "Submit the claim"}
      </Button>
      <p className="text-[11px] text-[var(--color-muted)]">
        Whether the day was a working day, a rest day or a public holiday is worked out from the
        calendar, because it decides the rate.
      </p>
    </form>
  );
}

/**
 * Deciding an overtime claim.
 *
 * The approved hours field starts at what was claimed but can be reduced — approving
 * four of six is normal, and the difference stays visible rather than the claim being
 * edited. The rate is asked for with its source; leaving it blank is allowed and
 * means payroll will not pay it until somebody supplies one, which is the honest
 * outcome while Q-HR-1 is open.
 */
export function OvertimeDecision({
  requestId,
  requestedHours,
  extraMinutesOnClock,
  dayKind,
  canDecide,
}: {
  requestId: string;
  requestedHours: number;
  extraMinutesOnClock: number | null;
  dayKind: string;
  canDecide: boolean;
}) {
  const [state, action, pending] = useActionState(decideOvertimeAction, initial);
  const [open, setOpen] = useState(false);
  const [refusing, setRefusing] = useState(false);

  if (!canDecide) return <span className="text-[11px] text-[var(--color-faint)]">—</span>;

  if (refusing) {
    return (
      <form action={action} className="space-y-1">
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="action" value="reject" />
        {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
        <input
          name="note"
          required
          placeholder="Why"
          aria-label="Reason for refusing"
          className="w-32 rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[11px]"
        />
        <div className="flex gap-1">
          <button
            type="submit"
            disabled={pending}
            className="btn btn-danger px-2 py-1 text-[11px]"
          >
            {pending ? "…" : "Refuse"}
          </button>
          <button
            type="button"
            onClick={() => setRefusing(false)}
            className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
          >
            Back
          </button>
        </div>
      </form>
    );
  }

  if (!open) {
    return (
      <div className="space-y-1">
        {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn btn-primary px-2 py-1 text-[11px]"
        >
          Decide
        </button>
        <button
          type="button"
          onClick={() => setRefusing(true)}
          className="block text-[11px] text-[var(--color-muted)] hover:underline"
        >
          Refuse
        </button>
      </div>
    );
  }

  return (
    <form action={action} className="w-64 space-y-2 rounded-md border border-[var(--color-line)] p-2">
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="action" value="approve" />
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}

      <div>
        <label htmlFor={`hours-${requestId}`} className="block text-[11px] font-medium">
          Hours to pay
        </label>
        <input
          id={`hours-${requestId}`}
          name="approvedHours"
          defaultValue={String(requestedHours)}
          inputMode="decimal"
          className="numeric mt-0.5 w-full rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-right text-[12px]"
        />
        <p className="mt-0.5 text-[10px] text-[var(--color-muted)]">
          {requestedHours} claimed
          {extraMinutesOnClock !== null &&
            `; the clock shows ${(extraMinutesOnClock / 60).toFixed(2)} beyond the schedule`}
        </p>
      </div>

      <div>
        <label htmlFor={`rate-${requestId}`} className="block text-[11px] font-medium">
          Rate multiple
        </label>
        <input
          id={`rate-${requestId}`}
          name="rateMultiple"
          inputMode="decimal"
          placeholder="leave blank if not yet known"
          className="numeric mt-0.5 w-full rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-right text-[12px]"
        />
        <p className="mt-0.5 text-[10px] text-[var(--color-muted)]">
          A {dayKindLabel(dayKind)}. The multiple comes from the Employment Act, which CAC has not yet
          supplied — see Q-HR-1.
        </p>
      </div>

      <input
        name="rateSource"
        placeholder="Where the rate comes from"
        className="w-full rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[11px]"
      />

      <input
        name="note"
        placeholder="Note, optional"
        className="w-full rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[11px]"
      />

      <div className="flex gap-1">
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary px-2 py-1 text-[11px]"
        >
          {pending ? "…" : "Approve"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Supplying the rate on a claim that was approved without one.
 *
 * The counterpart of approving without a rate, which the decision form deliberately allows. Both
 * halves have to exist: approving hours while the legal multiple is unknown is honest, and leaving
 * the record with no way to apply the answer when it arrives is not — those hours were unpayable for
 * good, and the payslip told the employee so.
 */
export function OvertimeRate({
  requestId,
  dayKind,
  canRate,
}: {
  requestId: string;
  dayKind: string;
  canRate: boolean;
}) {
  const [state, action, pending] = useActionState(rateOvertimeAction, initial);
  const [open, setOpen] = useState(false);

  if (!canRate) return <span className="text-[11px] text-[var(--color-faint)]">—</span>;

  if (!open) {
    return (
      <div className="space-y-1">
        {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
        {state.notice && <p className="text-[11px] text-[var(--color-ok)]">{state.notice}</p>}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
        >
          Record the rate
        </button>
      </div>
    );
  }

  return (
    <form action={action} className="w-56 space-y-2 rounded-md border border-[var(--color-line)] p-2">
      <input type="hidden" name="requestId" value={requestId} />
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}

      <div>
        <label htmlFor={`newrate-${requestId}`} className="block text-[11px] font-medium">
          Rate multiple
        </label>
        <input
          id={`newrate-${requestId}`}
          name="rateMultiple"
          required
          inputMode="decimal"
          className="numeric mt-0.5 w-full rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-right text-[12px]"
        />
        <p className="mt-0.5 text-[10px] text-[var(--color-muted)]">
          A {dayKindLabel(dayKind)}. The hours and the approver are unchanged; only the rate is being
          supplied.
        </p>
      </div>

      <input
        name="rateSource"
        required
        placeholder="Where the rate comes from"
        aria-label="Where the rate comes from"
        className="w-full rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[11px]"
      />

      <div className="flex gap-1">
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary px-2 py-1 text-[11px]"
        >
          {pending ? "…" : "Record"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function TimeoffRequestForm({
  employees,
  ownEmployeeId,
  defaultDate,
}: {
  employees: EmployeeOption[];
  ownEmployeeId: string | null;
  defaultDate: string;
}) {
  const [state, action, pending] = useActionState(requestTimeoffAction, initial);
  const forOthers = employees.length > 0;

  if (!ownEmployeeId && !forOthers) return null;

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      {forOthers ? (
        <div>
          <label htmlFor="to-employeeId" className="block text-[12px] font-medium">
            Who
          </label>
          <select
            id="to-employeeId"
            name="employeeId"
            required
            defaultValue={ownEmployeeId ?? ""}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          >
            <option value="">Choose…</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.employeeNo} — {employee.fullName}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <input type="hidden" name="employeeId" value={ownEmployeeId ?? ""} />
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Day" name="workDate" type="date" required defaultValue={defaultDate} />
        <div>
          <label htmlFor="kind" className="block text-[12px] font-medium">
            Kind
          </label>
          <select
            id="kind"
            name="kind"
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          >
            <option value="late_in">Coming in late</option>
            <option value="early_out">Leaving early</option>
            <option value="during_day">Away during the day</option>
          </select>
        </div>
        <Field label="Minutes" name="minutes" required inputMode="numeric" />
      </div>

      <Field label="What for" name="reason" required />

      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" name="isPaid" defaultChecked />
        Paid time
      </label>

      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Submitting…" : "Submit"}
      </Button>
      <p className="text-[11px] text-[var(--color-muted)]">
        Approved time off stops the attendance engine counting the same minutes as lateness. Without
        it, permission to attend an appointment looks exactly like turning up late.
      </p>
    </form>
  );
}

export function TimeoffDecision({ requestId, canDecide }: { requestId: string; canDecide: boolean }) {
  const [state, action, pending] = useActionState(decideTimeoffAction, initial);
  const [refusing, setRefusing] = useState(false);

  if (!canDecide) return <span className="text-[11px] text-[var(--color-faint)]">—</span>;

  if (refusing) {
    return (
      <form action={action} className="space-y-1">
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="action" value="reject" />
        <input
          name="note"
          required
          placeholder="Why"
          aria-label="Reason for refusing"
          className="w-28 rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[11px]"
        />
        <button
          type="submit"
          disabled={pending}
          className="btn btn-danger px-2 py-1 text-[11px]"
        >
          {pending ? "…" : "Refuse"}
        </button>
      </form>
    );
  }

  return (
    <div className="space-y-1">
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      <form action={action}>
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="action" value="approve" />
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary px-2 py-1 text-[11px]"
        >
          {pending ? "…" : "Approve"}
        </button>
      </form>
      <button
        type="button"
        onClick={() => setRefusing(true)}
        className="text-[11px] text-[var(--color-muted)] hover:underline"
      >
        Refuse
      </button>
    </div>
  );
}

/**
 * Running the attendance engine over a range.
 *
 * Offered as a button rather than run automatically, because it is arithmetic over
 * somebody's pay and the person doing it should know they did it. Finalised days are
 * left alone and the result says how many.
 */
export function RecalculateForm({ from, to }: { from: string; to: string }) {
  const [state, action, pending] = useActionState(recalculate, initial);

  return (
    <form action={action} className="space-y-2">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor="rc-from" className="block text-[11px] font-medium">
            From
          </label>
          <input
            id="rc-from"
            name="from"
            type="date"
            required
            defaultValue={from}
            className="mt-0.5 w-full rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[12px]"
          />
        </div>
        <div>
          <label htmlFor="rc-to" className="block text-[11px] font-medium">
            To
          </label>
          <input
            id="rc-to"
            name="to"
            type="date"
            required
            defaultValue={to}
            className="mt-0.5 w-full rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[12px]"
          />
        </div>
      </div>

      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Calculating…" : "Recalculate"}
      </Button>
      <p className="text-[11px] text-[var(--color-muted)]">
        Works out lateness, early departures and extra time against each person&rsquo;s schedule,
        taking approved leave and approved absences into account. Finalised days are left alone.
      </p>
    </form>
  );
}
