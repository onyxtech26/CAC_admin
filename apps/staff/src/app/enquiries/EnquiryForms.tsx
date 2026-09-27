"use client";

import { useActionState, useState } from "react";
import type { EnquiryStatus } from "@cac/core";
import { handleEnquiryAction } from "./actions";
import type { FormState } from "../accounting/action-errors";
import { Alert, Button } from "@/components/ui";

const initial: FormState = {};

const NEXT: Array<{ value: EnquiryStatus; label: string }> = [
  { value: "in_progress", label: "I am answering this" },
  { value: "answered", label: "Answered" },
  { value: "converted", label: "Became business" },
  { value: "closed", label: "Closed" },
  { value: "spam", label: "Spam" },
];

/**
 * Recording what was done about an enquiry.
 *
 * Only the handling. What the enquirer wrote cannot be edited from here, or from anywhere — the
 * database refuses it — because an enquiry marked "answered" by rewriting the question is not an
 * answer.
 *
 * Marking one as spam asks for a reason, and that is not bureaucracy: it is a judgement about
 * somebody's message, made by one person, that the next person should be able to see behind.
 */
export function EnquiryHandling({
  enquiryId,
  status,
}: {
  enquiryId: string;
  status: EnquiryStatus;
}) {
  const [state, action, pending] = useActionState(handleEnquiryAction, initial);
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState<EnquiryStatus>(
    status === "new" ? "in_progress" : "answered",
  );

  if (!open) {
    return (
      <div className="space-y-1">
        {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
        {state.notice && <p className="text-[11px] text-[var(--color-ok)]">{state.notice}</p>}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
        >
          Record what happened
        </button>
      </div>
    );
  }

  return (
    <form action={action} className="w-64 space-y-2 rounded-md border border-[var(--color-line)] p-2">
      <input type="hidden" name="enquiryId" value={enquiryId} />
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <div>
        <label htmlFor={`status-${enquiryId}`} className="block text-[11px] font-medium">
          What happened
        </label>
        <select
          id={`status-${enquiryId}`}
          name="status"
          value={next}
          onChange={(event) => setNext(event.target.value as EnquiryStatus)}
          className="mt-0.5 w-full rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[12px]"
        >
          {NEXT.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <input
        name="note"
        required={next === "spam"}
        placeholder={next === "spam" ? "Why is this spam?" : "Note, optional"}
        aria-label="Note about the handling"
        className="w-full rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1 text-[11px]"
      />

      <div className="flex gap-1">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "…" : "Record"}
        </Button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
