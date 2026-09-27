"use client";

import { useState } from "react";

/**
 * The fields above a bill's lines.
 *
 * A client component for one reason: choosing the supplier sets the due date from their payment
 * terms, which is the figure people most often get wrong and least often notice. It stays
 * editable — a supplier's terms on file are the default, not the truth about this particular
 * invoice.
 *
 * "Their reference" is first, before the dates, because it is the field somebody is copying off
 * a piece of paper in front of them and the one the form refuses without.
 */
export function BillHeader({
  suppliers,
  defaultSupplierId,
  defaultSupplierDocNo,
  defaultBillDate,
  defaultDueDate,
  defaultReceivedDate,
  defaultSubject,
  defaultNotes,
}: {
  suppliers: Array<{ id: string; code: string; name: string; paymentTermsDays?: number }>;
  defaultSupplierId?: string;
  defaultSupplierDocNo?: string;
  defaultBillDate: string;
  defaultDueDate: string;
  defaultReceivedDate: string;
  defaultSubject?: string | null;
  defaultNotes?: string | null;
}) {
  const [billDate, setBillDate] = useState(defaultBillDate);
  const [dueDate, setDueDate] = useState(defaultDueDate);

  const applyTerms = (supplierId: string) => {
    const terms = suppliers.find((supplier) => supplier.id === supplierId)?.paymentTermsDays;
    if (typeof terms !== "number") return;
    const from = new Date(`${billDate}T00:00:00Z`);
    if (Number.isNaN(from.getTime())) return;
    from.setUTCDate(from.getUTCDate() + terms);
    setDueDate(from.toISOString().slice(0, 10));
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div>
        <label htmlFor="supplierId" className="block text-[12px] font-medium">
          Supplier
        </label>
        <select
          id="supplierId"
          name="supplierId"
          required
          defaultValue={defaultSupplierId ?? ""}
          onChange={(event) => applyTerms(event.target.value)}
          className="control mt-1"
        >
          <option value="">Choose…</option>
          {suppliers.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.code} — {supplier.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="supplierDocNo" className="block text-[12px] font-medium">
          Their invoice number
        </label>
        <input
          id="supplierDocNo"
          name="supplierDocNo"
          required
          maxLength={60}
          defaultValue={defaultSupplierDocNo ?? ""}
          className="control mt-1 font-mono"
        />
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          As printed on their document. Entering the same one twice for a supplier is refused.
        </p>
      </div>

      <div>
        <label htmlFor="subject" className="block text-[12px] font-medium">
          What it is for
        </label>
        <input
          id="subject"
          name="subject"
          defaultValue={defaultSubject ?? ""}
          className="control mt-1"
        />
      </div>

      <div>
        <label htmlFor="billDate" className="block text-[12px] font-medium">
          Date on the bill
        </label>
        <input
          id="billDate"
          name="billDate"
          type="date"
          required
          value={billDate}
          onChange={(event) => setBillDate(event.target.value)}
          className="control mt-1"
        />
      </div>

      <div>
        <label htmlFor="dueDate" className="block text-[12px] font-medium">
          Due
        </label>
        <input
          id="dueDate"
          name="dueDate"
          type="date"
          required
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
          className="control mt-1"
        />
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          Set from the supplier&rsquo;s terms. Change it if this invoice says otherwise.
        </p>
      </div>

      <div>
        <label htmlFor="receivedDate" className="block text-[12px] font-medium">
          Received
        </label>
        <input
          id="receivedDate"
          name="receivedDate"
          type="date"
          defaultValue={defaultReceivedDate}
          className="control mt-1"
        />
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          When it arrived, which is not when it was written. The gap is what decides whose fault a
          late payment was.
        </p>
      </div>

      <div className="sm:col-span-2 lg:col-span-3">
        <label htmlFor="notes" className="block text-[12px] font-medium">
          Notes
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={2}
          defaultValue={defaultNotes ?? ""}
          className="control mt-1"
        />
      </div>
    </div>
  );
}
