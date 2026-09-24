"use client";

import { useActionState, useState } from "react";
import { claimAction } from "../../purchasing-actions";
import type { FormState } from "../../action-errors";
import { Alert, Button } from "@/components/ui";

const initial: FormState = {};

export interface ReimbursableVoucher {
  id: string;
  voucherNo: string | null;
  total: string;
}

/**
 * What can be done to a claim next.
 *
 * The claimant's own buttons and the approver's are separated deliberately: the
 * claimant submits and can discard, and everything after that belongs to
 * somebody else. Nobody sees a button the server would refuse.
 */
export function ClaimActions({
  claimId,
  status,
  isClaimant,
  canCreate,
  canApprove,
  canReimburse,
  vouchers,
}: {
  claimId: string;
  status: string;
  isClaimant: boolean;
  canCreate: boolean;
  canApprove: boolean;
  canReimburse: boolean;
  /** Posted vouchers that could be the reimbursement. */
  vouchers: ReimbursableVoucher[];
}) {
  const [state, action, pending] = useActionState(claimAction, initial);
  const [rejecting, setRejecting] = useState(false);
  const [linking, setLinking] = useState(false);

  const simple = (value: string, label: string, variant: "primary" | "secondary" = "primary") => (
    <form action={action}>
      <input type="hidden" name="claimId" value={claimId} />
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

      {status === "draft" &&
        (isClaimant && canCreate ? (
          <div className="space-y-2">
            {simple("submit", "Submit this claim")}
            <form action={action}>
              <input type="hidden" name="claimId" value={claimId} />
              <input type="hidden" name="action" value="delete" />
              <button
                type="submit"
                disabled={pending}
                className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] hover:bg-[var(--color-canvas)]"
              >
                {pending ? "Discarding…" : "Discard draft"}
              </button>
            </form>
          </div>
        ) : (
          <p className="text-[12px] text-[var(--color-muted)]">
            A draft. Only the claimant can submit it.
          </p>
        ))}

      {status === "submitted" && (
        <div className="space-y-2">
          {isClaimant ? (
            <p className="text-[12px] text-[var(--color-muted)]">
              Submitted. You cannot approve your own claim — somebody else decides.
            </p>
          ) : canApprove ? (
            <>
              {simple("approve", "Approve this claim")}
              {rejecting ? (
                <form
                  action={action}
                  className="space-y-2 rounded-md border border-[var(--color-line)] p-3"
                >
                  <input type="hidden" name="claimId" value={claimId} />
                  <input type="hidden" name="action" value="reject" />
                  <label htmlFor="reason" className="block text-[12px] font-medium">
                    Why is it being rejected?
                  </label>
                  <input
                    id="reason"
                    name="reason"
                    required
                    placeholder="No receipt for the second line…"
                    className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
                  />
                  <p className="text-[11px] text-[var(--color-muted)]">
                    The claimant sees this, so write it for them.
                  </p>
                  <div className="flex gap-2">
                    <Button type="submit" variant="danger" disabled={pending}>
                      {pending ? "Rejecting…" : "Reject"}
                    </Button>
                    <button
                      type="button"
                      onClick={() => setRejecting(false)}
                      className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
                    >
                      Keep it open
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setRejecting(true)}
                  className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] hover:bg-[var(--color-canvas)]"
                >
                  Reject it
                </button>
              )}
            </>
          ) : (
            <p className="text-[12px] text-[var(--color-muted)]">
              Waiting for somebody who can approve claims.
            </p>
          )}
        </div>
      )}

      {status === "approved" && (
        <div className="space-y-2">
          {canApprove ? (
            <>
              {simple("post", "Post it to the ledger")}
              <p className="text-[11px] text-[var(--color-muted)]">
                This debits the cost accounts and credits staff claims payable. The firm then owes
                the claimant the money; paying it is a separate step.
              </p>
            </>
          ) : (
            <p className="text-[12px] text-[var(--color-muted)]">
              Approved. Waiting to be posted to the ledger.
            </p>
          )}
        </div>
      )}

      {status === "posted" && (
        <div className="space-y-2">
          <p className="text-[12px] text-[var(--color-muted)]">
            Owed to the claimant. Pay it with a voucher against staff claims payable (2155), then
            record which voucher settled it.
          </p>
          {canReimburse &&
            (linking ? (
              <form
                action={action}
                className="space-y-2 rounded-md border border-[var(--color-line)] p-3"
              >
                <input type="hidden" name="claimId" value={claimId} />
                <input type="hidden" name="action" value="reimburse" />
                <label htmlFor="voucherId" className="block text-[12px] font-medium">
                  Which voucher paid it?
                </label>
                {vouchers.length === 0 ? (
                  <p className="text-[12px] text-[var(--color-muted)]">
                    No posted voucher is available to link. Raise and post the payment voucher
                    first.
                  </p>
                ) : (
                  <select
                    id="voucherId"
                    name="voucherId"
                    required
                    className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
                  >
                    <option value="">Choose…</option>
                    {vouchers.map((voucher) => (
                      <option key={voucher.id} value={voucher.id}>
                        {voucher.voucherNo} — {voucher.total}
                      </option>
                    ))}
                  </select>
                )}
                <div className="flex gap-2">
                  <Button type="submit" variant="primary" disabled={pending || vouchers.length === 0}>
                    {pending ? "Recording…" : "Mark as reimbursed"}
                  </Button>
                  <button
                    type="button"
                    onClick={() => setLinking(false)}
                    className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
                  >
                    Not yet
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setLinking(true)}
                className="rounded-md bg-[var(--color-navy)] px-3 py-2 text-[13px] font-medium text-white"
              >
                Record the reimbursement
              </button>
            ))}
        </div>
      )}

      {status === "reimbursed" && (
        <p className="text-[12px] text-[var(--color-muted)]">
          Paid and settled. Nothing further to do.
        </p>
      )}

      {status === "rejected" && (
        <p className="text-[12px] text-[var(--color-muted)]">
          Rejected. A new claim can be raised if the reason has been dealt with.
        </p>
      )}
    </div>
  );
}
