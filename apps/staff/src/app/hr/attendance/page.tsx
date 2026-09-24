import Link from "next/link";
import { getDb } from "@cac/db";
import {
  formatDate,
  listAttendance,
  listAttendanceImports,
  listAttendancePeriods,
  listDepartments,
  listEmployees,
  listUnmappedEmployees,
  today,
  toIsoDate,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import {
  Alert,
  Badge,
  DataTable,
  EmptyState,
  LinkButton,
  Panel,
  StatTile,
  Td,
} from "@/components/ui";
import { AttendanceDayForm, OpenPeriodForm, PeriodActions } from "./AttendanceForms";

/**
 * Attendance.
 *
 * The figures on this page become payroll figures, so the two warnings at the top
 * are the ones that matter: days with a clock-in and no clock-out, and people the
 * device cannot identify. Both are silent otherwise — the first becomes a short day
 * nobody can defend, the second means somebody's attendance never arrives at all.
 */
export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; department?: string; employee?: string }>;
}) {
  const principal = await requireCapability("hr.attendance.view");
  const query = await searchParams;
  const db = await getDb();

  const now = toIsoDate(today());
  const monthStart = `${now.slice(0, 7)}-01`;
  const from = query.from ?? monthStart;
  const to = query.to ?? now;

  const [days, periods, imports, departments, employees, unmapped] = await Promise.all([
    listAttendance(db, {
      from,
      to,
      departmentId: query.department,
      employeeId: query.employee,
      limit: 2000,
    }),
    listAttendancePeriods(db),
    listAttendanceImports(db, 10),
    listDepartments(db),
    listEmployees(db, { limit: 1000 }),
    listUnmappedEmployees(db),
  ]);

  const missingClockOut = days.filter(
    (day) => day.clockIn && !day.clockOut && !day.isAbsent && !day.onLeaveType && !day.remarks,
  );
  const drafts = days.filter((day) => day.status === "draft");

  const canEdit = principal.capabilities.has("hr.attendance.edit");
  const canImport = principal.capabilities.has("hr.attendance.import");
  const canFinalise = principal.capabilities.has("hr.attendance.finalise");

  return (
    <Shell
      principal={principal}
      title="Attendance"
      breadcrumbs={[{ label: "Human resources" }, { label: "Attendance" }]}
      actions={
        canImport ? (
          <LinkButton href="/hr/attendance/import" variant="primary">
            Import from the device
          </LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {unmapped.length > 0 && (
          <Alert tone="warn">
            {unmapped.length} active employee{unmapped.length === 1 ? " has" : "s have"} no device
            number mapped, so their scans cannot be matched to them:{" "}
            {unmapped.slice(0, 5).map((row, index) => (
              <span key={row.id}>
                {index > 0 && ", "}
                <Link
                  href={`/hr/employees/${row.id}`}
                  className="font-medium text-[var(--color-info)] hover:underline"
                >
                  {row.fullName}
                </Link>
              </span>
            ))}
            {unmapped.length > 5 && ` and ${unmapped.length - 5} more`}.
          </Alert>
        )}

        {missingClockOut.length > 0 && (
          <Alert tone="warn">
            {missingClockOut.length} day{missingClockOut.length === 1 ? "" : "s"} in this range have
            a clock-in and no clock-out, with nothing said about why. A period cannot be finalised
            while any remain — either correct the time or add a remark explaining it.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-4">
          <StatTile label="Days in range" value={String(days.length)} hint={`${from} to ${to}`} />
          <StatTile
            label="Still draft"
            value={String(drafts.length)}
            hint={drafts.length > 0 ? "not yet evidence for payroll" : "everything is final"}
            tone={drafts.length > 0 ? "warn" : "ok"}
          />
          <StatTile
            label="Missing a clock-out"
            value={String(missingClockOut.length)}
            hint={missingClockOut.length > 0 ? "unexplained" : "nothing unexplained"}
            tone={missingClockOut.length > 0 ? "danger" : "ok"}
          />
          <StatTile
            label="Absences recorded"
            value={String(days.filter((day) => day.isAbsent).length)}
            hint="in this range"
          />
        </div>

        <Panel title="Range">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="from" className="block text-[12px] font-medium">
                From
              </label>
              <input
                id="from"
                name="from"
                type="date"
                defaultValue={from}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              />
            </div>
            <div>
              <label htmlFor="to" className="block text-[12px] font-medium">
                To
              </label>
              <input
                id="to"
                name="to"
                type="date"
                defaultValue={to}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              />
            </div>
            <div>
              <label htmlFor="department" className="block text-[12px] font-medium">
                Department
              </label>
              <select
                id="department"
                name="department"
                defaultValue={query.department ?? ""}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              >
                <option value="">All</option>
                {departments.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="rounded-md bg-[var(--color-navy)] px-3 py-2 text-[13px] font-medium text-white"
            >
              Show
            </button>
            <Link href="/hr/attendance" className="pb-2 text-[12px] text-[var(--color-info)]">
              This month
            </Link>
          </form>
        </Panel>

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            <Panel title={`${days.length} day${days.length === 1 ? "" : "s"}`}>
              {days.length === 0 ? (
                <EmptyState
                  title="Nothing recorded in this range"
                  body="Attendance arrives by importing the thumbprint device export, or by entering a day by hand."
                  action={
                    canImport ? (
                      <LinkButton href="/hr/attendance/import" variant="primary">
                        Import from the device
                      </LinkButton>
                    ) : undefined
                  }
                />
              ) : (
                <DataTable
                  columns={["Date", "Who", "In", "Out", "Worked", "Source", "Status", "Notes"]}
                  caption="Attendance"
                >
                  {days.map((day) => (
                    <tr key={day.id}>
                      <Td>{formatDate(day.workDate)}</Td>
                      <Td>
                        <Link
                          href={`/hr/employees/${day.employeeId}`}
                          className="text-[var(--color-info)] hover:underline"
                        >
                          {day.employeeName}
                        </Link>
                      </Td>
                      <Td>{timeOf(day.clockIn)}</Td>
                      <Td>
                        {day.clockOut ? (
                          timeOf(day.clockOut)
                        ) : day.isAbsent || day.onLeaveType ? (
                          <span className="text-[var(--color-faint)]">—</span>
                        ) : (
                          <span className="text-[var(--color-warn)]">missing</span>
                        )}
                      </Td>
                      <Td numeric>
                        {day.workedMinutes === null ? (
                          <span className="text-[var(--color-faint)]" title="Not yet calculated">
                            —
                          </span>
                        ) : (
                          `${Math.floor(day.workedMinutes / 60)}h ${day.workedMinutes % 60}m`
                        )}
                      </Td>
                      <Td>
                        <span className="text-[11px]">{day.source.replace(/_/g, " ")}</span>
                      </Td>
                      <Td>
                        {day.isAbsent ? (
                          <Badge tone="danger">absent</Badge>
                        ) : day.onLeaveType ? (
                          <Badge tone="info">{day.onLeaveType}</Badge>
                        ) : (
                          <Badge tone={day.status === "final" ? "ok" : "neutral"}>{day.status}</Badge>
                        )}
                      </Td>
                      <Td>
                        <span className="text-[11px] text-[var(--color-muted)]">
                          {day.remarks ?? day.correctedReason ?? ""}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              )}
              <p className="mt-2 border-t border-[var(--color-line)] pt-2 text-[11px] text-[var(--color-muted)]">
                &ldquo;Worked&rdquo; is blank because the calculation engine — lateness, early
                departures, extra time against the schedule — arrives with the HR workflows. The
                clock times are real; the arithmetic on them is not yet done.
              </p>
            </Panel>

            <Panel title="Recent imports">
              {imports.length === 0 ? (
                <p className="text-[13px] text-[var(--color-muted)]">
                  Nothing imported yet.
                </p>
              ) : (
                <DataTable
                  columns={["When", "File", "Device", "Period", "Rows", "Accepted", "Status"]}
                  caption="Attendance imports"
                >
                  {imports.map((batch) => (
                    <tr key={batch.id}>
                      <Td>
                        <Link
                          href={`/hr/attendance/imports/${batch.id}`}
                          className="text-[var(--color-info)] hover:underline"
                        >
                          {new Date(batch.createdAt).toLocaleDateString("en-GB")}
                        </Link>
                      </Td>
                      <Td>
                        <span className="font-mono text-[11px]">
                          {batch.sourceFilename ?? "pasted"}
                        </span>
                      </Td>
                      <Td>{batch.deviceLabel ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                      <Td>
                        {batch.periodFrom && batch.periodTo
                          ? `${batch.periodFrom} – ${batch.periodTo}`
                          : "—"}
                      </Td>
                      <Td numeric>{batch.rowCount}</Td>
                      <Td numeric>
                        {batch.acceptedCount}
                        {batch.rejectedCount > 0 && (
                          <span className="ml-1 text-[var(--color-warn)]">
                            ({batch.rejectedCount} rejected)
                          </span>
                        )}
                      </Td>
                      <Td>
                        <Badge
                          tone={
                            batch.status === "confirmed"
                              ? "ok"
                              : batch.status === "discarded"
                                ? "neutral"
                                : "warn"
                          }
                        >
                          {batch.status}
                        </Badge>
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel
              title="Periods"
              description="Closing a period turns its days into evidence. Payroll reads final days only."
            >
              {periods.length === 0 ? (
                <p className="text-[13px] text-[var(--color-muted)]">
                  No period has been opened. Payroll for a month needs that month closed.
                </p>
              ) : (
                <DataTable columns={["Period", "Days", "Status", ""]} caption="Attendance periods">
                  {periods.map((period) => (
                    <tr key={period.id}>
                      <Td>
                        {formatDate(period.periodFrom)} – {formatDate(period.periodTo)}
                      </Td>
                      <Td numeric>
                        {period.recordCount}
                        {period.draftCount > 0 && (
                          <span className="ml-1 text-[11px] text-[var(--color-warn)]">
                            {period.draftCount} draft
                          </span>
                        )}
                      </Td>
                      <Td>
                        <Badge tone={period.status === "finalised" ? "ok" : "warn"}>
                          {period.status}
                        </Badge>
                        {period.reopenReason && (
                          <span
                            className="ml-1 text-[10px] text-[var(--color-muted)]"
                            title={period.reopenReason}
                          >
                            reopened
                          </span>
                        )}
                      </Td>
                      <Td>
                        {canFinalise && (
                          <PeriodActions
                            periodId={period.id}
                            status={period.status}
                            draftCount={period.draftCount}
                          />
                        )}
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>

            {canFinalise && (
              <Panel title="Open a period">
                <OpenPeriodForm defaultFrom={monthStart} defaultTo={now} />
              </Panel>
            )}

            {canEdit && (
              <Panel title="Record a day by hand">
                <AttendanceDayForm
                  employees={employees.map((row) => ({
                    id: row.id,
                    employeeNo: row.employeeNo,
                    fullName: row.fullName,
                  }))}
                  defaultDate={now}
                />
              </Panel>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}

/** Malaysian clock time, whatever timezone the server is in. */
function timeOf(value: Date | string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kuala_Lumpur",
  });
}
