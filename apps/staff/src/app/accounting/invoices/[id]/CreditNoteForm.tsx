"use client";

import { useState } from "react";
import { formatAmount, isAmount, parseAmount, sumAmounts } from "@cac/core/money";
import { Alert, Button } from "@/components/ui";

export interface CreditableLine {
  description: string;
  quantity: string;
  unit: string;
  /** The line's full value, as a numeric string — the most that line can be credited. */
  lineTotal: string;
  unitPrice: string;
  accountId: string;
  taxCodeId: string;
  caseId: string;
}

/**
 * Raising a credit note, in whole or in part.
 *
 * `createCreditNote` has always accepted a `lines` array for a partial credit and the screen never
 * passed one, so the only credit note anybody could raise was for the entire invoice — while
 * crediting a single line is the ordinary case: one item was wrong, or the scope came down, and the
 * rest of the invoice stands.
 *
 * Each line starts at its full value and can be reduced or zeroed. A line at nought is dropped
 * rather than credited for nothing, and the total is shown as it changes because the cap — you may
 * not credit more than the invoice — is enforced on the server and nobody should meet it by
 * surprise.
 */
export function CreditNoteForm({
  invoiceId,
  lines,
  action,
  pending,
}: {
  invoiceId: string;
  lines: CreditableLine[];
  action: (formData: FormData) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [amounts, setAmounts] = useState<string[]>(() => lines.map((line) => line.lineTotal));

  const total = sumAmounts(
    amounts.map((value) => {
      const trimmed = value.trim();
      return trimmed === "" || !isAmount(trimmed) ? 0n : parseAmount(trimmed);
    }),
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] font-medium hover:bg-[var(--color-canvas)]"
      >
        Raise a credit note
      </button>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-md border border-[var(--color-line)] p-3">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="action" value="credit" />

      <Alert tone="info">
        Credit the whole invoice, or reduce the lines that are not being credited. A line at nought is
        left out.
      </Alert>

      <table className="w-full border-collapse text-[12px]">
        <caption className="sr-only">Lines to credit</caption>
        <thead>
          <tr className="border-b border-[var(--color-line)]">
            <th scope="col" className="px-1 py-1 text-left font-semibold text-[var(--color-faint)]">
              Line
            </th>
            <th scope="col" className="px-1 py-1 text-right font-semibold text-[var(--color-faint)]">
              Invoiced
            </th>
            <th scope="col" className="px-1 py-1 text-right font-semibold text-[var(--color-faint)]">
              Credit
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={index} className="border-b border-[var(--color-line)]">
              <td className="px-1 py-1.5">
                {line.description}
                {/* Carried through so the credit note's line is the invoice's line: same revenue
                    account, same tax treatment, same matter. A credit posted to a different account
                    is a reversal that does not reverse anything. */}
                <input type="hidden" name={`lines[${index}].description`} value={line.description} />
                <input type="hidden" name={`lines[${index}].quantity`} value="1" />
                <input type="hidden" name={`lines[${index}].unit`} value={line.unit} />
                <input type="hidden" name={`lines[${index}].accountId`} value={line.accountId} />
                <input type="hidden" name={`lines[${index}].taxCodeId`} value={line.taxCodeId} />
                <input type="hidden" name={`lines[${index}].caseId`} value={line.caseId} />
              </td>
              <td className="px-1 py-1.5 text-right font-mono text-[var(--color-muted)]">
                {formatAmount(parseAmount(line.lineTotal))}
              </td>
              <td className="px-1 py-1.5 text-right">
                <input
                  name={`lines[${index}].unitPrice`}
                  value={amounts[index] ?? ""}
                  onChange={(event) =>
                    setAmounts((current) =>
                      current.map((value, position) =>
                        position === index ? event.target.value : value,
                      ),
                    )
                  }
                  inputMode="decimal"
                  aria-label={`Amount to credit for ${line.description}`}
                  className={`numeric w-28 rounded border bg-[var(--color-surface)] px-2 py-1 text-right ${
                    (amounts[index] ?? "").trim() !== "" && !isAmount((amounts[index] ?? "").trim())
                      ? "border-[var(--color-danger)]"
                      : "border-[var(--color-line-strong)]"
                  }`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-right text-[13px]">
        Crediting <strong>{formatAmount(total, { currency: "RM" })}</strong>
      </p>

      <div>
        <label htmlFor="credit-reason" className="block text-[12px] font-medium">
          Why is the customer being credited?
        </label>
        <input
          id="credit-reason"
          name="reason"
          required
          placeholder="Scope reduced, billed twice, goodwill…"
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
        />
      </div>

      <div className="flex gap-2">
        <Button type="submit" variant="secondary" disabled={pending || total <= 0n}>
          {pending ? "Working…" : "Raise the credit note"}
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
