"use client";

import { useActionState, useState } from "react";
import { saveDepartment, savePosition, saveSchedule } from "../hr-actions";
import type { FormState } from "../../accounting/action-errors";
import { Alert, Button, Field, Select } from "@/components/ui";

const initial: FormState = {};

export interface Option {
  id: string;
  code: string;
  name: string;
}

export function DepartmentForm({
  departments,
  costCentres,
  employees,
}: {
  departments: Option[];
  costCentres: Option[];
  employees: Option[];
}) {
  const [state, action, pending] = useActionState(saveDepartment, initial);

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" name="code" required hint="Short, and it does not change." />
        <Field label="Name" name="name" required />
        <Select
          label="Sits under"
          name="parentId"
          placeholder="Nothing — it is top level"
          options={departments.map((row) => ({ value: row.id, label: `${row.code} ${row.name}` }))}
        />
        <Select
          label="Cost centre"
          name="costCentreId"
          placeholder="None"
          options={costCentres.map((row) => ({ value: row.id, label: `${row.code} ${row.name}` }))}
          hint="Where this department's payroll is charged."
        />
        <Select
          label="Head of department"
          name="headEmployeeId"
          placeholder="Not set"
          options={employees.map((row) => ({ value: row.id, label: row.name }))}
        />
      </div>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Add the department"}
      </Button>
    </form>
  );
}

export function PositionForm({ departments }: { departments: Option[] }) {
  const [state, action, pending] = useActionState(savePosition, initial);

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" name="code" required />
        <Field label="Title" name="title" required />
        <Select
          label="Department"
          name="departmentId"
          placeholder="None"
          options={departments.map((row) => ({ value: row.id, label: `${row.code} ${row.name}` }))}
        />
        <Field label="Grade" name="grade" hint="Free text: CAC has not stated a grade scheme." />
      </div>

      <Field label="What the role covers" name="description" />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Add the position"}
      </Button>
    </form>
  );
}

const DAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

/**
 * A work schedule.
 *
 * This form decides what "late" means, which is why the grace period is on it and
 * labelled as a company decision rather than a statutory one. The running total at
 * the bottom is shown because a break longer than the working day is a mistake that
 * is otherwise only caught by the server.
 */
export function ScheduleForm() {
  const [state, action, pending] = useActionState(saveSchedule, initial);
  const [startsAt, setStartsAt] = useState("09:00");
  const [endsAt, setEndsAt] = useState("18:00");
  const [breakMinutes, setBreakMinutes] = useState("60");
  const [crossesMidnight, setCrossesMidnight] = useState(false);

  const minutes = (time: string) => {
    const [hours, mins] = time.split(":");
    return Number(hours) * 60 + Number(mins);
  };

  const span = crossesMidnight
    ? 1440 - minutes(startsAt) + minutes(endsAt)
    : minutes(endsAt) - minutes(startsAt);
  const net = span - (Number(breakMinutes) || 0);

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" name="code" required />
        <Field label="Name" name="name" required />
      </div>

      <fieldset>
        <legend className="text-[12px] font-medium">Working days</legend>
        <div className="mt-1 flex flex-wrap gap-3">
          {DAYS.map((day) => (
            <label key={day.value} className="flex items-center gap-1.5 text-[13px]">
              <input
                type="checkbox"
                name="workDays"
                value={day.value}
                defaultChecked={day.value <= 5}
              />
              {day.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="startsAt" className="block text-[12px] font-medium">
            Starts
          </label>
          <input
            id="startsAt"
            name="startsAt"
            type="time"
            required
            value={startsAt}
            onChange={(event) => setStartsAt(event.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          />
        </div>
        <div>
          <label htmlFor="endsAt" className="block text-[12px] font-medium">
            Ends
          </label>
          <input
            id="endsAt"
            name="endsAt"
            type="time"
            required
            value={endsAt}
            onChange={(event) => setEndsAt(event.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          />
        </div>
        <div>
          <label htmlFor="breakMinutes" className="block text-[12px] font-medium">
            Unpaid break (minutes)
          </label>
          <input
            id="breakMinutes"
            name="breakMinutes"
            type="number"
            min={0}
            max={480}
            value={breakMinutes}
            onChange={(event) => setBreakMinutes(event.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          />
        </div>
        <div>
          <label htmlFor="graceMinutes" className="block text-[12px] font-medium">
            Grace before late (minutes)
          </label>
          <input
            id="graceMinutes"
            name="graceMinutes"
            type="number"
            min={0}
            max={120}
            defaultValue={10}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-4 text-[13px]">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="crossesMidnight"
            checked={crossesMidnight}
            onChange={(event) => setCrossesMidnight(event.target.checked)}
          />
          The shift ends the next day
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="isDefault" />
          Use this for anybody without a schedule of their own
        </label>
      </div>

      <p className={`text-[12px] ${net <= 0 ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"}`}>
        {net <= 0
          ? "That leaves no time worked — check the break, or whether the shift crosses midnight."
          : `A scheduled day is ${Math.floor(net / 60)}h ${net % 60}m of work.`}
      </p>

      <Field label="Notes" name="notes" />

      <Button type="submit" variant="primary" disabled={pending || net <= 0}>
        {pending ? "Saving…" : "Add the schedule"}
      </Button>
    </form>
  );
}
