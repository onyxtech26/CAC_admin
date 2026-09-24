"use client";

import { useActionState, useState } from "react";
import {
  decideLeaveAction,
  requestLeaveAction,
  saveBalanceAction,
  saveLeaveTypeAction,
} from "../workflow-actions";
import type { FormState } from "../../accounting/action-errors";
import { Alert, Button, Field } from "@/components/ui";

const initial: FormState = {};

export interface LeaveTypeOption {
  id: string;
  code: string;
  name: string;
  isConfigured: boolean;
  requiresDocument: boolean;
  allowsBackdating: boolean;
}

export interface EmployeeOption {
  id: string;
  employeeNo: string;
  fullName: string;
}

/**
 * Requesting leave.
 *
 * Submits in one step rather than leaving a draft: a request nobody sent is a
 * request nobody sees. A type with no entitlement recorded is offered but marked,
 * because the honest thing is to show why it cannot be used rather than to hide it.
 */
export function LeaveRequestForm({
  types,
  employees,
  ownEmployeeId,
  defaultDate,
}: {
  types: LeaveTypeOption[];
  /** Empty unless the person may raise leave on somebody else's record. */
  employees: EmployeeOption[];
  ownEmployeeId: string | null;
  defaultDate: string;
}) {
  const [state, action, pending] = useActionState(requestLeaveAction, initial);
  const [typeId, setTypeId] = useState(types.find((row) => row.isConfigured)?.id ?? "");
  const [startsOn, setStartsOn] = useState(defaultDate);
  const [endsOn, setEndsOn] = useState(defaultDate);

  const selected = types.find((row) => row.id === typeId);
  const forOthers = employees.length > 0;

  if (!ownEmployeeId && !forOthers) {
    return (
      <p className="text-[12px] text-[var(--color-muted)]">
        Your account is not linked to an employee record, so there is nobody to request leave for.
        An administrator links the two.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      {forOthers ? (
        <div>
          <label htmlFor="employeeId" className="block text-[12px] font-medium">
            Who is taking it
          </label>
          <select
            id="employeeId"
            name="employeeId"
            required
            defaultValue={ownEmployeeId ?? ""}
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
      ) : (
        <input type="hidden" name="employeeId" value={ownEmployeeId ?? ""} />
      )}

      <div>
        <label htmlFor="leaveTypeId" className="block text-[12px] font-medium">
          Kind of leave
        </label>
        <select
          id="leaveTypeId"
          name="leaveTypeId"
          required
          value={typeId}
          onChange={(event) => setTypeId(event.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
        >
          <option value="">Choose…</option>
          {types.map((type) => (
            <option key={type.id} value={type.id} disabled={!type.isConfigured}>
              {type.name}
              {type.isConfigured ? "" : " — no entitlement recorded yet"}
            </option>
          ))}
        </select>
        {selected && !selected.isConfigured && (
          <p className="mt-1 text-[11px] text-[var(--color-warn)]">
            This type has no entitlement figure with a source, so there is nothing to draw against.
            HR sets that first — see Q-HR-3.
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="startsOn" className="block text-[12px] font-medium">
            From
          </label>
          <input
            id="startsOn"
            name="startsOn"
            type="date"
            required
            value={startsOn}
            onChange={(event) => {
              setStartsOn(event.target.value);
              if (endsOn < event.target.value) setEndsOn(event.target.value);
            }}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
        </div>
        <div>
          <label htmlFor="endsOn" className="block text-[12px] font-medium">
            To
          </label>
          <input
            id="endsOn"
            name="endsOn"
            type="date"
            required
            value={endsOn}
            min={startsOn}
            onChange={(event) => setEndsOn(event.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-4 text-[13px]">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="halfDayStart" />
          Half day on the first day
        </label>
        {endsOn !== startsOn && (
          <label className="flex items-center gap-2">
            <input type="checkbox" name="halfDayEnd" />
            Half day on the last day
          </label>
        )}
      </div>

      <p className="text-[11px] text-[var(--color-muted)]">
        Rest days and public holidays inside the span are not counted, so the days used may be fewer
        than the dates suggest. The figure is worked out on submission and kept with the request.
      </p>

      <Field label="Reason" name="reason" />

      {selected?.requiresDocument && (
        <Field
          label="Supporting document"
          name="documentPath"
          required
          hint="This kind of leave needs evidence — a reference to where the certificate is filed."
        />
      )}

      <Button type="submit" variant="primary" disabled={pending || !selected?.isConfigured}>
        {pending ? "Submitting…" : "Submit the request"}
      </Button>
    </form>
  );
}

/**
 * Deciding a request.
 *
 * Approving is one click; refusing needs a reason, because the person reads it.
 * Approving beyond the remaining balance is possible but deliberate, and the audit
 * trail records that it was an exception.
 */
export function LeaveDecision({
  requestId,
  days,
  remaining,
  canDecide,
}: {
  requestId: string;
  days: number;
  remaining: number | null;
  canDecide: boolean;
}) {
  const [state, action, pending] = useActionState(decideLeaveAction, initial);
  const [refusing, setRefusing] = useState(false);

  if (!canDecide) return <span className="text-[11px] text-[var(--color-faint)]">—</span>;

  const short = remaining !== null && days > remaining;

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
          className="w-32 rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[11px]"
        />
        <div className="flex gap-1">
          <button
            type="submit"
            disabled={pending}
            className="rounded bg-[var(--color-danger)] px-2 py-1 text-[11px] text-white disabled:opacity-50"
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

  return (
    <div className="space-y-1">
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      <form action={action} className="space-y-1">
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="action" value="approve" />
        {short && (
          <label className="flex items-start gap-1 text-[10px] text-[var(--color-warn)]">
            <input type="checkbox" name="allowNegativeBalance" className="mt-0.5" required />
            <span>
              {days} days against {remaining} remaining — approve as an exception
            </span>
          </label>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-[var(--color-navy)] bg-[var(--color-navy)] px-2 py-1 text-[11px] text-white disabled:opacity-50"
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

export function CancelLeave({ requestId }: { requestId: string }) {
  const [state, action, pending] = useActionState(decideLeaveAction, initial);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-[11px] text-[var(--color-muted)] hover:underline"
      >
        Cancel
      </button>
    );
  }

  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="action" value="cancel" />
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      <input
        name="reason"
        required
        placeholder="Why"
        aria-label="Reason for cancelling"
        className="w-28 rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[11px]"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-[var(--color-warn)] px-2 py-1 text-[11px] text-white disabled:opacity-50"
      >
        {pending ? "…" : "Cancel it"}
      </button>
    </form>
  );
}

/**
 * Configuring a leave type.
 *
 * The entitlement field and the source field are deliberately adjacent and the
 * source is required whenever a figure is given. For statutory leave this is the
 * difference between granting somebody their minimum and guessing at it.
 */
export function LeaveTypeForm() {
  const [state, action, pending] = useActionState(saveLeaveTypeAction, initial);
  const [days, setDays] = useState("");

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" name="code" required />
        <Field label="Name" name="name" required />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="defaultDays" className="block text-[12px] font-medium">
            Days a year
          </label>
          <input
            id="defaultDays"
            name="defaultDays"
            inputMode="decimal"
            value={days}
            onChange={(event) => setDays(event.target.value)}
            className="numeric mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-right text-[14px]"
          />
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            Leave blank if it is not yet known. Blank is honest; a guess is not.
          </p>
        </div>
        <Field
          label="Where the figure comes from"
          name="entitlementSource"
          required={days.trim() !== ""}
          hint="The Employment Act section, or the company policy that exceeds it. Required once a figure is entered."
        />
      </div>

      <Field label="Carry forward, at most" name="carryForwardMax" inputMode="numeric" />

      <div className="flex flex-wrap gap-4 text-[13px]">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="isPaid" defaultChecked />
          Paid
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="isStatutory" />
          Minimum set by law
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="requiresDocument" />
          Needs evidence
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="allowsBackdating" />
          May be claimed after the fact
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="countsAsAttendance" defaultChecked />
          Counts as attendance
        </label>
      </div>

      <Field label="Notes" name="notes" />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Add the leave type"}
      </Button>
    </form>
  );
}

export function BalanceForm({
  employees,
  types,
  year,
}: {
  employees: EmployeeOption[];
  types: LeaveTypeOption[];
  year: number;
}) {
  const [state, action, pending] = useActionState(saveBalanceAction, initial);
  const [adjustment, setAdjustment] = useState("0");

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <input type="hidden" name="year" value={year} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="b-employeeId" className="block text-[12px] font-medium">
            Who
          </label>
          <select
            id="b-employeeId"
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
          <label htmlFor="b-leaveTypeId" className="block text-[12px] font-medium">
            Leave type
          </label>
          <select
            id="b-leaveTypeId"
            name="leaveTypeId"
            required
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          >
            <option value="">Choose…</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={`Entitled in ${year}`} name="entitledDays" required inputMode="decimal" />
        <Field label="Carried in" name="carriedDays" inputMode="decimal" />
        <div>
          <label htmlFor="adjustmentDays" className="block text-[12px] font-medium">
            Adjustment
          </label>
          <input
            id="adjustmentDays"
            name="adjustmentDays"
            inputMode="decimal"
            value={adjustment}
            onChange={(event) => setAdjustment(event.target.value)}
            className="numeric mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-right text-[14px]"
          />
        </div>
      </div>

      {adjustment.trim() !== "" && adjustment.trim() !== "0" && (
        <Field
          label="Why the adjustment"
          name="reason"
          required
          hint="An adjustment changes somebody's entitlement. Recorded against your name."
        />
      )}

      <Field label="Notes" name="notes" />

      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Saving…" : "Set the balance"}
      </Button>
      <p className="text-[11px] text-[var(--color-muted)]">
        Days taken are not entered here: they are derived from approved requests, so the balance
        cannot disagree with the requests beneath it.
      </p>
    </form>
  );
}
