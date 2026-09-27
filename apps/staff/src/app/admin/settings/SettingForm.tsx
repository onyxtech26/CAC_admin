"use client";

import { useActionState, useState } from "react";
import { saveSettingAction, type AdminFormState } from "../actions";
import { Alert } from "@/components/ui";

const initial: AdminFormState = {};

/**
 * One setting, edited in place.
 *
 * The value is JSON text, because these settings are genuinely of different
 * types — a number, a boolean, a list of day numbers, a string, or null for "not
 * yet known". One typed field per setting would need a type registry that the
 * seed and the form could disagree about; JSON keeps a single source of truth in
 * the seed and refuses anything malformed rather than storing a string where a
 * number was meant.
 */
export function SettingForm({
  settingKey,
  value,
  requiresApproval,
  needsReview,
}: {
  settingKey: string;
  value: unknown;
  requiresApproval: boolean;
  needsReview: boolean;
}) {
  const [state, action, pending] = useActionState(saveSettingAction, initial);
  const [open, setOpen] = useState(false);

  const current = value === null ? "" : JSON.stringify(value);

  if (!open) {
    return (
      <div className="space-y-1">
        <code className="font-mono text-[12px]">{value === null ? "unset" : current}</code>
        {state.notice && <p className="text-[11px] text-[var(--color-ok)]">{state.notice}</p>}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="block rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px] hover:bg-[var(--color-canvas)]"
        >
          {needsReview ? "Confirm or change" : "Change"}
        </button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="key" value={settingKey} />
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <div>
        <label htmlFor={`v-${settingKey}`} className="sr-only">
          Value for {settingKey}
        </label>
        <input
          id={`v-${settingKey}`}
          name="value"
          defaultValue={current}
          placeholder="Leave blank for unset"
          className="w-full rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1.5 font-mono text-[12px]"
        />
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          JSON: <code>30</code>, <code>true</code>, <code>&quot;Asia/Kuala_Lumpur&quot;</code>,{" "}
          <code>[30, 60, 90]</code>. Blank means unset.
        </p>
      </div>

      {requiresApproval && (
        <div>
          <label htmlFor={`r-${settingKey}`} className="block text-[11px] font-medium">
            Why is it changing? (required)
          </label>
          <input
            id={`r-${settingKey}`}
            name="reason"
            required
            className="mt-1 w-full rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1.5 text-[12px]"
          />
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            This setting carries statutory or financial weight, so the change needs a reason on the
            record.
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary px-2 py-1 text-[11px]"
        >
          {pending ? "Saving…" : "Save"}
        </button>
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
