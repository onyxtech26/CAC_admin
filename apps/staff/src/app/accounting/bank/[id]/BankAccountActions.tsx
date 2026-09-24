"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { deleteStatementAction, reconciliationAction } from "../banking-actions";
import type { FormState } from "../../action-errors";
import { Alert, Button } from "@/components/ui";

const initial: FormState = {};

export function StatementActions({
  bankAccountId,
  statementId,
  periodTo,
}: {
  bankAccountId: string;
  statementId: string;
  periodTo: string;
}) {
  const [state, action, pending] = useActionState(deleteStatementAction, initial);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-danger)] hover:underline"
      >
        Remove
      </button>
    );
  }

  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="bankAccountId" value={bankAccountId} />
      <input type="hidden" name="statementId" value={statementId} />
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      <input
        name="reason"
        required
        placeholder="Why"
        aria-label={`Reason for removing the statement to ${periodTo}`}
        className="w-28 rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[11px]"
      />
      <div className="flex gap-1">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-[var(--color-danger)] px-2 py-1 text-[11px] text-white disabled:opacity-50"
        >
          {pending ? "…" : "Remove"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
        >
          Keep
        </button>
      </div>
      <p className="text-[10px] text-[var(--color-muted)]">
        Removing takes its lines and matches with it. Anything a completed reconciliation stands
        on cannot be removed at all.
      </p>
    </form>
  );
}

/**
 * Opening, finishing or abandoning a reconciliation.
 *
 * Only one can be open per account, so this is either the button to start one or
 * the link into the one already running — never both.
 */
export function ReconciliationControls({
  bankAccountId,
  canReconcile,
  openId,
  openAsAt,
  defaultAsAt,
  hasStatements,
}: {
  bankAccountId: string;
  canReconcile: boolean;
  openId: string | null;
  openAsAt: string | null;
  defaultAsAt: string;
  hasStatements: boolean;
}) {
  const [state, action, pending] = useActionState(reconciliationAction, initial);
  const [abandoning, setAbandoning] = useState(false);

  if (!canReconcile) {
    return (
      <p className="text-[12px] text-[var(--color-muted)]">
        Signing an account off as reconciled is reserved to the people who own the ledger.
        Importing statements and matching lines is not.
      </p>
    );
  }

  if (!hasStatements) {
    return (
      <p className="text-[12px] text-[var(--color-muted)]">
        Import a statement first. There is nothing to reconcile the ledger against until the bank
        has told us what it thinks happened.
      </p>
    );
  }

  if (openId) {
    return (
      <div className="space-y-3">
        {state.error && <Alert tone="danger">{state.error}</Alert>}
        {state.notice && <Alert tone="ok">{state.notice}</Alert>}

        <p className="text-[12px]">
          A reconciliation to <strong>{openAsAt}</strong> is open.
        </p>
        <Link
          href={`/accounting/bank/${bankAccountId}/reconcile`}
          className="inline-block rounded-md bg-[var(--color-navy)] px-3 py-2 text-[13px] font-medium text-white"
        >
          Carry on with it
        </Link>

        {abandoning ? (
          <form action={action} className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
            <input type="hidden" name="bankAccountId" value={bankAccountId} />
            <input type="hidden" name="reconciliationId" value={openId} />
            <input type="hidden" name="action" value="abandon" />
            <label htmlFor="abandonReason" className="block text-[12px] font-medium">
              Why is it being abandoned?
            </label>
            <input
              id="abandonReason"
              name="reason"
              required
              className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
            />
            <p className="text-[11px] text-[var(--color-muted)]">
              The matches made along the way are kept — they were judgements about the same money
              and are still true. Only the attempt to sign off goes.
            </p>
            <div className="flex gap-2">
              <Button type="submit" variant="danger" disabled={pending}>
                {pending ? "…" : "Abandon"}
              </Button>
              <button
                type="button"
                onClick={() => setAbandoning(false)}
                className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
              >
                Keep it open
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAbandoning(true)}
            className="block text-[12px] text-[var(--color-muted)] hover:underline"
          >
            Abandon it
          </button>
        )}
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <input type="hidden" name="bankAccountId" value={bankAccountId} />
      <input type="hidden" name="action" value="open" />

      <div>
        <label htmlFor="asAt" className="block text-[12px] font-medium">
          Reconcile as at
        </label>
        <input
          id="asAt"
          name="asAt"
          type="date"
          required
          defaultValue={defaultAsAt}
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
        />
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          Usually the closing date of the statement being worked. It has to be later than the last
          reconciliation.
        </p>
      </div>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Opening…" : "Start reconciling"}
      </Button>
    </form>
  );
}
