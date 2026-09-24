"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { matchAction, reconciliationAction } from "../../banking-actions";
import type { FormState } from "../../../action-errors";
import { Alert, Badge, Button } from "@/components/ui";

const initial: FormState = {};

export interface Candidate {
  journalLineId: string;
  journalNo: string | null;
  entryDate: string;
  memo: string;
  amount: string;
  reasons: string[];
  sourceType: string;
}

export interface LineForMatching {
  id: string;
  lineNo: number;
  txnDate: string;
  description: string;
  reference: string | null;
  paidIn: string;
  paidOut: string;
  status: string;
  ignoreReason: string | null;
  journalNo: string | null;
  journalId: string | null;
  matchMethod: string | null;
  matchedByName: string | null;
}

/**
 * One statement line, and the three things that can be done with it.
 *
 * Candidates are offered, never applied. An automatic match that is wrong is
 * worse than no match: it is never looked at again, and the reconciliation
 * balances while saying something false. So every candidate is shown with the
 * reasons it is a candidate, and a person presses the button.
 */
export function StatementLineRow({
  bankAccountId,
  line,
  candidates,
  accounts,
}: {
  bankAccountId: string;
  line: LineForMatching;
  candidates: Candidate[];
  accounts: Array<{ id: string; code: string; name: string }>;
}) {
  const [state, action, pending] = useActionState(matchAction, initial);
  const [mode, setMode] = useState<"idle" | "post" | "ignore">("idle");

  const direction = line.paidIn === "—" ? "out" : "in";

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px]">
            <span className="font-mono text-[11px] text-[var(--color-muted)]">
              {line.txnDate}
            </span>{" "}
            {line.description}
          </p>
          {line.reference && (
            <p className="text-[11px] text-[var(--color-muted)]">ref {line.reference}</p>
          )}
          {line.status === "matched" && (
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">
              explained by{" "}
              <Link
                href={`/accounting/journals/${line.journalId}`}
                className="font-mono text-[var(--color-info)] hover:underline"
              >
                {line.journalNo}
              </Link>
              {line.matchedByName && ` · matched by ${line.matchedByName}`}
              {line.matchMethod === "posted_from_statement" && " · posted from this statement"}
            </p>
          )}
          {line.status === "ignored" && (
            <p className="mt-1 text-[11px] text-[var(--color-warn)]">
              set aside: {line.ignoreReason}
            </p>
          )}
        </div>

        <div className="text-right">
          <p className={`numeric text-[14px] font-medium ${direction === "in" ? "text-[var(--color-ok)]" : ""}`}>
            {direction === "in" ? `+${line.paidIn}` : `−${line.paidOut}`}
          </p>
          <p className="mt-0.5">
            {line.status === "matched" ? (
              <Badge tone="ok">accounted for</Badge>
            ) : line.status === "ignored" ? (
              <Badge tone="neutral">set aside</Badge>
            ) : (
              <Badge tone="warn">needs a decision</Badge>
            )}
          </p>
        </div>
      </div>

      {state.error && (
        <div className="mt-2">
          <Alert tone="danger">{state.error}</Alert>
        </div>
      )}

      {line.status === "matched" && (
        <form action={action} className="mt-2">
          <input type="hidden" name="bankAccountId" value={bankAccountId} />
          <input type="hidden" name="statementLineId" value={line.id} />
          <input type="hidden" name="action" value="unmatch" />
          <button
            type="submit"
            disabled={pending}
            className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-danger)] hover:underline disabled:opacity-50"
          >
            {pending ? "…" : "This is not the same payment — unmatch it"}
          </button>
        </form>
      )}

      {line.status === "ignored" && (
        <form action={action} className="mt-2">
          <input type="hidden" name="bankAccountId" value={bankAccountId} />
          <input type="hidden" name="statementLineId" value={line.id} />
          <input type="hidden" name="action" value="restore" />
          <button
            type="submit"
            disabled={pending}
            className="text-[11px] text-[var(--color-info)] hover:underline disabled:opacity-50"
          >
            {pending ? "…" : "Bring it back into the list"}
          </button>
        </form>
      )}

      {line.status === "unmatched" && (
        <div className="mt-2 space-y-2">
          {candidates.length > 0 ? (
            <ul className="space-y-1">
              {candidates.map((candidate) => (
                <li
                  key={candidate.journalLineId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1 text-[12px]">
                    <Link
                      href={`/accounting/journals/${candidate.journalLineId}`}
                      className="font-mono text-[11px] text-[var(--color-info)] hover:underline"
                    >
                      {candidate.journalNo}
                    </Link>{" "}
                    <span className="text-[var(--color-muted)]">{candidate.entryDate}</span>{" "}
                    {candidate.memo}
                    <span className="block text-[10px] text-[var(--color-faint)]">
                      {candidate.reasons.join(" · ")}
                    </span>
                  </div>
                  <span className="numeric text-[12px]">{candidate.amount}</span>
                  <form action={action}>
                    <input type="hidden" name="bankAccountId" value={bankAccountId} />
                    <input type="hidden" name="statementLineId" value={line.id} />
                    <input type="hidden" name="journalLineId" value={candidate.journalLineId} />
                    <input type="hidden" name="action" value="match" />
                    <input type="hidden" name="method" value="suggested" />
                    <button
                      type="submit"
                      disabled={pending}
                      className="rounded bg-[var(--color-navy)] px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                    >
                      {pending ? "…" : "Same payment"}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-[var(--color-muted)]">
              No ledger entry on this account has that amount in that direction and is still
              unexplained. Either the ledger never recorded it, or what was recorded is for a
              different amount.
            </p>
          )}

          {mode === "idle" && (
            <div className="flex flex-wrap gap-3 text-[11px]">
              <button
                type="button"
                onClick={() => setMode("post")}
                className="text-[var(--color-info)] hover:underline"
              >
                The ledger never recorded this — post it
              </button>
              <button
                type="button"
                onClick={() => setMode("ignore")}
                className="text-[var(--color-muted)] hover:underline"
              >
                Set it aside
              </button>
            </div>
          )}

          {mode === "post" && (
            <form
              action={action}
              className="space-y-2 rounded-md border border-[var(--color-line-strong)] p-3"
            >
              <input type="hidden" name="bankAccountId" value={bankAccountId} />
              <input type="hidden" name="statementLineId" value={line.id} />
              <input type="hidden" name="action" value="post" />

              <p className="text-[12px] font-medium">
                {direction === "in"
                  ? "Money the bank received. What was it for?"
                  : "Money the bank paid out. What was it for?"}
              </p>
              <p className="text-[11px] text-[var(--color-muted)]">
                This posts a journal dated {line.txnDate} for{" "}
                {direction === "in" ? line.paidIn : line.paidOut}:{" "}
                {direction === "in"
                  ? "debit the bank, credit the account you choose"
                  : "debit the account you choose, credit the bank"}
                . The date, the amount and the direction are the bank&rsquo;s — only the other side
                is your choice.
              </p>

              <div>
                <label htmlFor={`account-${line.id}`} className="block text-[11px] font-medium">
                  Account
                </label>
                <select
                  id={`account-${line.id}`}
                  name="accountId"
                  required
                  className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-[12px]"
                >
                  <option value="">Choose…</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} {account.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor={`memo-${line.id}`} className="block text-[11px] font-medium">
                  Memo
                </label>
                <input
                  id={`memo-${line.id}`}
                  name="memo"
                  defaultValue={line.description}
                  className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-[12px]"
                />
              </div>

              <div className="flex gap-2">
                <Button type="submit" variant="primary" disabled={pending}>
                  {pending ? "Posting…" : "Post and match"}
                </Button>
                <button
                  type="button"
                  onClick={() => setMode("idle")}
                  className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[12px]"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {mode === "ignore" && (
            <form
              action={action}
              className="space-y-2 rounded-md border border-[var(--color-line)] p-3"
            >
              <input type="hidden" name="bankAccountId" value={bankAccountId} />
              <input type="hidden" name="statementLineId" value={line.id} />
              <input type="hidden" name="action" value="ignore" />

              <label htmlFor={`reason-${line.id}`} className="block text-[11px] font-medium">
                Why is this not a transaction to record?
              </label>
              <input
                id={`reason-${line.id}`}
                name="reason"
                required
                placeholder="Advice line the bank reversed on the next row"
                className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-[12px]"
              />
              <p className="text-[11px] text-[var(--color-muted)]">
                Recorded against your name. Setting a line aside is a decision, not a way of
                clearing the list — the amount still counts towards the reconciliation.
              </p>
              <div className="flex gap-2">
                <Button type="submit" variant="secondary" disabled={pending}>
                  {pending ? "…" : "Set aside"}
                </Button>
                <button
                  type="button"
                  onClick={() => setMode("idle")}
                  className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[12px]"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </li>
  );
}

export function CompleteReconciliation({
  bankAccountId,
  reconciliationId,
  canReconcile,
  balanced,
  outstanding,
  ignored,
  asAt,
}: {
  bankAccountId: string;
  reconciliationId: string;
  canReconcile: boolean;
  balanced: boolean;
  outstanding: number;
  ignored: number;
  asAt: string;
}) {
  const [state, action, pending] = useActionState(reconciliationAction, initial);

  if (!canReconcile) {
    return (
      <p className="text-[12px] text-[var(--color-muted)]">
        Matching is yours to do; signing the account off as reconciled belongs to whoever owns the
        ledger. Leave the matching done and they will finish it.
      </p>
    );
  }

  const ready = balanced && outstanding === 0;

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <input type="hidden" name="bankAccountId" value={bankAccountId} />
      <input type="hidden" name="reconciliationId" value={reconciliationId} />
      <input type="hidden" name="action" value="complete" />

      {!ready && (
        <p className="text-[12px] text-[var(--color-muted)]">
          {!balanced
            ? "The two records do not yet agree on where they started."
            : `${outstanding} statement line${outstanding === 1 ? "" : "s"} still need${
                outstanding === 1 ? "s" : ""
              } accounting for.`}
        </p>
      )}

      {ignored > 0 && (
        <p className="text-[11px] text-[var(--color-muted)]">
          {ignored} line{ignored === 1 ? "" : "s"} set aside with a reason. They still count towards
          the balance.
        </p>
      )}

      <div>
        <label htmlFor="notes" className="block text-[12px] font-medium">
          Notes for the record
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={2}
          placeholder="What the outstanding items are, and when they are expected to clear."
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
        />
      </div>

      <Button type="submit" variant="primary" disabled={pending || !ready}>
        {pending ? "Signing off…" : `Reconciled as at ${asAt}`}
      </Button>
    </form>
  );
}
