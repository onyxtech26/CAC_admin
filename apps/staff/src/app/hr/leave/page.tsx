import Link from "next/link";
import { getDb } from "@cac/db";
import {
  formatDate,
  listEmployees,
  listLeaveBalances,
  listLeaveRequests,
  listLeaveTypes,
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
  Panel,
  StatTile,
  Td,
} from "@/components/ui";
import { BalanceForm, CancelLeave, LeaveDecision, LeaveRequestForm, LeaveTypeForm } from "./LeaveForms";

const TONE = {
  draft: "neutral",
  submitted: "warn",
  approved: "ok",
  rejected: "danger",
  cancelled: "neutral",
} as const;

const LABEL: Record<string, string> = {
  draft: "Draft",
  submitted: "Waiting",
  approved: "Approved",
  rejected: "Refused",
  cancelled: "Cancelled",
};

/**
 * Leave.
 *
 * Whoever can only request their own sees only their own, scoped by the session
 * rather than by a filter they could change. Whoever approves sees the queue, with
 * the remaining balance beside each request — an approver who cannot see that the
 * balance is short will approve it, and the shortfall surfaces at year end when it
 * is too late to do anything about.
 */
export default async function LeavePage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; mine?: string }>;
}) {
  const principal = await requireCapability("hr.leave.request");
  const query = await searchParams;
  const db = await getDb();

  const year = Number(query.year) || today().getUTCFullYear();
  const canApprove = principal.capabilities.has("hr.leave.approve");
  const canConfigure = principal.capabilities.has("hr.leave.manage_types");
  const canSetBalances = principal.capabilities.has("hr.leave.manage_balance");
  const onlyMine = !canApprove || query.mine === "1";

  const [types, requests, balances, employees] = await Promise.all([
    listLeaveTypes(db),
    listLeaveRequests(db, {
      employeeId: onlyMine ? (principal.employeeId ?? "none") : undefined,
      limit: 300,
    }),
    listLeaveBalances(db, {
      employeeId: onlyMine ? (principal.employeeId ?? "none") : undefined,
      year,
    }),
    canApprove ? listEmployees(db, { limit: 1000 }) : Promise.resolve([]),
  ]);

  const waiting = requests.filter((row) => row.status === "submitted");
  const unconfigured = types.filter((row) => !row.isConfigured);

  // The remaining balance per person and type, so the queue can show it.
  const remainingBy = new Map(
    (canApprove ? await listLeaveBalances(db, { year }) : balances).map((row) => [
      `${row.employeeId}|${row.leaveTypeId}`,
      row.remainingDays,
    ]),
  );

  return (
    <Shell
      principal={principal}
      title="Leave"
      breadcrumbs={[{ label: "Human resources" }, { label: "Leave" }]}
    >
      <div className="space-y-4">
        {types.length === 0 && (
          <Alert tone="warn">
            No leave types have been set up. Nothing can be requested until HR records the kinds of
            leave and, for each, how many days somebody is entitled to and where that figure comes
            from.
          </Alert>
        )}

        {unconfigured.length > 0 && (
          <Alert tone="warn">
            {unconfigured.length} leave type{unconfigured.length === 1 ? "" : "s"} have no
            entitlement figure with a source and so cannot be used:{" "}
            {unconfigured.map((row) => row.name).join(", ")}. Entitlements under the Employment Act
            depend on length of service, and that schedule has not been supplied — see Q-HR-3.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Waiting for a decision"
            value={String(waiting.length)}
            hint={
              waiting.length > 0
                ? `${waiting.reduce((sum, row) => sum + row.days, 0)} days in total`
                : "nothing waiting"
            }
            tone={waiting.length > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label={onlyMine ? "Your days taken" : "Days approved this year"}
            value={String(
              requests
                .filter((row) => row.status === "approved" && row.startsOn.startsWith(String(year)))
                .reduce((sum, row) => sum + row.days, 0),
            )}
            hint={`in ${year}`}
          />
          <StatTile
            label="Leave types in use"
            value={String(types.filter((row) => row.isConfigured).length)}
            hint={
              unconfigured.length > 0
                ? `${unconfigured.length} not yet usable`
                : "all configured"
            }
            tone={unconfigured.length > 0 ? "warn" : "ok"}
          />
        </div>

        {canApprove && (
          <Panel title="View">
            <form method="get" className="flex flex-wrap items-end gap-3 text-[13px]">
              <label className="flex items-center gap-2">
                <input type="checkbox" name="mine" value="1" defaultChecked={onlyMine} />
                Only mine
              </label>
              <div>
                <label htmlFor="year" className="block text-[12px] font-medium">
                  Year
                </label>
                <input
                  id="year"
                  name="year"
                  type="number"
                  defaultValue={year}
                  className="mt-1 w-24 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
                />
              </div>
              <button
                type="submit"
                className="rounded-md bg-[var(--color-navy)] px-3 py-2 text-[13px] font-medium text-white"
              >
                Apply
              </button>
              <Link href="/hr/leave" className="pb-2 text-[12px] text-[var(--color-info)]">
                Clear
              </Link>
            </form>
          </Panel>
        )}

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            {waiting.length > 0 && (
              <Panel
                title={`${waiting.length} waiting`}
                description="The remaining balance is shown beside each, so nobody approves leave that is not there without meaning to."
              >
                <DataTable
                  columns={["Request", "Who", "Kind", "When", "Days", "Remaining", "Reason", ""]}
                  caption="Leave awaiting a decision"
                >
                  {waiting.map((request) => {
                    const remaining =
                      remainingBy.get(`${request.employeeId}|${request.leaveTypeId}`) ?? null;
                    return (
                      <tr key={request.id}>
                        <Td>
                          <span className="font-mono text-[11px]">{request.requestNo}</span>
                        </Td>
                        <Td>
                          <Link
                            href={`/hr/employees/${request.employeeId}`}
                            className="text-[var(--color-info)] hover:underline"
                          >
                            {request.employeeName}
                          </Link>
                        </Td>
                        <Td>{request.leaveTypeName}</Td>
                        <Td>
                          {formatDate(request.startsOn)}
                          {request.endsOn !== request.startsOn && ` – ${formatDate(request.endsOn)}`}
                        </Td>
                        <Td numeric>{request.days}</Td>
                        <Td numeric>
                          {remaining === null ? (
                            <span className="text-[var(--color-faint)]">—</span>
                          ) : (
                            <span
                              className={
                                request.days > remaining ? "text-[var(--color-danger)]" : ""
                              }
                            >
                              {remaining}
                            </span>
                          )}
                        </Td>
                        <Td>
                          <span className="text-[11px] text-[var(--color-muted)]">
                            {request.reason ?? "—"}
                          </span>
                        </Td>
                        <Td>
                          <LeaveDecision
                            requestId={request.id}
                            days={request.days}
                            remaining={remaining}
                            canDecide={
                              canApprove && request.employeeId !== principal.employeeId
                            }
                          />
                        </Td>
                      </tr>
                    );
                  })}
                </DataTable>
              </Panel>
            )}

            <Panel title={`${requests.length} request${requests.length === 1 ? "" : "s"}`}>
              {requests.length === 0 ? (
                <EmptyState
                  title="No leave recorded"
                  body="Requests appear here once somebody asks for leave."
                />
              ) : (
                <DataTable
                  columns={["Request", "Who", "Kind", "When", "Days", "Status", "Note", ""]}
                  caption="Leave requests"
                >
                  {requests.map((request) => (
                    <tr key={request.id}>
                      <Td>
                        <span className="font-mono text-[11px]">
                          {request.requestNo ?? "draft"}
                        </span>
                      </Td>
                      <Td>{request.employeeName}</Td>
                      <Td>
                        {request.leaveTypeName}
                        {!request.isPaid && (
                          <span className="ml-1">
                            <Badge tone="neutral">unpaid</Badge>
                          </span>
                        )}
                      </Td>
                      <Td>
                        {formatDate(request.startsOn)}
                        {request.endsOn !== request.startsOn && ` – ${formatDate(request.endsOn)}`}
                        {(request.halfDayStart || request.halfDayEnd) && (
                          <span className="ml-1 text-[10px] text-[var(--color-muted)]">
                            half day
                          </span>
                        )}
                      </Td>
                      <Td numeric>{request.days}</Td>
                      <Td>
                        <Badge tone={TONE[request.status]}>{LABEL[request.status]}</Badge>
                      </Td>
                      <Td>
                        <span className="text-[11px] text-[var(--color-muted)]">
                          {request.decisionNote ?? request.cancelReason ?? ""}
                        </span>
                      </Td>
                      <Td>
                        {(request.status === "approved" || request.status === "submitted") &&
                        (request.employeeId === principal.employeeId || canApprove) ? (
                          <CancelLeave requestId={request.id} />
                        ) : (
                          ""
                        )}
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>

            <Panel title={`Balances for ${year}`}>
              {balances.length === 0 ? (
                <p className="text-[13px] text-[var(--color-muted)]">
                  No balances set for {year}. A request cannot be approved against a balance that
                  does not exist.
                </p>
              ) : (
                <DataTable
                  columns={["Who", "Kind", "Entitled", "Carried", "Adjusted", "Taken", "Left"]}
                  caption={`Leave balances for ${year}`}
                >
                  {balances.map((balance) => (
                    <tr key={balance.id}>
                      <Td>{balance.employeeName}</Td>
                      <Td>{balance.leaveTypeName}</Td>
                      <Td numeric>{balance.entitledDays}</Td>
                      <Td numeric>{balance.carriedDays || "—"}</Td>
                      <Td numeric>{balance.adjustmentDays || "—"}</Td>
                      <Td numeric>{balance.takenDays}</Td>
                      <Td numeric>
                        <span
                          className={
                            balance.remainingDays < 0 ? "text-[var(--color-danger)] font-medium" : ""
                          }
                        >
                          {balance.remainingDays}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel title="Request leave">
              <LeaveRequestForm
                types={types.map((row) => ({
                  id: row.id,
                  code: row.code,
                  name: row.name,
                  isConfigured: row.isConfigured,
                  requiresDocument: row.requiresDocument,
                  allowsBackdating: row.allowsBackdating,
                }))}
                employees={employees.map((row) => ({
                  id: row.id,
                  employeeNo: row.employeeNo,
                  fullName: row.fullName,
                }))}
                ownEmployeeId={principal.employeeId}
                defaultDate={toIsoDate(today())}
              />
            </Panel>

            {canSetBalances && employees.length > 0 && (
              <Panel title="Set a balance">
                <BalanceForm
                  employees={employees.map((row) => ({
                    id: row.id,
                    employeeNo: row.employeeNo,
                    fullName: row.fullName,
                  }))}
                  types={types.map((row) => ({
                    id: row.id,
                    code: row.code,
                    name: row.name,
                    isConfigured: row.isConfigured,
                    requiresDocument: row.requiresDocument,
                    allowsBackdating: row.allowsBackdating,
                  }))}
                  year={year}
                />
              </Panel>
            )}

            {canConfigure && (
              <Panel title="Add a leave type">
                <LeaveTypeForm />
              </Panel>
            )}

            <Panel title="What is not decided here">
              <p className="text-[12px] text-[var(--color-muted)]">
                How many days somebody is entitled to depends on their length of service under the
                Employment Act, and on whatever CAC&rsquo;s policy adds above that floor. That
                schedule has not been supplied, so no entitlement is seeded and no figure may be
                recorded without saying where it came from. Q-HR-3 is the question.
              </p>
            </Panel>
          </div>
        </div>
      </div>
    </Shell>
  );
}
