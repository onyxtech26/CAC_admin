"use client";

import { useActionState, useMemo, useState } from "react";
import {
  divideRoundHalfUp,
  formatAmount,
  isAmount,
  parseAmount,
  parseRate,
  roundToCents,
  sumAmounts,
  type Amount,
} from "@cac/core/money";
import type { FormState } from "./action-errors";
import { Alert, Button } from "@/components/ui";

export interface AccountOption {
  id: string;
  code: string;
  name: string;
}

export interface CustomerOption {
  id: string;
  code: string;
  name: string;
  paymentTermsDays: number;
}

export interface CaseOption {
  id: string;
  caseNo: string;
  title: string;
}

export interface TaxOption {
  id: string;
  code: string;
  name: string;
  /** Null when no rate is in force, which is the normal state today. */
  rate: string | null;
}

export interface DocumentFormLine {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPercent: string;
  taxCodeId: string;
  accountId: string;
  /**
   * The matter this line is billed against.
   *
   * `invoice_line.case_id` and `quotation_line.case_id` have been accepted, computed, persisted and
   * carried through conversions and credit notes since Phase 3 — and no form ever set one and no
   * report ever read one, so for a firm that bills per matter the two halves of the platform were
   * not joined at all.
   */
  caseId: string;
}

const emptyLine = (): DocumentFormLine => ({
  description: "",
  quantity: "1",
  unit: "",
  unitPrice: "",
  discountPercent: "",
  taxCodeId: "",
  accountId: "",
  caseId: "",
});

const initial: FormState = {};

/**
 * The quotation and invoice line editor.
 *
 * The totals shown here are computed with the same integer money functions the
 * server uses, imported from `@cac/core/money` rather than reimplemented. That is
 * the whole reason this is a client component: somebody building a five-line
 * invoice needs to see the total as they type, and a second implementation in
 * floating point would disagree with the server on exactly the awkward numbers
 * that matter.
 *
 * What it shows is a preview, not an authority. The server recomputes every
 * figure from the description, quantity and unit price; nothing about a total
 * posted from this form is read.
 */
