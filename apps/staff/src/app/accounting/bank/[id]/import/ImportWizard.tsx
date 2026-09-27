"use client";

import { useActionState } from "react";
import { confirmImport, previewStatement, type ImportPreviewState } from "../../banking-actions";
import type { FormState } from "../../../action-errors";
import { Alert, Button, DataTable, Td } from "@/components/ui";

const initialPreview: ImportPreviewState = {};
const initialConfirm: FormState = {};

/** Ten-thousandths back to something a person reads. */
function money(raw: string): string {
  const value = BigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10000n;
  const cents = (abs % 10000n) / 100n;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${cents.toString().padStart(2, "0")}`;
}

const COLUMN_FIELDS = [
  { key: "date", label: "Transaction date", required: true },
  { key: "description", label: "Description", required: true },
  { key: "paidIn", label: "Money in", required: false },
  { key: "paidOut", label: "Money out", required: false },
  { key: "amount", label: "Single signed amount", required: false },
  { key: "reference", label: "Reference", required: false },
  { key: "balance", label: "Running balance", required: false },
  { key: "valueDate", label: "Value date", required: false },
] as const;

/**
 * Import in two steps: read and show, then confirm and write.
 *
 * The preview is not decoration. A wrong column mapping imports a month of
 * transactions against the wrong fields and nothing about the result looks wrong
 * afterwards — the only cheap place to catch it is a screen showing the first
 * rows as they were read, next to the columns they were read from.
 */
export function ImportWizard({ bankAccountId }: { bankAccountId: string }) {
  const [preview, previewAction, previewing] = useActionState(previewStatement, initialPreview);
  const [confirm, confirmAction, confirming] = useActionState(confirmImport, initialConfirm);

  const mapping = preview.preview?.mapping;

  /** The column index the mapping holds for a field, or -1 for "none". */
  const columnFor = (field: (typeof COLUMN_FIELDS)[number]["key"]): number => {
    const value = mapping?.[field];
    return typeof value === "number" ? value : -1;
  };

  return (
    <div className="space-y-4">
      {preview.error && <Alert tone="danger">{preview.error}</Alert>}

      <form action={previewAction} className="space-y-3">
        {preview.preview && (
          <>
            <input type="hidden" name="fileText" value={preview.preview.fileText} />
            <input type="hidden" name="filename" value={preview.preview.filename ?? ""} />
          </>
        )}

        {!preview.preview && (
          <>
            <div>
              <label htmlFor="file" className="block text-[12px] font-medium">
                The statement, as CSV
              </label>
              <input
                id="file"
                name="file"
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[13px]"
              />
              <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                Whatever the bank exports. Comma, semicolon or tab separated; quoted fields and a
                UTF-8 byte order mark are all handled.
              </p>
            </div>

            <details>
              <summary className="cursor-pointer text-[12px] text-[var(--color-info)]">
                Or paste the rows
              </summary>
              <textarea
                name="pasted"
                rows={6}
                placeholder="Date,Description,Debit,Credit,Balance"
                className="mt-2 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 font-mono text-[12px]"
              />
            </details>
          </>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="skipRows" className="block text-[12px] font-medium">
              Rows before the headings
            </label>
            <input
              id="skipRows"
              name="skipRows"
              type="number"
              min={0}
              max={50}
              defaultValue={preview.preview?.skipRows ?? 0}
              className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
            />
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">
              Many exports start with the account name and the download date.
            </p>
          </div>

          <div>
            <label htmlFor="mapping.dateFormat" className="block text-[12px] font-medium">
              Date format
            </label>
            <select
              id="mapping.dateFormat"
              name="mapping.dateFormat"
              defaultValue={mapping?.dateFormat ?? "auto"}
              className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
            >
              <option value="auto">Work it out where it is unambiguous</option>
              <option value="dmy">Day first — 03/04/2026 is 3 April</option>
              <option value="mdy">Month first — 03/04/2026 is 4 March</option>
              <option value="ymd">Year first</option>
            </select>
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">
              Dates that could be read either way are refused rather than guessed.
            </p>
          </div>
        </div>

        {preview.preview && (
          <fieldset className="rounded-md border border-[var(--color-line)] p-3">
            <legend className="px-1 text-[12px] font-medium">Which column is which</legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {COLUMN_FIELDS.map((field) => (
                <div key={field.key}>
                  <label
                    htmlFor={`mapping.${field.key}`}
                    className="block text-[11px] font-medium"
                  >
                    {field.label}
                    {field.required && <span className="text-[var(--color-danger)]"> *</span>}
                  </label>
                  <select
                    id={`mapping.${field.key}`}
                    name={`mapping.${field.key}`}
                    defaultValue={String(columnFor(field.key))}
                    className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-2 py-1.5 text-[12px]"
                  >
                    <option value="-1">— none —</option>
                    {preview.preview!.header.map((heading, index) => (
                      <option key={`${heading}-${index}`} value={index}>
                        {heading || `(column ${index + 1})`}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-[var(--color-muted)]">
              Either money in and money out as two columns, or one signed column where a negative
              means money left the account — not both.
            </p>
          </fieldset>
        )}

        <Button type="submit" variant={preview.preview ? "secondary" : "primary"} disabled={previewing}>
          {previewing ? "Reading…" : preview.preview ? "Read it again with these columns" : "Read the file"}
        </Button>
      </form>

      {preview.preview && (
        <>
          {preview.preview.rejected.length > 0 && (
            <Alert tone="warn">
              {preview.preview.rejected.length} row
              {preview.preview.rejected.length === 1 ? "" : "s"} could not be read and will not be
              imported. Each is listed below with the reason — check that none of them is a real
              transaction before going on.
            </Alert>
          )}

          <div className="rounded-lg border border-[var(--color-line)] p-3">
            <p className="mb-2 text-[13px] font-medium">
              {preview.preview.rows.length} row
              {preview.preview.rows.length === 1 ? "" : "s"} read
              {preview.preview.earliest && (
                <span className="font-normal text-[var(--color-muted)]">
                  {" "}
                  · {preview.preview.earliest} to {preview.preview.latest}
                </span>
              )}
            </p>
            <DataTable
              columns={["#", "Date", "Description", "Reference", "In", "Out"]}
              caption="Rows as they were read"
            >
              {preview.preview.rows.slice(0, 25).map((row) => (
                <tr key={row.lineNo}>
                  <Td>{row.lineNo}</Td>
                  <Td>{row.txnDate}</Td>
                  <Td>{row.description}</Td>
                  <Td>{row.reference ?? "—"}</Td>
                  <Td numeric>{row.paidIn === "0" ? "—" : money(row.paidIn)}</Td>
                  <Td numeric>{row.paidOut === "0" ? "—" : money(row.paidOut)}</Td>
                </tr>
              ))}
            </DataTable>
            {preview.preview.rows.length > 25 && (
              <p className="mt-2 text-[11px] text-[var(--color-muted)]">
                Showing the first 25 of {preview.preview.rows.length}.
              </p>
            )}
            <p className="mt-2 text-[12px]">
              Money in <span className="numeric">{money(preview.preview.totalIn)}</span>, money out{" "}
              <span className="numeric">{money(preview.preview.totalOut)}</span>, a net movement of{" "}
              <strong className="numeric">{money(preview.preview.impliedMovement)}</strong>.
            </p>
          </div>

          {preview.preview.rejected.length > 0 && (
            <div className="rounded-lg border border-[var(--color-warn)] p-3">
              <p className="mb-2 text-[13px] font-medium">Rows that were not read</p>
              <ul className="space-y-1 text-[12px]">
                {preview.preview.rejected.map((row) => (
                  <li key={row.rowNo}>
                    <span className="font-mono text-[11px] text-[var(--color-muted)]">
                      row {row.rowNo}
                    </span>{" "}
                    {row.reason}
                    <span className="block font-mono text-[10px] text-[var(--color-faint)]">
                      {row.raw.slice(0, 6).join(" | ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <form action={confirmAction} className="space-y-3 rounded-lg border border-[var(--color-line-strong)] p-3">
            {confirm.error && <Alert tone="danger">{confirm.error}</Alert>}

            <input type="hidden" name="bankAccountId" value={bankAccountId} />
            <input type="hidden" name="fileText" value={preview.preview.fileText} />
            <input type="hidden" name="filename" value={preview.preview.filename ?? ""} />
            <input type="hidden" name="skipRows" value={preview.preview.skipRows} />
            <input type="hidden" name="mapping.dateFormat" value={mapping?.dateFormat ?? "auto"} />
            {COLUMN_FIELDS.map((field) => (
              <input
                key={field.key}
                type="hidden"
                name={`mapping.${field.key}`}
                value={String(columnFor(field.key))}
              />
            ))}

            <p className="text-[13px] font-medium">The statement itself</p>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label htmlFor="periodFrom" className="block text-[12px] font-medium">
                  From
                </label>
                <input
                  id="periodFrom"
                  name="periodFrom"
                  type="date"
                  required
                  defaultValue={preview.preview.earliest ?? ""}
                  className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
                />
              </div>
              <div>
                <label htmlFor="periodTo" className="block text-[12px] font-medium">
                  To
                </label>
                <input
                  id="periodTo"
                  name="periodTo"
                  type="date"
                  required
                  defaultValue={preview.preview.latest ?? ""}
                  className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
                />
              </div>
              <div>
                <label htmlFor="openingBalance" className="block text-[12px] font-medium">
                  Opening balance
                </label>
                <input
                  id="openingBalance"
                  name="openingBalance"
                  required
                  inputMode="decimal"
                  placeholder="0.00"
                  className="numeric mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-right text-[14px]"
                />
              </div>
              <div>
                <label htmlFor="closingBalance" className="block text-[12px] font-medium">
                  Closing balance
                </label>
                <input
                  id="closingBalance"
                  name="closingBalance"
                  required
                  inputMode="decimal"
                  placeholder="0.00"
                  className="numeric mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-right text-[14px]"
                />
              </div>
            </div>

            <p className="text-[11px] text-[var(--color-muted)]">
              Both balances come off the statement itself. They are what makes the import provably
              complete: the rows have to account for the movement between them, which is{" "}
              <strong className="numeric">{money(preview.preview.impliedMovement)}</strong>. If they
              do not, the download was filtered or cut short, and it is far cheaper to find that out
              now than when a reconciliation will not balance for no visible reason.
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="statementRef" className="block text-[12px] font-medium">
                  Statement reference
                </label>
                <input
                  id="statementRef"
                  name="statementRef"
                  className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
                />
              </div>
              <div>
                <label htmlFor="notes" className="block text-[12px] font-medium">
                  Notes
                </label>
                <input
                  id="notes"
                  name="notes"
                  className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
                />
              </div>
            </div>

            <details className="text-[12px]">
              <summary className="cursor-pointer text-[var(--color-muted)]">
                Overrides, if you know what you are doing
              </summary>
              <div className="mt-2 space-y-2 rounded-md border border-[var(--color-line)] p-3">
                <label className="flex items-start gap-2">
                  <input type="checkbox" name="acceptIncomplete" className="mt-0.5" />
                  <span>
                    Import even though the rows do not account for the balance movement. Recorded
                    against your name, and the reconciliation will be out by that amount.
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="checkbox" name="allowDuplicate" className="mt-0.5" />
                  <span>
                    Import even though this exact file has been imported before. This duplicates
                    every transaction on it; there is almost never a good reason.
                  </span>
                </label>
              </div>
            </details>

            <Button type="submit" variant="primary" disabled={confirming}>
              {confirming ? "Importing…" : `Import ${preview.preview.rows.length} rows`}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
