"use client";

import { useActionState, useState } from "react";
import { createRun, runAction } from "./payroll-actions";
import type { FormState } from "../../accounting/action-errors";
import { Alert, Button, Field } from "@/components/ui";

const initial: FormState = {};

export function CreateRunForm({
  defaultFrom,
  defaultTo,
  defaultPayDate,
  finalisedRuns,
}: {
  defaultFrom: string;
  defaultTo: string;
  defaultPayDate: string;
  /** Runs a supplementary run could correct. */
  finalisedRuns: Array<{ id: string; label: string }>;
}) {
  const [state, action, pending] = useActionState(createRun, initial);
  const [kind, setKind] = useState("regular");

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <div>
        <label htmlFor="kind" className="block text-[12px] font-medium">
          What kind of run
        </label>
        <select
          id="kind"
          name="kind"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
        >
          <option value="regular">The month&rsquo;s payroll</option>
          <option value="supplementary" disabled={finalisedRuns.length === 0}>
            A supplementary run, correcting an earlier one
          </option>
        </select>
        {kind === "supplementary" && (
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            A finalised run is never edited. A supplementary run is how a correction is made, and it
            says which run it corrects. It pays only what that run missed &mdash; overtime whose rate
            arrived afterwards, and the statutory contributions those extra wages attract. No basic
            salary and no allowances: those were paid. Anybody with nothing outstanding gets no
            payslip, and the period has to match the run being corrected.
          </p>
        )}
      </div>

      {kind === "supplementary" && (
        <div>
          <label htmlFor="correctsRunId" className="block text-[12px] font-medium">
            Which run does it correct?
          </label>
          <select
            id="correctsRunId"
            name="correctsRunId"
            required
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          >
            <option value="">Choose…</option>
            {finalisedRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {run.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Period from" name="periodFrom" type="date" required defaultValue={defaultFrom} />
        <Field label="Period to" name="periodTo" type="date" required defaultValue={defaultTo} />
        <Field label="Pay date" name="payDate" type="date" required defaultValue={defaultPayDate} />
      </div>

      <p className="text-[11px] text-[var(--color-muted)]">
        The pay date decides which statutory rules apply, so it matters as much as the period.
      </p>

      <Field label="Notes" name="notes" />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Creating…" : "Create the run"}
      </Button>
    </form>
  );
}

/**
 * The lifecycle buttons.
 *
 * Every step is deliberately separate, and the wording says whose step it is and what
 * it makes irreversible. The statutory refusal is rendered as its own alert rather
 * than as a generic error, because it is not a fault — it is the platform declining
 * to guess, and the message names what is missing.
 */
export function RunActions({
  runId,
  status,
  isPreparer,
  problemCount,
  canPrepare,
  canApprove,
  canFinalise,
  canPost,
}: {
  runId: string;
  status: string;
  isPreparer: boolean;
  problemCount: number;
  canPrepare: boolean;
  canApprove: boolean;
  canFinalise: boolean;
  canPost: boolean;
}) {
  const [state, action, pending] = useActionState(runAction, initial);
  const [reversing, setReversing] = useState(false);
  const [abandoning, setAbandoning] = useState(false);

  const simple = (value: string, label: string, variant: "primary" | "secondary" = "primary") => (
    <form action={action}>
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="action" value={value} />
      <Button type="submit" variant={variant} disabled={pending}>
        {pending ? "Working…" : label}
      </Button>
    </form>
  );

  return (
    <div className="space-y-3">
      {state.field === "statutory" ? (
        <Alert tone="warn">
          <strong>Payroll has not been run, and nothing has been guessed.</strong>
          <span className="mt-1 block">{state.error}</span>
        </Alert>
      ) : (
        state.error && <Alert tone="danger">{state.error}</Alert>
      )}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      {(status === "draft" || status === "prepared") && canPrepare && (
        <div className="space-y-2">
          {simple("prepare", status === "draft" ? "Compute the run" : "Compute it again")}
          <p className="text-[11px] text-[var(--color-muted)]">
            Computing replaces any previous attempt. Nothing is paid and nothing reaches the ledger.
          </p>
        </div>
      )}

      {status === "prepared" && (
        <div className="space-y-2">
          {problemCount > 0 ? (
            <Alert tone="danger">
              {problemCount} payslip{problemCount === 1 ? "" : "s"} could not be computed. The run
              cannot be approved until somebody has looked at them — a run that quietly paid
              everybody except one person is the worst possible outcome.
            </Alert>
          ) : isPreparer ? (
            <p className="text-[12px] text-[var(--color-muted)]">
              You computed this run, so somebody else has to approve it.
            </p>
          ) : canApprove ? (
            simple("approve", "Approve the run")
          ) : (
            <p className="text-[12px] text-[var(--color-muted)]">
              Waiting for somebody who can approve payroll.
            </p>
          )}
        </div>
      )}

      {status === "approved" && canFinalise && (
        <div className="space-y-2">
          {simple("finalise", "Finalise it")}
          <p className="text-[11px] text-[var(--color-muted)]">
            After this the payslips are documents and cannot be changed, and the overtime this run
            paid cannot be claimed again. A correction would be a supplementary run.
          </p>
        </div>
      )}

      {status === "finalised" && canPost && (
        <div className="space-y-2">
          {simple("post", "Post to the ledger")}
          <p className="text-[11px] text-[var(--color-muted)]">
            Debits the costs, credits what is owed to the agencies, and credits net pay to salaries
            payable. Paying the staff is a separate voucher against that account.
          </p>
        </div>
      )}

      {status === "posted" && canPost && (
        <div className="space-y-2">
          <p className="text-[12px] text-[var(--color-muted)]">
            Posted. Reversing puts the accounting right; it does not undo the payroll.
          </p>
          {reversing ? (
            <form action={action} className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
              <input type="hidden" name="runId" value={runId} />
              <input type="hidden" name="action" value="reverse" />
              <label htmlFor="reason" className="block text-[12px] font-medium">
                Why is the entry being reversed?
              </label>
              <input
                id="reason"
                name="reason"
                required
                placeholder="Posted to the wrong period"
                className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[13px]"
              />
              <div className="flex gap-2">
                <Button type="submit" variant="danger" disabled={pending}>
                  {pending ? "…" : "Reverse the entry"}
                </Button>
                <button
                  type="button"
                  onClick={() => setReversing(false)}
                  className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
                >
                  Leave it
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setReversing(true)}
              className="text-[12px] text-[var(--color-muted)] hover:underline"
            >
              Reverse the ledger entry
            </button>
          )}
        </div>
      )}

      {(status === "draft" || status === "prepared" || status === "approved") && canPrepare && (
        <>
          {abandoning ? (
            <form action={action} className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
              <input type="hidden" name="runId" value={runId} />
              <input type="hidden" name="action" value="abandon" />
              <label htmlFor="abandonReason" className="block text-[12px] font-medium">
                Why is it being abandoned?
              </label>
              <input
                id="abandonReason"
                name="reason"
                required
                className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[13px]"
              />
              <div className="flex gap-2">
                <Button type="submit" variant="danger" disabled={pending}>
                  {pending ? "…" : "Abandon"}
                </Button>
                <button
                  type="button"
                  onClick={() => setAbandoning(false)}
                  className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
                >
                  Keep it
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setAbandoning(true)}
              className="text-[12px] text-[var(--color-muted)] hover:underline"
            >
              Abandon this run
            </button>
          )}
        </>
      )}

      {status === "abandoned" && (
        <p className="text-[12px] text-[var(--color-muted)]">
          Abandoned. Create a new run for the period.
        </p>
      )}
    </div>
  );
}
