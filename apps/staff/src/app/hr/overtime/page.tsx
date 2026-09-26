import Link from "next/link";
import { getDb } from "@cac/db";
import {
  formatDate,
  listEmployees,
  listOvertime,
  listTimeoff,
  today,
  toIsoDate,
  unclaimedExtraTime,
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
import {
  OvertimeDecision,
  OvertimeRate,
  OvertimeRequestForm,
  RecalculateForm,
  TimeoffDecision,
  TimeoffRequestForm,
} from "./OvertimeForms";

const TONE = {
  draft: "neutral",
  submitted: "warn",
  approved: "ok",
  rejected: "danger",
} as const;

const DAY_KIND: Record<string, string> = {
  normal: "working day",
  rest_day: "rest day",
  public_holiday: "public holiday",
};

/**
 * Overtime and short absences.
 *
 * The panel that matters most is "extra time nobody has claimed". Extra time on the
 * clock is not a payment — but it is also not nothing: it is either overtime somebody
 * is owed a conversation about, or a scan nobody closed properly. Listing it is the
 * honest half of refusing to pay it automatically.
 */
export default async function OvertimePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; mine?: string }>;
}) {
  const principal = await requireCapability("hr.overtime.request");
  const query = await searchParams;
  const db = await getDb();

  const now = toIsoDate(today());
  const monthStart = `${now.slice(0, 7)}-01`;
  const from = query.from ?? monthStart;
  const to = query.to ?? now;

  const canApprove = principal.capabilities.has("hr.overtime.approve");
  const canSeeAll = canApprove || principal.capabilities.has("hr.overtime.view");
  const onlyMine = !canSeeAll || query.mine === "1";
  const canRecalculate = principal.capabilities.has("hr.attendance.edit");

  const [overtime, timeoff, unclaimed, employees] = await Promise.all([
    listOvertime(db, {
      employeeId: onlyMine ? (principal.employeeId ?? "none") : undefined,
      from,
      to,
      limit: 300,
    }),
    listTimeoff(db, {
      employeeId: onlyMine ? (principal.employeeId ?? "none") : undefined,
      from,
      to,
      limit: 300,
    }),
    canSeeAll ? unclaimedExtraTime(db, { from, to }) : Promise.resolve([]),
    canApprove ? listEmployees(db, { limit: 1000 }) : Promise.resolve([]),
  ]);

  const waitingOvertime = overtime.filter((row) => row.status === "submitted");
  const waitingTimeoff = timeoff.filter((row) => row.status === "submitted");
  const approvedWithoutRate = overtime.filter(
    (row) => row.status === "approved" && row.rateMultiple === null,
  );

  return (
    <Shell
      principal={principal}
      title="Overtime and time off"
      breadcrumbs={[{ label: "Human resources" }, { label: "Overtime" }]}
    >
      <div className="space-y-4">
        <Alert tone="info">
          <strong>Extra time is not payable overtime.</strong> The clock records time beyond the
          scheduled day whether anybody asked for it or not. What gets paid is what somebody claimed
          and somebody else approved — which may be fewer hours. Both figures are shown side by side
          below rather than reconciled in anybody&rsquo;s head.
        </Alert>

        {approvedWithoutRate.length > 0 && (
          <Alert tone="warn">
            {approvedWithoutRate.length} approved claim
            {approvedWithoutRate.length === 1 ? " has" : "s have"} no rate recorded, so payroll will
            not pay {approvedWithoutRate.length === 1 ? "it" : "them"}. The Malaysian multiples
            depend on the kind of day and come from the Employment Act, which CAC has not yet
            supplied — see Q-HR-1. The hours are agreed; only the rate is missing, and the last
            column records it once CAC has answered: the hours and the approver stay as they were.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-4">
          <StatTile
            label="Claims waiting"
            value={String(waitingOvertime.length)}
            hint={
              waitingOvertime.length > 0
                ? `${waitingOvertime.reduce((sum, row) => sum + row.requestedHours, 0).toFixed(2)} hours claimed`
                : "nothing waiting"
            }
            tone={waitingOvertime.length > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Approved hours"
            value={overtime
              .filter((row) => row.status === "approved")
              .reduce((sum, row) => sum + (row.approvedHours ?? 0), 0)
              .toFixed(2)}
            hint="payable, once a rate is recorded"
          />
          <StatTile
            label="Extra time unclaimed"
            value={String(unclaimed.length)}
            hint={
              unclaimed.length > 0
                ? `${Math.round(unclaimed.reduce((sum, row) => sum + row.extraMinutes, 0) / 60)} hours on the clock`
                : "nothing outstanding"
            }
            tone={unclaimed.length > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Absences waiting"
            value={String(waitingTimeoff.length)}
            tone={waitingTimeoff.length > 0 ? "warn" : "neutral"}
          />
        </div>

        <Panel title="Range">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="from" className="block text-[12px] font-medium">
                From
              </label>
              <input
                id="from"
                name="from"
                type="date"
                defaultValue={from}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              />
            </div>
            <div>
              <label htmlFor="to" className="block text-[12px] font-medium">
                To
              </label>
              <input
                id="to"
                name="to"
                type="date"
                defaultValue={to}
                className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              />
            </div>
            {canSeeAll && (
              <label className="flex items-center gap-2 pb-2 text-[13px]">
                <input type="checkbox" name="mine" value="1" defaultChecked={onlyMine} />
                Only mine
              </label>
            )}
            <button
              type="submit"
              className="rounded-md bg-[var(--color-navy)] px-3 py-2 text-[13px] font-medium text-white"
            >
              Show
            </button>
            <Link href="/hr/overtime" className="pb-2 text-[12px] text-[var(--color-info)]">
              This month
            </Link>
          </form>
        </Panel>

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            <Panel title={`Overtime claims (${overtime.length})`}>
              {overtime.length === 0 ? (
                <EmptyState
                  title="No claims in this range"
                  body="Overtime is claimed by the person who worked it, or by a manager on their behalf, and approved by somebody else."
                />
              ) : (
                <DataTable
                  columns={[
                    "Claim",
                    "Who",
                    "Day",
                    "Kind of day",
                    "Claimed",
                    "On the clock",
                    "Approved",
                    "Rate",
                    "Status",
                    "",
                  ]}
                  caption="Overtime claims"
                >
                  {overtime.map((request) => (
                    <tr key={request.id}>
                      <Td>
                        <span className="font-mono text-[11px]">
                          {request.requestNo ?? "draft"}
                        </span>
                        {request.isRetrospective && (
                          <span className="ml-1">
                            <Badge tone="neutral">after the fact</Badge>
                          </span>
                        )}
                      </Td>
                      <Td>
                        <Link
                          href={`/hr/employees/${request.employeeId}`}
                          className="text-[var(--color-info)] hover:underline"
                        >
                          {request.employeeName}
                        </Link>
                      </Td>
                      <Td>{formatDate(request.workDate)}</Td>
                      <Td>
                        <span className="text-[11px]">{DAY_KIND[request.dayKind]}</span>
                      </Td>
                      <Td numeric>{request.requestedHours.toFixed(2)}</Td>
                      <Td numeric>
                        {request.extraMinutesOnClock === null ? (
                          <span className="text-[var(--color-faint)]">—</span>
                        ) : (
                          (request.extraMinutesOnClock / 60).toFixed(2)
                        )}
                      </Td>
                      <Td numeric>
                        {request.approvedHours === null ? (
                          <span className="text-[var(--color-faint)]">—</span>
                        ) : (
                          <strong>{request.approvedHours.toFixed(2)}</strong>
                        )}
                      </Td>
                      <Td numeric>
                        {request.rateMultiple ? (
                          <span title={request.rateSource ?? undefined}>
                            ×{Number(request.rateMultiple).toFixed(2)}
                          </span>
                        ) : request.status === "approved" ? (
                          <Badge tone="warn">not set</Badge>
                        ) : (
                          <span className="text-[var(--color-faint)]">—</span>
                        )}
                      </Td>
                      <Td>
                        <Badge tone={TONE[request.status]}>{request.status}</Badge>
                        {request.paid && (
                          <span className="ml-1">
                            <Badge tone="ok">paid</Badge>
                          </span>
                        )}
                      </Td>
                      <Td>
                        {request.status === "submitted" ? (
                          <OvertimeDecision
                            requestId={request.id}
                            requestedHours={request.requestedHours}
                            extraMinutesOnClock={request.extraMinutesOnClock}
                            dayKind={request.dayKind}
                            canDecide={
                              canApprove && request.employeeId !== principal.employeeId
                            }
                          />
                        ) : request.status === "approved" &&
                          request.rateMultiple === null &&
                          !request.paid ? (
                          <OvertimeRate
                            requestId={request.id}
                            dayKind={request.dayKind}
                            canRate={canApprove && request.employeeId !== principal.employeeId}
                          />
                        ) : (
                          ""
                        )}
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>

            {canSeeAll && (
              <Panel
                title={`Extra time nobody has claimed (${unclaimed.length})`}
                description="The clock recorded these and no claim exists. Either somebody is owed a conversation, or a scan was never closed."
              >
                {unclaimed.length === 0 ? (
                  <p className="text-[13px] text-[var(--color-muted)]">
                    Nothing outstanding in this range.
                  </p>
                ) : (
                  <DataTable columns={["Who", "Day", "Extra on the clock"]} caption="Unclaimed extra time">
                    {unclaimed.map((row) => (
                      <tr key={`${row.employeeId}-${row.workDate}`}>
                        <Td>
                          <Link
                            href={`/hr/employees/${row.employeeId}`}
                            className="text-[var(--color-info)] hover:underline"
                          >
                            {row.employeeName}
                          </Link>
                        </Td>
                        <Td>{formatDate(row.workDate)}</Td>
                        <Td numeric>
                          {Math.floor(row.extraMinutes / 60)}h {row.extraMinutes % 60}m
                        </Td>
                      </tr>
                    ))}
                  </DataTable>
                )}
                <p className="mt-2 text-[11px] text-[var(--color-muted)]">
                  Nothing here is payable. It is listed so the decision is made by somebody rather
                  than by default.
                </p>
              </Panel>
            )}

            <Panel title={`Short absences (${timeoff.length})`}>
              {timeoff.length === 0 ? (
                <p className="text-[13px] text-[var(--color-muted)]">
                  None in this range.
                </p>
              ) : (
                <DataTable
                  columns={["Request", "Who", "Day", "Kind", "Minutes", "Paid", "Status", ""]}
                  caption="Time off"
                >
                  {timeoff.map((request) => (
                    <tr key={request.id}>
                      <Td>
                        <span className="font-mono text-[11px]">
                          {request.requestNo ?? "draft"}
                        </span>
                      </Td>
                      <Td>{request.employeeName}</Td>
                      <Td>{formatDate(request.workDate)}</Td>
                      <Td>
                        <span className="text-[11px]">{request.kind.replace(/_/g, " ")}</span>
                      </Td>
                      <Td numeric>{request.minutes}</Td>
                      <Td>{request.isPaid ? "yes" : "no"}</Td>
                      <Td>
                        <Badge tone={TONE[request.status]}>{request.status}</Badge>
                      </Td>
                      <Td>
                        {request.status === "submitted" ? (
                          <TimeoffDecision
                            requestId={request.id}
                            canDecide={
                              principal.capabilities.has("hr.timeoff.approve") &&
                              request.employeeId !== principal.employeeId
                            }
                          />
                        ) : (
                          ""
                        )}
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel title="Claim overtime">
              <OvertimeRequestForm
                employees={employees.map((row) => ({
                  id: row.id,
                  employeeNo: row.employeeNo,
                  fullName: row.fullName,
                }))}
                ownEmployeeId={principal.employeeId}
                defaultDate={now}
              />
            </Panel>

            <Panel title="Ask for time off within a day">
              <TimeoffRequestForm
                employees={employees.map((row) => ({
                  id: row.id,
                  employeeNo: row.employeeNo,
                  fullName: row.fullName,
                }))}
                ownEmployeeId={principal.employeeId}
                defaultDate={now}
              />
            </Panel>

            {canRecalculate && (
              <Panel title="Recalculate attendance">
                <RecalculateForm from={from} to={to} />
              </Panel>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}
