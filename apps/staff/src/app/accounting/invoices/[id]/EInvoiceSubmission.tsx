"use client";

import { useActionState, useState } from "react";
import type { SubmissionRecord } from "@cac/core";
import { cancelSubmissionAction, submitToAuthorityAction } from "../../sales-actions";
import type { FormState } from "../../action-errors";
import { Alert, Badge, Button } from "@/components/ui";

const initial: FormState = {};

const TONE = {
  submitted: "info",
  valid: "ok",
  invalid: "danger",
  cancelled: "neutral",
} as const;

/**
 * Submitting an invoice to LHDN, and what came back.
 *
 * There was no way to do this at all: `buildEInvoiceDocument` had no callers, `provider.submit()`
 * was reached only from tests, and nothing recorded a submission id — so even with credentials the
 * integration could not have been used.
 *
 * What the panel shows depends on what is true, and the distinction matters. **Not configured** is a
 * question for CAC, and the blockers are listed rather than hidden behind a disabled button.
 * **Configured but this invoice is not ready** is CAC's own data — a missing TIN, a service with no
 * classification code — and says which. Only when both are clear is there a button.
 */
export function EInvoiceSubmission({
  invoiceId,
  configured,
  blockers,
  invoiceBlockers,
  submissions,
  canSubmit,
  canCancel,
}: {
  invoiceId: string;
  configured: boolean;
  /** Why the integration itself is unavailable. */
  blockers: string[];
  /** Why this particular invoice could not be sent. */
  invoiceBlockers: string[];
  submissions: SubmissionRecord[];
  canSubmit: boolean;
  canCancel: boolean;
}) {
  const [state, action, pending] = useActionState(submitToAuthorityAction, initial);
  const [cancelState, cancelAction, cancelPending] = useActionState(
    cancelSubmissionAction,
    initial,
  );
  const [cancelling, setCancelling] = useState<string | null>(null);

  const live = submissions.find(
    (entry) => entry.status === "submitted" || entry.status === "valid",
  );

  return (
    <div className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}
      {cancelState.error && <Alert tone="danger">{cancelState.error}</Alert>}

      {submissions.length > 0 && (
        <ul className="space-y-2">
          {submissions.map((entry) => (
            <li key={entry.id} className="rounded-md border border-[var(--color-line)] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={TONE[entry.status]}>{entry.status}</Badge>
                <span className="font-mono text-[11px] text-[var(--color-muted)]">
                  {entry.uuid ?? "no identifier"}
                </span>
                {entry.environment && entry.environment !== "production" && (
                  // A sandbox submission must never be mistaken for a real one, least of all later.
                  <Badge tone="warn">{entry.environment}</Badge>
                )}
              </div>
              <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                {new Date(entry.submittedAt).toLocaleString("en-GB")}
                {entry.submittedByName ? ` · ${entry.submittedByName}` : ""}
                {entry.cancelReason ? ` · cancelled: ${entry.cancelReason}` : ""}
              </p>
              {entry.messages.length > 0 && (
                <ul className="mt-2 space-y-1 text-[11px] text-[var(--color-danger)]">
                  {entry.messages.map((message, index) => (
                    <li key={index}>{message}</li>
                  ))}
                </ul>
              )}

              {canCancel && entry.status !== "cancelled" && entry.uuid && (
                cancelling === entry.id ? (
                  <form action={cancelAction} className="mt-2 space-y-2">
                    <input type="hidden" name="submissionId" value={entry.id} />
                    <input type="hidden" name="invoiceId" value={invoiceId} />
                    <input
                      name="reason"
                      required
                      placeholder="Why is it being withdrawn?"
                      aria-label="Reason for cancelling the submission"
                      className="w-full rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[11px]"
                    />
                    <div className="flex gap-1">
                      <Button type="submit" variant="danger" disabled={cancelPending}>
                        {cancelPending ? "…" : "Cancel it with LHDN"}
                      </Button>
                      <button
                        type="button"
                        onClick={() => setCancelling(null)}
                        className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
                      >
                        Keep it
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => setCancelling(entry.id)}
                    className="mt-2 text-[11px] text-[var(--color-muted)] underline"
                  >
                    Cancel this submission
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}

      {!configured && (
        <div className="space-y-2">
          <Alert tone="warn">
            e-Invoicing is not connected, so nothing has been submitted and nothing is pretending to
            have been.
          </Alert>
          <ul className="space-y-1 text-[11px] text-[var(--color-muted)]">
            {blockers.map((blocker, index) => (
              <li key={index}>· {blocker}</li>
            ))}
          </ul>
        </div>
      )}

      {configured && !live && invoiceBlockers.length > 0 && (
        <div className="space-y-2">
          <Alert tone="warn">This invoice is not ready to submit.</Alert>
          <ul className="space-y-1 text-[11px] text-[var(--color-muted)]">
            {invoiceBlockers.map((blocker, index) => (
              <li key={index}>· {blocker}</li>
            ))}
          </ul>
        </div>
      )}

      {configured && !live && invoiceBlockers.length === 0 && canSubmit && (
        <form action={action}>
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Submitting…" : "Submit to MyInvois"}
          </Button>
        </form>
      )}
    </div>
  );
}
