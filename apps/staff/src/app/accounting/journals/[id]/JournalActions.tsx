"use client";

import { useActionState, useState } from "react";
import {
  deleteJournalAction,
  postJournalAction,
  reverseJournalAction,
  type FormState,
} from "../../actions";
import { Alert, Button } from "@/components/ui";

const initial: FormState = {};

/**
 * Posting.
 *
 * `selfPrepared` is passed in so the screen can explain the maker/checker rule
 * before the click rather than after the refusal. The rule itself is enforced on
 * the server; hiding the button would not be a control.
 */
export function PostJournal({
  journalId,
  selfPrepared,
  secondPersonRequired,
}: {
  journalId: string;
  selfPrepared: boolean;
  secondPersonRequired: boolean;
}) {
  const [state, action, pending] = useActionState(postJournalAction, initial);
  const blocked = selfPrepared && secondPersonRequired;

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="journalId" value={journalId} />
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      {blocked ? (
        <Alert tone="warn">
          You prepared this journal, so you cannot post it. Someone else holding the posting
          capability has to review it. If CAC has only one person who posts journals, an
          administrator can turn off{" "}
          <span className="font-mono text-[11px]">
            accounting.journal_requires_second_person
          </span>{" "}
          in Settings — every self-posted journal is then flagged as such in the audit trail.
        </Alert>
      ) : (
        <>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Posting…" : "Post to the ledger"}
          </Button>
          <p className="text-[11px] text-[var(--color-muted)]">
            Posting is not reversible by editing. From then on the entry is numbered and fixed, and a
            mistake is corrected by a reversal that stays visible.
          </p>
        </>
      )}
    </form>
  );
}

export function ReverseJournal({
  journalId,
  journalNo,
  defaultDate,
}: {
  journalId: string;
  journalNo: string;
  defaultDate: string;
}) {
  const [state, action, pending] = useActionState(reverseJournalAction, initial);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] font-medium hover:bg-[var(--color-canvas)]"
      >
        Reverse this journal
      </button>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-md border border-[var(--color-line)] p-3">
      <input type="hidden" name="journalId" value={journalId} />
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <p className="text-[12px] text-[var(--color-muted)]">
        This posts a new journal with every debit and credit of {journalNo} swapped. Both entries stay
        in the ledger and cancel out, so the history shows what was entered, that it was wrong, and
        what corrected it.
      </p>

      <div>
        <label htmlFor="reversalReason" className="block text-[12px] font-medium">
          Why is it being reversed?
        </label>
        <input
          id="reversalReason"
          name="reason"
          required
          maxLength={500}
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
        />
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          Recorded on the reversal and in the audit trail.
        </p>
      </div>

      <div>
        <label htmlFor="reversalDate" className="block text-[12px] font-medium">
          Date of the reversal
        </label>
        <input
          id="reversalDate"
          name="entryDate"
          type="date"
          defaultValue={defaultDate}
          className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
        />
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          Must fall in an open period. Defaults to the original date when its period is still open.
        </p>
      </div>

      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={pending}>
          {pending ? "Reversing…" : "Post the reversal"}
        </Button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function DeleteDraft({ journalId }: { journalId: string }) {
  const [state, action, pending] = useActionState(deleteJournalAction, initial);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] font-medium hover:bg-[var(--color-canvas)]"
      >
        Discard draft
      </button>
    );
  }

  return (
    <form action={action} className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
      <input type="hidden" name="journalId" value={journalId} />
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <p className="text-[12px]">
        The draft is removed. What it contained is recorded in the audit trail first, so discarding it
        is not the same as it never existing.
      </p>
      <div>
        <label htmlFor="discardReason" className="block text-[12px] font-medium">
          Reason
        </label>
        <input
          id="discardReason"
          name="reason"
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={pending}>
          {pending ? "Discarding…" : "Discard"}
        </Button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px]"
        >
          Keep it
        </button>
      </div>
    </form>
  );
}
