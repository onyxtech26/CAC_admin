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
  IconBrainAI,
  IconFileCheck,
  IconLegalAI,
} from "@/components/icons";
import { OpenCaseForm } from "./CaseForms";

/**
 * CAC Legal AI & Property Forensics Command Center.
 *
 * Designed for property forensics, letters of administration and Malaysian estate matters:
 * - Intelligent rule engine (three-valued logic: satisfied, not satisfied, undecided)
 * - Legal AI Agent: zero-hallucination contradiction discovery & prerequisite unblocking
 * - Preparation packs & Court document assembly
 * - Interactive Legal AI matter workflow
 */
export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; type?: string; q?: string }>;
}) {
  const principal = await requireAnyCapability(["case.view", "case.view_all"]);
  const db = await getDb();
  const filters = await searchParams;

  const canOpen = principal.capabilities.has("case.create");

  const [cases, mine, approvedRules, employeesRes, customersRes] = await Promise.all([
    listCases(db, principal, {
      status: (filters.status as CaseStatus | "active" | undefined) ?? "active",
      matterType: filters.type as MatterType | undefined,
      search: filters.q,
    }),
    myCaseTasks(db, principal, 8).catch(() => []),
    listRequirementRules(db, { status: "approved" }),
    canOpen
      ? db
          .execute<{ id: string; full_name: string; employee_no: string }>(
            sql`SELECT id, full_name, employee_no FROM hr.employee WHERE status = 'active' ORDER BY full_name`,
          )
          .catch(() => ({ rows: [] }))
      : Promise.resolve({ rows: [] }),
    canOpen
      ? db
          .execute<{ id: string; name: string }>(
            sql`SELECT id, name FROM accounting.customer WHERE is_active ORDER BY name LIMIT 500`,
          )
          .catch(() => ({ rows: [] }))
      : Promise.resolve({ rows: [] }),
  ]);

  const employees = employeesRes.rows ?? [];
  const customers = customersRes.rows ?? [];

  const outstanding = cases.reduce((total, entry) => total + entry.outstandingRequirements, 0);
  const overdue = cases.reduce((total, entry) => total + entry.overdueTasks, 0);
  const undecided = cases.reduce((total, entry) => total + entry.undecidedRequirements, 0);

  return (
    <Shell
      principal={principal}
      title="Legal AI & Property Forensics"
      breadcrumbs={[{ label: "Cases & Legal AI" }]}
      currentSuite="legal"
      actions={
        <div className="flex items-center gap-2">
          {principal.capabilities.has("case.rule.view") && (
            <LinkButton href="/cases/rules">
              Questions & rules
            </LinkButton>
          )}
          {principal.capabilities.has("case.document.generate") && (
            <LinkButton href="/cases/templates">
              Document templates
            </LinkButton>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        {/* Approved Rules Alert */}
        {approvedRules.length === 0 && (
          <Alert tone="warn">
            <strong>No requirement rules have been approved yet.</strong> Checklists on estate matters
            are derived from facts against authoritative Malaysian probate rules signed off by named
            legal reviewers (Q-LEGAL-1, Q-LEGAL-2).{" "}
            {principal.capabilities.has("case.rule.view") && (
              <Link href="/cases/rules" className="underline font-semibold">
                Set up rules and questions
              </Link>
            )}
          </Alert>
        )}

        {/* Legal AI Key Stat Tiles */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Active estate matters"
            value={String(cases.length)}
            hint={`${outstanding} legal requirements total`}
          />
          <StatTile
            label="Requirements outstanding"
            value={String(outstanding)}
            hint="Checklist prerequisites remaining"
            tone="neutral"
          />
          <StatTile
            label="Undecided requirements"
            value={String(undecided)}
            hint="Blocked until client answers intake questions"
            tone={undecided > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Tasks overdue"
            value={String(overdue)}
            hint={overdue > 0 ? "Requires urgent attention" : "All deadlines on track"}
            tone={overdue > 0 ? "danger" : "ok"}
          />
        </div>

        {/* Legal AI Capability Highlights */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3.5 space-y-1 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs">
            <div className="flex items-center gap-2 text-[var(--color-gold-2)]">
              <IconBrainAI size={18} />
              <h4 className="text-[13px] font-semibold text-[var(--color-ivory)]">
                AI Contradiction Agent
              </h4>
            </div>
            <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed">
              Discovers discrepancies between death certificates, family trees, and land titles with exact citations.
            </p>
          </div>

          <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3.5 space-y-1 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs">
            <div className="flex items-center gap-2 text-[var(--color-info)]">
              <IconLegalAI size={18} />
              <h4 className="text-[13px] font-semibold text-[var(--color-ivory)]">
                Statutory Rule Engine
              </h4>
            </div>
            <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed">
              Malaysian probate compliance (Probate and Administration Act 1959, Distribution Act 1958) verified by named reviewers.
            </p>
          </div>

          <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3.5 space-y-1 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs">
            <div className="flex items-center gap-2 text-[var(--color-ok)]">
              <IconFileCheck size={18} />
              <h4 className="text-[13px] font-semibold text-[var(--color-ivory)]">
                Preparation Pack Generator
              </h4>
            </div>
            <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed">
              Bundles complete court evidence packs, affidavits, and asset schedules ready for filing.
            </p>
          </div>
        </div>

        {/* Visual Process Flowchart */}
        <WorkflowNavigator defaultTab="legal" />

        {/* Assigned tasks */}
        {mine.length > 0 && (
          <Panel
            title="My Assigned Case Tasks"
            description="Active checklist items assigned to you across all matters."
          >
            <DataTable columns={["Matter", "Task Description", "Due Date", "Priority"]} caption="My case tasks">
              {mine.map((task) => (
                <tr key={task.id}>
                  <Td>
                    <Link
                      href={`/cases/${task.caseId}/checklist`}
                      className="font-mono text-[12px] text-[var(--color-gold-2)] hover:underline"
                    >
                      {task.caseNo}
                    </Link>
                  </Td>
                  <Td>{task.title}</Td>
                  <Td>
                    {task.dueOn ? (
                      <span className={task.overdue ? "text-[var(--color-danger)] font-medium" : ""}>
                        {formatDate(task.dueOn)}
                      </span>
                    ) : (
                      <span className="text-[var(--color-faint)]">—</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={task.priority === "urgent" ? "danger" : "neutral"}>
                      {task.priority}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </DataTable>
          </Panel>
        )}

        {/* Matters Directory & Search */}
        <Panel title={`Estate & Probate Matters (${cases.length})`}>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-2.5">
            <div>
              <label htmlFor="q" className="block text-[11px] text-[var(--color-muted)] mb-1">
                Search
              </label>
              <input
                id="q"
                name="q"
                defaultValue={filters.q ?? ""}
                placeholder="Case number, deceased name, or title"
                className="control w-64"
              />
            </div>
            <div>
              <label htmlFor="status" className="block text-[11px] text-[var(--color-muted)] mb-1">
                Status
              </label>
              <select
                id="status"
                name="status"
                defaultValue={filters.status ?? "active"}
                className="control w-36"
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
              <label htmlFor="type" className="block text-[11px] text-[var(--color-muted)] mb-1">
                Matter Type
              </label>
              <select
                id="type"
                name="type"
                defaultValue={filters.type ?? ""}
                className="control w-48"
              >
                <option value="">All Types</option>
                {MATTER_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="btn btn-secondary px-3 py-1.5 text-[12.5px] cursor-pointer"
            >
              Filter
            </button>
          </form>

          {cases.length === 0 ? (
            <EmptyState
              title="No estate matters found"
              body={
                principal.capabilities.has("case.view_all")
                  ? "No matters match your filter criteria. Open a new matter below or adjust search."
                  : "You are not assigned to any matching matters."
              }
            />
          ) : (
            <DataTable
              columns={[
                "Case No",
                "Matter Title",
                "Deceased",
                "Status",
                "Lead Counsel",
                "Unresolved",
                "Tasks",
                "AI Agent",
              ]}
              caption="Estate matters"
            >
              {cases.map((entry) => (
                <tr key={entry.id}>
                  <Td>
                    <Link
                      href={`/cases/${entry.id}`}
                      className="font-mono text-[12px] text-[var(--color-gold-2)] hover:underline"
                    >
                      {entry.caseNo}
                    </Link>
                  </Td>
                  <Td>
                    <span className="font-medium text-[var(--color-body)]">{entry.title}</span>
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
                        className="ml-1 text-[11px] text-[var(--color-warn)] font-medium"
                        title="Waiting on unanswered intake question"
                      >
                        ({entry.undecidedRequirements}?)
                      </span>
                    )}
                  </Td>
                  <Td numeric>
                    {entry.openTasks}
                    {entry.overdueTasks > 0 && (
                      <span className="ml-1 text-[11px] text-[var(--color-danger)] font-medium">
                        ({entry.overdueTasks} late)
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Link
                      href={`/cases/${entry.id}/agent`}
                      className="inline-flex items-center gap-1 rounded bg-[rgba(233,199,102,0.12)] border border-[var(--color-line-strong)] px-2 py-0.5 text-[11px] text-[var(--color-gold-2)] hover:bg-[rgba(233,199,102,0.22)] transition"
                    >
                      <IconBrainAI size={12} />
                      <span>Review</span>
                    </Link>
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>

        {/* Open Matter Form */}
        {canOpen && (
          <Panel
            title="Open a New Estate Matter"
            description="Record client instructions and estate facts. The requirement checklist generates automatically from rules."
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
