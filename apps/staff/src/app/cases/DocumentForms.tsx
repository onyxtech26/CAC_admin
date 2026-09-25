"use client";

import { useActionState, useState } from "react";
import {
  approveCaseTemplateAction,
  approveDocumentAction,
  cancelDocumentAction,
  finaliseDocumentAction,
  generateDocumentAction,
  saveCaseTemplateAction,
} from "./document-actions";
import type { FormState } from "../accounting/action-errors";
import { Alert, Button, Field, Select, Textarea } from "@/components/ui";

const initial: FormState = {};

function Result({ state }: { state: FormState }) {
  if (state.error) return <Alert tone="danger">{state.error}</Alert>;
  if (state.notice) return <Alert tone="ok">{state.notice}</Alert>;
  return null;
}

export interface Option {
  value: string;
  label: string;
}

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

const KINDS = [
  { value: "application", label: "Application" },
  { value: "affidavit", label: "Affidavit" },
  { value: "inventory", label: "Inventory" },
  { value: "schedule", label: "Schedule" },
  { value: "letter", label: "Letter" },
  { value: "report", label: "Report" },
  { value: "other", label: "Other" },
];

/** The kinds whose wording must cite the form or precedent it follows. */
const LEGAL_KINDS = new Set(["application", "affidavit", "schedule"]);

/**
 * Writing a case document template.
 *
 * The body is free text with `{{placeholders}}` and `{{#if}}…{{else}}…{{/if}}` — what people
 * already write in Word — and the variables are declared in rows beside it. The engine refuses
 * a placeholder nothing declares, so the two have to agree, and the refusal happens here rather
 * than when somebody generates an application for a real estate.
 */
