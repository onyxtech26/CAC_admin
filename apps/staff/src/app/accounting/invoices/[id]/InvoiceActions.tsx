"use client";

import { useActionState, useState } from "react";
import { deleteInvoiceAction, invoiceAction } from "../../sales-actions";
import type { FormState } from "../../action-errors";
import { Alert, Button } from "@/components/ui";
import { CreditNoteForm, type CreditableLine } from "./CreditNoteForm";

const initial: FormState = {};

export interface InvoicePermissions {
  canEdit: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  canIssue: boolean;
  canVoid: boolean;
  /** True when the caller prepared it, so cannot approve it. */
  isPreparer: boolean;
}

/**
 * The lifecycle buttons.
 *
 * Only the step the invoice is actually at is offered, and where a step is
 * blocked for the caller the reason is shown instead of the button. Hiding a
 * button is presentation; the server checks every one of these again.
 */
export function InvoiceActions({
  invoiceId,
  status,
  kind,
  permissions,
  approvalHint,
  creditableLines,
}: {
  invoiceId: string;
  status: string;
  kind: "invoice" | "credit_note";
  permissions: InvoicePermissions;
  approvalHint: string;
  /** The invoice's own lines, so a credit note can be raised for part of it. */
  creditableLines: CreditableLine[];
}) {
  const [state, action, pending] = useActionState(invoiceAction, initial);
  const noun = kind === "credit_note" ? "credit note" : "invoice";

  return (
    <div className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      {status === "draft" && (
        <div className="space-y-2">
          {permissions.canSubmit ? (
            <form action={action}>
              <input type="hidden" name="invoiceId" value={invoiceId} />
              <input type="hidden" name="action" value="submit" />
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? "Sending…" : "Send for approval"}
              </Button>
            </form>
          ) : (
            <p className="text-[12px] text-[var(--color-muted)]">
              You cannot submit this {noun} for approval.
            </p>
          )}
          <p className="text-[11px] text-[var(--color-muted)]">
            Nothing is sent to the customer at this point. Approval is somebody reading it.
          </p>
        </div>
      )}

      {status === "pending_approval" && (
        <div className="space-y-3">
          <Alert tone="info">{approvalHint}</Alert>
          {permissions.isPreparer ? (
            <p className="text-[12px] text-[var(--color-muted)]">
              You prepared this {noun}, so somebody else has to approve it.
            </p>
          ) : (
            <form action={action}>
              <input type="hidden" name="invoiceId" value={invoiceId} />
              <input type="hidden" name="action" value="approve" />
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? "Approving…" : `Approve this ${noun}`}
              </Button>
            </form>
          )}
          {permissions.canEdit && (
            <ReasonForm
              action={action}
              invoiceId={invoiceId}
              actionName="return"
              label="Send back for changes"
              prompt="What needs changing?"
              placeholder="The preparer sees this"
              pending={pending}
            />
          )}
        </div>
      )}

      {status === "approved" && (
        <div className="space-y-2">
          {permissions.canIssue ? (
            <form action={action}>
              <input type="hidden" name="invoiceId" value={invoiceId} />
              <input type="hidden" name="action" value="issue" />
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? "Issuing…" : `Issue this ${noun}`}
              </Button>
            </form>
          ) : (
            <p className="text-[12px] text-[var(--color-muted)]">
              Approved. Somebody with the authority to issue has to release it.
            </p>
          )}
          <p className="text-[11px] text-[var(--color-muted)]">
            Issuing numbers the {noun} and posts it to the ledger. From then on it is fixed, and a
            mistake is corrected by a void or a credit note.
          </p>
        </div>
      )}

      {(status === "issued" || status === "paid") && permissions.canVoid && (
        <div className="space-y-3">
          {kind === "invoice" && (
            <CreditNoteForm
              invoiceId={invoiceId}
              lines={creditableLines}
              action={action}
              pending={pending}
            />
          )}
          <ReasonForm
            action={action}
            invoiceId={invoiceId}
            actionName="void"
            label={`Void this ${noun}`}
            prompt={`Voiding reverses the ledger entry. Both stay visible. Why?`}
            placeholder="Raised against the wrong client, duplicate…"
            pending={pending}
            variant="danger"
          />
          <p className="text-[11px] text-[var(--color-muted)]">
            Void is for a document that should never have existed. Where the work was done and the
            amount is wrong, a credit note is the honest instrument — it leaves the original visible
            to the customer, which is what they have in their own records.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * A button that reveals a reason field before it will submit.
 *
 * The reason is mandatory on the server too. Asking here means the person is
 * prompted before the round trip, and can change their mind.
 */
function ReasonForm({
  action,
  invoiceId,
  actionName,
  label,
  prompt,
  placeholder,
  pending,
  variant = "secondary",
}: {
  action: (formData: FormData) => void;
  invoiceId: string;
  actionName: string;
  label: string;
  prompt: string;
  placeholder: string;
  pending: boolean;
  variant?: "secondary" | "danger";
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`rounded-md px-3 py-2 text-[13px] font-medium ${
          variant === "danger"
            ? "bg-[var(--color-danger)] text-white hover:opacity-90"
            : "border border-[var(--color-line-strong)] hover:bg-[var(--color-canvas)]"
        }`}
      >
        {label}
      </button>
    );
  }

  return (
    <form action={action} className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="action" value={actionName} />
      <label htmlFor={`reason-${actionName}`} className="block text-[12px] font-medium">
        {prompt}
      </label>
      <input
        id={`reason-${actionName}`}
        name="reason"
        required
        maxLength={500}
        placeholder={placeholder}
        className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
      />
      <p className="text-[11px] text-[var(--color-muted)]">Recorded in the audit trail.</p>
      <div className="flex gap-2">
        <Button type="submit" variant={variant === "danger" ? "danger" : "primary"} disabled={pending}>
          {pending ? "Working…" : label}
        </Button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function DeleteInvoiceDraft({ invoiceId }: { invoiceId: string }) {
  const [state, action, pending] = useActionState(deleteInvoiceAction, initial);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] hover:bg-[var(--color-canvas)]"
      >
        Discard draft
      </button>
    );
  }

  return (
    <form action={action} className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <p className="text-[12px]">
        The draft is removed. What it contained is recorded in the audit trail first.
      </p>
      <input
        name="reason"
        placeholder="Reason (optional)"
        className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
      />
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={pending}>
          {pending ? "Discarding…" : "Discard"}
        </Button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
        >
          Keep it
        </button>
      </div>
    </form>
  );
}
