"use client";

import type { Option } from "../PurchaseForm";

/**
 * The fields above a purchase order's lines.
 *
 * A plain form — unlike a voucher, nothing here changes what else is shown. It is
 * a client component only because `PurchaseForm` is one and takes it as a child.
 */
export function OrderHeader({
  suppliers,
  defaultDate,
  defaults,
}: {
  suppliers: Option[];
  defaultDate: string;
  defaults?: {
    supplierId: string;
    orderDate: string;
    requiredBy: string;
    reference: string;
    subject: string;
    deliveryNote: string;
    notes: string;
  };
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="supplierId" className="block text-[12px] font-medium">
            Supplier
          </label>
          <select
            id="supplierId"
            name="supplierId"
            required
            defaultValue={defaults?.supplierId ?? ""}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
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
          <label htmlFor="orderDate" className="block text-[12px] font-medium">
            Order date
          </label>
          <input
            id="orderDate"
            name="orderDate"
            type="date"
            required
            defaultValue={defaults?.orderDate ?? defaultDate}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          />
        </div>

        <div>
          <label htmlFor="requiredBy" className="block text-[12px] font-medium">
            Required by
          </label>
          <input
            id="requiredBy"
            name="requiredBy"
            type="date"
            defaultValue={defaults?.requiredBy ?? ""}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          />
        </div>

        <div>
          <label htmlFor="reference" className="block text-[12px] font-medium">
            Reference
          </label>
          <input
            id="reference"
            name="reference"
            defaultValue={defaults?.reference ?? ""}
            placeholder="Their quotation number"
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
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
          placeholder="What this order is for, in one line"
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="deliveryNote" className="block text-[12px] font-medium">
            Delivery instructions
          </label>
          <textarea
            id="deliveryNote"
            name="deliveryNote"
            rows={2}
            defaultValue={defaults?.deliveryNote ?? ""}
            placeholder="Where and when it should arrive"
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
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
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
          />
        </div>
      </div>
    </div>
  );
}
