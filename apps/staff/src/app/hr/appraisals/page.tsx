import { getDb } from "@cac/db";
import { formatDate, listAppraisals, listCycles, today, toIsoDate } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import {
  Alert,
  Badge,
  DataTable,
  EmptyState,
  Panel,
  StatTile,
  Td,
} from "@/components/ui";
import { AcknowledgeForm, AnswerForm, CycleForm, OpenCycle } from "./AppraisalForms";

const TONE = {
  draft: "neutral",
  self_assessed: "warn",
  reviewed: "info",
  acknowledged: "ok",
} as const;

const STATUS: Record<string, string> = {
  draft: "Not started",
  self_assessed: "Waiting for the reviewer",
  reviewed: "Waiting to be read",
  acknowledged: "Complete",
};

/**
 * Appraisals.
 *
 * Three audiences on one page, which is right because each person has one or two
 * things to do and a separate screen each would hide them: your own appraisal, the
 * ones you review, and — for whoever runs the round — the cycles themselves.
 */
export default async function AppraisalsPage() {
  const principal = await requireCapability("hr.appraisal.view");
  const db = await getDb();

  const canManage = principal.capabilities.has("hr.appraisal.manage");
  const canReview = principal.capabilities.has("hr.appraisal.review");

  const [cycles, mine, toReview] = await Promise.all([
    listCycles(db),
    principal.employeeId
      ? listAppraisals(db, { employeeId: principal.employeeId })
      : Promise.resolve([]),
    canReview && principal.employeeId
      ? listAppraisals(db, { reviewerId: principal.employeeId })
      : Promise.resolve([]),
  ]);

  const now = toIsoDate(today());
  const year = now.slice(0, 4);

  const waitingOnMe = toReview.filter((row) => row.status === "self_assessed");
  const myAction = mine.filter((row) => row.status === "draft" || row.status === "reviewed");

  return (
    <Shell
      principal={principal}
      title="Appraisals"
      breadcrumbs={[{ label: "Human resources" }, { label: "Appraisals" }]}
    >
      <div className="space-y-4">
        {cycles.length === 0 && (
          <Alert tone="info">
            No appraisal round has been set up. A round carries its own form — what CAC asks about
            its staff is a management decision, so nothing is assumed here.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Yours to do"
            value={String(myAction.length)}
            hint={
              myAction.length > 0
                ? myAction[0]!.status === "draft"
                  ? "a self-assessment is waiting"
                  : "a review is waiting to be read"
                : "nothing outstanding"
            }
            tone={myAction.length > 0 ? "warn" : "ok"}
          />
          <StatTile
            label="Waiting for your review"
            value={String(waitingOnMe.length)}
            hint={canReview ? "people who report to you" : "you do not review anybody"}
            tone={waitingOnMe.length > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Rounds"
            value={String(cycles.length)}
            hint={
              cycles.filter((row) => row.status === "open").length > 0
                ? `${cycles.filter((row) => row.status === "open").length} open`
                : "none open"
            }
          />
        </div>

        {myAction.map((appraisal) =>
          appraisal.status === "draft" && appraisal.template ? (
            <Panel
              key={appraisal.id}
              title={`Your assessment — ${appraisal.cycleName}`}
              description="Your own view, which your reviewer sees beside theirs."
            >
              <AnswerForm
                appraisalId={appraisal.id}
                template={appraisal.template}
                mode="self"
                existing={
                  appraisal.selfAssessment as Record<string, Record<string, unknown>> | null
                }
              />
            </Panel>
          ) : appraisal.status === "reviewed" ? (
            <Panel key={appraisal.id} title={`Your review — ${appraisal.cycleName}`}>
              <div className="space-y-4">
                <dl className="space-y-2 text-[13px]">
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-[var(--color-muted)]">Reviewer</dt>
                    <dd>{appraisal.reviewerName}</dd>
                  </div>
                  {appraisal.overallScore !== null && (
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-[var(--color-muted)]">Overall</dt>
                      <dd className="font-semibold">{appraisal.overallScore}</dd>
                    </div>
                  )}
                </dl>

                {appraisal.overallComment && (
                  <p className="rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] p-3 text-[13px]">
                    {appraisal.overallComment}
                  </p>
                )}

                {appraisal.template && appraisal.review && (
                  <DataTable columns={["Question", "Their rating", "Yours"]} caption="Review detail">
                    {appraisal.template.sections.flatMap((section) =>
                      section.questions.map((question) => {
                        const review = appraisal.review as Record<
                          string,
                          Record<string, unknown>
                        > | null;
                        const self = appraisal.selfAssessment as Record<
                          string,
                          Record<string, unknown>
                        > | null;
                        return (
                          <tr key={`${section.key}-${question.key}`}>
                            <Td>
                              <span className="text-[11px] text-[var(--color-muted)]">
                                {section.title}
                              </span>{" "}
                              {question.prompt}
                            </Td>
                            <Td numeric>{String(review?.[section.key]?.[question.key] ?? "—")}</Td>
                            <Td numeric>{String(self?.[section.key]?.[question.key] ?? "—")}</Td>
                          </tr>
                        );
                      }),
                    )}
                  </DataTable>
                )}

                <AcknowledgeForm appraisalId={appraisal.id} />
              </div>
            </Panel>
          ) : null,
        )}

        {waitingOnMe.length > 0 &&
          waitingOnMe.map((appraisal) =>
            appraisal.template ? (
              <Panel
                key={appraisal.id}
                title={`Review — ${appraisal.employeeName}`}
                description={`${appraisal.cycleName}. Their own answers are shown beside each question.`}
              >
                <AnswerForm
                  appraisalId={appraisal.id}
                  template={appraisal.template}
                  mode="review"
                  existing={appraisal.review as Record<string, Record<string, unknown>> | null}
                  showSelfAssessment={
                    appraisal.selfAssessment as Record<string, Record<string, unknown>> | null
                  }
                />
              </Panel>
            ) : null,
          )}

        {toReview.length > 0 && (
          <Panel title={`People you review (${toReview.length})`}>
            <DataTable
              columns={["Who", "Round", "Status", "Overall", "Acknowledged"]}
              caption="Appraisals you review"
            >
              {toReview.map((appraisal) => (
                <tr key={appraisal.id}>
                  <Td>{appraisal.employeeName}</Td>
                  <Td>{appraisal.cycleName}</Td>
                  <Td>
                    <Badge tone={TONE[appraisal.status]}>{STATUS[appraisal.status]}</Badge>
                  </Td>
                  <Td numeric>
                    {appraisal.overallScore ?? <span className="text-[var(--color-faint)]">—</span>}
                  </Td>
                  <Td>
                    {appraisal.acknowledgedAt
                      ? new Date(appraisal.acknowledgedAt).toLocaleDateString("en-GB")
                      : "—"}
                  </Td>
                </tr>
              ))}
            </DataTable>
          </Panel>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Panel title={`Rounds (${cycles.length})`}>
              {cycles.length === 0 ? (
                <EmptyState
                  title="No rounds yet"
                  body="A round covers a period and carries the form used for it."
                />
              ) : (
                <DataTable
                  columns={["Code", "Name", "Period", "Status", "Appraisals", "Complete", ""]}
                  caption="Appraisal rounds"
                >
                  {cycles.map((cycle) => (
                    <tr key={cycle.id}>
                      <Td>
                        <span className="font-mono text-[12px]">{cycle.code}</span>
                      </Td>
                      <Td>{cycle.name}</Td>
                      <Td>
                        {formatDate(cycle.periodFrom)} – {formatDate(cycle.periodTo)}
                      </Td>
                      <Td>
                        <Badge
                          tone={
                            cycle.status === "open"
                              ? "warn"
                              : cycle.status === "closed"
                                ? "neutral"
                                : "info"
                          }
                        >
                          {cycle.status}
                        </Badge>
                        {!cycle.template && (
                          <span className="ml-1">
                            <Badge tone="warn">no form</Badge>
                          </span>
                        )}
                      </Td>
                      <Td numeric>{cycle.appraisalCount}</Td>
                      <Td numeric>
                        {cycle.appraisalCount === 0
                          ? "—"
                          : `${cycle.acknowledgedCount}/${cycle.appraisalCount}`}
                      </Td>
                      <Td>
                        {canManage && cycle.status === "draft" && cycle.template && (
                          <OpenCycle cycleId={cycle.id} name={cycle.code} />
                        )}
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>
          </div>

          <div className="space-y-4">
            {canManage && (
              <Panel title="New round">
                <CycleForm defaultFrom={`${year}-01-01`} defaultTo={`${year}-12-31`} />
              </Panel>
            )}

            <Panel title="How a round runs">
              <ol className="space-y-2 text-[12px] text-[var(--color-muted)]">
                <li>
                  <strong>1.</strong> The round is created with its form, and opened. One appraisal
                  per person whose manager is recorded; anybody without one is reported rather than
                  assigned an arbitrary reviewer.
                </li>
                <li>
                  <strong>2.</strong> Each person writes their own assessment. Only they can — an
                  assessment written by somebody else is not a self-assessment.
                </li>
                <li>
                  <strong>3.</strong> The reviewer sees those answers beside each question and
                  records theirs.
                </li>
                <li>
                  <strong>4.</strong> The person reads it and acknowledges it. From that moment it
                  cannot be changed by anybody, which is what makes it worth having.
                </li>
              </ol>
            </Panel>
          </div>
        </div>
      </div>
    </Shell>
  );
}
