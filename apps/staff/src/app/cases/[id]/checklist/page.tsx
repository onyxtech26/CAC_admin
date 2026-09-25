import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import {
  formatDate,
  getCase,
  listCaseFacts,
  listDocuments,
  listRequirements,
  listTasks,
} from "@cac/core";
import { requireAnyCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, LinkButton, Panel, StatTile, Td } from "@/components/ui";
import {
  AddRequirementForm,
  RebuildChecklistForm,
  RequirementControls,
  TaskControls,
  TaskForm,
} from "../../CaseForms";
import { CaseTabs } from "../CaseTabs";

const STATUS_TONE = {
  outstanding: "warn",
  in_progress: "info",
  satisfied: "ok",
  waived: "info",
  not_applicable: "neutral",
} as const;

/**
 * The checklist, and the work coming off it.
 *
 * Every item says where it came from: a rule with its code, version and authority, or
 * "added by hand" with none. That distinction is the point — a legal requirement enters
 * this platform only through an approved rule, and an item somebody typed in carries no
 * authority of its own.
 *
 * Items flagged as waiting on an unanswered question are shown as such rather than
 * hidden. A short checklist must mean little is required, never that nobody asked.
 */
export default async function ChecklistPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireAnyCapability(["case.view", "case.view_all"]);
  const { id } = await params;
  const db = await getDb();

  const record = await getCase(db, principal, id);
  if (!record) notFound();

  const canSeeDocuments = principal.capabilities.has("case.document.view");
  const canSeeTasks = principal.capabilities.has("case.task.view");

  const [requirements, documents, tasks, facts] = await Promise.all([
    listRequirements(db, principal, id),
    canSeeDocuments ? listDocuments(db, principal, id) : Promise.resolve([]),
    canSeeTasks ? listTasks(db, principal, id) : Promise.resolve([]),
    listCaseFacts(db, principal, id),
  ]);

  const canManage = principal.capabilities.has("case.checklist.manage");
  const canManageTasks = principal.capabilities.has("case.task.manage");
  const closed = record.status === "closed" || record.status === "withdrawn";
  const labels = new Map(facts.map((fact) => [fact.factKey, fact.label]));

  const employees = canManageTasks
    ? (
        await db.execute<{ id: string; full_name: string }>(sql`
          SELECT id, full_name FROM hr.employee WHERE status = 'active' ORDER BY full_name
        `)
      ).rows ?? []
    : [];

  const open = requirements.filter(
    (item) => item.status === "outstanding" || item.status === "in_progress",
  );
  const settled = requirements.filter(
    (item) => item.status === "satisfied" || item.status === "waived",
  );
  const fallenAway = requirements.filter((item) => item.status === "not_applicable");
  const waiting = open.filter((item) => item.undecidedFacts.length > 0);
  const liveTasks = tasks.filter((task) => task.status !== "done" && task.status !== "cancelled");

  const documentOptions = documents.map((document) => ({
    value: document.id,
    label: document.title,
  }));

  return (
    <Shell
      principal={principal}
      title={`${record.caseNo} — checklist`}
      breadcrumbs={[
        { label: "Cases", href: "/cases" },
        { label: record.caseNo, href: `/cases/${id}` },
        { label: "Checklist" },
      ]}
      actions={<LinkButton href={`/cases/${id}/intake`}>Intake</LinkButton>}
    >
      <div className="space-y-4">
        <CaseTabs caseId={id} active="checklist" />

        {requirements.length === 0 && (
          <Alert tone="warn">
            Nothing on the checklist. Either no requirement rule has been approved for this kind of
            matter, or the checklist has not been built from the facts yet. This platform does not
            supply Malaysian probate requirements from general knowledge — they are entered as
            rules, with their authority, and approved by somebody qualified to approve them
            (Q-LEGAL-1, Q-LEGAL-2).
          </Alert>
        )}

        {waiting.length > 0 && (
          <Alert tone="warn">
            {waiting.length} item{waiting.length === 1 ? "" : "s"} cannot be decided until an intake
            question is answered, and stay here flagged rather than falling off the list.{" "}
            <Link href={`/cases/${id}/intake`} className="underline">
              Answer the questions
            </Link>
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-4">
          <StatTile label="Outstanding" value={String(open.length)} />
          <StatTile
            label="Waiting on an answer"
            value={String(waiting.length)}
            hint={waiting.length > 0 ? "Undecidable on the facts recorded" : undefined}
            tone="warn"
          />
          <StatTile label="Dealt with" value={String(settled.length)} />
          <StatTile label="No longer applicable" value={String(fallenAway.length)} />
        </div>

        <Panel
          title={`Outstanding (${open.length})`}
          description="What this matter still needs, and where each item came from."
        >
          {open.length === 0 ? (
            <EmptyState title="Nothing outstanding" />
          ) : (
            <div className="space-y-4">
              {open.map((item) => (
                <div
                  key={item.id}
                  className="grid gap-3 border-b border-[var(--color-line)] pb-4 last:border-0 last:pb-0 sm:grid-cols-[1fr_200px]"
                >
                  <div>
                    <p className="text-[13px] font-medium">
                      {item.title}
                      <Badge tone={STATUS_TONE[item.status]}>{item.status.replace("_", " ")}</Badge>
                    </p>
                    {item.detail && (
                      <p className="mt-1 text-[12px] text-[var(--color-muted)]">{item.detail}</p>
                    )}
                    <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                      {item.fromRule ? (
                        <>
                          From rule{" "}
                          <span className="font-mono">
                            {item.ruleCode} v{item.ruleVersion}
                          </span>{" "}
                          · authority: {item.sourceRef}
                        </>
                      ) : (
                        <>
                          Added by hand
                          {item.sourceRef ? ` · reference: ${item.sourceRef}` : " · no authority recorded"}
                        </>
                      )}
                      {" · "}
                      {item.kind}
                      {item.dueOn ? ` · due ${formatDate(item.dueOn)}` : ""}
                    </p>
                    {item.undecidedFacts.length > 0 && (
                      <p className="mt-1 text-[11px] text-[var(--color-warn)]">
                        Cannot be decided until:{" "}
                        {item.undecidedFacts.map((key) => labels.get(key) ?? key).join(", ")}
                      </p>
                    )}
                  </div>
                  {canManage && !closed && (
                    <RequirementControls
                      caseId={id}
                      requirementId={item.id}
                      status={item.status}
                      kind={item.kind}
                      documents={documentOptions}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>

        {settled.length > 0 && (
          <Panel title={`Dealt with (${settled.length})`}>
            <DataTable
              columns={["What", "How", "By", "Rule", ""]}
              caption="Requirements dealt with"
            >
              {settled.map((item) => (
                <tr key={item.id}>
                  <Td>{item.title}</Td>
                  <Td>
                    {item.status === "satisfied" ? (
                      <>
                        <Badge tone="ok">satisfied</Badge>
                        {item.documentTitle && (
                          <span className="ml-1 text-[11px] text-[var(--color-muted)]">
                            {item.documentTitle}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <Badge tone="info">waived</Badge>
                        <span className="ml-1 text-[11px] text-[var(--color-muted)]">
                          {item.waiveReason}
                        </span>
                      </>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[11px]">
                      {item.satisfiedByName ?? item.waivedByName ?? "—"}
                    </span>
                  </Td>
                  <Td>
                    {item.ruleCode ? (
                      <span className="font-mono text-[11px]">
                        {item.ruleCode} v{item.ruleVersion}
                      </span>
                    ) : (
                      <span className="text-[var(--color-faint)]">by hand</span>
                    )}
                  </Td>
                  <Td>
                    {canManage && !closed && (
                      <RequirementControls
                        caseId={id}
                        requirementId={item.id}
                        status={item.status}
                        kind={item.kind}
                        documents={documentOptions}
                      />
                    )}
                  </Td>
                </tr>
              ))}
            </DataTable>
          </Panel>
        )}

        {fallenAway.length > 0 && (
          <Panel
            title={`No longer applicable (${fallenAway.length})`}
            description="Kept on the file with the reason they fell away, because “this used to be on the list” is a question that gets asked."
          >
            <DataTable columns={["What", "Why it fell away", "Rule"]} caption="Items no longer applicable">
              {fallenAway.map((item) => (
                <tr key={item.id} className="opacity-70">
                  <Td>{item.title}</Td>
                  <Td>{item.droppedReason}</Td>
                  <Td>
                    {item.ruleCode ? (
                      <span className="font-mono text-[11px]">
                        {item.ruleCode} v{item.ruleVersion}
                      </span>
                    ) : (
                      <span className="text-[var(--color-faint)]">by hand</span>
                    )}
                  </Td>
                </tr>
              ))}
            </DataTable>
          </Panel>
        )}

        {canSeeTasks && (
          <Panel
            title={`Tasks (${liveTasks.length} open)`}
            description="A requirement is what the matter needs; a task is what somebody is doing about it."
          >
            {tasks.length === 0 ? (
              <EmptyState title="No tasks yet" />
            ) : (
              <DataTable
                columns={["What", "Who", "Due", "Priority", "Status", ""]}
                caption="Case tasks"
              >
                {tasks.map((task) => (
                  <tr
                    key={task.id}
                    className={task.status === "cancelled" || task.status === "done" ? "opacity-70" : ""}
                  >
                    <Td>
                      {task.title}
                      {task.requirementTitle && (
                        <span className="block text-[11px] text-[var(--color-muted)]">
                          for: {task.requirementTitle}
                        </span>
                      )}
                      {task.blockedReason && (
                        <span className="block text-[11px] text-[var(--color-warn)]">
                          blocked: {task.blockedReason}
                        </span>
                      )}
                      {task.cancelReason && (
                        <span className="block text-[11px] text-[var(--color-muted)]">
                          cancelled: {task.cancelReason}
                        </span>
                      )}
                    </Td>
                    <Td>{task.assigneeName ?? <span className="text-[var(--color-faint)]">—</span>}</Td>
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
                    <Td>
                      <Badge
                        tone={
                          task.status === "done"
                            ? "ok"
                            : task.status === "blocked"
                              ? "danger"
                              : task.status === "cancelled"
                                ? "neutral"
                                : "info"
                        }
                      >
                        {task.status.replace("_", " ")}
                      </Badge>
                    </Td>
                    <Td>
                      {!closed && task.status !== "done" && task.status !== "cancelled" && (
                        <TaskControls
                          caseId={id}
                          taskId={task.id}
                          canManage={canManageTasks}
                          canComplete={
                            canManageTasks ||
                            (principal.employeeId !== null && principal.employeeId === task.assigneeId)
                          }
                        />
                      )}
                    </Td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Panel>
        )}

        {canManageTasks && !closed && (
          <Panel title="Assign a task">
            <TaskForm
              caseId={id}
              employees={employees.map((employee) => ({
                value: employee.id,
                label: employee.full_name,
              }))}
              requirements={open.map((item) => ({ value: item.id, label: item.title }))}
            />
          </Panel>
        )}

        {canManage && !closed && (
          <>
            <Panel
              title="Add an item by hand"
              description="For work no rule anticipated. It carries no authority of its own — a legal requirement belongs in an approved rule."
            >
              <AddRequirementForm caseId={id} />
            </Panel>
            <Panel title="Rebuild from the facts">
              <RebuildChecklistForm caseId={id} />
            </Panel>
          </>
        )}
      </div>
    </Shell>
  );
}
