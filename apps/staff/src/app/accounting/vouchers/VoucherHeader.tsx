"use client";

import { useState } from "react";
import type { Option } from "../PurchaseForm";
import { Alert } from "@/components/ui";

/**
 * The fields above a voucher's lines.
 *
 * A client component because two of the choices change the form: paying on
 * account hides the bank account (nothing leaves yet), and a settlement is
 * always paid. Rendering fields that do not apply is how a voucher ends up with
 * a payment account it never used.
 */
export function VoucherHeader({
  suppliers,
  bankAccounts,
  defaultDate,
  defaults,
  taxNote,
  purchaseOrderId,
}: {
  suppliers: Option[];
  bankAccounts: Option[];
  defaultDate: string;
  defaults?: {
    supplierId: string;
    payeeName: string;
    voucherDate: string;
    reference: string;
    subject: string;
    kind: string;
    settlement: string;
    method: string;
    paymentAccountId: string;
    notes: string;
  };
  taxNote?: string;
  /** Set when the voucher was started from a purchase order. */
  purchaseOrderId?: string;
}) {
  const [kind, setKind] = useState(defaults?.kind ?? "expense");
  const [settlement, setSettlement] = useState(defaults?.settlement ?? "paid");
  const [useSupplier, setUseSupplier] = useState(
    defaults ? Boolean(defaults.supplierId) : suppliers.length > 0,
  );

  // A settlement always moves money; only an expense can sit on account.
  const paysNow = kind === "settlement" || settlement === "paid";

  return (
    <div className="space-y-3">
      {/* Inside the form, so the link between the payment and what was ordered
          survives the submit. */}
      {purchaseOrderId && (
        <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      )}
      {taxNote && <Alert tone="info">{taxNote}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="kind" className="block text-[12px] font-medium">
            What this is
          </label>
          <select
            id="kind"
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          >
            <option value="expense">Buying something</option>
            <option value="settlement">Paying off a supplier account</option>
          </select>
        </div>

        <div>
          <label htmlFor="settlement" className="block text-[12px] font-medium">
            Settlement
          </label>
          <select
            id="settlement"
            name="settlement"
            value={kind === "settlement" ? "paid" : settlement}
            disabled={kind === "settlement"}
            onChange={(event) => setSettlement(event.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px] disabled:opacity-60"
          >
            <option value="paid">Paying now</option>
            <option value="payable">On account, to pay later</option>
          </select>
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            {paysNow
              ? "Credits the bank or cash account."
              : "Credits trade payables; a later voucher settles it."}
          </p>
        </div>

        <div>
          <label htmlFor="voucherDate" className="block text-[12px] font-medium">
            Date
          </label>
          <input
            id="voucherDate"
            name="voucherDate"
            type="date"
            required
            defaultValue={defaults?.voucherDate ?? defaultDate}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />
        </div>

        <div>
          <label htmlFor="method" className="block text-[12px] font-medium">
            Method
          </label>
          <select
            id="method"
            name="method"
            defaultValue={defaults?.method ?? "transfer"}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          >
            <option value="transfer">Bank transfer</option>
            <option value="cheque">Cheque</option>
            <option value="cash">Cash</option>
            <option value="card">Card</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <div className="flex items-center justify-between">
            <label htmlFor="payee" className="block text-[12px] font-medium">
              Who is being paid
            </label>
            <button
              type="button"
              onClick={() => setUseSupplier((current) => !current)}
              className="text-[11px] text-[var(--color-info)] hover:underline"
            >
              {useSupplier ? "Not a registered supplier" : "Choose a supplier"}
            </button>
          </div>

          {useSupplier ? (
            <select
              id="payee"
              name="supplierId"
              required
              defaultValue={defaults?.supplierId ?? ""}
              className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
            >
              <option value="">Choose…</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.code} — {supplier.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="payee"
              name="payeeName"
              required
              defaultValue={defaults?.payeeName ?? ""}
              placeholder="Name of the payee"
              className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
            />
          )}
        </div>

        {paysNow ? (
          <div>
            <label htmlFor="paymentAccountId" className="block text-[12px] font-medium">
              Paid from
            </label>
            <select
              id="paymentAccountId"
              name="paymentAccountId"
              required
              defaultValue={defaults?.paymentAccountId ?? bankAccounts[0]?.id ?? ""}
              className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
            >
              <option value="">Choose…</option>
              {bankAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} {account.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="flex items-end">
            <p className="text-[11px] text-[var(--color-muted)]">
              Nothing leaves the bank yet, so there is no account to choose.
            </p>
          </div>
        )}

        <div>
          <label htmlFor="reference" className="block text-[12px] font-medium">
            Reference
          </label>
          <input
            id="reference"
            name="reference"
            defaultValue={defaults?.reference ?? ""}
            placeholder="Their invoice number, cheque number"
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
          defaultValue={defaults?.subject ?? ""}
          placeholder="What this payment is for, in one line"
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
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
        />
      </div>
    </div>
  );
}
