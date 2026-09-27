import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import {
  MATTER_TYPES,
  describePosition,
  estatePosition,
  formatAmount,
  formatDate,
  getCase,
  listCaseEvents,
  listRequirements,
  listTasks,
  toIsoDate,
  today,
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
import {
  AssignForm,
  CloseCaseForm,
  EditCaseForm,
  MilestoneForm,
  ReopenCaseForm,
  UnassignButton,
} from "../CaseForms";
import { CaseTabs } from "./CaseTabs";

/**
 * One matter.
 *
 * The overview: what it is, who is on it, where the estate stands, and what has
 * happened. The working screens — intake, the checklist, the file — are separate pages
 * because they are separate jobs, and this page links to them rather than becoming all
 * of them at once.
 */
export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireAnyCapability(["case.view", "case.view_all"]);
  const { id } = await params;
  const db = await getDb();

  const record = await getCase(db, principal, id);
  if (!record) notFound();

  const [position, requirements, tasks, events] = await Promise.all([
    estatePosition(db, principal, id),
    listRequirements(db, principal, id),
    principal.capabilities.has("case.task.view")
      ? listTasks(db, principal, id)
      : Promise.resolve([]),
    listCaseEvents(db, principal, id, 25),
  ]);

  const canEdit = principal.capabilities.has("case.edit");
  const canAssign = principal.capabilities.has("case.assign");
  const canClose = principal.capabilities.has("case.close");
  const closed = record.status === "closed" || record.status === "withdrawn";

  const employees = canAssign
    ? (
        await db.execute<{ id: string; full_name: string; employee_no: string }>(sql`
          SELECT id, full_name, employee_no FROM hr.employee
           WHERE status = 'active' ORDER BY full_name
        `)
      ).rows ?? []
    : [];

  const outstanding = requirements.filter(
    (item) => item.status === "outstanding" || item.status === "in_progress",
  );
  const waiting = outstanding.filter((item) => item.undecidedFacts.length > 0);
  const openTasks = tasks.filter((task) => task.status !== "done" && task.status !== "cancelled");

  return (
    <Shell
      principal={principal}
      title={record.caseNo}
      breadcrumbs={[
        { label: "Cases", href: "/cases" },
        { label: record.caseNo },
      ]}
      actions={
        <div className="flex gap-2">
          <LinkButton href={`/cases/${id}/intake`}>Intake</LinkButton>
          <LinkButton href={`/cases/${id}/checklist`} variant="primary">
            Checklist
          </LinkButton>
        </div>
      }
    >
      <div className="space-y-4">
        <CaseTabs caseId={id} active="overview" />

        {closed && (
          <Alert tone={record.status === "closed" ? "ok" : "neutral"}>
            This matter is {record.status}
            {record.closedOn ? ` as at ${formatDate(record.closedOn)}` : ""}.{" "}
            {record.closeReason}
            {" — nothing can be written to the file until it is reopened."}
          </Alert>
        )}

        {waiting.length > 0 && (
          <Alert tone="warn">
            {waiting.length} requirement{waiting.length === 1 ? "" : "s"} cannot be decided until an
            intake question is answered. They stay on the checklist, flagged, rather than dropping
            off it.{" "}
            <Link href={`/cases/${id}/intake`} className="underline">
              Answer the questions
            </Link>
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Assets recorded"
            value={`RM ${formatAmount(position.assetTotal)}`}
            hint={
              position.assetsUnvalued > 0
                ? `${position.assetsUnvalued} with no figure yet`
                : undefined
            }
            tone="warn"
          />
          <StatTile
            label="Liabilities recorded"
            value={`RM ${formatAmount(position.liabilityTotal)}`}
            hint={
              position.liabilitiesUnvalued > 0
                ? `${position.liabilitiesUnvalued} with no figure yet`
                : undefined
            }
            tone="warn"
          />
          <StatTile label="Net, so far" value={`RM ${formatAmount(position.net)}`} />
          <StatTile
            label="Outstanding requirements"
            value={String(outstanding.length)}
            hint={openTasks.length > 0 ? `${openTasks.length} task(s) open` : undefined}
          />
        </div>

        <Alert tone={position.incomplete ? "warn" : "info"}>{describePosition(position)}</Alert>

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Panel title={record.title}>
              <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
                <Row label="Kind of matter">
                  {MATTER_TYPES.find((type) => type.value === record.matterType)?.label ??
                    record.matterType}
                </Row>
                <Row label="Status">
                  <Badge
                    tone={
                      record.status === "closed"
                        ? "ok"
                        : record.status === "on_hold"
                          ? "warn"
                          : "info"
                    }
                  >
                    {record.status.replace("_", " ")}
                  </Badge>
                </Row>
                <Row label="Deceased">
                  {record.deceasedName}
                  {record.deceasedIdLast4 && (
                    <span className="ml-1 font-mono text-[11px] text-[var(--color-muted)]">
                      ···{record.deceasedIdLast4}
                    </span>
                  )}
                </Row>
                <Row label="Date of death">
                  {record.dateOfDeath ? formatDate(record.dateOfDeath) : "—"}
                </Row>
                <Row label="Registered at">{record.placeOfDeath ?? "—"}</Row>
                <Row label="State">{record.domicileState ?? "—"}</Row>
                <Row label="Opened">{formatDate(record.openedOn)}</Row>
                <Row label="Target">{record.targetOn ? formatDate(record.targetOn) : "—"}</Row>
                <Row label="Court reference">{record.courtReference ?? "—"}</Row>
                <Row label="Registry">{record.registry ?? "—"}</Row>
                <Row label="Instructed by">{record.instructedBy ?? "—"}</Row>
                <Row label="Client">
                  {record.customerName ? (
                    <Link
                      href={`/accounting/customers`}
                      className="text-[var(--color-link)] hover:underline"
                    >
                      {record.customerName}
                    </Link>
                  ) : (
                    "not linked"
                  )}
                </Row>
                <Row label="Engagement">{record.engagementRef ?? "—"}</Row>
              </dl>
              {record.notes && (
                <p className="mt-3 whitespace-pre-wrap border-t border-[var(--color-line)] pt-3 text-[12px] text-[var(--color-muted)]">
                  {record.notes}
                </p>
              )}
            </Panel>

            <Panel
              title="What has happened"
              description="The matter's own history — append-only, and separate from the audit trail."
              action={<LinkButton href={`/cases/${id}/timeline`}>All of it</LinkButton>}
            >
              {events.length === 0 ? (
                <EmptyState title="Nothing recorded yet" />
              ) : (
                <ol className="space-y-3">
                  {events.slice(0, 10).map((event) => (
                    <li key={event.id} className="border-l-2 border-[var(--color-line)] pl-3">
                      <p className="text-[13px]">{event.summary}</p>
                      <p className="text-[11px] text-[var(--color-muted)]">
                        {formatDate(event.occurredAt.slice(0, 10))} · {event.kind}
                        {event.origin === "recorded" ? " · recorded" : ""}
                        {event.actorLabel ? ` · ${event.actorLabel}` : ""}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>

            {canEdit && !closed && (
              <Panel title="Amend the matter">
                <EditCaseForm
                  caseId={id}
                  matterTypes={MATTER_TYPES.map((type) => ({
                    value: type.value,
                    label: type.label,
                  }))}
                  defaults={{
                    title: record.title,
                    matterType: record.matterType,
                    status: record.status,
                    deceasedName: record.deceasedName,
                    dateOfDeath: record.dateOfDeath ?? "",
                    placeOfDeath: record.placeOfDeath ?? "",
                    domicileState: record.domicileState ?? "",
                    instructedBy: record.instructedBy ?? "",
                    targetOn: record.targetOn ?? "",
                    courtReference: record.courtReference ?? "",
                    registry: record.registry ?? "",
                    engagementRef: record.engagementRef ?? "",
                    notes: record.notes ?? "",
                    hasIdentification: record.deceasedIdLast4 !== null,
                  }}
                />
              </Panel>
            )}
          </div>

          <div className="space-y-4">
            <Panel
              title="Who is on it"
              description="Estate matters are visible to the people assigned to them."
            >
              {record.assignments.length === 0 ? (
                <p className="text-[12px] text-[var(--color-muted)]">Nobody yet.</p>
              ) : (
                <ul className="space-y-2">
                  {record.assignments.map((assignment) => (
                    <li key={assignment.id} className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-[13px]">{assignment.employeeName}</p>
                        <p className="text-[11px] text-[var(--color-muted)]">
                          {assignment.role} · {assignment.employeeNo}
                        </p>
                      </div>
                      {canAssign && !closed && (
                        <UnassignButton
                          caseId={id}
                          employeeId={assignment.employeeId}
                          name={assignment.employeeName.split(" ")[0]}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canAssign && !closed && (
                <div className="mt-3 border-t border-[var(--color-line)] pt-3">
                  <AssignForm
                    caseId={id}
                    employees={employees.map((employee) => ({
                      value: employee.id,
                      label: `${employee.full_name} (${employee.employee_no})`,
                    }))}
                  />
                </div>
              )}
            </Panel>

            {openTasks.length > 0 && (
              <Panel title={`Open tasks (${openTasks.length})`}>
                <DataTable columns={["What", "Who", "Due"]} caption="Open tasks">
                  {openTasks.slice(0, 8).map((task) => (
                    <tr key={task.id}>
                      <Td>{task.title}</Td>
                      <Td>
                        <span className="text-[11px]">{task.assigneeName ?? "unassigned"}</span>
                      </Td>
                      <Td>
                        {task.dueOn ? (
                          <span className={task.overdue ? "text-[var(--color-danger)]" : ""}>
                            {formatDate(task.dueOn)}
                          </span>
                        ) : (
                          <span className="text-[var(--color-faint)]">—</span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              </Panel>
            )}

            {canEdit && !closed && (
              <Panel
                title="Record something that happened"
                description="At a registry, in a meeting — outside this platform."
              >
                <MilestoneForm caseId={id} today={toIsoDate(today())} />
              </Panel>
            )}

            {canClose && !closed && (
              <Panel title="Finish the matter">
                <CloseCaseForm caseId={id} />
              </Panel>
            )}

            {canClose && closed && (
              <Panel title="Reopen it">
                <ReopenCaseForm caseId={id} />
              </Panel>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-[var(--color-faint)]">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
