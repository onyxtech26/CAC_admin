"use client";

import { useActionState, useMemo, useState } from "react";
import { formatAmount, isAmount, parseAmount, sumAmounts } from "@cac/core/money";
import { allocateAction, receiptAction, removeAllocationAction, saveReceipt } from "../sales-actions";
import type { FormState } from "../action-errors";
import { Alert, Button, Field, Select, Textarea } from "@/components/ui";

const initial: FormState = {};

export interface CustomerOption {
  id: string;
  code: string;
  name: string;
}

export interface BankOption {
  id: string;
  code: string;
  name: string;
}

export function ReceiptForm({
  customers,
  bankAccounts,
  receiptId,
  defaults,
}: {
  customers: CustomerOption[];
  bankAccounts: BankOption[];
  receiptId?: string;
  defaults?: {
    customerId: string;
    receiptDate: string;
    method: string;
    reference: string;
    depositAccountId: string;
    amount: string;
    notes: string;
  };
}) {
  const [state, action, pending] = useActionState(saveReceipt, initial);

  return (
    <form action={action} className="space-y-3">
      {receiptId && <input type="hidden" name="receiptId" value={receiptId} />}
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Select
          label="Customer"
          name="customerId"
          required
          placeholder="Choose…"
          defaultValue={defaults?.customerId}
          options={customers.map((customer) => ({
            value: customer.id,
            label: `${customer.code} — ${customer.name}`,
          }))}
        />
        <Field
          label="Date received"
          name="receiptDate"
          type="date"
          required
          defaultValue={defaults?.receiptDate}
        />
        <Field
          label="Amount (RM)"
          name="amount"
          required
          inputMode="numeric"
          defaultValue={defaults?.amount}
          hint="What actually arrived, before any allocation."
        />
        <Select
          label="Method"
          name="method"
          defaultValue={defaults?.method ?? "transfer"}
          options={[
            { value: "transfer", label: "Bank transfer" },
            { value: "cheque", label: "Cheque" },
            { value: "cash", label: "Cash" },
            { value: "card", label: "Card" },
            { value: "other", label: "Other" },
          ]}
        />
        <Field
          label="Reference"
          name="reference"
          defaultValue={defaults?.reference}
          hint="Cheque number, transaction reference, slip number."
        />
        <Select
          label="Into which account"
          name="depositAccountId"
          required
          placeholder="Choose…"
          defaultValue={defaults?.depositAccountId}
          options={bankAccounts.map((account) => ({
            value: account.id,
            label: `${account.code} ${account.name}`,
          }))}
          hint="Money received lands in a bank or cash account."
        />
      </div>

      <Textarea label="Notes" name="notes" rows={2} defaultValue={defaults?.notes} />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : receiptId ? "Save changes" : "Save draft"}
      </Button>
      <p className="text-[11px] text-[var(--color-muted)]">
        A draft records that money arrived. Posting it puts the entry in the ledger; matching it to
        invoices is a separate step, because cash often arrives before anyone knows what it is for.
      </p>
    </form>
  );
}

