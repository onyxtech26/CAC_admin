"use client";

import { useActionState, useState } from "react";
import {
  answerFactAction,
  approveRuleAction,
  assignAction,
  closeCaseAction,
  openCaseAction,
  recomputeChecklistAction,
  recordAssetAction,
  recordLiabilityAction,
  recordMilestoneAction,
  recordPartyAction,
  registerDocumentAction,
  removeDocumentAction,
  reopenCaseAction,
  requirementAction,
  saveFactDefinitionAction,
  saveRuleAction,
  taskAction,
  updateCaseAction,
  verifyAction,
} from "./case-actions";
import type { FormState } from "../accounting/action-errors";
import { Alert, Button, Field, Select, Textarea } from "@/components/ui";

const initial: FormState = {};

/** What every form here shows when it comes back: the message, or nothing. */
function Result({ state }: { state: FormState }) {
  if (state.error) return <Alert tone="danger">{state.error}</Alert>;
  if (state.notice) return <Alert tone="ok">{state.notice}</Alert>;
  return null;
}

export interface Option {
  value: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Opening and amending a matter
// ---------------------------------------------------------------------------

export function OpenCaseForm({
  matterTypes,
  employees,
  customers,
  today,
}: {
  matterTypes: Option[];
  employees: Option[];
  customers: Option[];
  today: string;
}) {
  const [state, action, pending] = useActionState(openCaseAction, initial);

  return (
    <form action={action} className="space-y-3">
      <Result state={state} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="What kind of matter"
          name="matterType"
          options={matterTypes}
          required
          placeholder="Choose…"
          hint="What CAC was instructed on. Which procedural route applies is a legal question this platform does not decide."
        />
        <Field label="Title" name="title" required hint="How the file will be referred to." />
        <Field label="Name of the deceased" name="deceasedName" required />
        <Field
          label="Identification (optional)"
          name="deceasedId"
          hint="Encrypted. Lists show only the last four digits."
        />
        <Field label="Date of death" name="dateOfDeath" type="date" />
        <Field label="Where the death was registered" name="placeOfDeath" />
        <Field label="State" name="domicileState" />
        <Field label="Opened on" name="openedOn" type="date" defaultValue={today} required />
        <Field label="Target date" name="targetOn" type="date" />
        <Field label="Who instructed CAC" name="instructedBy" />
        <Select
          label="Client, for billing"
          name="customerId"
          options={customers}
          placeholder="Not set yet"
          hint="Optional at intake. Linking it keeps the matter and its invoices to one client record."
        />
        <Select
          label="Who leads the matter"
          name="leadEmployeeId"
          options={employees}
          required
          placeholder="Choose…"
          hint="Estate matters are visible to the people assigned to them, so a matter needs at least one."
        />
        <Field label="Engagement reference" name="engagementRef" />
      </div>

      <Textarea label="Notes" name="notes" rows={3} />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Opening…" : "Open the matter"}
      </Button>
    </form>
  );
}

export function EditCaseForm({
  caseId,
  matterTypes,
  defaults,
}: {
  caseId: string;
  matterTypes: Option[];
  defaults: {
    title: string;
    matterType: string;
    status: string;
    deceasedName: string;
    dateOfDeath: string;
    placeOfDeath: string;
    domicileState: string;
    instructedBy: string;
    targetOn: string;
    courtReference: string;
    registry: string;
    engagementRef: string;
    notes: string;
    hasIdentification: boolean;
  };
}) {
  const [state, action, pending] = useActionState(updateCaseAction, initial);

  return (
    <form action={action} className="space-y-3">
      <Result state={state} />
      <input type="hidden" name="caseId" value={caseId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title" name="title" required defaultValue={defaults.title} />
        <Select
          label="What kind of matter"
          name="matterType"
          options={matterTypes}
          defaultValue={defaults.matterType}
          required
        />
        <Field label="Name of the deceased" name="deceasedName" required defaultValue={defaults.deceasedName} />
        <Field
          label="Identification"
          name="deceasedId"
          hint={
            defaults.hasIdentification
              ? "Held and encrypted. Leave blank to keep it; type a new number to replace it."
              : "Encrypted. Lists show only the last four digits."
          }
        />
        <Field label="Date of death" name="dateOfDeath" type="date" defaultValue={defaults.dateOfDeath} />
        <Field label="Where the death was registered" name="placeOfDeath" defaultValue={defaults.placeOfDeath} />
        <Field label="State" name="domicileState" defaultValue={defaults.domicileState} />
        <Field label="Target date" name="targetOn" type="date" defaultValue={defaults.targetOn} />
        <Field
          label="Court reference"
          name="courtReference"
          defaultValue={defaults.courtReference}
          hint="Recorded when there is one. Never generated here — and it goes on the timeline."
        />
        <Field label="Registry" name="registry" defaultValue={defaults.registry} />
        <Field label="Who instructed CAC" name="instructedBy" defaultValue={defaults.instructedBy} />
        <Field label="Engagement reference" name="engagementRef" defaultValue={defaults.engagementRef} />
        <Select
          label="Status"
          name="status"
          options={[
            { value: "intake", label: "Intake" },
            { value: "open", label: "Open" },
            { value: "on_hold", label: "On hold" },
          ]}
          defaultValue={defaults.status}
        />
      </div>

      <Textarea label="Notes" name="notes" rows={3} defaultValue={defaults.notes} />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

export function CloseCaseForm({ caseId }: { caseId: string }) {
  const [state, action, pending] = useActionState(closeCaseAction, initial);

  return (
    <form action={action} className="space-y-2">
      <Result state={state} />
      <input type="hidden" name="caseId" value={caseId} />
      <Select
        label="Outcome"
        name="outcome"
        options={[
          { value: "closed", label: "Closed — the work finished" },
          { value: "withdrawn", label: "Withdrawn — the work stopped" },
        ]}
        defaultValue="closed"
        hint="Two different words on the record, because they mean two different things."
      />
      <Textarea label="How it concluded" name="reason" rows={2} required />
      <p className="text-[11px] text-[var(--color-muted)]">
        Closing is refused while any requirement is still outstanding or any task is still
        open — deal with them, waive them with a reason, or withdraw the matter.
      </p>
      <Button type="submit" variant="danger" disabled={pending}>
        {pending ? "…" : "Close the matter"}
      </Button>
    </form>
  );
}

export function ReopenCaseForm({ caseId }: { caseId: string }) {
  const [state, action, pending] = useActionState(reopenCaseAction, initial);

  return (
    <form action={action} className="space-y-2">
      <Result state={state} />
      <input type="hidden" name="caseId" value={caseId} />
      <Textarea label="Why it is being reopened" name="reason" rows={2} required />
      <Button type="submit" disabled={pending}>
        {pending ? "…" : "Reopen"}
      </Button>
    </form>
  );
}

export function AssignForm({
  caseId,
  employees,
}: {
  caseId: string;
  employees: Option[];
}) {
  const [state, action, pending] = useActionState(assignAction, initial);

  return (
    <form action={action} className="space-y-2">
      <Result state={state} />
      <input type="hidden" name="caseId" value={caseId} />
      <Select label="Who" name="employeeId" options={employees} required placeholder="Choose…" />
      <Select
        label="As"
        name="role"
        options={[
          { value: "lead", label: "Lead" },
          { value: "reviewer", label: "Reviewer" },
          { value: "contributor", label: "Contributor" },
          { value: "observer", label: "Observer" },
        ]}
        defaultValue="contributor"
      />
      <Button type="submit" disabled={pending}>
        {pending ? "…" : "Assign"}
      </Button>
    </form>
  );
}

export function UnassignButton({
  caseId,
  employeeId,
  name,
}: {
  caseId: string;
  employeeId: string;
  name: string;
}) {
  const [state, action, pending] = useActionState(assignAction, initial);

  return (
    <form action={action}>
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="employeeId" value={employeeId} />
      <input type="hidden" name="intent" value="remove" />
      <button
        type="submit"
        disabled={pending}
        className="text-[11px] text-[var(--color-danger)] hover:underline disabled:opacity-50"
      >
        {pending ? "…" : `Remove ${name}`}
      </button>
      {state.error && <p className="mt-1 text-[11px] text-[var(--color-danger)]">{state.error}</p>}
    </form>
  );
}

export function MilestoneForm({ caseId, today }: { caseId: string; today: string }) {
  const [state, action, pending] = useActionState(recordMilestoneAction, initial);

  return (
    <form action={action} className="space-y-2">
      <Result state={state} />
      <input type="hidden" name="caseId" value={caseId} />
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="When it happened" name="occurredAt" type="date" defaultValue={today} required />
        <Select
          label="What kind"
          name="kind"
          options={[
            { value: "filing", label: "Filing" },
            { value: "hearing", label: "Hearing" },
            { value: "grant", label: "Grant" },
            { value: "correspondence", label: "Correspondence" },
            { value: "meeting", label: "Meeting" },
            { value: "note", label: "Note" },
          ]}
          defaultValue="note"
        />
        <div className="sm:col-span-1" />
      </div>
      <Textarea label="What happened" name="summary" rows={2} required />
      <p className="text-[11px] text-[var(--color-muted)]">
        For things that happened outside this platform — at a registry, in a meeting. Entries
        are marked as recorded rather than observed, and the timeline cannot be edited
        afterwards.
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? "…" : "Add to the timeline"}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

export function PartyForm({ caseId, roles }: { caseId: string; roles: Option[] }) {
  const [state, action, pending] = useActionState(recordPartyAction, initial);

  return (
    <form action={action} className="space-y-3">
      <Result state={state} />
      <input type="hidden" name="caseId" value={caseId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Role in the matter" name="role" options={roles} required placeholder="Choose…" />
        <Select
          label="Person or organisation"
          name="partyKind"
          options={[
            { value: "person", label: "Person" },
            { value: "organisation", label: "Organisation" },
          ]}
          defaultValue="person"
        />
        <Field label="Name" name="fullName" required />
        <Field label="Relationship to the deceased" name="relationship" />
        <Field
          label="Identification"
          name="identification"
          hint="Encrypted. Lists show only the last four digits."
        />
        <Field label="Date of birth" name="dateOfBirth" type="date" />
        <Field label="Telephone" name="phone" />
        <Field label="Email" name="email" type="email" />
      </div>

      <Textarea label="Address" name="address" rows={2} />

      <label className="flex items-center gap-2 text-[12px]">
        <input type="checkbox" name="isMinor" /> This person is a minor
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <Textarea
          label="Stated entitlement"
          name="shareNote"
          rows={2}
          hint="What CAC was told, not what this platform worked out."
        />
        <Textarea
          label="Where that came from"
          name="shareSource"
          rows={2}
          hint="Required as soon as an entitlement is stated. Who inherits what is a legal question; this records what CAC was told and by whom."
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Consent / renunciation status" name="consentStatus" />
        <Field label="Notes" name="notes" />
      </div>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Add to the matter"}
      </Button>
    </form>
  );
}

export function AssetForm({
  caseId,
  categories,
  defaults,
}: {
  caseId: string;
  categories: Option[];
  defaults?: {
    assetId: string;
    category: string;
    description: string;
    location: string;
    holder: string;
    ownership: string;
    ownershipNote: string;
    valuationAmount: string;
    valuationBasis: string;
    valuationDate: string;
    valuationSource: string;
    notes: string;
  };
}) {
  const [state, action, pending] = useActionState(recordAssetAction, initial);

  return (
    <form action={action} className="space-y-3">
      <Result state={state} />
      <input type="hidden" name="caseId" value={caseId} />
      {defaults && <input type="hidden" name="assetId" value={defaults.assetId} />}

      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="What kind of asset"
          name="category"
          options={categories}
          required
          defaultValue={defaults?.category}
          placeholder="Choose…"
        />
        <Field label="Description" name="description" required defaultValue={defaults?.description} />
        <Field
          label="Title / account / policy number"
          name="reference"
          hint="Encrypted. Lists show only the last four digits."
        />
        <Field label="Where it is / who holds it" name="holder" defaultValue={defaults?.holder} />
        <Field label="Location" name="location" defaultValue={defaults?.location} />
        <Select
          label="How it is held"
          name="ownership"
          options={[
            { value: "sole", label: "Sole" },
            { value: "joint", label: "Joint" },
            { value: "shared", label: "Shared" },
            { value: "trust", label: "In trust" },
            { value: "disputed", label: "Disputed" },
          ]}
          defaultValue={defaults?.ownership ?? "sole"}
        />
      </div>

      <Textarea label="Note on how it is held" name="ownershipNote" rows={2} defaultValue={defaults?.ownershipNote} />

      <fieldset className="rounded-md border border-[var(--color-line)] p-3">
        <legend className="px-1 text-[12px] font-medium">The figure, and where it comes from</legend>
        <p className="mb-2 text-[11px] text-[var(--color-muted)]">
          All four together or none of them. A figure on an estate inventory that nobody can
          trace back is worse than a blank, because it gets relied on.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Amount (RM)"
            name="valuationAmount"
            inputMode="decimal"
            defaultValue={defaults?.valuationAmount}
          />
          <Field label="As at" name="valuationDate" type="date" defaultValue={defaults?.valuationDate} />
          <Field
            label="How it was arrived at"
            name="valuationBasis"
            defaultValue={defaults?.valuationBasis}
            hint="A valuation report, a bank statement, an agent's appraisal."
          />
          <Field
            label="The document it comes from"
            name="valuationSource"
            defaultValue={defaults?.valuationSource}
          />
        </div>
      </fieldset>

      <Field label="Notes" name="notes" defaultValue={defaults?.notes} />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : defaults ? "Save the asset" : "Add the asset"}
      </Button>
    </form>
  );
}

export function LiabilityForm({ caseId, categories }: { caseId: string; categories: Option[] }) {
  const [state, action, pending] = useActionState(recordLiabilityAction, initial);
  const [secured, setSecured] = useState(false);

  return (
    <form action={action} className="space-y-3">
      <Result state={state} />
      <input type="hidden" name="caseId" value={caseId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="What kind of debt" name="category" options={categories} required placeholder="Choose…" />
        <Field label="Who is owed" name="creditor" required />
        <Field label="Description" name="description" required />
        <Field
          label="Account / reference number"
          name="reference"
          hint="Encrypted. Lists show only the last four digits."
        />
      </div>

      <fieldset className="rounded-md border border-[var(--color-line)] p-3">
        <legend className="px-1 text-[12px] font-medium">The figure, and where it comes from</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount (RM)" name="amount" inputMode="decimal" />
          <Field label="As at" name="amountAsAt" type="date" />
          <Field label="How it was arrived at" name="amountBasis" />
          <Field label="The document it comes from" name="amountSource" />
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-[12px]">
        <input
          type="checkbox"
          name="isSecured"
          checked={secured}
          onChange={(event) => setSecured(event.target.checked)}
        />
        The debt is secured
      </label>
      {secured && (
        <Field
          label="What secures it"
          name="securityNote"
          required
          hint="Whether a debt is secured changes how it is dealt with, so a bare tick is not enough."
        />
      )}

      <Field label="Notes" name="notes" />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Add the liability"}
      </Button>
    </form>
  );
}

/** Reported → verified, or excluded with a reason. */
export function VerifyControl({
  caseId,
  kind,
  recordId,
  status,
  canVerify,
}: {
  caseId: string;
  kind: string;
  recordId: string;
  status: "reported" | "verified" | "excluded" | "stated" | "unknown";
  canVerify: boolean;
}) {
  const [state, action, pending] = useActionState(verifyAction, initial);
  const [excluding, setExcluding] = useState(false);

  if (excluding) {
    return (
      <form action={action} className="space-y-1">
        <input type="hidden" name="caseId" value={caseId} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="recordId" value={recordId} />
        <input type="hidden" name="status" value="excluded" />
        <input
          name="reason"
          required
          placeholder="Why it is being excluded"
          className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[12px]"
        />
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className="text-[11px] text-[var(--color-danger)] hover:underline"
          >
            Exclude
          </button>
          <button
            type="button"
            onClick={() => setExcluding(false)}
            className="text-[11px] text-[var(--color-muted)] hover:underline"
          >
            Keep it
          </button>
        </div>
        {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      </form>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        {status !== "verified" && canVerify && (
          <form action={action}>
            <input type="hidden" name="caseId" value={caseId} />
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="recordId" value={recordId} />
            <input type="hidden" name="status" value="verified" />
            <button
              type="submit"
              disabled={pending}
              className="text-[11px] text-[var(--color-link)] hover:underline disabled:opacity-50"
            >
              Mark verified
            </button>
          </form>
        )}
        {status === "verified" && (
          <form action={action}>
            <input type="hidden" name="caseId" value={caseId} />
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="recordId" value={recordId} />
            <input type="hidden" name="status" value="reported" />
            <button
              type="submit"
              disabled={pending}
              className="text-[11px] text-[var(--color-muted)] hover:underline disabled:opacity-50"
            >
              Withdraw verification
            </button>
          </form>
        )}
        {kind !== "fact" && status !== "excluded" && (
          <button
            type="button"
            onClick={() => setExcluding(true)}
            className="text-[11px] text-[var(--color-muted)] hover:underline"
          >
            Exclude
          </button>
        )}
      </div>
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
    </div>
  );
}

export function DocumentForm({ caseId, today }: { caseId: string; today: string }) {
  const [state, action, pending] = useActionState(registerDocumentAction, initial);

  return (
    <form action={action} className="space-y-3">
      <Result state={state} />
      <input type="hidden" name="caseId" value={caseId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What the document is" name="title" required />
        <Field label="Kind" name="docKind" hint="Free text — the set an estate needs is not fixed." />
        <Select
          label="Original or copy"
          name="form"
          options={[
            { value: "original", label: "Original" },
            { value: "certified_copy", label: "Certified copy" },
            { value: "copy", label: "Copy" },
            { value: "electronic", label: "Electronic" },
          ]}
          defaultValue="copy"
        />
        <Field label="Received on" name="receivedOn" type="date" defaultValue={today} />
        <Field label="Received from" name="receivedFrom" />
        <Field
          label="Where it is filed"
          name="filedAt"
          hint="The answer to “do we have it, and where”."
        />
      </div>

      <Field label="Notes" name="notes" />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Register the document"}
      </Button>
    </form>
  );
}

export function RemoveDocumentButton({
  caseId,
  documentId,
}: {
  caseId: string;
  documentId: string;
}) {
  const [state, action, pending] = useActionState(removeDocumentAction, initial);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-[11px] text-[var(--color-danger)] hover:underline"
      >
        Remove
      </button>
    );
  }

  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="documentId" value={documentId} />
      <input
        name="reason"
        required
        placeholder="Why it is being removed"
        className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[12px]"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="text-[11px] text-[var(--color-danger)] hover:underline"
        >
          Remove it
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-[11px] text-[var(--color-muted)] hover:underline"
        >
          Keep it
        </button>
      </div>
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

export function FactAnswerForm({
  caseId,
  factKey,
  kind,
  options,
  value,
  sourceNote,
}: {
  caseId: string;
  factKey: string;
  kind: string;
  options: string[];
  value: string | null;
  sourceNote: string | null;
}) {
  const [state, action, pending] = useActionState(answerFactAction, initial);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="factKey" value={factKey} />

      {kind === "boolean" ? (
        <select
          name="value"
          defaultValue={value ?? ""}
          className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[13px]"
        >
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      ) : kind === "choice" ? (
        <select
          name="value"
          defaultValue={value ?? ""}
          className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[13px]"
        >
          <option value="">—</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          name="value"
          type={kind === "date" ? "date" : "text"}
          inputMode={kind === "number" ? "decimal" : undefined}
          defaultValue={value ?? ""}
          className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[13px]"
        />
      )}

      <input
        name="sourceNote"
        defaultValue={sourceNote ?? ""}
        placeholder="Where the answer came from"
        className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[12px]"
      />

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary px-2 py-1 text-[11px]"
        >
          {pending ? "…" : "Record"}
        </button>
        <button
          type="submit"
          name="intent"
          value="unknown"
          disabled={pending}
          className="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
          title="Asked, and cannot be answered. A rule that needs this stays on the checklist, flagged."
        >
          Not known
        </button>
      </div>

      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      {state.notice && <p className="text-[11px] text-[var(--color-ok)]">{state.notice}</p>}
    </form>
  );
}

export function RebuildChecklistForm({ caseId }: { caseId: string }) {
  const [state, action, pending] = useActionState(recomputeChecklistAction, initial);

  return (
    <form action={action} className="space-y-2">
      <Result state={state} />
      <input type="hidden" name="caseId" value={caseId} />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Working…" : "Rebuild the checklist from these facts"}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

export function RequirementControls({
  caseId,
  requirementId,
  status,
  kind,
  documents,
}: {
  caseId: string;
  requirementId: string;
  status: string;
  kind: string;
  documents: Option[];
}) {
  const [state, action, pending] = useActionState(requirementAction, initial);
  const [mode, setMode] = useState<"none" | "satisfy" | "waive">("none");

  if (mode === "satisfy") {
    return (
      <form action={action} className="space-y-1">
        <input type="hidden" name="caseId" value={caseId} />
        <input type="hidden" name="requirementId" value={requirementId} />
        <input type="hidden" name="status" value="satisfied" />
        {kind === "document" ? (
          <select
            name="documentId"
            required
            className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[12px]"
          >
            <option value="">Which document…</option>
            {documents.map((document) => (
              <option key={document.value} value={document.value}>
                {document.label}
              </option>
            ))}
          </select>
        ) : (
          <select
            name="documentId"
            className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[12px]"
          >
            <option value="">No document</option>
            {documents.map((document) => (
              <option key={document.value} value={document.value}>
                {document.label}
              </option>
            ))}
          </select>
        )}
        <div className="flex gap-2">
          <button type="submit" disabled={pending} className="text-[11px] text-[var(--color-ok)] hover:underline">
            Satisfied
          </button>
          <button
            type="button"
            onClick={() => setMode("none")}
            className="text-[11px] text-[var(--color-muted)] hover:underline"
          >
            Back
          </button>
        </div>
        {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      </form>
    );
  }

  if (mode === "waive") {
    return (
      <form action={action} className="space-y-1">
        <input type="hidden" name="caseId" value={caseId} />
        <input type="hidden" name="requirementId" value={requirementId} />
        <input type="hidden" name="status" value="waived" />
        <input
          name="reason"
          required
          placeholder="Why it is being waived"
          className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[12px]"
        />
        <div className="flex gap-2">
          <button type="submit" disabled={pending} className="text-[11px] text-[var(--color-link)] hover:underline">
            Waive it
          </button>
          <button
            type="button"
            onClick={() => setMode("none")}
            className="text-[11px] text-[var(--color-muted)] hover:underline"
          >
            Back
          </button>
        </div>
        {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      </form>
    );
  }

  const settled = status === "satisfied" || status === "waived";

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        {!settled && (
          <>
            <button
              type="button"
              onClick={() => setMode("satisfy")}
              className="text-[11px] text-[var(--color-ok)] hover:underline"
            >
              Satisfied
            </button>
            <button
              type="button"
              onClick={() => setMode("waive")}
              className="text-[11px] text-[var(--color-link)] hover:underline"
            >
              Waive
            </button>
            {status === "outstanding" && (
              <form action={action}>
                <input type="hidden" name="caseId" value={caseId} />
                <input type="hidden" name="requirementId" value={requirementId} />
                <input type="hidden" name="status" value="in_progress" />
                <button
                  type="submit"
                  disabled={pending}
                  className="text-[11px] text-[var(--color-muted)] hover:underline"
                >
                  Started
                </button>
              </form>
            )}
          </>
        )}
        {settled && (
          <form action={action}>
            <input type="hidden" name="caseId" value={caseId} />
            <input type="hidden" name="requirementId" value={requirementId} />
            <input type="hidden" name="status" value="outstanding" />
            <button
              type="submit"
              disabled={pending}
              className="text-[11px] text-[var(--color-muted)] hover:underline"
            >
              Reopen
            </button>
          </form>
        )}
      </div>
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
    </div>
  );
}

export function AddRequirementForm({ caseId }: { caseId: string }) {
  const [state, action, pending] = useActionState(requirementAction, initial);

  return (
    <form action={action} className="space-y-3">
      <Result state={state} />
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="intent" value="add" />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What is needed" name="title" required />
        <Select
          label="Kind"
          name="kind"
          options={[
            { value: "document", label: "Document" },
            { value: "evidence", label: "Evidence" },
            { value: "action", label: "Something to do" },
            { value: "form", label: "Form" },
            { value: "consent", label: "Consent" },
            { value: "payment", label: "Payment" },
          ]}
          defaultValue="action"
        />
        <Field label="Due" name="dueOn" type="date" />
        <Field
          label="Reference, if there is one"
          name="sourceRef"
          hint="An item added by hand carries no authority of its own. A legal requirement belongs in an approved rule."
        />
      </div>

      <Textarea label="Detail" name="detail" rows={2} />

      <Button type="submit" disabled={pending}>
        {pending ? "…" : "Add to this matter's checklist"}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function TaskForm({
  caseId,
  employees,
  requirements,
}: {
  caseId: string;
  employees: Option[];
  requirements: Option[];
}) {
  const [state, action, pending] = useActionState(taskAction, initial);

  return (
    <form action={action} className="space-y-3">
      <Result state={state} />
      <input type="hidden" name="caseId" value={caseId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What needs doing" name="title" required />
        <Select label="Who" name="assigneeId" options={employees} placeholder="Nobody yet" />
        <Field label="Due" name="dueOn" type="date" />
        <Select
          label="Priority"
          name="priority"
          options={[
            { value: "low", label: "Low" },
            { value: "normal", label: "Normal" },
            { value: "high", label: "High" },
            { value: "urgent", label: "Urgent" },
          ]}
          defaultValue="normal"
        />
        <Select
          label="Against which requirement"
          name="requirementId"
          options={requirements}
          placeholder="None"
          hint="A requirement is what the matter needs; a task is what somebody is doing about it."
        />
      </div>

      <Textarea label="Detail" name="detail" rows={2} />

      <Button type="submit" disabled={pending}>
        {pending ? "…" : "Create the task"}
      </Button>
    </form>
  );
}

export function TaskControls({
  caseId,
  taskId,
  canManage,
  canComplete,
}: {
  caseId: string;
  taskId: string;
  canManage: boolean;
  canComplete: boolean;
}) {
  const [state, action, pending] = useActionState(taskAction, initial);
  const [cancelling, setCancelling] = useState(false);

  if (cancelling) {
    return (
      <form action={action} className="space-y-1">
        <input type="hidden" name="caseId" value={caseId} />
        <input type="hidden" name="taskId" value={taskId} />
        <input type="hidden" name="intent" value="cancel" />
        <input
          name="reason"
          required
          placeholder="Why"
          className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[12px]"
        />
        <div className="flex gap-2">
          <button type="submit" disabled={pending} className="text-[11px] text-[var(--color-danger)] hover:underline">
            Cancel it
          </button>
          <button
            type="button"
            onClick={() => setCancelling(false)}
            className="text-[11px] text-[var(--color-muted)] hover:underline"
          >
            Keep it
          </button>
        </div>
        {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      </form>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        {canComplete && (
          <form action={action}>
            <input type="hidden" name="caseId" value={caseId} />
            <input type="hidden" name="taskId" value={taskId} />
            <input type="hidden" name="intent" value="complete" />
            <button
              type="submit"
              disabled={pending}
              className="text-[11px] text-[var(--color-ok)] hover:underline disabled:opacity-50"
            >
              Done
            </button>
          </form>
        )}
        {canManage && (
          <button
            type="button"
            onClick={() => setCancelling(true)}
            className="text-[11px] text-[var(--color-muted)] hover:underline"
          >
            Cancel
          </button>
        )}
      </div>
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Questions and rules
// ---------------------------------------------------------------------------

export function FactDefinitionForm({ matterTypes }: { matterTypes: Option[] }) {
  const [state, action, pending] = useActionState(saveFactDefinitionAction, initial);
  const [kind, setKind] = useState("boolean");

  return (
    <form action={action} className="space-y-3">
      <Result state={state} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Key"
          name="key"
          required
          hint="Lower case, underscores — for example has_will. Rules refer to this, so it is fixed once answers exist."
        />
        <Field label="Label" name="label" required />
        <div>
          <label htmlFor="f-kind" className="block text-[12px] font-medium">
            Kind of answer
          </label>
          <select
            id="f-kind"
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          >
            <option value="boolean">Yes / no</option>
            <option value="choice">One of a list</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="text">Text</option>
          </select>
        </div>
        {kind === "choice" && (
          <Field
            label="The answers offered"
            name="options"
            required
            hint="Separated by commas. A choice with no options cannot be answered."
          />
        )}
        <Field label="Order" name="sortOrder" defaultValue="100" inputMode="numeric" />
      </div>

      <Field label="How to ask it" name="prompt" />
      <Textarea label="Guidance for whoever answers" name="helpText" rows={2} />

      <fieldset className="rounded-md border border-[var(--color-line)] p-3">
        <legend className="px-1 text-[12px] font-medium">Asked on which matters</legend>
        <p className="mb-2 text-[11px] text-[var(--color-muted)]">Leave all unticked to ask it on every matter.</p>
        <div className="flex flex-wrap gap-3">
          {matterTypes.map((type) => (
            <label key={type.value} className="flex items-center gap-1 text-[12px]">
              <input type="checkbox" name="matterTypes" value={type.value} /> {type.label}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-[12px]">
        <input type="checkbox" name="retire" /> Stop asking this question
      </label>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Save the question"}
      </Button>
    </form>
  );
}

interface TestRow {
  fact: string;
  operator: string;
  value: string;
}

const OPERATORS = [
  { value: "is", label: "is" },
  { value: "isNot", label: "is not" },
  { value: "oneOf", label: "is one of" },
  { value: "answered", label: "is known" },
  { value: "atLeast", label: "is at least" },
  { value: "atMost", label: "is at most" },
  { value: "onOrBefore", label: "is on or before" },
  { value: "onOrAfter", label: "is on or after" },
];

/**
 * Writing a requirement rule.
 *
 * The condition is built from rows — question, test, value — rather than typed as
 * JSON. Whoever is qualified to say what a matter requires should not have to write a
 * condition tree, and a form that can only produce valid shapes removes a whole class
 * of mistake. The core layer validates whatever arrives regardless.
 */
export function RuleForm({
  facts,
  matterTypes,
}: {
  facts: Array<{ key: string; label: string; kind: string }>;
  matterTypes: Option[];
}) {
  const [state, action, pending] = useActionState(saveRuleAction, initial);
  const [tests, setTests] = useState<TestRow[]>([]);

  const update = (index: number, field: keyof TestRow, value: string) =>
    setTests((current) =>
      current.map((row, position) => (position === index ? { ...row, [field]: value } : row)),
    );

  return (
    <form action={action} className="space-y-3">
      <Result state={state} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" name="code" required hint="Upper case — for example DEATH_CERT." />
        <Select
          label="Kind of requirement"
          name="kind"
          options={[
            { value: "document", label: "Document" },
            { value: "evidence", label: "Evidence" },
            { value: "action", label: "Something to do" },
            { value: "form", label: "Form" },
            { value: "consent", label: "Consent" },
            { value: "payment", label: "Payment" },
          ]}
          defaultValue="document"
        />
        <Field label="What is required" name="title" required />
        <Field
          label="The authority it comes from"
          name="sourceRef"
          required
          hint="Required. A requirement with nothing behind it must never reach a checklist."
        />
        <Field label="In force from" name="effectiveFrom" type="date" />
        <Field label="In force until" name="effectiveTo" type="date" />
      </div>

      <Textarea label="Detail" name="detail" rows={2} />

      <fieldset className="rounded-md border border-[var(--color-line)] p-3">
        <legend className="px-1 text-[12px] font-medium">Applies to which matters</legend>
        <p className="mb-2 text-[11px] text-[var(--color-muted)]">Leave all unticked to apply to every matter.</p>
        <div className="flex flex-wrap gap-3">
          {matterTypes.map((type) => (
            <label key={type.value} className="flex items-center gap-1 text-[12px]">
              <input type="checkbox" name="matterTypes" value={type.value} /> {type.label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-[var(--color-line)] p-3">
        <legend className="px-1 text-[12px] font-medium">Applies when</legend>
        <p className="mb-2 text-[11px] text-[var(--color-muted)]">
          No conditions means the requirement applies to every matter of the kinds ticked above.
          A condition over a question nobody has answered leaves the item on the checklist,
          flagged — it does not remove it.
        </p>

        <div className="mb-2">
          <select
            name="join"
            defaultValue="all"
            className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[12px]"
          >
            <option value="all">All of these must hold</option>
            <option value="any">Any one of these is enough</option>
          </select>
        </div>

        {tests.length === 0 && (
          <p className="text-[12px] text-[var(--color-muted)]">No conditions — always required.</p>
        )}

        <div className="space-y-2">
          {tests.map((row, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
              <select
                name={`tests[${index}].fact`}
                value={row.fact}
                onChange={(event) => update(index, "fact", event.target.value)}
                required
                className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[12px]"
              >
                <option value="">Which question…</option>
                {facts.map((fact) => (
                  <option key={fact.key} value={fact.key}>
                    {fact.label} ({fact.kind})
                  </option>
                ))}
              </select>
              <select
                name={`tests[${index}].operator`}
                value={row.operator}
                onChange={(event) => update(index, "operator", event.target.value)}
                className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[12px]"
              >
                {OPERATORS.map((operator) => (
                  <option key={operator.value} value={operator.value}>
                    {operator.label}
                  </option>
                ))}
              </select>
              <input
                name={`tests[${index}].value`}
                value={row.value}
                onChange={(event) => update(index, "value", event.target.value)}
                placeholder={row.operator === "answered" ? "—" : "true / false / value"}
                disabled={row.operator === "answered"}
                className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[12px] disabled:opacity-40"
              />
              <button
                type="button"
                onClick={() => setTests((current) => current.filter((_, at) => at !== index))}
                className="text-[11px] text-[var(--color-danger)] hover:underline"
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setTests((current) => [...current, { fact: "", operator: "is", value: "" }])}
          className="mt-2 text-[12px] text-[var(--color-link)] hover:underline"
          disabled={facts.length === 0}
        >
          Add a condition
        </button>
        {facts.length === 0 && (
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            Declare an intake question first — a rule can only read questions that exist.
          </p>
        )}
      </fieldset>

      <Textarea label="Notes" name="notes" rows={2} />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Save as a draft"}
      </Button>
      <p className="text-[11px] text-[var(--color-muted)]">
        A draft cannot appear on any checklist. Somebody other than its author, holding
        <span className="font-mono"> case.rule.approve</span>, has to approve it first.
      </p>
    </form>
  );
}

export function RuleApproval({
  ruleId,
  label,
  approved,
}: {
  ruleId: string;
  label: string;
  approved: boolean;
}) {
  const [state, action, pending] = useActionState(approveRuleAction, initial);
  const [retiring, setRetiring] = useState(false);

  if (approved && retiring) {
    return (
      <form action={action} className="space-y-1">
        <input type="hidden" name="ruleId" value={ruleId} />
        <input type="hidden" name="intent" value="retire" />
        <input
          name="reason"
          required
          placeholder="Why it is being withdrawn"
          className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[12px]"
        />
        <div className="flex gap-2">
          <button type="submit" disabled={pending} className="text-[11px] text-[var(--color-danger)] hover:underline">
            Withdraw it
          </button>
          <button
            type="button"
            onClick={() => setRetiring(false)}
            className="text-[11px] text-[var(--color-muted)] hover:underline"
          >
            Keep it
          </button>
        </div>
        {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      </form>
    );
  }

  if (approved) {
    return (
      <button
        type="button"
        onClick={() => setRetiring(true)}
        className="text-[11px] text-[var(--color-muted)] hover:underline"
      >
        Withdraw
      </button>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="ruleId" value={ruleId} />
      <Button type="submit" disabled={pending}>
        {pending ? "…" : `Approve ${label}`}
      </Button>
      {state.error && <p className="mt-1 text-[11px] text-[var(--color-danger)]">{state.error}</p>}
    </form>
  );
}
