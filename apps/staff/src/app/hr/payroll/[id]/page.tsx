import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, getPayrollRun, listPayslips } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, Panel, StatTile, Td, TotalRow } from "@/components/ui";
import { RunActions } from "../PayrollForms";

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

export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("hr.payroll.view");
  const { id } = await params;
  const db = await getDb();

  const run = await getPayrollRun(db, id);
  if (!run) notFound();

  const payslips = await listPayslips(db, { runId: id, limit: 1000 });
  const problems = payslips.filter((row) => row.problem !== null);

  // Payroll figures are salaries: whoever may see the run may see its totals, but the
  // per-person amounts need the capability to see any payslip.
  const canSeeAmounts = principal.capabilities.has("hr.payslip.view_all");

  return (
    <Shell
      principal={principal}
      title={run.runNo ?? "Draft payroll run"}
      breadcrumbs={[
        { label: "Human resources" },
        { label: "Payroll", href: "/hr/payroll" },
        { label: run.runNo ?? "Draft" },
      ]}
    >
      <div className="space-y-4">
        {run.kind === "supplementary" && (
          <Alert tone="info">
            A supplementary run. It corrects an earlier one rather than replacing it, so both stay on
            the record.
          </Alert>
        )}

        {problems.length > 0 && (
          <Alert tone="danger">
            {problems.length} payslip{problems.length === 1 ? "" : "s"} could not be computed. The run
            cannot be approved until each is dealt with — a run that paid everybody except one person
            is worse than one that failed outright.
            <ul className="mt-2 space-y-1">
              {problems.map((row) => (
                <li key={row.id}>
                  <strong>{row.employeeName}</strong>: {row.problem}
                </li>
              ))}
            </ul>
          </Alert>
        )}

        {run.status === "posted" && run.journalNo && (
          <Alert tone="ok">
            In the ledger as{" "}
            <Link
              href={`/accounting/journals/${run.journalId}`}
              className="font-mono font-medium underline"
            >
              {run.journalNo}
            </Link>
            . Net pay sits in salaries payable until a voucher pays it.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-4">
          <StatTile
            label="People"
            value={String(run.employeeCount)}
            hint={`${formatDate(run.periodFrom)} – ${formatDate(run.periodTo)}`}
          />
          <StatTile label="Gross" value={formatAmount(run.grossTotal)} hint="before deductions" />
          <StatTile
            label="Net"
            value={formatAmount(run.netTotal)}
            hint="owed to staff"
            tone="ok"
          />
          <StatTile
            label="Employer cost"
            value={formatAmount(run.employerCostTotal)}
            hint="contributions on top of pay"
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            <Panel title="Payslips">
              {payslips.length === 0 ? (
                <p className="text-[13px] text-[var(--color-muted)]">
                  Nothing computed yet.
                </p>
              ) : (
                <DataTable
                  columns={["Who", "Basic", "Gross", "Deductions", "Net", "Employer", ""]}
                  caption="Payslips in this run"
                >
                  {payslips.map((payslip) => (
                    <tr key={payslip.id}>
                      <Td>
                        <Link
                          href={`/hr/payslips/${payslip.id}`}
                          className="text-[var(--color-info)] hover:underline"
                        >
                          {payslip.employeeName}
                        </Link>
                        <span className="block font-mono text-[10px] text-[var(--color-muted)]">
                          {payslip.employeeNo}
                        </span>
                        {payslip.payableDays !== payslip.periodDays && (
                          <span className="block text-[10px] text-[var(--color-muted)]">
                            {payslip.payableDays} of {payslip.periodDays} days
                          </span>
                        )}
                      </Td>
                      <Td numeric>
                        {canSeeAmounts ? formatAmount(payslip.basicSalary) : "—"}
                      </Td>
                      <Td numeric>{canSeeAmounts ? formatAmount(payslip.grossPay) : "—"}</Td>
                      <Td numeric>
                        {canSeeAmounts ? formatAmount(payslip.totalDeductions) : "—"}
                      </Td>
                      <Td numeric>
                        {canSeeAmounts ? <strong>{formatAmount(payslip.netPay)}</strong> : "—"}
                      </Td>
                      <Td numeric>{canSeeAmounts ? formatAmount(payslip.employerCost) : "—"}</Td>
                      <Td>
                        {payslip.problem ? (
                          <span title={payslip.problem}>
                            <Badge tone="danger">not computed</Badge>
                          </span>
                        ) : (
                          ""
                        )}
                      </Td>
                    </tr>
                  ))}
                  {canSeeAmounts && (
                    <TotalRow>
                      <Td>Total</Td>
                      <Td>{""}</Td>
                      <Td numeric>{formatAmount(run.grossTotal)}</Td>
                      <Td numeric>{formatAmount(run.deductionTotal)}</Td>
                      <Td numeric>{formatAmount(run.netTotal)}</Td>
                      <Td numeric>{formatAmount(run.employerCostTotal)}</Td>
                      <Td>{""}</Td>
                    </TotalRow>
                  )}
                </DataTable>
              )}
              {!canSeeAmounts && (
                <p className="mt-2 text-[11px] text-[var(--color-muted)]">
                  Individual amounts are withheld: they need the capability to view payslips. The
                  run totals are shown because approving a run means agreeing to its total.
                </p>
              )}
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel title="Details">
              <dl className="space-y-2 text-[13px]">
                <Row label="Status">
                  <Badge tone={TONE[run.status]}>{LABEL[run.status]}</Badge>
                </Row>
                <Row label="Pay date">{formatDate(run.payDate)}</Row>
                <Row label="Computed by">{run.preparedByName ?? "—"}</Row>
                <Row label="Approved by">{run.approvedByName ?? "—"}</Row>
                <Row label="Finalised by">{run.finalisedByName ?? "—"}</Row>
                {run.abandonReason && <Row label="Abandoned">{run.abandonReason}</Row>}
              </dl>
              {run.notes && (
                <p className="mt-2 border-t border-[var(--color-line)] pt-2 text-[12px] text-[var(--color-muted)]">
                  {run.notes}
                </p>
              )}
            </Panel>

            <Panel title="What happens next">
              <RunActions
                runId={id}
                status={run.status}
                isPreparer={run.preparedByName === principal.fullName}
                problemCount={run.problemCount}
                canPrepare={principal.capabilities.has("hr.payroll.prepare")}
                canApprove={principal.capabilities.has("hr.payroll.approve")}
                canFinalise={principal.capabilities.has("hr.payroll.finalise")}
                canPost={principal.capabilities.has("hr.payroll.post")}
              />
            </Panel>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
