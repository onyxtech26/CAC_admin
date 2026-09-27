import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import {
  formatAmount,
  formatDate,
  getEmployee,
  listAttendance,
  listEmploymentEvents,
  today,
  toIsoDate,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { hrFormOptions } from "@/lib/hr-options";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, LinkButton, Panel, Td } from "@/components/ui";
import { DeviceMappingForm, EmploymentEventForm, SensitiveReveal } from "./EmployeeActions";

const TONE = {
  active: "ok",
  on_leave: "info",
  suspended: "warn",
  resigned: "neutral",
  terminated: "danger",
} as const;

const STATUS: Record<string, string> = {
  active: "Active",
  on_leave: "On leave",
  suspended: "Suspended",
  resigned: "Resigned",
  terminated: "Terminated",
};

const EVENT: Record<string, string> = {
  hired: "Joined",
  confirmed: "Confirmed",
  promoted: "Promoted",
  transferred: "Transferred",
  salary_changed: "Salary changed",
  type_changed: "Type changed",
  suspended: "Suspended",
  reinstated: "Reinstated",
  resigned: "Resigned",
  terminated: "Terminated",
  corrected: "Correction",
};

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("hr.employee.view");
  const { id } = await params;
  const db = await getDb();

  const employee = await getEmployee(db, id);
  if (!employee) notFound();

  const [history, recentAttendance, options] = await Promise.all([
    listEmploymentEvents(db, id),
    listAttendance(db, { employeeId: id, limit: 14 }),
    hrFormOptions({ excludeEmployeeId: id }),
  ]);

  const now = toIsoDate(today());
  const confirmationDue =
    employee.status === "active" &&
    !employee.confirmedOn &&
    employee.probationEndsOn !== null &&
    employee.probationEndsOn < now;

  const canSeeSensitive = principal.capabilities.has("hr.employee.view_sensitive");
  const canEdit = principal.capabilities.has("hr.employee.edit");

  return (
    <Shell
      principal={principal}
      title={employee.fullName}
      breadcrumbs={[
        { label: "Human resources" },
        { label: "Employees", href: "/hr/employees" },
        { label: employee.employeeNo },
      ]}
      actions={
        canEdit ? <LinkButton href={`/hr/employees/${id}/edit`}>Edit the record</LinkButton> : undefined
      }
    >
      <div className="space-y-4">
        {confirmationDue && (
          <Alert tone="warn">
            Probation ended on {formatDate(employee.probationEndsOn!)} and no confirmation has been
            recorded. Until one is, this person is formally still on probation.
          </Alert>
        )}
        {(employee.status === "resigned" || employee.status === "terminated") && (
          <Alert tone="info">
            Left on {formatDate(employee.lastDay!)}
            {employee.exitReason ? ` — ${employee.exitReason}` : ""}. The record is kept; no
            attendance can be recorded after that date.
          </Alert>
        )}
        {employee.status === "active" && !employee.deviceUserId && (
          <Alert tone="warn">
            The attendance device has no number mapped to this person, so their scans arrive with
            nobody to attach them to. Map it below.
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Panel title="The record">
              <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
                <Detail label="Employee number">
                  <span className="font-mono text-[12px]">{employee.employeeNo}</span>
                </Detail>
                <Detail label="Status">
                  <Badge tone={TONE[employee.status]}>{STATUS[employee.status]}</Badge>
                </Detail>
                <Detail label="Identity card">
                  {employee.nricLast4 ? (
                    <span className="font-mono text-[12px]">···{employee.nricLast4}</span>
                  ) : (
                    <span className="text-[var(--color-faint)]">not recorded</span>
                  )}
                </Detail>
                <Detail label="Position">{employee.positionTitle ?? "—"}</Detail>
                <Detail label="Department">{employee.departmentName ?? "—"}</Detail>
                <Detail label="Reports to">
                  {employee.reportsToId ? (
                    <Link
                      href={`/hr/employees/${employee.reportsToId}`}
                      className="text-[var(--color-link)] hover:underline"
                    >
                      {employee.reportsToName}
                    </Link>
                  ) : (
                    "—"
                  )}
                </Detail>
                <Detail label="Employment type">{employee.employmentType.replace(/_/g, " ")}</Detail>
                <Detail label="Joined">{formatDate(employee.joinedOn)}</Detail>
                <Detail label="Confirmed">
                  {employee.confirmedOn ? (
                    formatDate(employee.confirmedOn)
                  ) : (
                    <span className="text-[var(--color-warn)]">
                      not yet
                      {employee.probationEndsOn && ` (due ${formatDate(employee.probationEndsOn)})`}
                    </span>
                  )}
                </Detail>
                <Detail label="Work schedule">
                  {employee.workScheduleName ?? (
                    <span className="text-[var(--color-muted)]">the default</span>
                  )}
                </Detail>
                <Detail label="Work email">{employee.email ?? "—"}</Detail>
                <Detail label="Phone">{employee.phone ?? "—"}</Detail>
                <Detail label="Bank">
                  {employee.bankName ?? "—"}
                  {employee.bankAccountLast4 && (
                    <span className="ml-1 font-mono text-[11px] text-[var(--color-muted)]">
                      ···{employee.bankAccountLast4}
                    </span>
                  )}
                </Detail>
                <Detail label="Device number">
                  {employee.deviceUserId ? (
                    <span className="font-mono text-[12px]">{employee.deviceUserId}</span>
                  ) : (
                    <Badge tone="warn">not mapped</Badge>
                  )}
                </Detail>
                <Detail label="Staff account">
                  {employee.userId ? (
                    <Link
                      href={`/admin/users/${employee.userId}`}
                      className="text-[var(--color-link)] hover:underline"
                    >
                      has a login
                    </Link>
                  ) : (
                    <span className="text-[var(--color-muted)]">none</span>
                  )}
                </Detail>
              </dl>

              <div className="mt-3 border-t border-[var(--color-line)] pt-3">
                <p className="text-[12px] text-[var(--color-muted)]">
                  Statutory: {employee.epfApplicable ? "EPF" : "no EPF"} ·{" "}
                  {employee.socsoApplicable ? "SOCSO" : "no SOCSO"} ·{" "}
                  {employee.eisApplicable ? "EIS" : "no EIS"} ·{" "}
                  {employee.pcbApplicable ? "PCB" : "no PCB"} · {employee.taxDependants}{" "}
                  dependant{employee.taxDependants === 1 ? "" : "s"} claimed. How much each comes to
                  is a schedule CAC has not yet supplied (Q-HR-1).
                </p>
              </div>

              {employee.notes && (
                <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-[12px] text-[var(--color-muted)]">
                  {employee.notes}
                </p>
              )}
            </Panel>

            <Panel
              title="Employment history"
              description="Append-only. The salary in force on a past date is read from here, which is what makes a payroll rerun reproducible."
            >
              <DataTable
                columns={["Effective", "What", "Salary", "Position", "Reason", "Recorded by"]}
                caption="Employment history"
              >
                {history.map((event) => (
                  <tr key={event.id}>
                    <Td>{formatDate(event.effectiveFrom)}</Td>
                    <Td>{EVENT[event.kind] ?? event.kind}</Td>
                    <Td numeric>
                      {event.basicSalary === null ? (
                        <span className="text-[var(--color-faint)]">—</span>
                      ) : canSeeSensitive ? (
                        formatAmount(event.basicSalary)
                      ) : (
                        <span className="text-[var(--color-faint)]">hidden</span>
                      )}
                    </Td>
                    <Td>{event.positionTitle ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                    <Td>{event.reason ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                    <Td>
                      <span className="text-[11px] text-[var(--color-muted)]">
                        {event.createdByName ?? "—"}
                      </span>
                    </Td>
                  </tr>
                ))}
              </DataTable>
              {!canSeeSensitive && (
                <p className="mt-2 text-[11px] text-[var(--color-muted)]">
                  Salary figures are withheld: they need the capability to see sensitive employee
                  details.
                </p>
              )}
            </Panel>

            {principal.capabilities.has("hr.attendance.view") && (
              <Panel title="Recent attendance">
                {recentAttendance.length === 0 ? (
                  <p className="text-[13px] text-[var(--color-muted)]">
                    Nothing recorded yet. Attendance arrives by importing the device export.
                  </p>
                ) : (
                  <DataTable columns={["Date", "In", "Out", "Source", "Status"]} caption="Attendance">
                    {recentAttendance.map((day) => (
                      <tr key={day.id}>
                        <Td>{formatDate(day.workDate)}</Td>
                        <Td>{timeOf(day.clockIn)}</Td>
                        <Td>
                          {day.clockOut ? (
                            timeOf(day.clockOut)
                          ) : (
                            <span className="text-[var(--color-warn)]">missing</span>
                          )}
                        </Td>
                        <Td>
                          <span className="text-[11px]">{day.source.replace(/_/g, " ")}</span>
                        </Td>
                        <Td>
                          <Badge tone={day.status === "final" ? "ok" : "neutral"}>{day.status}</Badge>
                        </Td>
                      </tr>
                    ))}
                  </DataTable>
                )}
              </Panel>
            )}
          </div>

          <div className="space-y-4">
            {canSeeSensitive && (
              <Panel title="Identity and pay">
                <SensitiveReveal employeeId={id} />
              </Panel>
            )}

            {canEdit && employee.status !== "resigned" && employee.status !== "terminated" && (
              <Panel title="Record a change">
                <EmploymentEventForm
                  employeeId={id}
                  positions={options.positions}
                  departments={options.departments}
                  canTerminate={principal.capabilities.has("hr.employee.terminate")}
                  suggestedDate={employee.probationEndsOn ?? now}
                />
              </Panel>
            )}

            {canEdit && (
              <Panel title="Attendance device">
                <DeviceMappingForm employeeId={id} current={employee.deviceUserId} />
              </Panel>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
        {label}
      </dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

/**
 * The time in Malaysia, whatever the server thinks the timezone is.
 *
 * Clock times are stored as instants; rendering them in the server's zone would
 * show a clock-in of 08:57 as 00:57 on a UTC host.
 */
function timeOf(value: Date | string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kuala_Lumpur",
  });
}
