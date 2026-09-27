"use client";

import { useActionState } from "react";
import type { FormState } from "../../action-errors";
import { billAction, settleBill, unsettleBill } from "../../bills-actions";
import { Alert, Button } from "@/components/ui";

const initial: FormState = {};

/**
 * What can be done to a bill, and by whom.
 *
 * Every button is a form posting to a server action; nothing is decided here. The buttons a
 * person cannot use are not rendered, which is a courtesy rather than a control — the capability
 * is checked again on the server, and again inside the business function.
 */
export function BillActions({
  billId,
  status,
  canApprove,
  canPost,
  canVoid,
  canEdit,
}: {
  billId: string;
  status: string;
  canApprove: boolean;
  canPost: boolean;
  canVoid: boolean;
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(billAction, initial);

  return (
    <div className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="flex flex-wrap gap-2">
        {status === "draft" && canEdit && (
          <form action={action}>
            <input type="hidden" name="billId" value={billId} />
            <input type="hidden" name="action" value="submit" />
            <Button type="submit" disabled={pending}>
              Send for approval
            </Button>
          </form>
        )}

        {status === "pending_approval" && canApprove && (
          <form action={action}>
            <input type="hidden" name="billId" value={billId} />
            <input type="hidden" name="action" value="approve" />
            <Button type="submit" disabled={pending}>
              Approve as genuine
            </Button>
          </form>
        )}

        {status === "pending_approval" && canApprove && (
          <form action={action} className="flex items-end gap-2">
            <input type="hidden" name="billId" value={billId} />
            <input type="hidden" name="action" value="return" />
            <div>
              <label htmlFor="return-reason" className="sr-only">
                What needs correcting
              </label>
              <input
                id="return-reason"
                name="reason"
                required
                placeholder="What needs correcting"
                className="control w-56 px-2 py-1.5 text-[12px]"
              />
            </div>
            <Button type="submit" variant="secondary" disabled={pending}>
              Send back
            </Button>
          </form>
        )}

        {status === "approved" && canPost && (
          <form action={action}>
            <input type="hidden" name="billId" value={billId} />
            <input type="hidden" name="action" value="post" />
            <Button type="submit" disabled={pending}>
              Post to the ledger
            </Button>
          </form>
        )}

        {status === "draft" && canEdit && (
          <form action={action}>
            <input type="hidden" name="billId" value={billId} />
            <input type="hidden" name="action" value="delete" />
            <Button type="submit" variant="danger" disabled={pending}>
              Delete draft
            </Button>
          </form>
        )}
      </div>

      {(status === "posted" || status === "settled") && canVoid && (
        <form action={action} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="billId" value={billId} />
          <input type="hidden" name="action" value="void" />
          <div>
            <label htmlFor="void-reason" className="block text-[12px] font-medium">
              Void this bill
            </label>
            <input
              id="void-reason"
              name="reason"
              required
              placeholder="Why it should never have existed"
              className="control mt-1 w-72 px-2 py-1.5 text-[12px]"
            />
          </div>
          <Button type="submit" variant="danger" disabled={pending}>
            Void
          </Button>
        </form>
      )}

      {status === "posted" && (
        <p className="text-[11px] text-[var(--color-muted)]">
          Voiding reverses the journal and is for a bill that should never have existed — the wrong
          supplier, a duplicate, somebody else&rsquo;s invoice. Where the work was done and the
          amount is merely wrong, ask the supplier for a credit note: it leaves the original
          visible, which is what they have in their own records.
        </p>
      )}
    </div>
  );
}

/** Applying a posted voucher, or a posted supplier credit note, to this bill. */
export function SettleForm({
  billId,
  outstanding,
  vouchers,
  creditNotes,
}: {
  billId: string;
  outstanding: string;
  vouchers: Array<{ id: string; label: string }>;
  creditNotes: Array<{ id: string; label: string }>;
}) {
  const [state, action, pending] = useActionState(settleBill, initial);

  if (vouchers.length === 0 && creditNotes.length === 0) {
    return (
      <p className="text-[12px] text-[var(--color-muted)]">
        Nothing to apply. A payment voucher made out to this supplier has to be posted before it
        can settle a bill, and so does a credit note.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="billId" value={billId} />
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="source" className="block text-[12px] font-medium">
            Apply
          </label>
          <select id="source" name="source" defaultValue="voucher" className="control mt-1">
            <option value="voucher">A payment</option>
            <option value="credit_note">A credit note</option>
          </select>
        </div>

        <div>
          <label htmlFor="voucherId" className="block text-[12px] font-medium">
            Payment
          </label>
          <select id="voucherId" name="voucherId" defaultValue="" className="control mt-1">
            <option value="">—</option>
            {vouchers.map((voucher) => (
              <option key={voucher.id} value={voucher.id}>
                {voucher.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="creditNoteId" className="block text-[12px] font-medium">
            Credit note
          </label>
          <select id="creditNoteId" name="creditNoteId" defaultValue="" className="control mt-1">
            <option value="">—</option>
            {creditNotes.map((note) => (
              <option key={note.id} value={note.id}>
                {note.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="amount" className="block text-[12px] font-medium">
            Amount
          </label>
          <input
            id="amount"
            name="amount"
            inputMode="decimal"
            required
            defaultValue={outstanding}
            className="control numeric mt-1 text-right"
          />
        </div>
      </div>

      <Button type="submit" disabled={pending}>
        Apply
      </Button>
    </form>
  );
}

export function RemoveSettlement({
  billId,
  settlementId,
}: {
  billId: string;
  settlementId: string;
}) {
  const [state, action, pending] = useActionState(unsettleBill, initial);

  return (
    <form action={action} className="flex items-center gap-1.5">
      <input type="hidden" name="billId" value={billId} />
      <input type="hidden" name="settlementId" value={settlementId} />
      <label htmlFor={`why-${settlementId}`} className="sr-only">
        Why it is being removed
      </label>
      <input
        id={`why-${settlementId}`}
        name="reason"
        required
        placeholder="Why"
        className="control w-32 px-2 py-1 text-[11px]"
      />
      <button type="submit" disabled={pending} className="btn btn-danger px-2 py-1 text-[11px]">
        Remove
      </button>
      {state.error && <span className="text-[11px] text-[var(--color-danger)]">{state.error}</span>}
    </form>
  );
}
