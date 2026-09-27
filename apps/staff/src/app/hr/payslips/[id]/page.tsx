import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, getPayslip } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, LinkButton, Panel, Td, TotalRow } from "@/components/ui";

/**
 * One payslip.
 *
 * Every figure shows how it was arrived at, and every statutory figure shows the
 * document its rate came from. That is the difference between a payslip somebody has
 * to accept and one they can check.
 */
export default async function PayslipPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("hr.payslip.view_own");
  const { id } = await params;
  const db = await getDb();

  // Applies the own-record scope: somebody else's payslip is refused here, not hidden
  // by the page.
  const payslip = await getPayslip(db, principal, id);
  if (!payslip) notFound();

  const earnings = payslip.lines.filter((line) => line.kind === "earning");
  const deductions = payslip.lines.filter((line) => line.kind === "deduction");
  const employer = payslip.lines.filter((line) => line.kind === "employer");

  const isFinal = payslip.runStatus === "finalised" || payslip.runStatus === "posted";

  return (
    <Shell
      principal={principal}
      title={`${formatDate(payslip.periodFrom)} – ${formatDate(payslip.periodTo)}`}
      breadcrumbs={[
        { label: "Human resources" },
        { label: "Payslips", href: "/hr/payslips" },
        { label: payslip.runNo ?? "Draft" },
      ]}
      actions={
        <LinkButton href={`/hr/payslips/${id}/pdf`} variant="primary">
          Download the PDF
        </LinkButton>
      }
    >
      <div className="space-y-4">
        {!isFinal && (
          <Alert tone="warn">
            This payroll run is {payslip.runStatus} — the figures may still change. The PDF says so
            too, so a draft cannot be mistaken for the real thing.
          </Alert>
        )}

        {payslip.problem && (
          <Alert tone="danger">
            This payslip could not be computed: {payslip.problem}
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Panel title="Earnings">
              <DataTable columns={["What", "How it was worked out", "Amount"]} caption="Earnings">
                {earnings.map((line) => (
                  <tr key={line.id}>
                    <Td>{line.description}</Td>
                    <Td>
                      <span className="text-[11px] text-[var(--color-muted)]">
                        {line.basis ?? "—"}
                      </span>
                    </Td>
                    <Td numeric>{formatAmount(line.amount)}</Td>
                  </tr>
                ))}
                <TotalRow>
                  <Td>Gross pay</Td>
                  <Td>{""}</Td>
                  <Td numeric>{formatAmount(payslip.grossPay)}</Td>
                </TotalRow>
              </DataTable>
            </Panel>

            <Panel title="Deductions">
              {deductions.length === 0 ? (
                <p className="text-[13px] text-[var(--color-muted)]">Nothing deducted.</p>
              ) : (
                <DataTable
                  columns={["What", "How it was worked out", "From which table", "Amount"]}
                  caption="Deductions"
                >
                  {deductions.map((line) => (
                    <tr key={line.id}>
                      <Td>{line.description}</Td>
                      <Td>
                        <span className="text-[11px] text-[var(--color-muted)]">
                          {line.basis ?? "—"}
                        </span>
                      </Td>
                      <Td>
                        <span className="text-[11px] text-[var(--color-muted)]">
                          {line.statutorySource ?? "—"}
                        </span>
                      </Td>
                      <Td numeric>{formatAmount(line.amount)}</Td>
                    </tr>
                  ))}
                  <TotalRow>
                    <Td>Total deductions</Td>
                    <Td>{""}</Td>
                    <Td>{""}</Td>
                    <Td numeric>{formatAmount(payslip.totalDeductions)}</Td>
                  </TotalRow>
                </DataTable>
              )}
            </Panel>

            {employer.length > 0 && (
              <Panel
                title="Paid by the employer on your behalf"
                description="The company's own contributions. Not deducted from your pay, and not part of the net figure."
              >
                <DataTable
                  columns={["What", "How it was worked out", "Amount"]}
                  caption="Employer contributions"
                >
                  {employer.map((line) => (
                    <tr key={line.id}>
                      <Td>{line.description}</Td>
                      <Td>
                        <span className="text-[11px] text-[var(--color-muted)]">
                          {line.basis ?? "—"}
                        </span>
                      </Td>
                      <Td numeric>{formatAmount(line.amount)}</Td>
                    </tr>
                  ))}
                  <TotalRow>
                    <Td>Employer total</Td>
                    <Td>{""}</Td>
                    <Td numeric>{formatAmount(payslip.employerCost)}</Td>
                  </TotalRow>
                </DataTable>
              </Panel>
            )}
          </div>

          <div className="space-y-4">
            <Panel title="Net pay">
              <p className="numeric text-3xl font-semibold">{formatAmount(payslip.netPay)}</p>
              <p className="mt-1 text-[12px] text-[var(--color-muted)]">
                Paid {formatDate(payslip.payDate)}
                {payslip.bankName && payslip.bankAccountLast4
                  ? ` to ${payslip.bankName} ···${payslip.bankAccountLast4}`
                  : ""}
              </p>
              <p className="mt-2 border-t border-[var(--color-line)] pt-2">
                <Badge tone={isFinal ? "ok" : "warn"}>{isFinal ? "final" : "draft"}</Badge>
              </p>
            </Panel>

            <Panel title="Who">
              <dl className="space-y-2 text-[13px]">
                <Row label="Name" value={payslip.employeeName} />
                <Row label="Number" value={payslip.employeeNo} />
                <Row label="Position" value={payslip.positionTitle ?? "—"} />
                <Row label="Department" value={payslip.departmentName ?? "—"} />
                <Row label="Basic salary" value={formatAmount(payslip.basicSalary)} />
                {payslip.payableDays !== payslip.periodDays && (
                  <Row
                    label="Days paid"
                    value={`${payslip.payableDays} of ${payslip.periodDays}`}
                  />
                )}
                <Row label="Run" value={payslip.runNo ?? "draft"} />
              </dl>
            </Panel>

            <Panel title="If something looks wrong">
              <p className="text-[12px] text-[var(--color-muted)]">
                Every statutory deduction above names the table its rate came from, and the
                calculation is recorded line by line. Raise it with HR: the answer is a matter of
                looking something up rather than of anybody&rsquo;s recollection.
              </p>
              {principal.capabilities.has("hr.statutory.view") && (
                <p className="mt-2 text-[12px]">
                  <Link href="/hr/statutory" className="text-[var(--color-link)] hover:underline">
                    The rules themselves
                  </Link>
                </p>
              )}
            </Panel>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
