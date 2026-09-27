"use client";

import { useActionState, useMemo, useState } from "react";
// The money subpath, not the package root: importing @cac/core into a client
// component would drag argon2 and the database driver into the browser bundle.
import { formatAmount, isAmount, parseAmount, sumAmounts, type Amount } from "@cac/core/money";
import { saveJournal, type FormState } from "../actions";
import { Alert, Button } from "@/components/ui";

export interface AccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
}

export interface CostCentreOption {
  id: string;
  code: string;
  name: string;
}

export interface JournalFormLine {
  accountId: string;
  debit: string;
  credit: string;
  description: string;
  costCentreId: string;
}

const emptyLine = (): JournalFormLine => ({
  accountId: "",
  debit: "",
  credit: "",
  description: "",
  costCentreId: "",
});

const initial: FormState = {};

/**
 * The journal entry form.
 *
 * Two things make this worth being a client component rather than a plain form.
 *
 * The running total: an accountant entering a journal needs to see the
 * difference shrink to nothing as they type. Finding out on submit that it is out
 * by RM 0.10 means re-reading every line.
 *
 * The arithmetic is done with the same integer money code the server uses,
 * imported rather than reimplemented, so what the screen says the difference is
 * and what the server decides are the same number. A quick `Number(input.value)`
 * here would disagree with the server on exactly the awkward cases that matter.
 *
 * Nothing here is a security control. The server validates every line again and
 * the database constraints sit behind that; this only makes the form usable.
 */
