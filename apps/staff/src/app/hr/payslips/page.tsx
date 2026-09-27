import Link from "next/link";
import { getDb } from "@cac/db";
import { formatAmount, formatDate, listPayslips } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { ownEmployeeFilter, UNLINKED_ACCOUNT } from "@/lib/own-employee";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, Panel, Td } from "@/components/ui";

/**
 * Payslips.
 *
 * Scoped by the session: somebody with only `hr.payslip.view_own` sees their own and
 * nothing else, and there is no filter to change that. A payslip is the most personal
 * document in the platform.
 */
export default async function PayslipsPage() {
  const principal = await requireCapability("hr.payslip.view_own");
  const db = await getDb();

  const canSeeAll = principal.capabilities.has("hr.payslip.view_all");

  // The message below was already written for this case and was unreachable: the query ran first
  // and threw. See lib/own-employee.ts.
  const mine = ownEmployeeFilter(principal, !canSeeAll);

  const payslips =
    mine.scope === "unlinked"
      ? []
      : await listPayslips(db, { employeeId: mine.employeeId, limit: 500 });

  return (
    <Shell
      principal={principal}
      title="Payslips"
      breadcrumbs={[{ label: "Human resources" }, { label: "Payslips" }]}
    >
      <div className="space-y-4">
        {mine.scope === "unlinked" && <Alert tone="info">{UNLINKED_ACCOUNT}</Alert>}

        <Panel title={canSeeAll ? `All payslips (${payslips.length})` : "Your payslips"}>
          {payslips.length === 0 ? (
            <EmptyState
              title="No payslips yet"
              body="A payslip appears once a payroll run covering the period has been computed."
            />
          ) : (
            <DataTable
              columns={["Period", "Run", canSeeAll ? "Who" : "", "Gross", "Deductions", "Net", "Status"]}
              caption="Payslips"
            >
              {payslips.map((payslip) => (
                <tr key={payslip.id}>
                  <Td>
                    <Link
                      href={`/hr/payslips/${payslip.id}`}
                      className="text-[var(--color-link)] hover:underline"
                    >
                      {formatDate(payslip.periodFrom)} – {formatDate(payslip.periodTo)}
                    </Link>
                  </Td>
                  <Td>
                    <span className="font-mono text-[11px]">{payslip.runNo ?? "draft"}</span>
                  </Td>
                  <Td>{canSeeAll ? payslip.employeeName : ""}</Td>
                  <Td numeric>{formatAmount(payslip.grossPay)}</Td>
                  <Td numeric>{formatAmount(payslip.totalDeductions)}</Td>
                  <Td numeric>
                    <strong>{formatAmount(payslip.netPay)}</strong>
                  </Td>
                  <Td>
                    {payslip.problem ? (
                      <Badge tone="danger">not computed</Badge>
                    ) : payslip.runStatus === "finalised" || payslip.runStatus === "posted" ? (
                      <Badge tone="ok">final</Badge>
                    ) : (
                      <Badge tone="warn">draft</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
          <p className="mt-2 border-t border-[var(--color-line)] pt-2 text-[11px] text-[var(--color-muted)]">
            A payslip from a run that is not yet finalised is marked draft, on the screen and on the
            PDF. The figures may still change.
          </p>
        </Panel>
      </div>
    </Shell>
  );
}
