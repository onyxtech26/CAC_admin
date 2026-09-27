"use client";

import { useActionState, useState } from "react";
import { importAction } from "../../../hr-actions";
import type { FormState } from "../../../../accounting/action-errors";
import { Alert, Button } from "@/components/ui";

const initial: FormState = {};

/**
 * Confirming or discarding a staged batch.
 *
 * This is the step that writes into attendance, and it is separate from reading the
 * file on purpose: somebody has to look at what was read first. The wording says
 * what confirming will and will not do, because "it skipped some" is much better
 * understood before the fact than after.
 */
export function ImportActions({
  importId,
  status,
  acceptedCount,
  rejectedCount,
}: {
  importId: string;
  status: "staged" | "confirmed" | "discarded";
  acceptedCount: number;
  rejectedCount: number;
}) {
  const [state, action, pending] = useActionState(importAction, initial);
  const [discarding, setDiscarding] = useState(false);

  if (status === "confirmed") {
    return (
      <div className="space-y-2">
        {state.notice && <Alert tone="ok">{state.notice}</Alert>}
        <p className="text-[12px] text-[var(--color-muted)]">
          Confirmed. The accepted days are in attendance, and this batch is the record of where they
          came from. Correct a day on the attendance screen rather than re-importing.
        </p>
      </div>
    );
  }

  if (status === "discarded") {
    return (
      <p className="text-[12px] text-[var(--color-muted)]">
        Discarded. Nothing from this file reached attendance.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <form action={action} className="space-y-2">
        <input type="hidden" name="importId" value={importId} />
        <input type="hidden" name="action" value="confirm" />

        <Button type="submit" variant="primary" disabled={pending || acceptedCount === 0}>
          {pending ? "Writing…" : `Confirm and write ${acceptedCount} day${acceptedCount === 1 ? "" : "s"}`}
        </Button>

        <ul className="space-y-1 text-[11px] text-[var(--color-muted)]">
          <li>
            {rejectedCount > 0
              ? `${rejectedCount} row${rejectedCount === 1 ? "" : "s"} will not be written; they stay here with the reason.`
              : "Every row read will be written."}
          </li>
          <li>
            A day that already has a record is left alone, not overwritten — a correction somebody
            made by hand survives an import of the same day.
          </li>
          <li>Days are written as drafts. Finalising a period is a separate act.</li>
        </ul>
      </form>

      {discarding ? (
        <form action={action} className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
          <input type="hidden" name="importId" value={importId} />
          <input type="hidden" name="action" value="discard" />
          <label htmlFor="reason" className="block text-[12px] font-medium">
            Why is it being discarded?
          </label>
          <input
            id="reason"
            name="reason"
            required
            placeholder="Wrong device, wrong month, columns mapped wrongly…"
            className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[13px]"
          />
          <div className="flex gap-2">
            <Button type="submit" variant="danger" disabled={pending}>
              {pending ? "…" : "Discard it"}
            </Button>
            <button
              type="button"
              onClick={() => setDiscarding(false)}
              className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
            >
              Keep it
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setDiscarding(true)}
          className="text-[12px] text-[var(--color-muted)] hover:underline"
        >
          Discard this batch
        </button>
      )}
    </div>
  );
}
