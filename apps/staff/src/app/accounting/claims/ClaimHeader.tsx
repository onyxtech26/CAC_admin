"use client";

import { Alert } from "@/components/ui";

/**
 * The fields above a claim's lines.
 *
 * There is no claimant field. The claim belongs to whoever is signed in — the
 * server takes the claimant from the session and ignores anything sent for it —
 * so offering a name here would only imply you could claim on somebody else's
 * behalf.
 */
export function ClaimHeader({
  claimantName,
  defaultDate,
  defaults,
  taxNote,
}: {
  claimantName: string;
  defaultDate: string;
  defaults?: {
    claimDate: string;
    periodFrom: string | null;
    periodTo: string | null;
    subject: string | null;
    notes: string | null;
  };
  taxNote?: string;
}) {
  return (
    <div className="space-y-3">
      {taxNote && <Alert tone="info">{taxNote}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <span className="block text-[12px] font-medium">Claimant</span>
          <p className="mt-1 rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-[14px]">
            {claimantName}
          </p>
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            Taken from who you are signed in as.
          </p>
        </div>

        <div>
          <label htmlFor="claimDate" className="block text-[12px] font-medium">
            Claim date
          </label>
          <input
            id="claimDate"
            name="claimDate"
            type="date"
            required
            defaultValue={defaults?.claimDate ?? defaultDate}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
        </div>

        <div>
          <label htmlFor="periodFrom" className="block text-[12px] font-medium">
            Spending from
          </label>
          <input
            id="periodFrom"
            name="periodFrom"
            type="date"
            defaultValue={defaults?.periodFrom ?? ""}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
        </div>

        <div>
          <label htmlFor="periodTo" className="block text-[12px] font-medium">
            Spending to
          </label>
          <input
            id="periodTo"
            name="periodTo"
            type="date"
            defaultValue={defaults?.periodTo ?? ""}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
        </div>
      </div>

      <div>
        <label htmlFor="subject" className="block text-[12px] font-medium">
          What this claim is for
        </label>
        <input
          id="subject"
          name="subject"
          defaultValue={defaults?.subject ?? ""}
          placeholder="Site visit travel, October"
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
        />
      </div>

      <div>
        <label htmlFor="notes" className="block text-[12px] font-medium">
          Notes
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={2}
          defaultValue={defaults?.notes ?? ""}
          placeholder="Anything the approver needs to know."
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
        />
      </div>
    </div>
  );
}
