"use client";

import { useActionState, useState } from "react";
import { deletePurchaseOrderAction, purchaseOrderAction } from "../../purchasing-actions";
import type { FormState } from "../../action-errors";
import { Alert, Button } from "@/components/ui";

const initial: FormState = {};

export interface ReceivableLine {
  id: string;
  description: string;
  quantity: string;
  quantityReceived: string;
}

/**
 * The lifecycle buttons for a purchase order.
 *
 * The receiving form is the interesting one: quantities per line, pre-filled with
 * what has already been recorded, because a partial delivery is the normal case
 * and the person entering it is reading a delivery note, not a screen.
 */
export function OrderActions({
  orderId,
  status,
  isPreparer,
  canCreate,
  canApprove,
  canReceive,
  canClose,
  lines,
}: {
  orderId: string;
  status: string;
  isPreparer: boolean;
  canCreate: boolean;
  canApprove: boolean;
  canReceive: boolean;
  canClose: boolean;
  lines: ReceivableLine[];
}) {
  const [state, action, pending] = useActionState(purchaseOrderAction, initial);
  const [receiving, setReceiving] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const simple = (value: string, label: string, variant: "primary" | "secondary" = "primary") => (
    <form action={action}>
      <input type="hidden" name="orderId" value={orderId} />
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

      {status === "draft" && canCreate && (
        <div className="space-y-2">
          {simple("submit", "Send for approval")}
          <DeleteDraft orderId={orderId} />
        </div>
      )}

      {status === "pending_approval" && (
        <div className="space-y-2">
          {isPreparer ? (
            <p className="text-[12px] text-[var(--color-muted)]">
              You raised this order, so somebody else has to approve it.
            </p>
          ) : canApprove ? (
            simple("approve", "Approve this order")
          ) : (
            <p className="text-[12px] text-[var(--color-muted)]">
              Waiting for somebody who can approve purchase orders.
            </p>
          )}
        </div>
      )}

      {status === "approved" && canCreate && (
        <div className="space-y-2">
          {simple("issue", "Send to the supplier")}
          <p className="text-[11px] text-[var(--color-muted)]">
            This numbers the order and fixes its contents. The platform does not email it — attach
            the order to your own message.
          </p>
        </div>
      )}

      {(status === "issued" || status === "received") && (
        <div className="space-y-3">
          {canReceive &&
            (receiving ? (
              <form action={action} className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
                <input type="hidden" name="orderId" value={orderId} />
                <input type="hidden" name="action" value="receive" />
                <p className="text-[12px] font-medium">How much has arrived?</p>
                {lines.map((line) => (
                  <div key={line.id} className="flex items-center justify-between gap-3 text-[12px]">
                    <span className="min-w-0 flex-1 truncate">{line.description}</span>
                    <span className="text-[var(--color-muted)]">of {trim(line.quantity)}</span>
                    <input
                      name={`receive[${line.id}]`}
                      defaultValue={trim(line.quantityReceived)}
                      inputMode="decimal"
                      aria-label={`Quantity received for ${line.description}`}
                      className="numeric w-20 rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-right"
                    />
                  </div>
                ))}
                <p className="text-[11px] text-[var(--color-muted)]">
                  Cumulative, not incremental: enter the total received so far on each line.
                </p>
                <div className="flex gap-2">
                  <Button type="submit" variant="primary" disabled={pending}>
                    {pending ? "Recording…" : "Record delivery"}
                  </Button>
                  <button
                    type="button"
                    onClick={() => setReceiving(false)}
                    className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setReceiving(true)}
                className="btn btn-primary px-3 py-2 text-[13px]"
              >
                Record a delivery
              </button>
            ))}

          {canClose && simple("close", "Close this order", "secondary")}

          {canApprove &&
            (cancelling ? (
              <form action={action} className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
                <input type="hidden" name="orderId" value={orderId} />
                <input type="hidden" name="action" value="cancel" />
                <label htmlFor="cancelReason" className="block text-[12px] font-medium">
                  Why is it being cancelled?
                </label>
                <input
                  id="cancelReason"
                  name="reason"
                  required
                  placeholder="Supplier could not meet the date…"
                  className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
                />
                <div className="flex gap-2">
                  <Button type="submit" variant="danger" disabled={pending}>
                    {pending ? "Cancelling…" : "Cancel the order"}
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
                className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] hover:bg-[var(--color-canvas)]"
              >
                Cancel this order
              </button>
            ))}
        </div>
      )}

      {(status === "closed" || status === "cancelled") && (
        <p className="text-[12px] text-[var(--color-muted)]">
          This order is {status}. Raise a new one if more is needed.
        </p>
      )}
    </div>
  );
}

function DeleteDraft({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState(deletePurchaseOrderAction, initial);

  return (
    <form action={action}>
      <input type="hidden" name="orderId" value={orderId} />
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] hover:bg-[var(--color-canvas)]"
      >
        {pending ? "Discarding…" : "Discard draft"}
      </button>
    </form>
  );
}

/** "6.000000" reads better as "6". */
function trim(quantity: string): string {
  const asNumber = Number.parseFloat(quantity);
  return Number.isFinite(asNumber) ? String(asNumber) : quantity;
}
