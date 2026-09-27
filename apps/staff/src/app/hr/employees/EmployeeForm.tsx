"use client";

import { useActionState, useState } from "react";
import { saveEmployee } from "../hr-actions";
import type { FormState } from "../../accounting/action-errors";
import { Alert, Button, Field, FieldSet, Select } from "@/components/ui";

const initial: FormState = {};

export interface Option {
  id: string;
  code: string;
  name: string;
}

export interface EmployeeDefaults {
  employeeId: string;
  employeeNo: string;
  fullName: string;
  preferredName: string;
  nricLast4: string | null;
  nationality: string;
  gender: string;
  maritalStatus: string;
  email: string;
  phone: string;
  positionId: string;
  departmentId: string;
  reportsToId: string;
  costCentreId: string;
  workScheduleId: string;
  employmentType: string;
  joinedOn: string;
  probationMonths: number;
  epfApplicable: boolean;
  socsoApplicable: boolean;
  eisApplicable: boolean;
  pcbApplicable: boolean;
  taxDependants: number;
  bankName: string;
  bankAccountLast4: string | null;
  payFrequency: string;
  deviceUserId: string;
  notes: string;
}

/**
 * The employee record.
 *
 * Two deliberate choices about the sensitive fields.
 *
 * On an **edit**, the identity card number and the bank account are not pre-filled
 * — they are ciphertext on the server and putting them back on the page would mean
 * decrypting them into a form nobody asked to see. Leaving the field blank keeps
 * what is stored; typing in it replaces it. The label says so, because a blank box
 * beside "identity card number" otherwise looks like missing data.
 *
 * Everything else is posted on every save, including fields nobody touched. The
 * server treats an absent field as "leave alone", so a partial post would silently
 * clear whatever the form omitted.
 */
