"use client";

import { useActionState, useState } from "react";
import { quotationAction } from "../../sales-actions";
import type { FormState } from "../../action-errors";
import { Alert, Button } from "@/components/ui";

const initial: FormState = {};

/**
 * Where a quotation can go from here.
 *
 * Send, then accepted or declined, then converted. Only the transitions the
 * document is actually at are offered; the database enforces the same graph.
 */
export function QuotationActions({
  quotationId,
  status,
  canEdit,
  canConvert,
}: {
  quotationId: string;
  status: string;
  canEdit: boolean;
  canConvert: boolean;
}) {
  const [state, action, pending] = useActionState(quotationAction, initial);
  const [deleting, setDeleting] = useState(false);

  const button = (value: string, label: string, variant: "primary" | "secondary" | "danger" = "secondary") => (
    <form action={action}>
      <input type="hidden" name="quotationId" value={quotationId} />
      <input type="hidden" name="action" value={value} />
      <Button type="submit" variant={variant} disabled={pending}>
        {pending ? "Working…" : label}
      </Button>
    </form>
  );

  return (
    <div className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      {status === "draft" && canEdit && (
        <>
          {button("send", "Mark as sent", "primary")}
          <p className="text-[11px] text-[var(--color-muted)]">
            This numbers the quotation and fixes its contents. The platform does not email it — open
            the PDF and attach it to your own message, so what the client received is what you sent.
          </p>

          {/* A draft raised by mistake could only be sent: there was no edit route and no delete,
              though every comparable document had both. */}
          {deleting ? (
            <form action={action} className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
              <input type="hidden" name="quotationId" value={quotationId} />
              <input type="hidden" name="action" value="delete" />
              <label htmlFor="delete-reason" className="block text-[12px] font-medium">
                Why is this draft being thrown away?
              </label>
              <input
                id="delete-reason"
                name="reason"
                required
                placeholder="Raised against the wrong client, duplicate…"
                className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[13px]"
              />
              <p className="text-[11px] text-[var(--color-muted)]">
                The draft goes; the audit trail keeps the fact that it existed.
              </p>
              <div className="flex gap-2">
                <Button type="submit" variant="danger" disabled={pending}>
                  {pending ? "Working…" : "Delete the draft"}
                </Button>
                <button
                  type="button"
                  onClick={() => setDeleting(false)}
                  className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
                >
                  Keep it
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setDeleting(true)}
              className="text-[12px] text-[var(--color-muted)] underline"
            >
              Delete this draft
            </button>
          )}
        </>
      )}

      {status === "sent" && canEdit && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {button("accept", "Client accepted", "primary")}
            {button("decline", "Client declined", "danger")}
          </div>
          <p className="text-[11px] text-[var(--color-muted)]">
            Recording the answer is what lets it become an invoice.
          </p>
        </div>
      )}

      {status === "accepted" && (
        <div className="space-y-2">
          {canConvert ? (
            button("convert", "Create the invoice", "primary")
          ) : (
            <p className="text-[12px] text-[var(--color-muted)]">
              Accepted. Somebody who can raise invoices converts it from here.
            </p>
          )}
          <p className="text-[11px] text-[var(--color-muted)]">
            The lines are copied into a draft invoice. Editing that invoice afterwards leaves this
            quotation exactly as it was quoted.
          </p>
        </div>
      )}

      {status === "converted" && (
        <p className="text-[12px] text-[var(--color-muted)]">
          Converted. A quotation becomes an invoice once, and this one already has.
        </p>
      )}

      {status === "declined" && (
        <p className="text-[12px] text-[var(--color-muted)]">
          Declined. Copy it into a new quotation if the client comes back.
        </p>
      )}
    </div>
  );
}
