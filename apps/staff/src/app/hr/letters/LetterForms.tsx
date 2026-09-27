"use client";

import { useActionState, useState } from "react";
import {
  approveTemplateAction,
  generateLetterAction,
  letterAction,
  saveTemplateAction,
} from "./letter-actions";
import type { FormState } from "../../accounting/action-errors";
import { Alert, Button, Field } from "@/components/ui";

const initial: FormState = {};

export interface VariableRow {
  key: string;
  label: string;
  type: string;
  required: boolean;
  hint?: string;
}

const TYPES = [
  { value: "text", label: "Text" },
  { value: "money", label: "Money" },
  { value: "date", label: "Date" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Yes / no (for a conditional clause)" },
];

/**
 * Writing a template.
 *
 * The body is free text with `{{placeholders}}` — what people already write in Word —
 * and the variables are declared in rows beside it rather than as JSON. The engine
 * refuses a placeholder that is not declared, so the two have to agree, and the refusal
 * happens here rather than when a letter is generated for a real person.
 */
export function TemplateForm({
  defaults,
}: {
  defaults?: {
    templateId: string;
    code: string;
    name: string;
    kind: string;
    subject: string;
    body: string;
    variables: VariableRow[];
    sourceRef: string;
    notes: string;
  };
}) {
  const [state, action, pending] = useActionState(saveTemplateAction, initial);
  const [variables, setVariables] = useState<VariableRow[]>(
    defaults?.variables?.length
      ? defaults.variables
      : [
          { key: "employee_name", label: "Employee name", type: "text", required: true },
          { key: "letter_date", label: "Letter date", type: "date", required: true },
        ],
  );
  const [body, setBody] = useState(defaults?.body ?? "");

  const update = (index: number, field: keyof VariableRow, value: string | boolean) => {
    setVariables((current) =>
      current.map((row, position) => (position === index ? { ...row, [field]: value } : row)),
    );
  };

  // What the body refers to, so undeclared placeholders are visible while typing rather
  // than on save.
  const used = Array.from(
    new Set(
      [...body.matchAll(/\{\{\s*(?:#if\s+)?([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]!),
    ),
  ).filter((key) => key !== "else");
  const declared = new Set(variables.map((row) => row.key));
  const undeclared = used.filter((key) => !declared.has(key));

  return (
    <form action={action} className="space-y-4">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}
      {defaults && <input type="hidden" name="templateId" value={defaults.templateId} />}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Code" name="code" required defaultValue={defaults?.code} hint="Short, reused across versions." />
        <Field label="Name" name="name" required defaultValue={defaults?.name} />
        <div>
          <label htmlFor="kind" className="block text-[12px] font-medium">
            Kind
          </label>
          <select
            id="kind"
            name="kind"
            defaultValue={defaults?.kind ?? "custom"}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          >
            <option value="appointment">Appointment</option>
            <option value="confirmation">Confirmation after probation</option>
            <option value="increment">Salary increment</option>
            <option value="promotion">Promotion</option>
            <option value="warning">Warning</option>
            <option value="reference">Reference / certificate</option>
            <option value="termination">Termination</option>
            <option value="custom">Something else</option>
          </select>
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            Only an appointment letter may be dated before somebody joins.
          </p>
        </div>
        <Field
          label="Where the wording came from"
          name="sourceRef"
          defaultValue={defaults?.sourceRef}
          hint="A previous Word template, a model letter."
        />
      </div>

      <Field
        label="Subject line"
        name="subject"
        required
        defaultValue={defaults?.subject}
        hint="May use placeholders too, e.g. Offer of employment — {{position}}."
      />

      <fieldset className="rounded-md border border-[var(--color-line)] p-3">
        <legend className="px-1 text-[12px] font-medium">What the letter may refer to</legend>

        <div className="space-y-2">
          {variables.map((row, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-12">
              <input
                name={`variables[${index}].key`}
                value={row.key}
                onChange={(event) => update(index, "key", event.target.value)}
                placeholder="key"
                aria-label={`Variable ${index + 1} key`}
                className="rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1.5 font-mono text-[12px] sm:col-span-3"
              />
              <input
                name={`variables[${index}].label`}
                value={row.label}
                onChange={(event) => update(index, "label", event.target.value)}
                placeholder="What to call it on the form"
                aria-label={`Variable ${index + 1} label`}
                className="rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1.5 text-[12px] sm:col-span-4"
              />
              <select
                name={`variables[${index}].type`}
                value={row.type}
                onChange={(event) => update(index, "type", event.target.value)}
                aria-label={`Variable ${index + 1} type`}
                className="rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1.5 text-[12px] sm:col-span-3"
              >
                {TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-[11px] sm:col-span-2">
                <input
                  type="checkbox"
                  name={`variables[${index}].required`}
                  checked={row.required}
                  onChange={(event) => update(index, "required", event.target.checked)}
                />
                Required
              </label>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() =>
            setVariables((current) => [
              ...current,
              { key: "", label: "", type: "text", required: true },
            ])
          }
          className="mt-2 text-[11px] text-[var(--color-link)] hover:underline"
        >
          Another one
        </button>

        <p className="mt-2 text-[11px] text-[var(--color-muted)]">
          A required variable with no value refuses to render. That is deliberate: &ldquo;your salary
          will be&nbsp;&nbsp;per month&rdquo; is a letter somebody would act on.
        </p>
      </fieldset>

      <div>
        <label htmlFor="body" className="block text-[12px] font-medium">
          The letter
        </label>
        <textarea
          id="body"
          name="body"
          rows={14}
          required
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={"Dear {{employee_name}},\n\nWe are pleased to offer you…\n\n{{#if has_car_allowance}}\nYou will also receive a car allowance of RM {{car_allowance}} per month.\n{{/if}}\n\nYours sincerely,"}
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 font-mono text-[12px]"
        />
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          A blank line starts a new paragraph. <code>{"{{#if x}}…{{else}}…{{/if}}"}</code> includes a
          clause only when <code>x</code> is set. There are no loops or arithmetic — a template that
          can compute is a template whose output you cannot predict by reading it.
        </p>
      </div>

      {undeclared.length > 0 && (
        <Alert tone="warn">
          The letter refers to {undeclared.map((key) => `{{${key}}}`).join(", ")}, which is not
          declared above. Saving will be refused: a letter reaching somebody with a placeholder
          still in it is worse than no letter.
        </Alert>
      )}

      <Field label="Notes" name="notes" defaultValue={defaults?.notes} />

      <Button type="submit" variant="primary" disabled={pending || undeclared.length > 0}>
        {pending ? "Saving…" : defaults ? "Save the draft" : "Create the template"}
      </Button>
    </form>
  );
}

export function ApproveTemplate({ templateId, label }: { templateId: string; label: string }) {
  const [state, action, pending] = useActionState(approveTemplateAction, initial);

  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="templateId" value={templateId} />
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="btn btn-primary px-2 py-1 text-[11px]"
      >
        {pending ? "…" : `Approve ${label}`}
      </button>
    </form>
  );
}

/**
 * Filling a letter in.
 *
 * The form is built from the template's own declarations, so it asks for exactly what
 * the letter needs. Values that can be read off the employee record are pre-filled,
 * because a letter that disagrees with the record it is about is worse than a slow one.
 */
export function GenerateLetterForm({
  templates,
  employees,
  defaultsByEmployee,
  defaultDate,
  supersedes,
}: {
  templates: Array<{
    code: string;
    name: string;
    kind: string;
    version: number;
    variables: VariableRow[];
  }>;
  employees: Array<{ id: string; employeeNo: string; fullName: string }>;
  /** Pre-fill values per employee, from their record. */
  defaultsByEmployee: Record<string, Record<string, string>>;
  defaultDate: string;
  supersedes?: { id: string; letterNo: string } | null;
}) {
  const [state, action, pending] = useActionState(generateLetterAction, initial);
  const [templateCode, setTemplateCode] = useState(templates[0]?.code ?? "");
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? "");

  const template = templates.find((row) => row.code === templateCode);
  const prefill = defaultsByEmployee[employeeId] ?? {};

  if (templates.length === 0) {
    return (
      <p className="text-[12px] text-[var(--color-muted)]">
        No approved template exists yet. A draft cannot be used to write to somebody, because its
        wording has not been agreed as what the firm says.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {supersedes && <input type="hidden" name="supersedesLetterId" value={supersedes.id} />}

      {supersedes && (
        <Alert tone="info">
          This will supersede {supersedes.letterNo}. The original stays exactly as it was — both
          letters show the relationship.
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="templateCode" className="block text-[12px] font-medium">
            Which letter
          </label>
          <select
            id="templateCode"
            name="templateCode"
            required
            value={templateCode}
            onChange={(event) => setTemplateCode(event.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          >
            {templates.map((row) => (
              <option key={row.code} value={row.code}>
                {row.name} (v{row.version})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="employeeId" className="block text-[12px] font-medium">
            To whom
          </label>
          <select
            id="employeeId"
            name="employeeId"
            required
            value={employeeId}
            onChange={(event) => setEmployeeId(event.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          >
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.employeeNo} — {employee.fullName}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Field label="Letter date" name="letterDate" type="date" required defaultValue={defaultDate} />

      {template && template.variables.length > 0 && (
        <fieldset className="rounded-md border border-[var(--color-line)] p-3">
          <legend className="px-1 text-[12px] font-medium">What this letter says</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {template.variables.map((variable) => {
              const value = prefill[variable.key] ?? "";

              if (variable.type === "boolean") {
                return (
                  <label key={variable.key} className="flex items-center gap-2 text-[13px]">
                    <input type="checkbox" name={`value.${variable.key}`} value="true" />
                    {variable.label}
                  </label>
                );
              }

              return (
                <div key={variable.key}>
                  <label
                    htmlFor={`value.${variable.key}`}
                    className="block text-[12px] font-medium"
                  >
                    {variable.label}
                    {variable.required && <span className="text-[var(--color-danger)]"> *</span>}
                  </label>
                  <input
                    id={`value.${variable.key}`}
                    name={`value.${variable.key}`}
                    type={variable.type === "date" ? "date" : "text"}
                    required={variable.required}
                    defaultValue={value}
                    inputMode={
                      variable.type === "money" || variable.type === "number"
                        ? "decimal"
                        : undefined
                    }
                    className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
                  />
                  {value !== "" && (
                    <p className="mt-0.5 text-[10px] text-[var(--color-muted)]">
                      Filled from the employee record.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      )}

      <Field label="Notes, for the file" name="notes" />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Generating…" : "Generate the draft"}
      </Button>
      <p className="text-[11px] text-[var(--color-muted)]">
        A draft. It needs approving before it can be issued, and the wording and values are kept with
        it so that revising the template later cannot change what this letter says.
      </p>
    </form>
  );
}

export function LetterActions({
  letterId,
  status,
  canApprove,
  canIssue,
  isAuthor,
}: {
  letterId: string;
  status: string;
  canApprove: boolean;
  canIssue: boolean;
  isAuthor: boolean;
}) {
  const [state, action, pending] = useActionState(letterAction, initial);
  const [issuing, setIssuing] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  return (
    <div className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      {status === "draft" && (
        <div className="space-y-2">
          {isAuthor ? (
            <p className="text-[12px] text-[var(--color-muted)]">
              You generated this letter, so somebody else has to approve it.
            </p>
          ) : canApprove ? (
            <form action={action}>
              <input type="hidden" name="letterId" value={letterId} />
              <input type="hidden" name="action" value="approve" />
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? "…" : "Approve it"}
              </Button>
            </form>
          ) : (
            <p className="text-[12px] text-[var(--color-muted)]">
              Waiting for somebody who can approve letters. An appointment letter states somebody&rsquo;s
              terms of employment, so one person does not send it alone.
            </p>
          )}
        </div>
      )}

      {status === "approved" && canIssue && (
        <>
          {issuing ? (
            <form action={action} className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
              <input type="hidden" name="letterId" value={letterId} />
              <input type="hidden" name="action" value="issue" />
              <label htmlFor="deliveryNote" className="block text-[12px] font-medium">
                How is it reaching them?
              </label>
              <input
                id="deliveryNote"
                name="deliveryNote"
                placeholder="Handed over in person, signed copy on file"
                className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[13px]"
              />
              <p className="text-[11px] text-[var(--color-muted)]">
                Recorded, because &ldquo;was it actually given to them&rdquo; is the question asked
                afterwards. Issuing fixes the letter permanently.
              </p>
              <div className="flex gap-2">
                <Button type="submit" variant="primary" disabled={pending}>
                  {pending ? "…" : "Issue it"}
                </Button>
                <button
                  type="button"
                  onClick={() => setIssuing(false)}
                  className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
                >
                  Not yet
                </button>
              </div>
            </form>
          ) : (
            <Button type="button" variant="primary" onClick={() => setIssuing(true)}>
              Issue it
            </Button>
          )}
        </>
      )}

      {(status === "draft" || status === "approved") && canIssue && (
        <>
          {cancelling ? (
            <form action={action} className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
              <input type="hidden" name="letterId" value={letterId} />
              <input type="hidden" name="action" value="cancel" />
              <input
                name="reason"
                required
                placeholder="Why it is being cancelled"
                className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[13px]"
              />
              <div className="flex gap-2">
                <Button type="submit" variant="danger" disabled={pending}>
                  {pending ? "…" : "Cancel it"}
                </Button>
                <button
                  type="button"
                  onClick={() => setCancelling(false)}
                  className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
                >
                  Keep it
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setCancelling(true)}
              className="text-[12px] text-[var(--color-muted)] hover:underline"
            >
              Cancel this draft
            </button>
          )}
        </>
      )}

      {status === "issued" && (
        <p className="text-[12px] text-[var(--color-muted)]">
          Issued. Nothing about it can change now. If it was wrong, generate a corrected letter that
          supersedes it — both stay on the record, which is what somebody holding a copy deserves.
        </p>
      )}

      {status === "cancelled" && (
        <p className="text-[12px] text-[var(--color-muted)]">
          Cancelled. Nothing was issued.
        </p>
      )}
    </div>
  );
}