export function JournalForm({
  accounts,
  costCentres,
  journalId,
  defaultEntryDate,
  defaultMemo,
  defaultLines,
  periodHint,
}: {
  accounts: AccountOption[];
  costCentres: CostCentreOption[];
  journalId?: string;
  defaultEntryDate: string;
  defaultMemo?: string;
  defaultLines?: JournalFormLine[];
  periodHint?: string;
}) {
  const [state, action, pending] = useActionState(saveJournal, initial);
  const [lines, setLines] = useState<JournalFormLine[]>(
    defaultLines && defaultLines.length > 0
      ? [...defaultLines, emptyLine()]
      : [emptyLine(), emptyLine()],
  );

  const totals = useMemo(() => {
    const safe = (value: string): Amount => {
      const trimmed = value.trim();
      if (trimmed === "" || !isAmount(trimmed)) return 0n;
      return parseAmount(trimmed);
    };
    const debit = sumAmounts(lines.map((line) => safe(line.debit)));
    const credit = sumAmounts(lines.map((line) => safe(line.credit)));
    return { debit, credit, difference: debit - credit };
  }, [lines]);

  const update = (index: number, field: keyof JournalFormLine, value: string) => {
    setLines((current) =>
      current.map((line, position) => {
        if (position !== index) return line;
        // A line carries a debit or a credit, never both. Typing in one side
        // clears the other, which is faster than an error message.
        if (field === "debit" && value.trim() !== "") return { ...line, debit: value, credit: "" };
        if (field === "credit" && value.trim() !== "") return { ...line, credit: value, debit: "" };
        return { ...line, [field]: value };
      }),
    );
  };

  const balanced = totals.difference === 0n && totals.debit > 0n;

  return (
    <form action={action} className="space-y-4">
      {journalId && <input type="hidden" name="journalId" value={journalId} />}

      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="entryDate" className="block text-[12px] font-medium">
            Entry date
          </label>
          <input
            id="entryDate"
            name="entryDate"
            type="date"
            required
            defaultValue={defaultEntryDate}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          />
          {periodHint && (
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">{periodHint}</p>
          )}
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="memo" className="block text-[12px] font-medium">
            Memo
          </label>
          <input
            id="memo"
            name="memo"
            defaultValue={defaultMemo}
            placeholder="Why this entry exists"
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">Journal lines</caption>
          <thead>
            <tr className="border-b border-[var(--color-line)]">
              {["#", "Account", "Narrative", "Cost centre", "Debit", "Credit", ""].map((heading) => (
                <th
                  key={heading}
                  scope="col"
                  className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--color-faint)]"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index} className="border-b border-[var(--color-line)]">
                <td className="px-2 py-1.5 text-[var(--color-faint)]">{index + 1}</td>
                <td className="px-2 py-1.5">
                  <select
                    name={`lines[${index}].account`}
                    value={line.accountId}
                    onChange={(event) => update(index, "accountId", event.target.value)}
                    aria-label={`Account for line ${index + 1}`}
                    className="w-full min-w-[220px] rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1.5"
                  >
                    <option value="">—</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} {account.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  <input
                    name={`lines[${index}].description`}
                    value={line.description}
                    onChange={(event) => update(index, "description", event.target.value)}
                    aria-label={`Narrative for line ${index + 1}`}
                    className="w-full min-w-[160px] rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1.5"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <select
                    name={`lines[${index}].costCentre`}
                    value={line.costCentreId}
                    onChange={(event) => update(index, "costCentreId", event.target.value)}
                    aria-label={`Cost centre for line ${index + 1}`}
                    className="w-full rounded border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1.5"
                  >
                    <option value="">—</option>
                    {costCentres.map((centre) => (
                      <option key={centre.id} value={centre.id}>
                        {centre.code}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  <input
                    name={`lines[${index}].debit`}
                    value={line.debit}
                    onChange={(event) => update(index, "debit", event.target.value)}
                    inputMode="decimal"
                    aria-label={`Debit for line ${index + 1}`}
                    className={`numeric w-28 rounded border bg-[var(--color-ink)]/55 px-2 py-1.5 text-right ${
                      line.debit.trim() !== "" && !isAmount(line.debit.trim())
                        ? "border-[var(--color-danger)]"
                        : "border-[var(--color-line-strong)]"
                    }`}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    name={`lines[${index}].credit`}
                    value={line.credit}
                    onChange={(event) => update(index, "credit", event.target.value)}
                    inputMode="decimal"
                    aria-label={`Credit for line ${index + 1}`}
                    className={`numeric w-28 rounded border bg-[var(--color-ink)]/55 px-2 py-1.5 text-right ${
                      line.credit.trim() !== "" && !isAmount(line.credit.trim())
                        ? "border-[var(--color-danger)]"
                        : "border-[var(--color-line-strong)]"
                    }`}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setLines((current) =>
                        current.length <= 2
                          ? current.map((l, p) => (p === index ? emptyLine() : l))
                          : current.filter((_, p) => p !== index),
                      )
                    }
                    aria-label={`Remove line ${index + 1}`}
                    className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px] hover:bg-[var(--color-canvas)]"
                  >
                    Clear
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[var(--color-line-strong)] font-semibold">
              <td colSpan={4} className="px-2 py-2 text-right">
                Totals
              </td>
              <td className="numeric px-2 py-2 text-right">{formatAmount(totals.debit)}</td>
              <td className="numeric px-2 py-2 text-right">{formatAmount(totals.credit)}</td>
              <td />
            </tr>
            {totals.difference !== 0n && (
              <tr>
                <td colSpan={4} className="px-2 py-2 text-right text-[var(--color-danger)]">
                  Out of balance
                </td>
                <td colSpan={2} className="numeric px-2 py-2 text-right text-[var(--color-danger)]">
                  {formatAmount(
                    totals.difference < 0n ? -totals.difference : totals.difference,
                  )}{" "}
                  {totals.difference > 0n ? "more debit" : "more credit"}
                </td>
                <td />
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setLines((current) => [...current, emptyLine()])}
          className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] hover:bg-[var(--color-canvas)]"
        >
          Add line
        </button>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : journalId ? "Save changes" : "Save draft"}
        </Button>

        {balanced ? (
          <span className="text-[12px] text-[var(--color-ok)]">Balanced.</span>
        ) : (
          <span className="text-[12px] text-[var(--color-muted)]">
            Debits must equal credits before this can be posted.
          </span>
        )}
      </div>

      <p className="text-[11px] text-[var(--color-muted)]">
        Saving creates a draft. It changes no balances and appears in no report until somebody posts
        it — which, for a manual journal, is somebody other than you.
      </p>
    </form>
  );
}
