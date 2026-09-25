import Link from "next/link";
import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import {
  MATTER_TYPES,
  formatDate,
  listCases,
  listRequirementRules,
  myCaseTasks,
  toIsoDate,
  today,
  type CaseStatus,
  type MatterType,
} from "@cac/core";
import { requireAnyCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, LinkButton, Panel, StatTile, Td } from "@/components/ui";
import { OpenCaseForm } from "./CaseForms";

/**
 * Estate matters.
 *
 * Scoped in the data layer: somebody with `case.view` sees the matters they are
 * assigned to, and somebody with `case.view_all` sees all of them. There is no filter
 * that changes that, and no list of the ones they cannot open.
 */
export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; type?: string; q?: string }>;
}) {
  const principal = await requireAnyCapability(["case.view", "case.view_all"]);
  const db = await getDb();
  const filters = await searchParams;

  const [cases, mine, approvedRules] = await Promise.all([
    listCases(db, principal, {
      status: (filters.status as CaseStatus | "active" | undefined) ?? "active",
      matterType: filters.type as MatterType | undefined,
      search: filters.q,
    }),
    myCaseTasks(db, principal, 8).catch(() => []),
    listRequirementRules(db, { status: "approved" }),
  ]);

  const canOpen = principal.capabilities.has("case.create");

  const employees = canOpen
    ? (
        await db.execute<{ id: string; full_name: string; employee_no: string }>(sql`
          SELECT id, full_name, employee_no FROM hr.employee
           WHERE status = 'active' ORDER BY full_name
        `)
      ).rows ?? []
    : [];
  const customers = canOpen
    ? (
        await db.execute<{ id: string; name: string }>(sql`
          SELECT id, name FROM accounting.customer WHERE is_active ORDER BY name LIMIT 500
        `)
      ).rows ?? []
    : [];

  const outstanding = cases.reduce((total, entry) => total + entry.outstandingRequirements, 0);
  const overdue = cases.reduce((total, entry) => total + entry.overdueTasks, 0);
  const undecided = cases.reduce((total, entry) => total + entry.undecidedRequirements, 0);

  return (
    <Shell
      principal={principal}
      title="Estate matters"
      breadcrumbs={[{ label: "Cases" }]}
      actions={
        principal.capabilities.has("case.rule.view") ? (
          <LinkButton href="/cases/rules">Questions and rules</LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {approvedRules.length === 0 && (
          <Alert tone="warn">
            No requirement rule has been approved yet, so no matter has a checklist. Checklists
            here are built from the facts of a case against rules that name their authority and
            are approved by somebody qualified to approve them — this platform does not supply
            Malaysian probate requirements from general knowledge (Q-LEGAL-1, Q-LEGAL-2).{" "}
            {principal.capabilities.has("case.rule.view") && (
              <Link href="/cases/rules" className="underline">
                Questions and rules
              </Link>
            )}
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Matters shown" value={String(cases.length)} />
          <StatTile label="Requirements outstanding" value={String(outstanding)} />
          <StatTile
            label="Waiting on an answer"
            value={String(undecided)}
            hint="Requirements that cannot be decided until an intake question is answered."
          />
          <StatTile
            label="Tasks overdue"
            value={String(overdue)}
            tone={overdue > 0 ? "danger" : undefined}
          />
        </div>

        {mine.length > 0 && (
          <Panel title="Your case work" description="Across every matter you are assigned to.">
            <DataTable columns={["Matter", "What", "Due", "Priority"]} caption="My case tasks">
              {mine.map((task) => (
                <tr key={task.id}>
                  <Td>
                    <Link
                      href={`/cases/${task.caseId}/checklist`}
                      className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                    >
                      {task.caseNo}
                    </Link>
                  </Td>
                  <Td>{task.title}</Td>
                  <Td>
                    {task.dueOn ? (
                      <span className={task.overdue ? "text-[var(--color-danger)]" : ""}>
                        {formatDate(task.dueOn)}
                      </span>
                    ) : (
                      <span className="text-[var(--color-faint)]">—</span>
                    )}
                  </Td>
                  <Td>{task.priority}</Td>
                </tr>
              ))}
            </DataTable>
          </Panel>
        )}

        <Panel title={`Matters (${cases.length})`}>
          <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="q" className="block text-[11px] text-[var(--color-muted)]">
                Search
              </label>
              <input
                id="q"
                name="q"
                defaultValue={filters.q ?? ""}
                placeholder="Case number, title, name, court reference"
                className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[13px]"
              />
            </div>
            <div>
              <label htmlFor="status" className="block text-[11px] text-[var(--color-muted)]">
                Status
              </label>
              <select
                id="status"
                name="status"
                defaultValue={filters.status ?? "active"}
                className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[13px]"
              >
                <option value="active">Live matters</option>
                <option value="intake">Intake</option>
                <option value="open">Open</option>
                <option value="on_hold">On hold</option>
                <option value="closed">Closed</option>
                <option value="withdrawn">Withdrawn</option>
              </select>
            </div>
            <div>
              <label htmlFor="type" className="block text-[11px] text-[var(--color-muted)]">
                Kind
              </label>
              <select
                id="type"
                name="type"
                defaultValue={filters.type ?? ""}
                className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[13px]"
              >
                <option value="">Any</option>
                {MATTER_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="rounded-md border border-[var(--color-line-strong)] px-3 py-1.5 text-[13px]"
            >
              Filter
            </button>
          </form>

          {cases.length === 0 ? (
            <EmptyState
              title="No matters here"
              body={
                principal.capabilities.has("case.view_all")
                  ? "Nothing matches. Open one below, or widen the filter."
                  : "You are not assigned to any matter that matches. Estate matters are visible to the people working on them."
              }
            />
          ) : (
            <DataTable
              columns={[
                "Case",
                "Matter",
                "Deceased",
                "Status",
                "Lead",
                "Outstanding",
                "Tasks",
                "Opened",
              ]}
              caption="Estate matters"
            >
              {cases.map((entry) => (
                <tr key={entry.id}>
                  <Td>
                    <Link
                      href={`/cases/${entry.id}`}
                      className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                    >
                      {entry.caseNo}
                    </Link>
                  </Td>
                  <Td>
                    {entry.title}
                    <span className="block text-[11px] text-[var(--color-muted)]">
                      {MATTER_TYPES.find((type) => type.value === entry.matterType)?.label ??
                        entry.matterType}
                    </span>
                  </Td>
                  <Td>
                    {entry.deceasedName}
                    {entry.dateOfDeath && (
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        died {formatDate(entry.dateOfDeath)}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        entry.status === "closed"
                          ? "ok"
                          : entry.status === "withdrawn"
                            ? "neutral"
                            : entry.status === "on_hold"
                              ? "warn"
                              : "info"
                      }
                    >
                      {entry.status.replace("_", " ")}
                    </Badge>
                  </Td>
                  <Td>{entry.leadName ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
                  <Td numeric>
                    {entry.outstandingRequirements}
                    {entry.undecidedRequirements > 0 && (
                      <span
                        className="ml-1 text-[11px] text-[var(--color-warn)]"
                        title="Waiting on an unanswered intake question"
                      >
                        ({entry.undecidedRequirements}?)
                      </span>
                    )}
                  </Td>
                  <Td numeric>
                    {entry.openTasks}
                    {entry.overdueTasks > 0 && (
                      <span className="ml-1 text-[11px] text-[var(--color-danger)]">
                        ({entry.overdueTasks} late)
                      </span>
                    )}
                  </Td>
                  <Td>{formatDate(entry.openedOn)}</Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>

        {canOpen && (
          <Panel
            title="Open a matter"
            description="Intake. The checklist comes afterwards, from the facts you record."
          >
            <OpenCaseForm
              matterTypes={MATTER_TYPES.map((type) => ({ value: type.value, label: type.label }))}
              employees={employees.map((employee) => ({
                value: employee.id,
                label: `${employee.full_name} (${employee.employee_no})`,
              }))}
              customers={customers.map((customer) => ({
                value: customer.id,
                label: customer.name,
              }))}
              today={toIsoDate(today())}
            />
          </Panel>
        )}
      </div>
    </Shell>
  );
}
