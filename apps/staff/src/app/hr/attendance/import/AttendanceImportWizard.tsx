"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  previewAttendance,
  stageAttendance,
  type AttendancePreviewState,
} from "../../hr-actions";
import type { FormState } from "../../../accounting/action-errors";
import { Alert, Badge, Button, DataTable, Td } from "@/components/ui";

const initialPreview: AttendancePreviewState = {};
const initialStage: FormState = {};

const COLUMN_FIELDS = [
  { key: "deviceUserId", label: "Device user number", hint: "The safest way to identify people." },
  { key: "employeeNo", label: "Employee number", hint: "" },
  { key: "employeeName", label: "Name", hint: "A poor identifier: two people can share one." },
  { key: "timestamp", label: "Date and time (one row per scan)", hint: "" },
  { key: "date", label: "Date (one row per day)", hint: "" },
  { key: "clockIn", label: "Check in", hint: "" },
  { key: "clockOut", label: "Check out", hint: "" },
  { key: "direction", label: "In/out marker", hint: "" },
] as const;

/**
 * The attendance import, in two steps: read and show, then stage.
 *
 * Nothing this wizard does touches attendance. Even the second step only *stages*
 * the batch — writing into attendance is a third, explicit confirmation on the
 * batch's own page, after somebody has looked at what was read. Attendance feeds
 * payroll, and a silently wrong import is a wrong payslip.
 */
