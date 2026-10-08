import Link from "next/link";
import { getDb } from "@cac/db";
import {
  formatDate,
  listDepartments,
  listEmployees,
  listLeaveRequests,
  listPayrollRuns,
  today,
  toIsoDate,
} from "@cac/core";
import { requireAnyCapability } from "@/lib/auth";
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
import { WorkflowNavigator } from "@/components/WorkflowNavigator";
import {
  IconAward,
  IconBuilding,
  IconCalendar,
  IconClock,
  IconLetters,
  IconPayroll,
  IconPayslip,
  IconTax,
  IconUsers,
} from "@/components/icons";

/**
 * AutoCount HRMS Overview Hub.
 *
 * Modeled on AutoCount Cloud HRMS & AutoCount Payroll:
 * - Interactive visual workflow: Org & Calendar -> Employee Master -> Time & Leave -> Payroll Processing -> Statutory Compliance
 * - Real-time workforce metrics
 * - Malaysian statutory filing calendar (KWSP Form A, PERKESO 8A, EIS, PCB CP39 by 15th)
 * - Pending leave approvals & operational alerts
 */
export default async function HRMSOverviewPage() {
  const principal = await requireAnyCapability([
    "hr.employee.view",
    "hr.leave.view",
    "hr.leave.request",
    "hr.org.view",
  ]);
  const db = await getDb();
  const now = toIsoDate(today());

  const [employees, departments, pendingLeaves, payrollRuns] = await Promise.all([
    listEmployees(db, { limit: 1000 }).catch(() => []),
    listDepartments(db).catch(() => []),
    principal.capabilities.has("hr.leave.view")
      ? listLeaveRequests(db, { status: "submitted", limit: 8 }).catch(() => [])
      : Promise.resolve([]),
    principal.capabilities.has("hr.payroll.view")
      ? listPayrollRuns(db, 5).catch(() => [])
      : Promise.resolve([]),
  ]);

  const activeEmployees = employees.filter((e) => e.status === "active");
  const onProbation = employees.filter(
    (e) => e.status === "active" && !e.confirmedOn && e.probationEndsOn,
  );
  const overdueProbation = onProbation.filter((e) => e.probationEndsOn && e.probationEndsOn < now);
  const latestPayroll = payrollRuns[0];

  return (
    <Shell
      principal={principal}
      title="AutoCount HRMS & Payroll"
      breadcrumbs={[{ label: "Human Resources" }]}
      currentSuite="hrms"
      actions={
        <div className="flex items-center gap-2">
          {principal.capabilities.has("hr.employee.manage") && (
            <LinkButton href="/hr/employees/new" variant="primary">
              Add employee
            </LinkButton>
          )}
          {principal.capabilities.has("hr.leave.request") && (
            <LinkButton href="/hr/leave">
              Apply leave
            </LinkButton>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        {/* Probation Alert if any */}
        {overdueProbation.length > 0 && (
          <Alert tone="warn">
            <strong>{overdueProbation.length} employee probation period(s) have passed</strong>{" "}
            without a formal confirmation record. Review their status in the{" "}
            <Link href="/hr/employees" className="underline font-medium">
              Employee Directory
            </Link>
            .
          </Alert>
        )}

        {/* HR Key Metrics */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Active workforce"
            value={String(activeEmployees.length)}
            hint={`${departments.length} department(s) active`}
            tone="neutral"
          />
          <StatTile
            label="Probations to review"
            value={String(onProbation.length)}
            hint={
              overdueProbation.length > 0
                ? `${overdueProbation.length} overdue confirmation`
                : "All on schedule"
            }
            tone={overdueProbation.length > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Pending leave requests"
            value={String(pendingLeaves.length)}
            hint={pendingLeaves.length > 0 ? "Awaiting manager approval" : "Queue is clear"}
            tone={pendingLeaves.length > 0 ? "warn" : "ok"}
          />
          <StatTile
            label="Latest payroll run"
            value={latestPayroll ? latestPayroll.status.toUpperCase() : "None"}
            hint={
              latestPayroll
                ? `${formatDate(latestPayroll.periodFrom)} – ${formatDate(latestPayroll.periodTo)}`
                : "No payroll batch processed yet"
            }
            tone={latestPayroll?.status === "finalised" || latestPayroll?.status === "posted" ? "ok" : "neutral"}
          />
        </div>

        {/* Visual Process Flowchart */}
        <WorkflowNavigator defaultTab="hrms" />

        {/* Two-column operational section */}
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Malaysian Statutory Calendar & Compliance */}
          <Panel
            title="Malaysian Statutory Compliance Calendar"
            description="AutoCount HRMS strict deadlines for statutory contributions (LHDN, KWSP, PERKESO)."
            action={
              <Link href="/hr/statutory" className="text-[12px] text-[var(--color-gold-2)] hover:underline">
                View contribution tables
              </Link>
            }
          >
            <div className="space-y-3">
              <div className="flex items-start justify-between border-b border-[var(--color-line)] pb-2.5">
                <div>
                  <p className="text-[13px] font-medium text-[var(--color-body)]">
                    KWSP / EPF (Form A)
                  </p>
                  <p className="text-[11px] text-[var(--color-muted)]">
                    Monthly employee & employer retirement contributions
                  </p>
                </div>
                <div className="text-right">
                  <Badge tone="warn">Due 15th monthly</Badge>
                </div>
              </div>

              <div className="flex items-start justify-between border-b border-[var(--color-line)] pb-2.5">
                <div>
                  <p className="text-[13px] font-medium text-[var(--color-body)]">
                    PERKESO / SOCSO (Borang 8A) & EIS
                  </p>
                  <p className="text-[11px] text-[var(--color-muted)]">
                    Employment Injury, Invalidity & Employment Insurance System
                  </p>
                </div>
                <div className="text-right">
                  <Badge tone="warn">Due 15th monthly</Badge>
                </div>
              </div>

              <div className="flex items-start justify-between border-b border-[var(--color-line)] pb-2.5">
                <div>
                  <p className="text-[13px] font-medium text-[var(--color-body)]">
                    LHDN PCB / CP39 Monthly Deduction
                  </p>
                  <p className="text-[11px] text-[var(--color-muted)]">
                    Monthly tax deduction calculated per statutory tax schedule
                  </p>
                </div>
                <div className="text-right">
                  <Badge tone="info">Due month-end</Badge>
                </div>
              </div>

              <div className="flex items-start justify-between pt-1">
                <div>
                  <p className="text-[13px] font-medium text-[var(--color-body)]">
                    Annual Tax Reporting (EA Form & Form E)
                  </p>
                  <p className="text-[11px] text-[var(--color-muted)]">
                    EA form distributed to staff by Feb 28; Form E / CP8D to LHDN by Mar 31
                  </p>
                </div>
                <div className="text-right">
                  <Badge tone="neutral">Annual</Badge>
                </div>
              </div>
            </div>
          </Panel>

          {/* Pending Leave Requests */}
          <Panel
            title="Pending Leave Approvals"
            description="Leave applications submitted by team members waiting for supervisor action."
            action={
              <Link href="/hr/leave" className="text-[12px] text-[var(--color-gold-2)] hover:underline">
                Leave center
              </Link>
            }
          >
            {pendingLeaves.length === 0 ? (
              <EmptyState
                title="No pending leave applications"
                body="All staff leave submissions have been reviewed and decided."
              />
            ) : (
              <DataTable
                columns={["Staff", "Type", "Dates", "Days", "Action"]}
                caption="Pending leave requests"
              >
                {pendingLeaves.map((req) => (
                  <tr key={req.id}>
                    <Td>
                      <span className="font-medium text-[var(--color-body)]">{req.employeeName}</span>
                    </Td>
                    <Td>{req.leaveTypeName}</Td>
                    <Td>
                      {formatDate(req.startsOn)} {req.startsOn !== req.endsOn && `– ${formatDate(req.endsOn)}`}
                    </Td>
                    <Td numeric>{req.days}</Td>
                    <Td>
                      <Link
                        href={`/hr/leave#request-${req.id}`}
                        className="text-[12px] text-[var(--color-gold-2)] hover:underline"
                      >
                        Review
                      </Link>
                    </Td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Panel>
        </div>

        {/* AutoCount HRMS Fast Module Directory */}
        <Panel
          title="AutoCount HRMS Module Directory"
          description="Direct access to all HR setup, operational, and talent management sub-modules."
        >
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            <Link
              href="/hr/employees"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconUsers size={18} />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  Employees
                </p>
                <p className="text-[11px] text-[var(--color-muted)]">
                  Directory, profiles, contracts & NRIC
                </p>
              </div>
            </Link>

            <Link
              href="/hr/leave"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconCalendar size={18} />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  Leave Management
                </p>
                <p className="text-[11px] text-[var(--color-muted)]">
                  Entitlements, applications & balance
                </p>
              </div>
            </Link>

            <Link
              href="/hr/attendance"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconClock size={18} />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  Attendance
                </p>
                <p className="text-[11px] text-[var(--color-muted)]">
                  Biometrics, clocking & timesheets
                </p>
              </div>
            </Link>

            <Link
              href="/hr/payroll"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconPayroll size={18} />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  Payroll Processing
                </p>
                <p className="text-[11px] text-[var(--color-muted)]">
                  Monthly wage runs & salary posting
                </p>
              </div>
            </Link>

            <Link
              href="/hr/payslips"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconPayslip size={18} />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  Payslips
                </p>
                <p className="text-[11px] text-[var(--color-muted)]">
                  Confidential employee wage slips
                </p>
              </div>
            </Link>

            <Link
              href="/hr/statutory"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconTax size={18} />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  Statutory Rates
                </p>
                <p className="text-[11px] text-[var(--color-muted)]">
                  KWSP, PERKESO, EIS & PCB rules
                </p>
              </div>
            </Link>

            <Link
              href="/hr/overtime"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconClock size={18} />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  Overtime & Time Off
                </p>
                <p className="text-[11px] text-[var(--color-muted)]">
                  Overtime claims & compensatory hours
                </p>
              </div>
            </Link>

            <Link
              href="/hr/appraisals"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconAward size={18} />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  Appraisals
                </p>
                <p className="text-[11px] text-[var(--color-muted)]">
                  Performance evaluations & reviews
                </p>
              </div>
            </Link>

            <Link
              href="/hr/letters"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconLetters size={18} />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  HR Letters
                </p>
                <p className="text-[11px] text-[var(--color-muted)]">
                  Confirmation, appointment & templates
                </p>
              </div>
            </Link>

            <Link
              href="/hr/organisation"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconBuilding size={18} />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  Organisation Structure
                </p>
                <p className="text-[11px] text-[var(--color-muted)]">
                  Departments, hierarchy & cost centres
                </p>
              </div>
            </Link>

            <Link
              href="/hr/holidays"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconCalendar size={18} />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  Public Holidays
                </p>
                <p className="text-[11px] text-[var(--color-muted)]">
                  Federal and state gazetted rest days
                </p>
              </div>
            </Link>
          </div>
        </Panel>
      </div>
    </Shell>
  );
}
