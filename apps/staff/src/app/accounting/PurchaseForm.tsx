"use client";

import { useActionState, useMemo, useState } from "react";
import {
  divideRoundHalfUp,
  formatAmount,
  isAmount,
  parseAmount,
  parseRate,
  sumAmounts,
  type Amount,
} from "@cac/core/money";
import type { FormState } from "./action-errors";
import { Alert, Button } from "@/components/ui";

export interface Option {
  id: string;
  code: string;
  name: string;
}

export interface TaxOption extends Option {
  rate: string | null;
}

export interface PurchaseFormLine {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxCodeId: string;
  accountId: string;
  costCentreId: string;
  /** Claims only. */
  spentOn: string;
  receiptRef: string;
}

const emptyLine = (spentOn = ""): PurchaseFormLine => ({
  description: "",
  quantity: "1",
  unit: "",
  unitPrice: "",
  taxCodeId: "",
  accountId: "",
  costCentreId: "",
  spentOn,
  receiptRef: "",
});

const initial: FormState = {};

/**
 * The line editor for purchase orders, payment vouchers and expense claims.
 *
 * Deliberately *not* the sales one. These documents carry no discount — a
 * supplier's discount is already in the price they quoted, and a second field for
 * it would be a second place to record the same thing — and they do carry a cost
 * centre, which the sales documents do not. Forcing one component to do both
 * would mean a prop for every difference and a form that can render states
 * neither document has.
 *
 * Totals are computed with the same integer money functions the server uses,
 * imported rather than reimplemented. It is a preview: the server recomputes
 * every figure from the description, quantity and unit price.
 */
