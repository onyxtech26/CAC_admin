import { getDb } from "@cac/db";
import { listDepartments, listEmployees, listPositions, listWorkSchedules } from "@cac/core";
import { sql } from "drizzle-orm";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Badge, DataTable, EmptyState, Panel, Td } from "@/components/ui";
import { DepartmentForm, PositionForm, ScheduleForm } from "./OrganisationForms";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * The shape of the firm: departments, positions and working weeks.
 *
 * One page rather than three, because these are read together and rarely changed.
 * The work schedules matter more than they look — they are what the Phase 6
 * attendance engine reads to decide whether somebody was late, so a firm with no
 * schedule has no definition of lateness at all.
 */
export default async function OrganisationPage() {
  const principal = await requireCapability("hr.org.view");
  const db = await getDb();

  const [departments, positions, schedules, employees, centres] = await Promise.all([
    listDepartments(db, { includeInactive: true }),
    listPositions(db, { includeInactive: true }),
    listWorkSchedules(db, { includeInactive: true }),
    listEmployees(db, { limit: 1000 }),
    db.execute<{ id: string; code: string; name: string }>(
      sql`SELECT id, code, name FROM org.cost_centre WHERE is_active ORDER BY code`,
    ),
  ]);

  const canManage = principal.capabilities.has("hr.org.manage");
  const canSchedule = principal.capabilities.has("hr.schedule.manage");
  const costCentres = centres.rows ?? [];

  return (
    <Shell
      principal={principal}
      title="Organisation"
      breadcrumbs={[{ label: "Human resources" }, { label: "Organisation" }]}
    >
      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title={`Departments (${departments.length})`}>
            {departments.length === 0 ? (
              <EmptyState
                title="No departments yet"
                body="A department groups people and decides which cost centre their payroll is charged to."
              />
            ) : (
              <DataTable
                columns={["Code", "Name", "Sits under", "Cost centre", "Head", "People"]}
                caption="Departments"
              >
                {departments.map((row) => (
                  <tr key={row.id} className={row.isActive ? "" : "opacity-60"}>
                    <Td>
                      <span className="font-mono text-[12px]">{row.code}</span>
                    </Td>
                    <Td>
                      {row.name}
                      {!row.isActive && (
                        <span className="ml-1">
                          <Badge tone="neutral">closed</Badge>
                        </span>
                      )}
                    </Td>
                    <Td>{row.parentName ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                    <Td>
                      {row.costCentreCode ? (
                        <span className="font-mono text-[11px]">{row.costCentreCode}</span>
                      ) : (
                        <span className="text-[var(--color-faint)]">—</span>
                      )}
                    </Td>
                    <Td>{row.headName ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                    <Td numeric>{row.employeeCount}</Td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Panel>

          <Panel title={`Positions (${positions.length})`}>
            {positions.length === 0 ? (
              <EmptyState
                title="No positions yet"
                body="A position is the job, separate from the person holding it."
              />
            ) : (
              <DataTable
                columns={["Code", "Title", "Department", "Grade", "Held by"]}
                caption="Positions"
              >
                {positions.map((row) => (
                  <tr key={row.id} className={row.isActive ? "" : "opacity-60"}>
                    <Td>
                      <span className="font-mono text-[12px]">{row.code}</span>
                    </Td>
                    <Td>{row.title}</Td>
                    <Td>
                      {row.departmentName ?? <span className="text-[var(--color-faint)]">—</span>}
                    </Td>
                    <Td>{row.grade ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                    <Td numeric>{row.employeeCount}</Td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Panel>
        </div>

        <Panel
          title={`Work schedules (${schedules.length})`}
          description="What a normal week looks like, and therefore what counts as late."
        >
          {schedules.length === 0 ? (
            <EmptyState
              title="No schedules yet"
              body="Without one there is no definition of a normal day, so nothing can be late, early or extra."
            />
          ) : (
            <DataTable
              columns={["Code", "Name", "Days", "Hours", "Break", "Grace", "A day is", ""]}
              caption="Work schedules"
            >
              {schedules.map((row) => (
                <tr key={row.id} className={row.isActive ? "" : "opacity-60"}>
                  <Td>
                    <span className="font-mono text-[12px]">{row.code}</span>
                  </Td>
                  <Td>{row.name}</Td>
                  <Td>
                    <span className="text-[11px]">
                      {row.workDays.map((day) => DAY_NAMES[day]).join(" ")}
                    </span>
                  </Td>
                  <Td>
                    {row.startsAt}–{row.endsAt}
                    {row.crossesMidnight && (
                      <span className="ml-1 text-[10px] text-[var(--color-muted)]">next day</span>
                    )}
                  </Td>
                  <Td numeric>{row.breakMinutes}m</Td>
                  <Td numeric>{row.graceMinutes}m</Td>
                  <Td numeric>
                    {Math.floor(row.scheduledMinutes / 60)}h {row.scheduledMinutes % 60}m
                  </Td>
                  <Td>{row.isDefault ? <Badge tone="info">default</Badge> : ""}</Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>

        {(canManage || canSchedule) && (
          <div className="grid gap-4 lg:grid-cols-2">
            {canManage && (
              <>
                <Panel title="Add a department">
                  <DepartmentForm
                    departments={departments.map((row) => ({
                      id: row.id,
                      code: row.code,
                      name: row.name,
                    }))}
                    costCentres={costCentres}
                    employees={employees.map((row) => ({
                      id: row.id,
                      code: row.employeeNo,
                      name: row.fullName,
                    }))}
                  />
                </Panel>

                <Panel title="Add a position">
                  <PositionForm
                    departments={departments.map((row) => ({
                      id: row.id,
                      code: row.code,
                      name: row.name,
                    }))}
                  />
                </Panel>
              </>
            )}

            {canSchedule && (
              <div className="lg:col-span-2">
                <Panel title="Add a work schedule">
                  <ScheduleForm />
                </Panel>
              </div>
            )}
          </div>
        )}
      </div>
    </Shell>
  );
}
