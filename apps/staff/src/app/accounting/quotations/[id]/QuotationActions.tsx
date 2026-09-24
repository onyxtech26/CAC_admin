"use client";

import { useActionState } from "react";
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
            This numbers the quotation and fixes its contents. The platform does not email it —
            attach the PDF to your own message, so what the client received is what you sent.
          </p>
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
