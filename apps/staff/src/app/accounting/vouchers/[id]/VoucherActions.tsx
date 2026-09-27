"use client";

import { useActionState, useState } from "react";
import { voucherAction } from "../../purchasing-actions";
import type { FormState } from "../../action-errors";
import { Alert, Button } from "@/components/ui";

const initial: FormState = {};

/**
 * The lifecycle buttons for a payment voucher.
 *
 * Three people in the chain by design — prepare, approve, pay — and only the step
 * the voucher is actually at is offered. The server checks every one of these
 * again; hiding a button is presentation.
 */
export function VoucherActions({
  voucherId,
  status,
  isPreparer,
  canSubmit,
  canPost,
  canVoid,
  approvalHint,
}: {
  voucherId: string;
  status: string;
  isPreparer: boolean;
  canSubmit: boolean;
  canPost: boolean;
  canVoid: boolean;
  approvalHint: string;
}) {
  const [state, action, pending] = useActionState(voucherAction, initial);
  const [voiding, setVoiding] = useState(false);

  const simple = (value: string, label: string, variant: "primary" | "secondary" = "primary") => (
    <form action={action}>
      <input type="hidden" name="voucherId" value={voucherId} />
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

      {status === "draft" && (
        <div className="space-y-2">
          {canSubmit ? simple("submit", "Send for approval") : (
            <p className="text-[12px] text-[var(--color-muted)]">
              You cannot submit this voucher for approval.
            </p>
          )}
          {canSubmit && (
            <form action={action}>
              <input type="hidden" name="voucherId" value={voucherId} />
              <input type="hidden" name="action" value="delete" />
              <button
                type="submit"
                disabled={pending}
                className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] hover:bg-[var(--color-canvas)]"
              >
                Discard draft
              </button>
            </form>
          )}
        </div>
      )}

      {status === "pending_approval" && (
        <div className="space-y-3">
          <Alert tone="info">{approvalHint}</Alert>
          {isPreparer ? (
            <p className="text-[12px] text-[var(--color-muted)]">
              You raised this voucher, so somebody else has to approve it.
            </p>
          ) : (
            simple("approve", "Approve this payment")
          )}
        </div>
      )}

      {status === "approved" && (
        <div className="space-y-2">
          {canPost ? (
            simple("post", "Post the payment")
          ) : (
            <p className="text-[12px] text-[var(--color-muted)]">
              Approved. Somebody who can release payments has to post it.
            </p>
          )}
          <p className="text-[11px] text-[var(--color-muted)]">
            Posting numbers the voucher and writes the ledger entry. It is the point at which the
            money is treated as gone.
          </p>
        </div>
      )}

      {status === "posted" && canVoid && (
        <div className="space-y-2">
          {voiding ? (
            <form action={action} className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
              <input type="hidden" name="voucherId" value={voucherId} />
              <input type="hidden" name="action" value="void" />
              <label htmlFor="voidReason" className="block text-[12px] font-medium">
                Why is it being voided?
              </label>
              <input
                id="voidReason"
                name="reason"
                required
                placeholder="Paid the wrong supplier, duplicate…"
                className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
              />
              <p className="text-[11px] text-[var(--color-muted)]">
                The ledger entry is reversed and both entries stay visible.
              </p>
              <div className="flex gap-2">
                <Button type="submit" variant="danger" disabled={pending}>
                  {pending ? "Voiding…" : "Void"}
                </Button>
                <button
                  type="button"
                  onClick={() => setVoiding(false)}
                  className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setVoiding(true)}
              className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] hover:bg-[var(--color-canvas)]"
            >
              Void this voucher
            </button>
          )}
        </div>
      )}
    </div>
  );
}