export function AttendanceImportWizard() {
  const [preview, previewAction, previewing] = useActionState(previewAttendance, initialPreview);
  const [stage, stageAction, staging] = useActionState(stageAttendance, initialStage);

  const mapping = preview.preview?.mapping;

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
                The device export
              </label>
              <input
                id="file"
                name="file"
                type="file"
                accept=".csv,.txt,.tsv,text/csv,text/plain"
                className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              />
              <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                Whatever the thumbprint reader produces, as long as it is delimited text. If it only
                exports .xls, open it once and save as CSV. Comma, semicolon or tab separated are all
                handled, as are quoted fields and a byte order mark.
              </p>
            </div>

            <details>
              <summary className="cursor-pointer text-[12px] text-[var(--color-info)]">
                Or paste the rows
              </summary>
              <textarea
                name="pasted"
                rows={6}
                placeholder="USERID,Name,Date/Time&#10;101,Aishah,13/07/2026 08:57"
                className="mt-2 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[12px]"
              />
            </details>
          </>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
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
              className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
            />
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">
              Device exports usually begin with the company name and a date range.
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
              className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
            >
              <option value="auto">Work it out where it is unambiguous</option>
              <option value="dmy">Day first — 03/04/2026 is 3 April</option>
              <option value="mdy">Month first — 03/04/2026 is 4 March</option>
              <option value="ymd">Year first</option>
            </select>
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">
              A date that could be read either way is refused rather than guessed — guessing decides
              which month a whole file belongs to.
            </p>
          </div>
        </div>

        {preview.preview && (
          <fieldset className="rounded-md border border-[var(--color-line)] p-3">
            <legend className="px-1 text-[12px] font-medium">Which column is which</legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {COLUMN_FIELDS.map((field) => (
                <div key={field.key}>
                  <label htmlFor={`mapping.${field.key}`} className="block text-[11px] font-medium">
                    {field.label}
                  </label>
                  <select
                    id={`mapping.${field.key}`}
                    name={`mapping.${field.key}`}
                    defaultValue={String(columnFor(field.key))}
                    className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-[12px]"
                  >
                    <option value="-1">— none —</option>
                    {preview.preview!.header.map((heading, index) => (
                      <option key={`${heading}-${index}`} value={index}>
                        {heading || `(column ${index + 1})`}
                      </option>
                    ))}
                  </select>
                  {field.hint && (
                    <p className="mt-0.5 text-[10px] text-[var(--color-muted)]">{field.hint}</p>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-[var(--color-muted)]">
              Either one row per scan with a single date-and-time column, or one row per day with a
              date plus check-in and check-out. Scans are grouped per person per day: the earliest
              becomes the arrival and the latest the departure, so somebody going out for lunch is
              not a second working day.
            </p>
          </fieldset>
        )}

        <Button
          type="submit"
          variant={preview.preview ? "secondary" : "primary"}
          disabled={previewing}
        >
          {previewing
            ? "Reading…"
            : preview.preview
              ? "Read it again with these columns"
              : "Read the file"}
        </Button>
      </form>

      {preview.preview && (
        <>
          {preview.preview.unmappedDeviceIds.length > 0 && (
            <Alert tone="warn">
              The file uses device numbers nobody has mapped to an employee:{" "}
              <span className="font-mono">{preview.preview.unmappedDeviceIds.join(", ")}</span>. Map
              them on each{" "}
              <Link href="/hr/employees" className="font-medium underline">
                employee record
              </Link>{" "}
              and read the file again — those rows are set aside rather than guessed at.
            </Alert>
          )}

          <div className="grid gap-3 sm:grid-cols-4">
            <Figure label="Employee-days read" value={String(preview.preview.okCount)} />
            <Figure
              label="Set aside"
              value={String(preview.preview.problemCount)}
              tone={preview.preview.problemCount > 0 ? "warn" : undefined}
            />
            <Figure
              label="Duplicate scans collapsed"
              value={String(preview.preview.duplicateCount)}
            />
            <Figure
              label="Covering"
              value={
                preview.preview.earliest
                  ? `${preview.preview.earliest} → ${preview.preview.latest}`
                  : "—"
              }
            />
          </div>

          <div className="rounded-lg border border-[var(--color-line)] p-3">
            <p className="mb-2 text-[13px] font-medium">What was read</p>
            <DataTable
              columns={["#", "Who", "Device", "Day", "In", "Out", "State"]}
              caption="Rows as they were read"
            >
              {preview.preview.rows.slice(0, 40).map((row) => (
                <tr key={`${row.rowNo}-${row.workDate ?? "x"}`}>
                  <Td>{row.rowNo}</Td>
                  <Td>
                    {row.employeeName ?? <span className="text-[var(--color-faint)]">unknown</span>}
                  </Td>
                  <Td>
                    <span className="font-mono text-[11px]">{row.deviceUserId ?? "—"}</span>
                  </Td>
                  <Td>{row.workDate ?? "—"}</Td>
                  <Td>{clockOf(row.clockIn)}</Td>
                  <Td>
                    {row.clockOut ? (
                      clockOf(row.clockOut)
                    ) : row.state === "ok" ? (
                      <span className="text-[var(--color-warn)]">missing</span>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td>
                    {row.state === "ok" ? (
                      <Badge tone="ok">will import</Badge>
                    ) : (
                      <span title={row.problem ?? ""}>
                        <Badge tone="warn">set aside</Badge>
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </DataTable>
            {preview.preview.rows.length > 40 && (
              <p className="mt-2 text-[11px] text-[var(--color-muted)]">
                Showing the first 40 of {preview.preview.rows.length}.
              </p>
            )}
          </div>

          {preview.preview.problemCount > 0 && (
            <div className="rounded-lg border border-[var(--color-warn)] p-3">
              <p className="mb-2 text-[13px] font-medium">
                Rows that will not import, and why
              </p>
              <ul className="space-y-1 text-[12px]">
                {preview.preview.rows
                  .filter((row) => row.state !== "ok")
                  .slice(0, 30)
                  .map((row) => (
                    <li key={`p-${row.rowNo}`}>
                      <span className="font-mono text-[11px] text-[var(--color-muted)]">
                        row {row.rowNo}
                      </span>{" "}
                      {row.problem}
                      <span className="block font-mono text-[10px] text-[var(--color-faint)]">
                        {row.raw.slice(0, 6).join(" | ")}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <form
            action={stageAction}
            className="space-y-3 rounded-lg border border-[var(--color-line-strong)] p-3"
          >
            {stage.error && <Alert tone="danger">{stage.error}</Alert>}

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

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="deviceLabel" className="block text-[12px] font-medium">
                  Which device is this?
                </label>
                <input
                  id="deviceLabel"
                  name="deviceLabel"
                  placeholder="Front door reader"
                  className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
                />
                <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                  Remembered with the column mapping, so next month&rsquo;s export from the same
                  device needs no re-mapping.
                </p>
              </div>
              <div>
                <label htmlFor="notes" className="block text-[12px] font-medium">
                  Notes
                </label>
                <input
                  id="notes"
                  name="notes"
                  className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
                />
              </div>
            </div>

            <details className="text-[12px]">
              <summary className="cursor-pointer text-[var(--color-muted)]">
                Override, if you know what you are doing
              </summary>
              <label className="mt-2 flex items-start gap-2 rounded-md border border-[var(--color-line)] p-3">
                <input type="checkbox" name="allowDuplicate" className="mt-0.5" />
                <span>
                  Stage even though this exact file has already been imported and confirmed. That
                  would duplicate every scan in it.
                </span>
              </label>
            </details>

            <Button type="submit" variant="primary" disabled={staging}>
              {staging ? "Staging…" : `Stage ${preview.preview.okCount} days for review`}
            </Button>
            <p className="text-[11px] text-[var(--color-muted)]">
              Staging writes nothing into attendance. The next screen shows the batch and asks you
              to confirm it.
            </p>
          </form>
        </>
      )}
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
        {label}
      </p>
      <p
        className={`mt-0.5 text-[15px] font-semibold ${
          tone === "warn" ? "text-[var(--color-warn)]" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

/** The clock time in Malaysia, from an instant string. */
function clockOf(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kuala_Lumpur",
  });
}
