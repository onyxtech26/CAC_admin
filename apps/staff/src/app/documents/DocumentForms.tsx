"use client";

import { useActionState, useState } from "react";
import {
  archiveAction,
  classifyAction,
  deleteDocumentAction,
  embedAction,
  extractAction,
  releaseAction,
  scanDocumentAction,
  uploadDocumentAction,
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

/**
 * Uploading a file.
 *
 * The form says what will happen before it happens, including the part that is not
 * flattering: with no scanner configured the file will be stored and held in quarantine,
 * and nothing will read it. Somebody who knows that before they press the button is not
 * surprised by it afterwards.
 */
export function UploadForm({
  cases,
  scannerConfigured,
  maxMegabytes,
}: {
  cases: Option[];
  scannerConfigured: boolean;
  maxMegabytes: number;
}) {
  const [state, action, pending] = useActionState(uploadDocumentAction, initial);

  return (
    <form action={action} className="space-y-3">
      <Result state={state} />

      {!scannerConfigured && (
        <Alert tone="warn">
          No malware scanner is configured, so an uploaded file will be stored, checksummed
          and held in quarantine. Nothing will read it, index it or let anybody download it
          until either a scanner is configured or somebody releases it with a reason — which
          records it as <em>unscanned</em>, never as clean.
        </Alert>
      )}

      <div>
        <label htmlFor="f-file" className="block text-[12px] font-medium">
          The file
        </label>
        <input
          id="f-file"
          name="file"
          type="file"
          required
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
        />
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          Up to {maxMegabytes} MB. Originals are held in the database so a backup restores the
          file and the record describing it together.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title" name="title" hint="Defaults to the file's own name." />
        <Select
          label="Against which matter"
          name="caseId"
          options={cases}
          placeholder="None — firm-wide"
          hint="A document on a matter is visible to the people assigned to that matter, and to nobody else."
        />
        <Select
          label="Confidentiality"
          name="confidentiality"
          options={[
            { value: "internal", label: "Internal" },
            { value: "client", label: "Client" },
            { value: "restricted", label: "Restricted" },
          ]}
          defaultValue="internal"
        />
      </div>

      <Textarea label="Notes" name="notes" rows={2} />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Storing…" : "Upload"}
      </Button>
    </form>
  );
}

/** Run the pipeline again on one document. */
export function PipelineButton({
  documentId,
  stage,
  label,
}: {
  documentId: string;
  stage: "scan" | "extract" | "embed";
  label: string;
}) {
  const chosen =
    stage === "scan" ? scanDocumentAction : stage === "extract" ? extractAction : embedAction;
  const [state, action, pending] = useActionState(chosen, initial);

  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="documentId" value={documentId} />
      <Button type="submit" disabled={pending}>
        {pending ? "Working…" : label}
      </Button>
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      {state.notice && <p className="text-[11px] text-[var(--color-ok)]">{state.notice}</p>}
    </form>
  );
}

/**
 * Releasing a file nobody scanned.
 *
 * Two steps, and the wording does not soften what is being decided. This is the one place
 * in the pipeline where a person overrides the absence of a scanner, and the record keeps
 * their name and their reason against it.
 */
export function ReleaseForm({ documentId }: { documentId: string }) {
  const [state, action, pending] = useActionState(releaseAction, initial);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="space-y-2">
        <p className="text-[12px] text-[var(--color-muted)]">
          No scanner has looked at this file. Releasing it is a decision recorded against your
          name: the document will be marked <strong>released unscanned</strong> permanently, and
          never described as clean.
        </p>
        <Button type="button" onClick={() => setConfirming(true)}>
          Release it without a scan
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-2">
      <Result state={state} />
      <input type="hidden" name="documentId" value={documentId} />
      <Textarea
        label="Why this file is being released without a scan"
        name="reason"
        rows={3}
        required
        hint="At least a sentence. This is the note somebody reads if the file turns out to have been a problem."
      />
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={pending}>
          {pending ? "…" : "Release it"}
        </Button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
        >
          Leave it in quarantine
        </button>
      </div>
    </form>
  );
}

export function ClassifyForm({
  documentId,
  defaults,
}: {
  documentId: string;
  defaults: { title: string; kind: string; confidentiality: string; notes: string };
}) {
  const [state, action, pending] = useActionState(classifyAction, initial);

  return (
    <form action={action} className="space-y-3">
      <Result state={state} />
      <input type="hidden" name="documentId" value={documentId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title" name="title" defaultValue={defaults.title} />
        <Field
          label="What this document is"
          name="kind"
          required
          defaultValue={defaults.kind}
          hint="Set by you, which replaces any guess made from the filename."
        />
        <Select
          label="Confidentiality"
          name="confidentiality"
          options={[
            { value: "internal", label: "Internal" },
            { value: "client", label: "Client" },
            { value: "restricted", label: "Restricted" },
          ]}
          defaultValue={defaults.confidentiality}
        />
      </div>

      <Textarea label="Notes" name="notes" rows={2} defaultValue={defaults.notes} />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

export function ArchiveForm({ documentId }: { documentId: string }) {
  const [state, action, pending] = useActionState(archiveAction, initial);

  return (
    <form action={action} className="space-y-2">
      <Result state={state} />
      <input type="hidden" name="documentId" value={documentId} />
      <Textarea label="Why it is being archived" name="reason" rows={2} required />
      <p className="text-[11px] text-[var(--color-muted)]">
        The original is kept and can still be downloaded; the document stops appearing in
        search.
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? "…" : "Archive"}
      </Button>
    </form>
  );
}

/** The one operation here that loses the original. */
export function DestroyForm({ documentId }: { documentId: string }) {
  const [state, action, pending] = useActionState(deleteDocumentAction, initial);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="space-y-2">
        <p className="text-[12px] text-[var(--color-muted)]">
          Destroying the original cannot be undone. Archiving keeps the file and only removes
          it from search, and is almost always what is wanted instead.
        </p>
        <Button type="button" variant="danger" onClick={() => setConfirming(true)}>
          Destroy the original
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-2">
      <Result state={state} />
      <input type="hidden" name="documentId" value={documentId} />
      <Textarea
        label="Why the original is being destroyed"
        name="reason"
        rows={3}
        required
        hint="At least a sentence. It goes into the audit trail, which outlives the document."
      />
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={pending}>
          {pending ? "…" : "Destroy it"}
        </Button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
        >
          Keep it
        </button>
      </div>
    </form>
  );
}