export function CaseTemplateForm({
  matterTypes,
  defaults,
}: {
  matterTypes: Option[];
  defaults?: {
    templateId: string;
    code: string;
    name: string;
    kind: string;
    title: string;
    body: string;
    variables: VariableRow[];
    sourceRef: string;
    notes: string;
    matterTypes: string[];
  };
}) {
  const [state, action, pending] = useActionState(saveCaseTemplateAction, initial);
  const [kind, setKind] = useState(defaults?.kind ?? "application");
  const [variables, setVariables] = useState<VariableRow[]>(
    defaults?.variables?.length
      ? defaults.variables
      : [
          { key: "deceased_name", label: "Name of the deceased", type: "text", required: true },
          { key: "document_date", label: "Date of the document", type: "date", required: true },
        ],
  );

  const update = (index: number, field: keyof VariableRow, value: string | boolean) =>
    setVariables((current) =>
      current.map((row, position) => (position === index ? { ...row, [field]: value } : row)),
    );

  return (
    <form action={action} className="space-y-3">
      <Result state={state} />
      {defaults && <input type="hidden" name="templateId" value={defaults.templateId} />}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Code"
          name="code"
          required
          defaultValue={defaults?.code}
          hint="Upper case — for example PROBATE_APP."
        />
        <Field label="Name" name="name" required defaultValue={defaults?.name} />
        <div>
          <label htmlFor="f-kind" className="block text-[12px] font-medium">
            Kind of document
          </label>
          <select
            id="f-kind"
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          >
            {KINDS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        <Field label="Title on the document" name="title" required defaultValue={defaults?.title} />
        <Field
          label="The form or precedent it follows"
          name="sourceRef"
          required={LEGAL_KINDS.has(kind)}
          defaultValue={defaults?.sourceRef}
          hint={
            LEGAL_KINDS.has(kind)
              ? "Required for this kind. Without it this is somebody's recollection of a court form, and it will be produced to a registry."
              : "Optional for this kind, and still worth recording."
          }
        />
      </div>

      <fieldset className="rounded-md border border-[var(--color-line)] p-3">
        <legend className="px-1 text-[12px] font-medium">Which matters it may be used on</legend>
        <p className="mb-2 text-[11px] text-[var(--color-muted)]">
          Leave all unticked to allow any matter.
        </p>
        <div className="flex flex-wrap gap-3">
          {matterTypes.map((type) => (
            <label key={type.value} className="flex items-center gap-1 text-[12px]">
              <input
                type="checkbox"
                name="matterTypes"
                value={type.value}
                defaultChecked={defaults?.matterTypes?.includes(type.value)}
              />{" "}
              {type.label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-[var(--color-line)] p-3">
        <legend className="px-1 text-[12px] font-medium">The variables the body may use</legend>
        <div className="space-y-2">
          {variables.map((row, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1.2fr_1.5fr_1fr_auto_auto]">
              <input
                name={`variables[${index}].key`}
                value={row.key}
                onChange={(event) => update(index, "key", event.target.value)}
                placeholder="key"
                className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[12px]"
              />
              <input
                name={`variables[${index}].label`}
                value={row.label}
                onChange={(event) => update(index, "label", event.target.value)}
                placeholder="Label"
                className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[12px]"
              />
              <select
                name={`variables[${index}].type`}
                value={row.type}
                onChange={(event) => update(index, "type", event.target.value)}
                className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[12px]"
              >
                {TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-[11px]">
                <input
                  type="checkbox"
                  name={`variables[${index}].required`}
                  checked={row.required}
                  onChange={(event) => update(index, "required", event.target.checked)}
                />
                required
              </label>
              <button
                type="button"
                onClick={() => setVariables((current) => current.filter((_, at) => at !== index))}
                className="text-[11px] text-[var(--color-danger)] hover:underline"
              >
                Remove
              </button>
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
          className="mt-2 text-[12px] text-[var(--color-info)] hover:underline"
        >
          Add a variable
        </button>
      </fieldset>

      <Textarea
        label="The body"
        name="body"
        rows={16}
        required
        defaultValue={defaults?.body}
        hint="Placeholders as {{key}}. A conditional clause is {{#if flag}}…{{else}}…{{/if}}. A placeholder nothing declares is refused — including inside a branch that is not taken."
      />

      <Textarea label="Notes" name="notes" rows={2} defaultValue={defaults?.notes} />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Save as a draft"}
      </Button>
      <p className="text-[11px] text-[var(--color-muted)]">
        A draft produces nothing. Somebody other than its author, holding{" "}
        <span className="font-mono">case.document.approve</span>, has to approve it first — and for
        an application, an affidavit or a schedule, only once an authorised legal reviewer has been
        appointed.
      </p>
    </form>
  );
}

export function ApproveCaseTemplate({ templateId, label }: { templateId: string; label: string }) {
  const [state, action, pending] = useActionState(approveCaseTemplateAction, initial);

  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="templateId" value={templateId} />
      <Button type="submit" disabled={pending}>
        {pending ? "…" : `Approve ${label}`}
      </Button>
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
    </form>
  );
}

/**
 * Filling a document in.
 *
 * The values are pre-filled from what the matter already knows, and every one can be
 * overwritten. Nothing is filled in that the matter has not recorded: a blank stays a blank, and
 * the engine refuses to render a required blank rather than guessing at it.
 */
export function GenerateDocumentForm({
  caseId,
  templates,
  variables,
  defaults,
  templateId,
  supersedes,
}: {
  caseId: string;
  templates: Option[];
  variables: VariableRow[];
  defaults: Record<string, string>;
  templateId: string | null;
  supersedes: Option[];
}) {
  const [state, action, pending] = useActionState(generateDocumentAction, initial);

  // Choosing a template reloads the page, because the variables to fill in depend on it —
  // and the server is what knows them.
  if (!templateId) {
    return (
      <form method="get" className="space-y-3">
        {templates.length === 0 ? (
          <Alert tone="warn">
            No approved template applies to this matter. A form of words nobody approved must not
            reach a registry, so nothing can be produced until one exists.
          </Alert>
        ) : (
          <>
            <Select
              label="Which document"
              name="template"
              options={templates}
              required
              placeholder="Choose…"
            />
            <Button type="submit">Fill it in</Button>
          </>
        )}
      </form>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <Result state={state} />
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="templateId" value={templateId} />

      <div className="grid gap-3 sm:grid-cols-2">
        {variables.map((variable) => (
          <div key={variable.key}>
            <label
              htmlFor={`v-${variable.key}`}
              className="block text-[12px] font-medium text-[var(--color-body)]"
            >
              {variable.label}
              {!variable.required && (
                <span className="ml-1 text-[10px] font-normal text-[var(--color-faint)]">
                  optional
                </span>
              )}
            </label>
            {variable.type === "boolean" ? (
              <select
                id={`v-${variable.key}`}
                name={`values[${variable.key}]`}
                defaultValue={defaults[variable.key] ?? ""}
                className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
              >
                <option value="">No</option>
                <option value="true">Yes</option>
              </select>
            ) : (
              <input
                id={`v-${variable.key}`}
                name={`values[${variable.key}]`}
                type={variable.type === "date" ? "date" : "text"}
                inputMode={
                  variable.type === "money" || variable.type === "number" ? "decimal" : undefined
                }
                required={variable.required}
                defaultValue={defaults[variable.key] ?? ""}
                className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
              />
            )}
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">
              <span className="font-mono">{variable.key}</span> · {variable.type}
              {defaults[variable.key] ? " · suggested from the matter" : ""}
              {variable.hint ? ` · ${variable.hint}` : ""}
            </p>
          </div>
        ))}
      </div>

      {supersedes.length > 0 && (
        <Select
          label="Does this replace an earlier document?"
          name="supersedesId"
          options={supersedes}
          placeholder="No"
          hint="Both stay on the record. A finalised document is corrected this way, never edited."
        />
      )}

      <Textarea label="Notes" name="notes" rows={2} />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Producing…" : "Produce the document"}
      </Button>
    </form>
  );
}

export function DocumentActions({
  caseId,
  documentId,
  status,
  isAuthor,
  canApprove,
  canGenerate,
}: {
  caseId: string;
  documentId: string;
  status: string;
  isAuthor: boolean;
  canApprove: boolean;
  canGenerate: boolean;
}) {
  const [approveState, approve, approving] = useActionState(approveDocumentAction, initial);
  const [finaliseState, finalise, finalising] = useActionState(finaliseDocumentAction, initial);
  const [cancelState, cancel, cancelling] = useActionState(cancelDocumentAction, initial);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  return (
    <div className="space-y-4">
      {status === "draft" && canApprove && !isAuthor && (
        <form action={approve} className="space-y-2">
          <Result state={approveState} />
          <input type="hidden" name="caseId" value={caseId} />
          <input type="hidden" name="documentId" value={documentId} />
          <Textarea
            label="What you checked"
            name="note"
            rows={2}
            hint="Recorded with the approval. This is the note somebody reads when they ask who checked it and against what."
          />
          <Button type="submit" variant="primary" disabled={approving}>
            {approving ? "…" : "Reviewed — approve it"}
          </Button>
        </form>
      )}

      {status === "draft" && canApprove && isAuthor && (
        <Alert tone="info">
          You produced this document, so you cannot review it. Somebody else holding{" "}
          <span className="font-mono">case.document.approve</span> has to.
        </Alert>
      )}

      {status === "approved" && canApprove && (
        <form action={finalise} className="space-y-2">
          <Result state={finaliseState} />
          <input type="hidden" name="caseId" value={caseId} />
          <input type="hidden" name="documentId" value={documentId} />
          <p className="text-[12px] text-[var(--color-muted)]">
            Finalising renders the PDF once and stores those exact bytes where they cannot be
            altered, with the checksum on the record. After that the document cannot be changed —
            a correction is a new document that supersedes it.
          </p>
          <Button type="submit" variant="primary" disabled={finalising}>
            {finalising ? "Producing the PDF…" : "Finalise it"}
          </Button>
        </form>
      )}

      {(status === "draft" || status === "approved") && canGenerate && (
        <div>
          {confirmingCancel ? (
            <form action={cancel} className="space-y-2">
              <Result state={cancelState} />
              <input type="hidden" name="caseId" value={caseId} />
              <input type="hidden" name="documentId" value={documentId} />
              <input
                name="reason"
                required
                placeholder="Why it is being cancelled"
                className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              />
              <div className="flex gap-2">
                <Button type="submit" variant="danger" disabled={cancelling}>
                  {cancelling ? "…" : "Cancel it"}
                </Button>
                <button
                  type="button"
                  onClick={() => setConfirmingCancel(false)}
                  className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
                >
                  Keep it
                </button>
              </div>
            </form>
          ) : (
            <Button type="button" onClick={() => setConfirmingCancel(true)}>
              Cancel this document
            </Button>
          )}
        </div>
      )}

      {status === "finalised" && (
        <Alert tone="ok">
          Finalised. The stored PDF is the document; it cannot be altered, and a correction is a
          new document that supersedes this one.
        </Alert>
      )}
    </div>
  );
}
