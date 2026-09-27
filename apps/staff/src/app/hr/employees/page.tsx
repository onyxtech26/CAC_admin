import Link from "next/link";
import { getDb } from "@cac/db";
import { formatDate, listDepartments, listEmployees, today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Badge, DataTable, EmptyState, LinkButton, Panel, StatTile, Td } from "@/components/ui";

const TONE = {
  active: "ok",
  on_leave: "info",
  suspended: "warn",
  resigned: "neutral",
  terminated: "danger",
} as const;

const LABEL: Record<string, string> = {
  active: "Active",
  on_leave: "On leave",
  suspended: "Suspended",
  resigned: "Resigned",
  terminated: "Terminated",
};

/**
 * The staff list.
 *
 * Two numbers at the top are the ones that prompt action: probations that have
 * ended without a confirmation, and people the attendance device does not know
 * about. Both are quiet failures otherwise — one means somebody is still formally
 * on probation months later, the other means their attendance silently never
 * arrives.
 */
export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; department?: string; all?: string }>;
}) {
  const principal = await requireCapability("hr.employee.view");
  const query = await searchParams;
  const db = await getDb();

  const [employees, departments] = await Promise.all([
    listEmployees(db, {
      search: query.q,
      status: (query.status as "active") || undefined,
      departmentId: query.department,
      includeLeavers: query.all === "1",
      limit: 1000,
    }),
    listDepartments(db),
  ]);

  const now = toIsoDate(today());
  const overdueConfirmation = employees.filter(
    (row) =>
      row.status === "active" &&
      !row.confirmedOn &&
      row.probationEndsOn !== null &&
      row.probationEndsOn < now,
  );
  const unmapped = employees.filter((row) => row.status === "active" && !row.deviceUserId);

  return (
    <Shell
      principal={principal}
      title="Employees"
      breadcrumbs={[{ label: "Human resources" }, { label: "Employees" }]}
      actions={
        principal.capabilities.has("hr.employee.create") ? (
          <LinkButton href="/hr/employees/new" variant="primary">
            Add an employee
          </LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="On the books"
            value={String(employees.filter((row) => row.status !== "resigned" && row.status !== "terminated").length)}
            hint={`across ${departments.length} department${departments.length === 1 ? "" : "s"}`}
          />
          <StatTile
            label="Probation ended, not confirmed"
            value={String(overdueConfirmation.length)}
            hint={
              overdueConfirmation.length > 0
                ? overdueConfirmation
                    .slice(0, 3)
                    .map((row) => row.fullName)
                    .join(", ")
                : "nothing outstanding"
            }
            tone={overdueConfirmation.length > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Not known to the device"
            value={String(unmapped.length)}
            hint={
              unmapped.length > 0
                ? "their scans cannot be matched to them"
                : "every active employee is mapped"
            }
            tone={unmapped.length > 0 ? "warn" : "ok"}
          />
        </div>

        <Panel title="Filter">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="q" className="block text-[12px] font-medium">
                Name, number or last four of the identity card
              </label>
              <input
                id="q"
                name="q"
                defaultValue={query.q ?? ""}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[13px]"
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
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[13px]"
              >
                <option value="">All</option>
                {departments.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 pb-2 text-[13px]">
              <input type="checkbox" name="all" value="1" defaultChecked={query.all === "1"} />
              Include people who have left
            </label>
            <button
              type="submit"
              className="btn btn-primary px-3 py-2 text-[13px]"
            >
              Apply
            </button>
            <Link href="/hr/employees" className="pb-2 text-[12px] text-[var(--color-info)]">
              Clear
            </Link>
          </form>
        </Panel>

        <Panel title={`${employees.length} ${employees.length === 1 ? "person" : "people"}`}>
          {employees.length === 0 ? (
            <EmptyState
              title="Nobody matches"
              body="Change the filter, or add an employee."
              action={
                principal.capabilities.has("hr.employee.create") ? (
                  <LinkButton href="/hr/employees/new" variant="primary">
                    Add an employee
                  </LinkButton>
                ) : undefined
              }
            />
          ) : (
            <DataTable
              columns={["Number", "Name", "Position", "Department", "Joined", "Device", "Status"]}
              caption="Employees"
            >
              {employees.map((employee) => (
                <tr key={employee.id}>
                  <Td>
                    <Link
                      href={`/hr/employees/${employee.id}`}
                      className="font-mono text-[12px] text-[var(--color-link)] hover:underline"
                    >
                      {employee.employeeNo}
                    </Link>
                  </Td>
                  <Td>
                    {employee.fullName}
                    {employee.nricLast4 && (
                      <span className="ml-1 font-mono text-[10px] text-[var(--color-faint)]">
                        ···{employee.nricLast4}
                      </span>
                    )}
                    {employee.preferredName && (
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        known as {employee.preferredName}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {employee.positionTitle ?? <span className="text-[var(--color-faint)]">—</span>}
                  </Td>
                  <Td>
                    {employee.departmentName ?? <span className="text-[var(--color-faint)]">—</span>}
                  </Td>
                  <Td>{formatDate(employee.joinedOn)}</Td>
                  <Td>
                    {employee.deviceUserId ? (
                      <span className="font-mono text-[11px]">{employee.deviceUserId}</span>
                    ) : employee.status === "active" ? (
                      <Badge tone="warn">not mapped</Badge>
                    ) : (
                      <span className="text-[var(--color-faint)]">—</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={TONE[employee.status]}>{LABEL[employee.status]}</Badge>
                    {employee.status === "active" &&
                      !employee.confirmedOn &&
                      employee.probationEndsOn !== null &&
                      employee.probationEndsOn < now && (
                        <span className="ml-1">
                          <Badge tone="warn">confirmation due</Badge>
                        </span>
                      )}
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
