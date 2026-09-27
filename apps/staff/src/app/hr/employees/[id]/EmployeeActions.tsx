"use client";

import { useActionState, useState } from "react";
import {
  revealSensitive,
  saveDeviceMapping,
  saveEmploymentEvent,
  type SensitiveState,
} from "../../hr-actions";
import type { FormState } from "../../../accounting/action-errors";
import { Alert, Button } from "@/components/ui";

const initial: FormState = {};
const initialSensitive: SensitiveState = {};

export interface Option {
  id: string;
  code: string;
  name: string;
}

/**
 * Recording a change in somebody's employment.
 *
 * One form, because a confirmation, a promotion, a raise and an exit are the same
 * kind of fact: something that took effect on a date. Which extra fields appear
 * follows from the kind, and an exit demands a reason — it is the first thing
 * anybody asks afterwards.
 */
export function EmploymentEventForm({
  employeeId,
  positions,
  departments,
  canTerminate,
  suggestedDate,
}: {
  employeeId: string;
  positions: Option[];
  departments: Option[];
  canTerminate: boolean;
  suggestedDate: string;
}) {
  const [state, action, pending] = useActionState(saveEmploymentEvent, initial);
  const [kind, setKind] = useState("confirmed");

  const changesPay = kind === "salary_changed" || kind === "promoted";
  const changesRole = kind === "promoted" || kind === "transferred";
  const exiting = kind === "resigned" || kind === "terminated";

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <input type="hidden" name="employeeId" value={employeeId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="kind" className="block text-[12px] font-medium">
            What happened
          </label>
          <select
            id="kind"
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          >
            <option value="confirmed">Confirmed after probation</option>
            <option value="salary_changed">Salary changed</option>
            <option value="promoted">Promoted</option>
            <option value="transferred">Transferred</option>
            <option value="type_changed">Employment type changed</option>
            <option value="suspended">Suspended</option>
            <option value="reinstated">Reinstated</option>
            {canTerminate && <option value="resigned">Resigned</option>}
            {canTerminate && <option value="terminated">Employment terminated</option>}
            <option value="corrected">Correction to the record</option>
          </select>
        </div>

        <div>
          <label htmlFor="effectiveFrom" className="block text-[12px] font-medium">
            Effective from
          </label>
          <input
            id="effectiveFrom"
            name="effectiveFrom"
            type="date"
            required
            defaultValue={suggestedDate}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          />
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            The date it took effect, not today. Payroll reads this.
          </p>
        </div>
      </div>

      {changesPay && (
        <div>
          <label htmlFor="basicSalary" className="block text-[12px] font-medium">
            New basic salary (RM)
          </label>
          <input
            id="basicSalary"
            name="basicSalary"
            required
            inputMode="decimal"
            className="numeric mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-right text-[14px]"
          />
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            Recorded against the date above, so a payroll run for an earlier month still finds the
            old figure.
          </p>
        </div>
      )}

      {changesRole && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="positionId" className="block text-[12px] font-medium">
              New position
            </label>
            <select
              id="positionId"
              name="positionId"
              className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
            >
              <option value="">Unchanged</option>
              {positions.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.code} {row.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="departmentId" className="block text-[12px] font-medium">
              New department
            </label>
            <select
              id="departmentId"
              name="departmentId"
              className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
            >
              <option value="">Unchanged</option>
              {departments.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.code} {row.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {kind === "type_changed" && (
        <div>
          <label htmlFor="employmentType" className="block text-[12px] font-medium">
            New employment type
          </label>
          <select
            id="employmentType"
            name="employmentType"
            required
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          >
            <option value="permanent">Permanent</option>
            <option value="probation">On probation</option>
            <option value="contract">Contract</option>
            <option value="part_time">Part time</option>
            <option value="intern">Intern</option>
          </select>
        </div>
      )}

      <div>
        <label htmlFor="reason" className="block text-[12px] font-medium">
          Reason {exiting && <span className="text-[var(--color-danger)]">*</span>}
        </label>
        <input
          id="reason"
          name="reason"
          required={exiting}
          placeholder={exiting ? "Why the employment ended" : "Optional, but worth writing"}
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
        />
      </div>

      {exiting && (
        <Alert tone="warn">
          This ends the employment from the date above. Attendance cannot be recorded after it, and
          only a correction can be recorded against the person afterwards.
        </Alert>
      )}

      <Button type="submit" variant={exiting ? "danger" : "primary"} disabled={pending}>
        {pending ? "Recording…" : "Record it"}
      </Button>
    </form>
  );
}

export function DeviceMappingForm({
  employeeId,
  current,
}: {
  employeeId: string;
  current: string | null;
}) {
  const [state, action, pending] = useActionState(saveDeviceMapping, initial);

  return (
    <form action={action} className="space-y-2">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <input type="hidden" name="employeeId" value={employeeId} />

      <label htmlFor="deviceUserId" className="block text-[12px] font-medium">
        Device number
      </label>
      <input
        id="deviceUserId"
        name="deviceUserId"
        required
        defaultValue={current ?? ""}
        className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
      />
      <p className="text-[11px] text-[var(--color-muted)]">
        What the thumbprint reader calls this person. Until it is set their scans arrive with
        nobody to attach them to, and the import reports them rather than guessing by name.
      </p>

      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Saving…" : current ? "Change it" : "Map it"}
      </Button>
    </form>
  );
}

/**
 * Showing the identity and pay details, on the record.
 *
 * The reason field is not a formality. The capability alone satisfies the code, but
 * "why did somebody look at this person's identity card number in March" is a
 * question PDPA makes real, and it is only answerable if the reason was captured at
 * the time.
 */
export function SensitiveReveal({ employeeId }: { employeeId: string }) {
  const [state, action, pending] = useActionState(revealSensitive, initialSensitive);

  if (state.revealed) {
    const details = state.revealed;
    return (
      <div className="space-y-3">
        <Alert tone="warn">
          Shown once, and recorded: your name, the time and your reason are in the audit trail.
          Close the page when you are done.
        </Alert>

        <dl className="space-y-2 text-[13px]">
          <Row label="Identity card" value={details.nric} mono />
          <Row label="Passport" value={details.passportNo} mono />
          <Row label="Date of birth" value={details.dateOfBirth} />
          <Row label="Address" value={details.address} />
          <Row label="Personal email" value={details.personalEmail} />
          <Row label="Emergency contact" value={details.emergencyContact} />
          <Row label="Emergency phone" value={details.emergencyPhone} />
          <div className="border-t border-[var(--color-line)] pt-2">
            <Row label="EPF number" value={details.epfNo} mono />
            <Row label="SOCSO number" value={details.socsoNo} mono />
            <Row label="Income tax number" value={details.incomeTaxNo} mono />
          </div>
          <div className="border-t border-[var(--color-line)] pt-2">
            <Row label="Bank" value={details.bankName} />
            <Row label="Account number" value={details.bankAccountNo} mono />
            <Row label="Basic salary" value={details.basicSalary} mono />
          </div>
        </dl>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <input type="hidden" name="employeeId" value={employeeId} />

      <p className="text-[12px] text-[var(--color-muted)]">
        The identity card number, bank account and salary are held encrypted. Showing them is
        recorded against your name, with the reason you give.
      </p>

      <div>
        <label htmlFor="reason" className="block text-[12px] font-medium">
          Why do you need them?
        </label>
        <input
          id="reason"
          name="reason"
          required
          placeholder="Preparing the EPF submission for March"
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
        />
      </div>

      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "…" : "Show them"}
      </Button>
    </form>
  );
}

function Row({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className={mono ? "font-mono text-[12px]" : ""}>
        {value ?? <span className="text-[var(--color-faint)]">not recorded</span>}
      </dd>
    </div>
  );
}
