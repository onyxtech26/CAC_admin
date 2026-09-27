"use client";

import { useActionState, useState } from "react";
import { formatAmount, isAmount, parseAmount } from "@cac/core/money";
import {
  countPettyCashAction,
  pettyCashAction,
  recordPettyCashAction,
} from "../purchasing-actions";
import type { FormState } from "../action-errors";
import { Alert, Button, Field, Select } from "@/components/ui";

const initial: FormState = {};

export interface AccountOption {
  id: string;
  code: string;
  name: string;
}

/**
 * Recording a movement in and out of the tin.
 *
 * The kind decides what the other side is: a top-up comes from the bank, an
 * expense goes to a cost account. Showing one list for both would invite a
 * top-up from a revenue account, which the server refuses anyway.
 */
export function PettyCashEntryForm({
  expenseAccounts,
  bankAccounts,
  taxCodes,
  defaultDate,
}: {
  expenseAccounts: AccountOption[];
  bankAccounts: AccountOption[];
  taxCodes: Array<{ id: string; code: string }>;
  defaultDate: string;
}) {
  const [state, action, pending] = useActionState(recordPettyCashAction, initial);
  const [kind, setKind] = useState<"expense" | "top_up">("expense");

  const accounts = kind === "top_up" ? bankAccounts : expenseAccounts;

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="kind" className="block text-[12px] font-medium">
            What happened
          </label>
          <select
            id="kind"
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as "expense")}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          >
            <option value="expense">Money spent from the tin</option>
            <option value="top_up">Topping the tin up from the bank</option>
          </select>
        </div>

        <Field label="Date" name="txnDate" type="date" required defaultValue={defaultDate} />
        <Field label="Amount (RM)" name="amount" required inputMode="numeric" />

        <div>
          <label htmlFor="counterpartAccountId" className="block text-[12px] font-medium">
            {kind === "top_up" ? "Taken from" : "Spent on"}
          </label>
          <select
            id="counterpartAccountId"
            name="counterpartAccountId"
            required
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          >
            <option value="">Choose…</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} {account.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <Field label="What it was for" name="description" required />
        </div>
        <Field
          label="Receipt reference"
          name="receiptRef"
          hint="Where the paper receipt is filed."
        />
      </div>

      {kind === "expense" && taxCodes.length > 0 && (
        <Select
          label="Tax code"
          name="taxCodeId"
          placeholder="None"
          options={taxCodes.map((code) => ({ value: code.id, label: code.code }))}
        />
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Recording…" : "Record it"}
      </Button>
      <p className="text-[11px] text-[var(--color-muted)]">
        Recording it is not posting it. Somebody who can approve petty cash confirms it into the
        ledger, so the person who spent the money is not the person who signs it off.
      </p>
    </form>
  );
}

export function PettyCashRowActions({
  txnId,
  status,
  canApprove,
}: {
  txnId: string;
  status: string;
  canApprove: boolean;
}) {
  const [state, action, pending] = useActionState(pettyCashAction, initial);
  const [voiding, setVoiding] = useState(false);

  if (!canApprove || status === "void") {
    return <span className="text-[11px] text-[var(--color-faint)]">—</span>;
  }

  if (status === "draft") {
    return (
      <form action={action}>
        <input type="hidden" name="txnId" value={txnId} />
        <input type="hidden" name="action" value="post" />
        {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary px-2 py-1 text-[11px]"
        >
          {pending ? "…" : "Post"}
        </button>
      </form>
    );
  }

  if (!voiding) {
    return (
      <button
        type="button"
        onClick={() => setVoiding(true)}
        className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px] hover:bg-[var(--color-canvas)]"
      >
        Void
      </button>
    );
  }

  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="txnId" value={txnId} />
      <input type="hidden" name="action" value="void" />
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      <input
        name="reason"
        required
        placeholder="Reason"
        aria-label="Reason for voiding"
        className="w-32 rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[11px]"
      />
      <div className="flex gap-1">
        <button
          type="submit"
          disabled={pending}
          className="btn btn-danger px-2 py-1 text-[11px]"
        >
          {pending ? "…" : "Void"}
        </button>
        <button
          type="button"
          onClick={() => setVoiding(false)}
          className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
        >
          No
        </button>
      </div>
    </form>
  );
}

/**
 * Counting the tin.
 *
 * The book balance is shown next to the field so the person counting can see the
 * difference before they commit to it — and so a difference is a deliberate
 * statement rather than a surprise. Anything other than nil posts as an
 * adjustment with their name on it.
 */
export function PettyCashCountForm({
  bookBalance,
  defaultDate,
  blocked,
}: {
  /** As a numeric string, so the client can show the difference as it is typed. */
  bookBalance: string;
  defaultDate: string;
  /** Set when unposted entries make a count meaningless. */
  blocked: number;
}) {
  const [state, action, pending] = useActionState(countPettyCashAction, initial);
  const [counted, setCounted] = useState("");

  const difference =
    counted.trim() !== "" && isAmount(counted.trim())
      ? parseAmount(counted.trim()) - parseAmount(bookBalance)
      : null;

  if (blocked > 0) {
    return (
      <Alert tone="warn">
        {blocked} petty cash {blocked === 1 ? "entry has" : "entries have"} not been posted yet.
        Counting the tin against a book balance that does not include what was spent proves nothing,
        so post them first.
      </Alert>
    );
  }

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Counted on" name="countedOn" type="date" required defaultValue={defaultDate} />
        <div>
          <label htmlFor="countedAmount" className="block text-[12px] font-medium">
            What was in the tin (RM)
          </label>
          <input
            id="countedAmount"
            name="countedAmount"
            required
            inputMode="decimal"
            value={counted}
            onChange={(event) => setCounted(event.target.value)}
            className="numeric mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-right text-[14px]"
          />
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            The ledger says {formatAmount(parseAmount(bookBalance))}.
          </p>
        </div>
        <div className="flex items-end">
          {difference === null ? (
            <p className="pb-2 text-[12px] text-[var(--color-muted)]">
              Enter the count to see the difference.
            </p>
          ) : difference === 0n ? (
            <p className="pb-2 text-[13px] font-medium text-[var(--color-ok)]">Agrees exactly.</p>
          ) : (
            <p className="pb-2 text-[13px] font-medium text-[var(--color-warn)]">
              {difference < 0n ? "Short by " : "Over by "}
              <span className="numeric">{formatAmount(difference < 0n ? -difference : difference)}</span>
            </p>
          )}
        </div>
      </div>

      <Field label="Notes" name="notes" hint="Who counted it with you, anything unusual." />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Recording…" : "Record the count"}
      </Button>
      <p className="text-[11px] text-[var(--color-muted)]">
        A difference is posted as an adjustment rather than absorbed into the balance. A shortfall
        nobody can see is a shortfall nobody investigates.
      </p>
    </form>
  );
}
