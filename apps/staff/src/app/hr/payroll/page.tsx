import Link from "next/link";
import { getDb } from "@cac/db";
import {
  formatAmount,
  formatDate,
  listPayrollRuns,
  rulesAvailableFor,
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
import { CreateRunForm } from "./PayrollForms";

const TONE = {
  draft: "neutral",
  prepared: "warn",
  approved: "info",
  finalised: "ok",
  posted: "ok",
  abandoned: "neutral",
} as const;

const LABEL: Record<string, string> = {
  draft: "Draft",
  prepared: "Computed, not approved",
  approved: "Approved, not finalised",
  finalised: "Finalised",
  posted: "Posted to the ledger",
  abandoned: "Abandoned",
};

/**
 * Payroll.
 *
 * The banner at the top is the most important thing on this page while Q-HR-1 is
 * open: it says exactly which statutory schedules are missing and therefore why
 * payroll cannot run. That is a better outcome than a plausible figure, and saying it
 * plainly is the difference between a blocked feature and a silent wrong answer.
 */
export default async function PayrollPage() {
  const principal = await requireCapability("hr.payroll.view");
  const db = await getDb();

  const now = toIsoDate(today());
  const monthStart = `${now.slice(0, 7)}-01`;
  const monthEnd = lastDayOf(now);

  const [runs, rules] = await Promise.all([
    listPayrollRuns(db, 50),
    rulesAvailableFor(db, monthEnd),
  ]);

  const missing = rules.filter((row) => row.rule === null);
  const canPrepare = principal.capabilities.has("hr.payroll.prepare");

  const posted = runs.filter((row) => row.status === "posted");
  const awaiting = runs.filter((row) => row.status === "prepared" || row.status === "approved");

  return (
    <Shell
      principal={principal}
      title="Payroll"
      breadcrumbs={[{ label: "Human resources" }, { label: "Payroll" }]}
      actions={
        principal.capabilities.has("hr.statutory.view") ? (
          <LinkButton href="/hr/statutory">Statutory rules</LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {missing.length > 0 ? (
          <Alert tone="warn">
            <strong>Payroll cannot run yet, and nothing is guessed.</strong>
            <span className="mt-1 block">
              No approved rule is in force for{" "}
              <strong>{missing.map((row) => row.label).join(", ")}</strong>. These are contribution
              schedules rather than percentages — EPF varies by age and wage band, SOCSO and EIS are
              tables read by band, PCB is a schedule with reliefs — so they are entered as data with
              their source and approved by a second person, never written into the code. That is
              Q-HR-1.
            </span>
            {principal.capabilities.has("hr.statutory.manage") && (
              <span className="mt-2 block">
                <Link href="/hr/statutory" className="font-medium underline">
                  Enter them here
                </Link>{" "}
                once CAC supplies the official tables.
              </span>
            )}
          </Alert>
        ) : (
          <Alert tone="ok">
            Every statutory rule needed for {formatDate(monthEnd)} is in force and approved. Each was
            entered with its source and confirmed by somebody other than whoever entered it.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Runs awaiting a step"
            value={String(awaiting.length)}
            hint={
              awaiting.length > 0
                ? awaiting.map((row) => row.runNo ?? "draft").join(", ")
                : "nothing outstanding"
            }
            tone={awaiting.length > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Net paid, posted runs"
            value={formatAmount(posted.reduce((sum, row) => sum + row.netTotal, 0n))}
            hint={`${posted.length} run${posted.length === 1 ? "" : "s"} in the ledger`}
          />
          <StatTile
            label="Statutory rules in force"
            value={`${rules.length - missing.length}/${rules.length}`}
            hint={missing.length > 0 ? `${missing.length} missing` : "complete"}
            tone={missing.length > 0 ? "warn" : "ok"}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            <Panel title={`Runs (${runs.length})`}>
              {runs.length === 0 ? (
                <EmptyState
                  title="No payroll runs yet"
                  body="A run covers a period and a pay date. Nothing is computed until you ask for it, and nothing is paid until it has been approved and finalised."
                />
              ) : (
                <DataTable
                  columns={[
                    "Run",
                    "Period",
                    "Pay date",
                    "People",
                    "Gross",
                    "Net",
                    "Employer cost",
                    "Status",
                  ]}
                  caption="Payroll runs"
                >
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <Td>
                        <Link
                          href={`/hr/payroll/${run.id}`}
                          className="font-mono text-[12px] text-[var(--color-link)] hover:underline"
                        >
                          {run.runNo ?? "draft"}
                        </Link>
                        {run.kind === "supplementary" && (
                          <span className="ml-1">
                            <Badge tone="info">supplementary</Badge>
                          </span>
                        )}
                      </Td>
                      <Td>
                        {formatDate(run.periodFrom)} – {formatDate(run.periodTo)}
                      </Td>
                      <Td>{formatDate(run.payDate)}</Td>
                      <Td numeric>{run.employeeCount}</Td>
                      <Td numeric>{formatAmount(run.grossTotal)}</Td>
                      <Td numeric>{formatAmount(run.netTotal)}</Td>
                      <Td numeric>{formatAmount(run.employerCostTotal)}</Td>
                      <Td>
                        <Badge tone={TONE[run.status]}>{LABEL[run.status]}</Badge>
                        {run.problemCount > 0 && (
                          <span className="ml-1">
                            <Badge tone="danger">{run.problemCount} unresolved</Badge>
                          </span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>

            <Panel title="How a run works">
              <ol className="space-y-2 text-[12px] text-[var(--color-muted)]">
                <li>
                  <strong>Computed.</strong> Every figure is worked out from the salary in force
                  during the period — read from employment history, not from the employee record —
                  and the statutory rules in force on the pay date. Nothing is paid.
                </li>
                <li>
                  <strong>Approved</strong> by somebody other than whoever computed it. A run with
                  any payslip that could not be computed cannot be approved at all.
                </li>
                <li>
                  <strong>Finalised.</strong> The payslips become documents and stop changing; the
                  overtime the run paid is marked as paid so it cannot be claimed twice.
                </li>
                <li>
                  <strong>Posted.</strong> The ledger learns the cost, what is owed to the agencies,
                  and what is owed to the staff. Paying the staff is a separate voucher.
                </li>
              </ol>
            </Panel>
          </div>

          <div className="space-y-4">
            {canPrepare && (
              <Panel title="New run">
                <CreateRunForm
                  defaultFrom={monthStart}
                  defaultTo={monthEnd}
                  defaultPayDate={monthEnd}
                  finalisedRuns={runs
                    .filter((row) => row.status === "finalised" || row.status === "posted")
                    .map((row) => ({
                      id: row.id,
                      label: `${row.runNo} — ${row.periodFrom} to ${row.periodTo}`,
                    }))}
                />
              </Panel>
            )}

            <Panel title="Statutory rules in force">
              <dl className="space-y-2 text-[12px]">
                {rules.map((row) => (
                  <div key={row.kind} className="flex items-baseline justify-between gap-3">
                    <dt className="text-[var(--color-muted)]">{row.label}</dt>
                    <dd>
                      {row.rule ? (
                        <span title={row.rule.sourceRef}>
                          <Badge tone="ok">from {row.rule.effectiveFrom}</Badge>
                        </span>
                      ) : (
                        <Badge tone="warn">not supplied</Badge>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-[11px] text-[var(--color-muted)]">
                Shown as at {formatDate(monthEnd)}. A rule is used for the dates it covers, so a rate
                change part way through the year does not disturb an earlier month.
              </p>
            </Panel>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function lastDayOf(isoDate: string): string {
  const [year, month] = isoDate.split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  const date = new Date(Date.UTC(year!, month!, 0));
  return date.toISOString().slice(0, 10);
}