export function PurchaseForm({
  kind,
  action,
  documentId,
  accounts,
  taxCodes,
  costCentres,
  header,
  defaultLines,
  defaultDate,
  submitLabel,
  footnote,
}: {
  kind: "order" | "voucher" | "claim";
  action: (state: FormState, form: FormData) => Promise<FormState>;
  documentId?: string;
  accounts: Option[];
  taxCodes: TaxOption[];
  costCentres: Option[];
  /** The document-specific fields above the lines. */
  header: React.ReactNode;
  defaultLines?: PurchaseFormLine[];
  defaultDate: string;
  submitLabel?: string;
  footnote?: string;
}) {
  const [state, formAction, pending] = useActionState(action, initial);
  const [lines, setLines] = useState<PurchaseFormLine[]>(
    defaultLines && defaultLines.length > 0
      ? [...defaultLines, emptyLine(defaultDate)]
      : [emptyLine(defaultDate)],
  );

  const totals = useMemo(() => computeTotals(lines, taxCodes), [lines, taxCodes]);
  const idField = kind === "order" ? "orderId" : kind === "voucher" ? "voucherId" : "claimId";
  const isClaim = kind === "claim";

  const update = (index: number, field: keyof PurchaseFormLine, value: string) => {
    setLines((current) =>
      current.map((line, position) => (position === index ? { ...line, [field]: value } : line)),
    );
  };

  const columns = [
    "#",
    "Description",
    ...(isClaim ? ["Spent on"] : []),
    "Account",
    "Cost centre",
    "Qty",
    "Unit price",
    "Tax",
    "Total",
    "",
  ];

  return (
    <form action={formAction} className="space-y-4">
      {documentId && <input type="hidden" name={idField} value={documentId} />}
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      {header}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">Document lines</caption>
          <thead>
            <tr className="border-b border-[var(--color-line)]">
              {columns.map((heading, index) => (
                <th
                  key={`${heading}-${index}`}
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
              <tr key={index} className="border-b border-[var(--color-line)] align-top">
                <td className="px-2 py-1.5 text-[var(--color-faint)]">{index + 1}</td>
                <td className="px-2 py-1.5">
                  <input
                    name={`lines[${index}].description`}
                    value={line.description}
                    onChange={(event) => update(index, "description", event.target.value)}
                    aria-label={`Description for line ${index + 1}`}
                    className="w-full min-w-[200px] rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5"
                  />
                  {isClaim && (
                    <input
                      name={`lines[${index}].receiptRef`}
                      value={line.receiptRef}
                      onChange={(event) => update(index, "receiptRef", event.target.value)}
                      placeholder="receipt reference"
                      aria-label={`Receipt reference for line ${index + 1}`}
                      className="mt-1 w-full rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-[11px]"
                    />
                  )}
                </td>
                {isClaim && (
                  <td className="px-2 py-1.5">
                    <input
                      name={`lines[${index}].spentOn`}
                      type="date"
                      value={line.spentOn}
                      onChange={(event) => update(index, "spentOn", event.target.value)}
                      aria-label={`Date spent for line ${index + 1}`}
                      className="w-36 rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5"
                    />
                  </td>
                )}
                <td className="px-2 py-1.5">
                  <select
                    name={`lines[${index}].accountId`}
                    value={line.accountId}
                    onChange={(event) => update(index, "accountId", event.target.value)}
                    aria-label={`Account for line ${index + 1}`}
                    className="w-full min-w-[190px] rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5"
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
                  <select
                    name={`lines[${index}].costCentreId`}
                    value={line.costCentreId}
                    onChange={(event) => update(index, "costCentreId", event.target.value)}
                    aria-label={`Cost centre for line ${index + 1}`}
                    className="w-24 rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5"
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
                    name={`lines[${index}].quantity`}
                    value={line.quantity}
                    onChange={(event) => update(index, "quantity", event.target.value)}
                    inputMode="decimal"
                    aria-label={`Quantity for line ${index + 1}`}
                    className="numeric w-20 rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-right"
                  />
                  <input
                    name={`lines[${index}].unit`}
                    value={line.unit}
                    onChange={(event) => update(index, "unit", event.target.value)}
                    placeholder="unit"
                    aria-label={`Unit for line ${index + 1}`}
                    className="mt-1 w-20 rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-[11px]"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    name={`lines[${index}].unitPrice`}
                    value={line.unitPrice}
                    onChange={(event) => update(index, "unitPrice", event.target.value)}
                    inputMode="decimal"
                    aria-label={`Unit price for line ${index + 1}`}
                    className={`numeric w-28 rounded border bg-[var(--color-surface)] px-2 py-1.5 text-right ${
                      line.unitPrice.trim() !== "" && !isAmount(line.unitPrice.trim())
                        ? "border-[var(--color-danger)]"
                        : "border-[var(--color-line-strong)]"
                    }`}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <select
                    name={`lines[${index}].taxCodeId`}
                    value={line.taxCodeId}
                    onChange={(event) => update(index, "taxCodeId", event.target.value)}
                    aria-label={`Tax code for line ${index + 1}`}
                    className="w-24 rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5"
                  >
                    <option value="">None</option>
                    {taxCodes.map((code) => (
                      <option key={code.id} value={code.id}>
                        {code.code}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="numeric px-2 py-2 text-right">
                  {formatAmount(totals.perLine[index] ?? 0n, { zeroAs: "—" })}
                </td>
                <td className="px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setLines((current) =>
                        current.length <= 1
                          ? [emptyLine(defaultDate)]
                          : current.filter((_, position) => position !== index),
                      )
                    }
                    aria-label={`Remove line ${index + 1}`}
                    className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px] hover:bg-[var(--color-canvas)]"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={columns.length - 3} />
              <td className="px-2 py-1 text-right text-[12px] text-[var(--color-muted)]">Subtotal</td>
              <td className="numeric px-2 py-1 text-right">{formatAmount(totals.subtotal)}</td>
              <td />
            </tr>
            {totals.tax > 0n && (
              <tr>
                <td colSpan={columns.length - 3} />
                <td className="px-2 py-1 text-right text-[12px] text-[var(--color-muted)]">Tax</td>
                <td className="numeric px-2 py-1 text-right">{formatAmount(totals.tax)}</td>
                <td />
              </tr>
            )}
            <tr className="border-t-2 border-[var(--color-line-strong)] font-semibold">
              <td colSpan={columns.length - 3} />
              <td className="px-2 py-2 text-right">Total</td>
              <td className="numeric px-2 py-2 text-right">{formatAmount(totals.total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setLines((current) => [...current, emptyLine(defaultDate)])}
          className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] hover:bg-[var(--color-canvas)]"
        >
          Add line
        </button>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : (submitLabel ?? (documentId ? "Save changes" : "Save draft"))}
        </Button>
      </div>

      {footnote && <p className="text-[11px] text-[var(--color-muted)]">{footnote}</p>}
    </form>
  );
}

/** Same arithmetic as the server, in the same order. No discount on this side. */
function computeTotals(lines: PurchaseFormLine[], taxCodes: TaxOption[]) {
  const rateFor = (taxCodeId: string): bigint => {
    const code = taxCodes.find((option) => option.id === taxCodeId);
    if (!code?.rate) return 0n;
    try {
      return parseRate(code.rate);
    } catch {
      return 0n;
    }
  };

  const perLine: Amount[] = [];
  const subtotals: Amount[] = [];
  const taxes: Amount[] = [];

  for (const line of lines) {
    let subtotal = 0n;
    try {
      const price = line.unitPrice.trim() === "" ? 0n : parseAmount(line.unitPrice);
      const quantity = line.quantity.trim() === "" ? 1_000_000n : parseRate(line.quantity);
      subtotal = divideRoundHalfUp(price * quantity, 1_000_000n * 100n) * 100n;
    } catch {
      subtotal = 0n;
    }

    const tax = divideRoundHalfUp(subtotal * rateFor(line.taxCodeId), 1_000_000n * 100n) * 100n;
    subtotals.push(subtotal);
    taxes.push(tax);
    perLine.push(subtotal + tax);
  }

  const subtotal = sumAmounts(subtotals);
  const tax = sumAmounts(taxes);
  return { perLine, subtotal, tax, total: subtotal + tax };
}