export function ReceiptActions({
  receiptId,
  status,
  canPost,
  canDelete,
}: {
  receiptId: string;
  status: string;
  canPost: boolean;
  canDelete: boolean;
}) {
  const [state, action, pending] = useActionState(receiptAction, initial);
  const [voiding, setVoiding] = useState(false);

  return (
    <div className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      {status === "draft" && (
        <div className="space-y-2">
          {canPost ? (
            <form action={action}>
              <input type="hidden" name="receiptId" value={receiptId} />
              <input type="hidden" name="action" value="post" />
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? "Posting…" : "Post to the ledger"}
              </Button>
            </form>
          ) : (
            <p className="text-[12px] text-[var(--color-muted)]">
              Somebody who can approve receipts has to post this.
            </p>
          )}
          {canDelete && (
            <form action={action}>
              <input type="hidden" name="receiptId" value={receiptId} />
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

      {status === "posted" && canPost && !voiding && (
        <button
          type="button"
          onClick={() => setVoiding(true)}
          className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] hover:bg-[var(--color-canvas)]"
        >
          Void this receipt
        </button>
      )}

      {status === "posted" && voiding && (
        <form action={action} className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
          <input type="hidden" name="receiptId" value={receiptId} />
          <input type="hidden" name="action" value="void" />
          <label htmlFor="voidReason" className="block text-[12px] font-medium">
            Why is it being voided?
          </label>
          <input
            id="voidReason"
            name="reason"
            required
            placeholder="Cheque bounced, recorded against the wrong customer…"
            className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
          <p className="text-[11px] text-[var(--color-muted)]">
            The ledger entry is reversed and both stay visible. Any allocations must be removed first.
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
      )}
    </div>
  );
}

export interface OpenInvoice {
  id: string;
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string;
  total: string;
  outstanding: string;
  daysOverdue: number | null;
}

/**
 * Matching a receipt to invoices.
 *
 * The running "left to allocate" figure is the point: somebody splitting a
 * payment across four invoices needs to see it reach zero. The suggestion button
 * fills the rows oldest-first, and it fills them rather than submitting them —
 * which invoice a payment is for is the customer's intention, and the software
 * should not decide it quietly.
 */
export function AllocationForm({
  receiptId,
  creditNoteId,
  available,
  openInvoices,
  existing,
  suggested = {},
}: {
  receiptId?: string;
  creditNoteId?: string;
  /** The amount there is to allocate, as a numeric string. */
  available: string;
  openInvoices: OpenInvoice[];
  existing: Record<string, string>;
  /** Oldest first, from `suggestAllocation` on the server. Empty when there is nothing to suggest. */
  suggested?: Record<string, string>;
}) {
  const [state, action, pending] = useActionState(allocateAction, initial);
  const [amounts, setAmounts] = useState<Record<string, string>>(existing);

  const totals = useMemo(() => {
    const allocated = sumAmounts(
      Object.values(amounts).map((value) => {
        const trimmed = value.trim();
        return trimmed === "" || !isAmount(trimmed) ? 0n : parseAmount(trimmed);
      }),
    );
    const availableAmount = isAmount(available) ? parseAmount(available) : 0n;
    return { allocated, remaining: availableAmount - allocated, available: availableAmount };
  }, [amounts, available]);

  /**
   * The server's suggestion, applied to the form.
   *
   * This used to be worked out here, and wrongly. It sorted by `dueDate`, which arrives already
   * formatted for display — "4 June 2026" — so `localeCompare` ordered the invoices alphabetically
   * by month name: April, August, December, February. "Oldest first" put December before February.
   *
   * `suggestAllocation` in the core does the same thing in SQL, ordered by the actual date, and had
   * no callers outside its own test: the feature was built, tested, and never offered. Now it is the
   * only implementation, which is also why the button does nothing when the suggestion is empty
   * rather than falling back to a second guess.
   */
  const suggest = () => setAmounts({ ...suggested });

  if (openInvoices.length === 0) {
    return (
      <p className="text-[12px] text-[var(--color-muted)]">
        This customer has nothing outstanding. The money sits on their account and reduces what they
        owe on the next invoice.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      {receiptId && <input type="hidden" name="receiptId" value={receiptId} />}
      {creditNoteId && <input type="hidden" name="creditNoteId" value={creditNoteId} />}
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">Open invoices</caption>
          <thead>
            <tr className="border-b border-[var(--color-line)]">
              {["Invoice", "Date", "Due", "Total", "Outstanding", "Apply"].map((heading) => (
                <th
                  key={heading}
                  scope="col"
                  className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--color-faint)]"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {openInvoices.map((invoice) => (
              <tr key={invoice.id} className="border-b border-[var(--color-line)]">
                <td className="px-2 py-1.5 font-mono text-[12px]">{invoice.invoiceNo}</td>
                <td className="px-2 py-1.5">{invoice.invoiceDate}</td>
                <td className="px-2 py-1.5">
                  {invoice.dueDate}
                  {invoice.daysOverdue !== null && invoice.daysOverdue > 0 && (
                    <span className="ml-1 text-[11px] text-[var(--color-danger)]">
                      {invoice.daysOverdue}d
                    </span>
                  )}
                </td>
                <td className="numeric px-2 py-1.5 text-right">
                  {formatAmount(parseAmount(invoice.total))}
                </td>
                <td className="numeric px-2 py-1.5 text-right">
                  {formatAmount(parseAmount(invoice.outstanding))}
                </td>
                <td className="px-2 py-1.5">
                  <input
                    name={`allocation[${invoice.id}]`}
                    value={amounts[invoice.id] ?? ""}
                    onChange={(event) =>
                      setAmounts((current) => ({ ...current, [invoice.id]: event.target.value }))
                    }
                    inputMode="decimal"
                    aria-label={`Amount to apply to ${invoice.invoiceNo}`}
                    className="numeric w-28 rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-right"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-line)] pt-3">
        <div className="text-[13px]">
          <span className="text-[var(--color-muted)]">Applied </span>
          <span className="numeric font-semibold">{formatAmount(totals.allocated)}</span>
          <span className="text-[var(--color-muted)]"> of {formatAmount(totals.available)}. </span>
          <span
            className={`numeric font-semibold ${
              totals.remaining < 0n
                ? "text-[var(--color-danger)]"
                : totals.remaining > 0n
                  ? "text-[var(--color-warn)]"
                  : "text-[var(--color-ok)]"
            }`}
          >
            {totals.remaining < 0n
              ? `${formatAmount(-totals.remaining)} over`
              : totals.remaining > 0n
                ? `${formatAmount(totals.remaining)} left`
                : "fully applied"}
          </span>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={suggest}
            disabled={Object.keys(suggested).length === 0}
            className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] hover:bg-[var(--color-canvas)] disabled:opacity-50"
          >
            Suggest oldest first
          </button>
          <Button type="submit" variant="primary" disabled={pending || totals.remaining < 0n}>
            {pending ? "Saving…" : "Save allocation"}
          </Button>
        </div>
      </div>

      <p className="text-[11px] text-[var(--color-muted)]">
        Saving replaces whatever was allocated before. Nothing is posted to the ledger: the invoice
        and the receipt have both already been through it, and this only records which paid for which.
      </p>
    </form>
  );
}

export function RemoveAllocation({ allocationId }: { allocationId: string }) {
  const [state, action, pending] = useActionState(removeAllocationAction, initial);

  return (
    <form action={action}>
      <input type="hidden" name="allocationId" value={allocationId} />
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px] hover:bg-[var(--color-canvas)]"
      >
        {pending ? "…" : "Unapply"}
      </button>
    </form>
  );
}