export function EmployeeForm({
  departments,
  positions,
  schedules,
  managers,
  costCentres,
  defaults,
  defaultJoinedOn,
}: {
  departments: Option[];
  positions: Array<Option & { departmentId: string | null }>;
  schedules: Array<{ id: string; code: string; name: string; summary: string; isDefault: boolean }>;
  managers: Option[];
  costCentres: Option[];
  defaults?: EmployeeDefaults;
  defaultJoinedOn: string;
}) {
  const [state, action, pending] = useActionState(saveEmployee, initial);
  const [nationality, setNationality] = useState(defaults?.nationality ?? "Malaysian");

  const editing = Boolean(defaults);

  return (
    <form action={action} className="space-y-5">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {defaults && <input type="hidden" name="employeeId" value={defaults.employeeId} />}

      <FieldSet legend="Who they are">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Full name, as on the identity card" name="fullName" required defaultValue={defaults?.fullName} />
          <Field label="Known as" name="preferredName" defaultValue={defaults?.preferredName} />
          <Field
            label="Employee number"
            name="employeeNo"
            defaultValue={defaults?.employeeNo}
            hint={editing ? undefined : "Left blank, one is allocated."}
          />

          <div>
            <label htmlFor="f-nationality" className="block text-[12px] font-medium">
              Nationality
            </label>
            <select
              id="f-nationality"
              name="nationality"
              value={nationality}
              onChange={(event) => setNationality(event.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
            >
              <option value="Malaysian">Malaysian</option>
              <option value="Other">Other</option>
            </select>
          </div>

          {nationality === "Malaysian" ? (
            <Field
              label="Identity card number"
              name="nric"
              inputMode="numeric"
              hint={
                editing
                  ? defaults?.nricLast4
                    ? `Ends ${defaults.nricLast4}. Leave blank to keep it; type to replace it.`
                    : "Not recorded. Encrypted when stored."
                  : "Twelve digits. Encrypted at rest; only the last four are ever shown."
              }
            />
          ) : (
            <Field
              label="Passport number"
              name="passportNo"
              hint="Encrypted at rest. Leave blank to keep what is stored."
            />
          )}

          <Field label="Date of birth" name="dateOfBirth" type="date" />
          <Select
            label="Gender"
            name="gender"
            placeholder="Not stated"
            defaultValue={defaults?.gender}
            options={[
              { value: "female", label: "Female" },
              { value: "male", label: "Male" },
            ]}
          />
          <Select
            label="Marital status"
            name="maritalStatus"
            placeholder="Not stated"
            defaultValue={defaults?.maritalStatus}
            options={[
              { value: "single", label: "Single" },
              { value: "married", label: "Married" },
              { value: "divorced", label: "Divorced" },
              { value: "widowed", label: "Widowed" },
            ]}
          />
        </div>
      </FieldSet>

      <FieldSet legend="Getting hold of them">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Work email" name="email" type="email" defaultValue={defaults?.email} />
          <Field label="Personal email" name="personalEmail" type="email" />
          <Field label="Phone" name="phone" defaultValue={defaults?.phone} />
          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="Address" name="address" />
          </div>
          <Field label="Emergency contact" name="emergencyContact" />
          <Field label="Emergency phone" name="emergencyPhone" />
        </div>
      </FieldSet>

      <FieldSet legend="The job">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Select
            label="Department"
            name="departmentId"
            placeholder="None"
            defaultValue={defaults?.departmentId}
            options={departments.map((row) => ({ value: row.id, label: `${row.code} ${row.name}` }))}
          />
          <Select
            label="Position"
            name="positionId"
            placeholder="None"
            defaultValue={defaults?.positionId}
            options={positions.map((row) => ({ value: row.id, label: `${row.code} ${row.name}` }))}
          />
          <Select
            label="Reports to"
            name="reportsToId"
            placeholder="Nobody"
            defaultValue={defaults?.reportsToId}
            options={managers.map((row) => ({ value: row.id, label: `${row.code} ${row.name}` }))}
          />
          <Select
            label="Cost centre"
            name="costCentreId"
            placeholder="None"
            defaultValue={defaults?.costCentreId}
            options={costCentres.map((row) => ({ value: row.id, label: `${row.code} ${row.name}` }))}
            hint="Which cost centre their payroll is charged to."
          />
          <Select
            label="Employment type"
            name="employmentType"
            defaultValue={defaults?.employmentType ?? "permanent"}
            options={[
              { value: "permanent", label: "Permanent" },
              { value: "probation", label: "On probation" },
              { value: "contract", label: "Contract" },
              { value: "part_time", label: "Part time" },
              { value: "intern", label: "Intern" },
            ]}
          />
          <Select
            label="Work schedule"
            name="workScheduleId"
            placeholder="The default"
            defaultValue={defaults?.workScheduleId}
            options={schedules.map((row) => ({
              value: row.id,
              label: `${row.name} (${row.summary})${row.isDefault ? " — default" : ""}`,
            }))}
            hint="Decides what counts as late."
          />
          <Field
            label="Joined on"
            name="joinedOn"
            type="date"
            required
            defaultValue={defaults?.joinedOn ?? defaultJoinedOn}
          />
          <Field
            label="Probation (months)"
            name="probationMonths"
            type="number"
            inputMode="numeric"
            defaultValue={String(defaults?.probationMonths ?? 3)}
          />
          <Field
            label="Device number"
            name="deviceUserId"
            defaultValue={defaults?.deviceUserId}
            hint="What the thumbprint reader calls them. Without it their scans cannot be matched."
          />
        </div>
      </FieldSet>

      <FieldSet legend="Pay">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label="Basic salary (RM)"
            name="basicSalary"
            required
            inputMode="numeric"
            hint={
              editing
                ? "Changing this records a dated change in the employment history."
                : "The figure they start on."
            }
          />
          <Select
            label="Paid"
            name="payFrequency"
            defaultValue={defaults?.payFrequency ?? "monthly"}
            options={[
              { value: "monthly", label: "Monthly" },
              { value: "daily", label: "Daily" },
              { value: "hourly", label: "Hourly" },
            ]}
          />
          <Field label="Bank" name="bankName" defaultValue={defaults?.bankName} />
          <Field
            label="Bank account number"
            name="bankAccountNo"
            hint={
              editing
                ? defaults?.bankAccountLast4
                  ? `Ends ${defaults.bankAccountLast4}. Leave blank to keep it.`
                  : "Not recorded."
                : "Encrypted at rest."
            }
          />
        </div>
      </FieldSet>

      <FieldSet legend="Statutory">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="EPF number" name="epfNo" />
          <Field label="SOCSO number" name="socsoNo" />
          <Field label="Income tax number" name="incomeTaxNo" />
          <Field
            label="Dependants claimed"
            name="taxDependants"
            type="number"
            inputMode="numeric"
            defaultValue={String(defaults?.taxDependants ?? 0)}
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-4 text-[13px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="epfApplicable" defaultChecked={defaults?.epfApplicable ?? true} />
            EPF applies
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="socsoApplicable"
              defaultChecked={defaults?.socsoApplicable ?? true}
            />
            SOCSO applies
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="eisApplicable" defaultChecked={defaults?.eisApplicable ?? true} />
            EIS applies
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="pcbApplicable" defaultChecked={defaults?.pcbApplicable ?? true} />
            PCB applies
          </label>
        </div>

        <p className="mt-2 text-[11px] text-[var(--color-muted)]">
          These say <em>whether</em> each contribution applies to this person. How much is a
          statutory schedule, and none is loaded — see Q-HR-1. Payroll will refuse to run until the
          official schedules are in place.
        </p>
      </FieldSet>

      <Field label="Notes" name="notes" defaultValue={defaults?.notes} />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : editing ? "Save changes" : "Create the record"}
      </Button>
    </form>
  );
}