export function DocumentForm({
  kind,
  action,
  documentId,
  customers,
  accounts,
  taxCodes,
  cases = [],
  defaultCustomerId,
  defaultDate,
  defaultDueDate,
  defaultReference,
  defaultSubject,
  defaultNotes,
  defaultTerms,
  defaultLines,
  dueDateLabel,
  taxNote,
}: {
  kind: "invoice" | "quotation";
  action: (state: FormState, form: FormData) => Promise<FormState>;
  documentId?: string;
  customers: CustomerOption[];
  accounts: AccountOption[];
  taxCodes: TaxOption[];
  /** Open matters this line can be billed against. Empty when the caller holds no case access. */
  cases?: CaseOption[];
  defaultCustomerId?: string;
  defaultDate: string;
  defaultDueDate?: string;
  defaultReference?: string;
  defaultSubject?: string;
  defaultNotes?: string;
  defaultTerms?: string;
  defaultLines?: DocumentFormLine[];
  dueDateLabel: string;
  taxNote?: string;
}) {
  const [state, formAction, pending] = useActionState(action, initial);
  const [lines, setLines] = useState<DocumentFormLine[]>(
    defaultLines && defaultLines.length > 0 ? [...defaultLines, emptyLine()] : [emptyLine()],
  );
  const [customerId, setCustomerId] = useState(defaultCustomerId ?? "");

  const totals = useMemo(() => computeTotals(lines, taxCodes), [lines, taxCodes]);

  const update = (index: number, field: keyof DocumentFormLine, value: string) => {
    setLines((current) =>
      current.map((line, position) => (position === index ? { ...line, [field]: value } : line)),
    );
  };

  const idField = kind === "invoice" ? "invoiceId" : "quotationId";

  return (
    <form action={formAction} className="space-y-4">
      {documentId && <input type="hidden" name={idField} value={documentId} />}
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {taxNote && <Alert tone="info">{taxNote}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="customerId" className="block text-[12px] font-medium">
            Customer
          </label>
          <select
            id="customerId"
            name="customerId"
            required
            value={customerId}
            onChange={(event) => setCustomerId(event.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          >
            <option value="">Choose…</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.code} — {customer.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="documentDate" className="block text-[12px] font-medium">
            Date
          </label>
          <input
            id="documentDate"
            name="documentDate"
            type="date"
            required
            defaultValue={defaultDate}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
        </div>

        <div>
          <label htmlFor="dueDate" className="block text-[12px] font-medium">
            {dueDateLabel}
          </label>
          <input
            id="dueDate"
            name="dueDate"
            type="date"
            defaultValue={defaultDueDate}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            {kind === "invoice"
              ? "Left blank, it follows the customer's payment terms."
              : "Left blank, it follows the configured validity."}
          </p>
        </div>

        <div>
          <label htmlFor="reference" className="block text-[12px] font-medium">
            Your reference
          </label>
          <input
            id="reference"
            name="reference"
            defaultValue={defaultReference}
            placeholder="Their PO, or a file number"
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
        </div>
      </div>

      <div>
        <label htmlFor="subject" className="block text-[12px] font-medium">
          Subject
        </label>
        <input
          id="subject"
          name="subject"
          defaultValue={defaultSubject}
          placeholder="What this is for, in one line"
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">Document lines</caption>
          <thead>
            <tr className="border-b border-[var(--color-line)]">
              {[
                "#",
                "Description",
                "Account",
                ...(cases.length > 0 ? ["Matter"] : []),
                "Qty",
                "Unit price",
                "Disc %",
                "Tax",
                "Line total",
                "",
              ].map(
                (heading, index) => (
                  <th
                    key={`${heading}-${index}`}
                    scope="col"
                    className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--color-faint)]"
                  >
                    {heading}
                  </th>
                ),
              )}
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
                    className="w-full min-w-[220px] rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5"
                  />
                  <input
                    name={`lines[${index}].unit`}
                    value={line.unit}
                    onChange={(event) => update(index, "unit", event.target.value)}
                    placeholder="unit (optional)"
                    aria-label={`Unit for line ${index + 1}`}
                    className="mt-1 w-full rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-[11px]"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <select
                    name={`lines[${index}].accountId`}
                    value={line.accountId}
                    onChange={(event) => update(index, "accountId", event.target.value)}
                    aria-label={`Account for line ${index + 1}`}
                    className="w-full min-w-[200px] rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5"
                  >
                    <option value="">—</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} {account.name}
                      </option>
                    ))}
                  </select>
                </td>
                {cases.length > 0 && (
                  <td className="px-2 py-1.5">
                    <select
                      name={`lines[${index}].caseId`}
                      value={line.caseId}
                      onChange={(event) => update(index, "caseId", event.target.value)}
                      aria-label={`Matter for line ${index + 1}`}
                      className="w-full min-w-[160px] rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5"
                    >
                      <option value="">—</option>
                      {cases.map((matter) => (
                        <option key={matter.id} value={matter.id}>
                          {matter.caseNo} — {matter.title}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
                <td className="px-2 py-1.5">
                  <input
                    name={`lines[${index}].quantity`}
                    value={line.quantity}
                    onChange={(event) => update(index, "quantity", event.target.value)}
                    inputMode="decimal"
                    aria-label={`Quantity for line ${index + 1}`}
                    className="numeric w-20 rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-right"
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
                  <input
                    name={`lines[${index}].discountPercent`}
                    value={line.discountPercent}
                    onChange={(event) => update(index, "discountPercent", event.target.value)}
                    inputMode="decimal"
                    placeholder="0.1"
                    aria-label={`Discount fraction for line ${index + 1}`}
                    className="numeric w-20 rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-right"
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
                          ? [emptyLine()]
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
              <td colSpan={6} />
              <td className="px-2 py-1 text-right text-[12px] text-[var(--color-muted)]">Subtotal</td>
              <td className="numeric px-2 py-1 text-right">{formatAmount(totals.subtotal)}</td>
              <td />
            </tr>
            {totals.discount > 0n && (
              <tr>
                <td colSpan={6} />
                <td className="px-2 py-1 text-right text-[12px] text-[var(--color-muted)]">Discount</td>
                <td className="numeric px-2 py-1 text-right">-{formatAmount(totals.discount)}</td>
                <td />
              </tr>
            )}
            {totals.tax > 0n && (
              <tr>
                <td colSpan={6} />
                <td className="px-2 py-1 text-right text-[12px] text-[var(--color-muted)]">Tax</td>
                <td className="numeric px-2 py-1 text-right">{formatAmount(totals.tax)}</td>
                <td />
              </tr>
            )}
            <tr className="border-t-2 border-[var(--color-line-strong)] font-semibold">
              <td colSpan={6} />
              <td className="px-2 py-2 text-right">Total</td>
              <td className="numeric px-2 py-2 text-right">{formatAmount(totals.total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <button
        type="button"
        onClick={() => setLines((current) => [...current, emptyLine()])}
        className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] hover:bg-[var(--color-canvas)]"
      >
        Add line
      </button>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="notes" className="block text-[12px] font-medium">
            Notes to the customer
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            defaultValue={defaultNotes}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
        </div>
        <div>
          <label htmlFor="terms" className="block text-[12px] font-medium">
            Terms
          </label>
          <textarea
            id="terms"
            name="terms"
            rows={3}
            defaultValue={defaultTerms}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : documentId ? "Save changes" : "Save draft"}
        </Button>
        <span className="text-[12px] text-[var(--color-muted)]">
          Saving creates a draft. Nothing is sent to the customer and nothing reaches the ledger
          until it is {kind === "invoice" ? "approved and issued" : "sent"}.
        </span>
      </div>
    </form>
  );
}

/**
 * The same arithmetic as the server, in the same order.
 *
 * subtotal = qty x price, discount = subtotal x percent, tax = (subtotal -
 * discount) x rate, total = subtotal - discount + tax — each rounded to cents at
 * the same points. Unparseable input contributes nothing rather than NaN, because
 * a half-typed number should not blank the whole total.
 */
function computeTotals(lines: DocumentFormLine[], taxCodes: TaxOption[]) {
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
  const discounts: Amount[] = [];
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

    let discount = 0n;
    if (line.discountPercent.trim() !== "") {
      try {
        discount = roundToCents((subtotal * parseRate(line.discountPercent)) / 1_000_000n);
      } catch {
        discount = 0n;
      }
    }
    if (discount > subtotal) discount = subtotal;

    const taxable = subtotal - discount;
    const tax = divideRoundHalfUp(taxable * rateFor(line.taxCodeId), 1_000_000n * 100n) * 100n;

    subtotals.push(subtotal);
    discounts.push(discount);
    taxes.push(tax);
    perLine.push(taxable + tax);
  }

  const subtotal = sumAmounts(subtotals);
  const discount = sumAmounts(discounts);
  const tax = sumAmounts(taxes);

  return { perLine, subtotal, discount, tax, total: subtotal - discount + tax };
}
