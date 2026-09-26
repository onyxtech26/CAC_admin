import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, today, toIsoDate } from "./dates.js";
import { allocateDocumentNumber } from "./sequence.js";
import { weekdayOf } from "./attendance-engine.js";

/**
 * Overtime, time off, and the line between extra time and payable hours.
 *
 * This module exists because of one distinction the brief is emphatic about and
 * which most systems collapse:
 *
 * > Extra time is calculated. Payable overtime is a separate decision gated on
 * > eligibility, company rule, statute and approval.
 *
 * `attendance.extraMinutes` is arithmetic: the clock says somebody was there beyond
 * their scheduled day. It happens whether anybody asked or not, and paying it
 * automatically pays for every evening somebody stayed late to finish something of
 * their own accord.
 *
 * `overtime_request.approvedHours` is the payable figure. Somebody asks, somebody
 * else approves — possibly for fewer hours than were asked — and only that reaches
 * payroll. The two numbers live in different tables on purpose, and the screens show
 * them side by side so the difference is visible rather than reconciled in
 * somebody's head.
 *
 * **The rate is not defaulted.** Malaysian overtime rates depend on whether the day
 * was a normal working day, a rest day or a public holiday, and they come from the
 * Employment Act rather than from anybody's preference. `rateMultiple` is nullable
 * and requires a source, so an unanswered Q-HR-1 shows up as a missing rate rather
 * than as a quiet 1.5×.
 */

export type RequestStatus = "draft" | "submitted" | "approved" | "rejected";
export type DayKind = "normal" | "rest_day" | "public_holiday";

export interface OvertimeInput {
  employeeId: string;
  workDate: string;
  startsAt?: string | null;
  endsAt?: string | null;
  requestedHours: string;
  reason: string;
}

export interface OvertimeView {
  id: string;
  requestNo: string | null;
  employeeId: string;
  employeeName: string;
  workDate: string;
  startsAt: string | null;
  endsAt: string | null;
  requestedHours: number;
  approvedHours: number | null;
  dayKind: DayKind;
  rateMultiple: string | null;
  rateSource: string | null;
  reason: string;
  status: RequestStatus;
  isRetrospective: boolean;
  decidedByName: string | null;
  decisionNote: string | null;
  paid: boolean;
  /** From the attendance row for the same day, for comparison. */
  extraMinutesOnClock: number | null;
  createdAt: Date | string;
}

/**
 * Works out what kind of day it was.
 *
 * The rate depends on this, so it is determined from the calendar and the schedule
 * rather than typed in: a claim for a public holiday entered as a normal day would
 * be paid at the wrong multiple.
 */
export async function dayKindFor(
  db: Executor,
  employeeId: string,
  workDate: string,
): Promise<DayKind> {
  const date = toIsoDate(parseIsoDate(workDate, "workDate"));

  const holiday = await db.execute<{ id: string }>(
    sql`SELECT id FROM hr.public_holiday WHERE holiday_on = ${date}::date LIMIT 1`,
  );
  if (holiday.rows?.[0]) return "public_holiday";

  const schedule = await db.execute<{ work_days: number[] | string | null }>(sql`
    SELECT ws.work_days
      FROM hr.employee e
      LEFT JOIN hr.work_schedule ws
        ON ws.id = COALESCE(e.work_schedule_id, (SELECT id FROM hr.work_schedule WHERE is_default LIMIT 1))
     WHERE e.id = ${employeeId}
  `);

  const raw = schedule.rows?.[0]?.work_days;
  const workDays = Array.isArray(raw)
    ? raw.map(Number)
    : typeof raw === "string"
      ? raw
          .replace(/[{}]/g, "")
          .split(",")
          .filter((part) => part.trim() !== "")
          .map(Number)
      : [1, 2, 3, 4, 5];

  return workDays.includes(weekdayOf(date)) ? "normal" : "rest_day";
}

export async function requestOvertime(
  db: Executor,
  principal: Principal,
  input: OvertimeInput,
  context?: AuditContext,
): Promise<{ id: string; dayKind: DayKind }> {
  const forSomebodyElse = principal.employeeId !== input.employeeId;
  if (forSomebodyElse) requireCapability(principal, "hr.overtime.approve");
  else requireCapability(principal, "hr.overtime.request");

  const workDate = toIsoDate(parseIsoDate(input.workDate, "workDate"));
  const hours = Number(input.requestedHours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    throw new ValidationError("Enter the hours worked, between 0 and 24.", "requestedHours");
  }
  if (!input.reason?.trim()) {
    throw new ValidationError(
      "Say what the overtime was for. It is what the approver decides on.",
      "reason",
    );
  }

  // One *live* claim per day. A rejected one does not count, and used to: the check had no status
  // filter, so a Tuesday claim refused for a missing reason blocked that Tuesday permanently, with no
  // route back — the request could not be edited once decided and could not be replaced. The unique
  // constraint behind it said the same thing, and migration 0028 narrowed both to the same rule.
  const existing = await db.execute<{ id: string; status: string }>(
    sql`SELECT id, status FROM hr.overtime_request
         WHERE employee_id = ${input.employeeId} AND work_date = ${workDate}::date
           AND status <> 'rejected'`,
  );
  if (existing.rows?.[0]) {
    throw new ConflictError(
      `There is already a ${existing.rows[0]!.status} overtime request for that day. Two would be ` +
        "two payments for the same evening.",
    );
  }

  const dayKind = await dayKindFor(db, input.employeeId, workDate);

  // Asking after the fact is normal and is recorded as such — whether a company
  // requires prior approval is a setting, and the honest thing is to show which
  // requests were retrospective rather than to refuse them silently.
  const isRetrospective = workDate < toIsoDate(today());

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.overtime_request
      (employee_id, work_date, starts_at, ends_at, requested_hours, day_kind, reason,
       is_retrospective, created_by)
    VALUES (${input.employeeId}, ${workDate}, ${input.startsAt?.trim() || null},
            ${input.endsAt?.trim() || null}, ${input.requestedHours}, ${dayKind},
            ${input.reason.trim()}, ${isRetrospective}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.OVERTIME_REQUESTED,
    entityType: "overtime_request",
    entityId: id,
    newValues: {
      employeeId: input.employeeId,
      workDate,
      requestedHours: input.requestedHours,
      dayKind,
      isRetrospective,
      raisedForSomebodyElse: forSomebodyElse || undefined,
    },
  });

  return { id, dayKind };
}

export async function submitOvertime(
  db: Executor,
  principal: Principal,
  requestId: string,
  context?: AuditContext,
): Promise<{ requestNo: string }> {
  const request = await lockOvertime(db, requestId);
  if (request.status !== "draft") throw new ConflictError(`That request is already ${request.status}.`);

  if (request.employee_id !== principal.employeeId) {
    requireCapability(principal, "hr.overtime.approve");
  } else {
    requireCapability(principal, "hr.overtime.request");
  }

  const requestNo = await allocateDocumentNumber(db, "overtime", { on: request.work_date });

  await db.execute(sql`
    UPDATE hr.overtime_request
       SET status = 'submitted', request_no = ${requestNo}, submitted_at = now(),
           updated_by = ${principal.userId}
     WHERE id = ${requestId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.OVERTIME_SUBMITTED,
    entityType: "overtime_request",
    entityId: requestId,
    newValues: { requestNo },
  });

  return { requestNo };
}

/**
 * Decides an overtime request.
 *
 * `approvedHours` is deliberately separate from what was requested: approving four
 * of the six hours claimed is a normal outcome, and the difference has to stay
 * visible rather than the request being edited down.
 *
 * The rate is asked for here rather than assumed. Until CAC supplies the statutory
 * multiples (Q-HR-1), an approver may approve the hours and leave the rate unset —
 * payroll will then refuse to pay it, which is the right failure: hours agreed, rate
 * not yet known.
 */
export async function decideOvertime(
  db: Executor,
  principal: Principal,
  requestId: string,
  decision: "approved" | "rejected",
  options: {
    approvedHours?: string;
    rateMultiple?: string | null;
    rateSource?: string | null;
    note?: string | null;
    context?: AuditContext;
  } = {},
): Promise<void> {
  requireCapability(principal, "hr.overtime.approve");

  const request = await lockOvertime(db, requestId);
  if (request.status !== "submitted") {
    throw new ConflictError(
      request.status === "draft"
        ? "That request has not been submitted yet."
        : `That request is already ${request.status}.`,
    );
  }

  if (request.employee_id === principal.employeeId) {
    throw new ConflictError("You cannot approve your own overtime. Somebody else has to decide it.");
  }

  if (decision === "rejected") {
    if (!options.note?.trim()) {
      throw new ValidationError("Say why it is being refused. The person sees this.", "note");
    }

    await db.execute(sql`
      UPDATE hr.overtime_request
         SET status = 'rejected', decided_at = now(), decided_by = ${principal.userId},
             decision_note = ${options.note.trim()}, updated_by = ${principal.userId}
       WHERE id = ${requestId}
    `);

    await writeAudit(db, {
      ...options.context,
      actorUserId: principal.userId,
      actorLabel: principal.email,
      action: AUDIT.OVERTIME_REJECTED,
      entityType: "overtime_request",
      entityId: requestId,
      reason: options.note.trim(),
    });
    return;
  }

  const approved = Number(options.approvedHours ?? request.requested_hours);
  if (!Number.isFinite(approved) || approved < 0) {
    throw new ValidationError("That is not a number of hours.", "approvedHours");
  }
  if (approved > Number(request.requested_hours)) {
    throw new ValidationError(
      `Only ${request.requested_hours} hours were claimed; more than that cannot be approved.`,
      "approvedHours",
    );
  }

  // A rate without a source is a rate nobody can defend, and this one multiplies
  // somebody's hourly pay.
  const rate = options.rateMultiple?.trim();
  if (rate) {
    const multiple = Number(rate);
    if (!Number.isFinite(multiple) || multiple <= 0 || multiple > 10) {
      throw new ValidationError("That is not a rate multiple.", "rateMultiple");
    }
    if (!options.rateSource?.trim()) {
      throw new ValidationError(
        "Say where the rate comes from — the Employment Act section, or the company policy that " +
          "exceeds it. See Q-HR-1.",
        "rateSource",
      );
    }
  }

  await db.execute(sql`
    UPDATE hr.overtime_request
       SET status = 'approved', approved_hours = ${String(approved)},
           rate_multiple = ${rate || null},
           rate_source = ${rate ? options.rateSource!.trim() : null},
           decided_at = now(), decided_by = ${principal.userId},
           decision_note = ${options.note?.trim() || null}, updated_by = ${principal.userId}
     WHERE id = ${requestId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.OVERTIME_APPROVED,
    entityType: "overtime_request",
    entityId: requestId,
    newValues: {
      requestNo: request.request_no,
      requestedHours: request.requested_hours,
      approvedHours: String(approved),
      dayKind: request.day_kind,
      rateMultiple: rate || null,
      rateRecorded: Boolean(rate),
    },
    reason: options.note ?? null,
  });
}

/**
 * Records the rate on a claim that was approved without one.
 *
 * This is the missing half of the Q-HR-1 design. Approving hours with no rate is deliberate and
 * correct — the hours are a fact somebody witnessed, the multiple is a legal question nobody had
 * answered — and payroll duly refuses to pay such a claim, putting an OT-UNRATED line on the payslip
 * saying so. But `decideOvertime` was the only writer of `rate_multiple` and it refuses anything that
 * is not still `submitted`, so once the answer arrived there was no way to apply it. Every claim
 * approved during the months Q-HR-1 was open was unpayable for good, and the platform's own message
 * told the employee their overtime existed and would not be paid.
 *
 * Deliberately not a re-approval: the hours are not reopened, the approver is not re-recorded, and the
 * decision that was made stands. Only the rate and its source change, and only while payroll has not
 * taken the claim — after that the database refuses, and the correction is a supplementary run.
 */
export async function rateOvertime(
  db: Executor,
  principal: Principal,
  requestId: string,
  options: { rateMultiple: string; rateSource: string; context?: AuditContext },
): Promise<void> {
  requireCapability(principal, "hr.overtime.approve");

  const request = await lockOvertime(db, requestId);

  if (request.status !== "approved") {
    throw new ConflictError(
      request.status === "rejected"
        ? "That request was refused, so there is nothing to rate."
        : "A rate belongs on an approved request. Approve the hours first — the rate can be supplied " +
          "at the same time or afterwards.",
    );
  }
  if (request.payroll_run_id) {
    throw new ConflictError(
      "Payroll has already paid this claim at the rate it had. Changing it here would leave the " +
        "payslip and the record disagreeing; correct it with a supplementary run.",
    );
  }
  // The same rule as approving. The multiple is a legal figure rather than a discretionary one, but
  // it is still the difference between being paid and not, and nobody settles that for themselves.
  if (request.employee_id === principal.employeeId) {
    throw new ConflictError(
      "You cannot put a rate on your own overtime. Somebody else has to record it.",
    );
  }

  const multiple = Number(options.rateMultiple?.trim());
  if (!Number.isFinite(multiple) || multiple <= 0 || multiple > 10) {
    throw new ValidationError("That is not a rate multiple.", "rateMultiple");
  }
  if (!options.rateSource?.trim()) {
    throw new ValidationError(
      "Say where the rate comes from — the Employment Act section, or the company policy that " +
        "exceeds it. A rate without a source is a rate nobody can defend, and this one multiplies " +
        "somebody's hourly pay.",
      "rateSource",
    );
  }

  await db.execute(sql`
    UPDATE hr.overtime_request
       SET rate_multiple = ${options.rateMultiple.trim()},
           rate_source = ${options.rateSource.trim()},
           updated_by = ${principal.userId}
     WHERE id = ${requestId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.OVERTIME_RATED,
    entityType: "overtime_request",
    entityId: requestId,
    oldValues: { rateMultiple: request.rate_multiple, rateSource: request.rate_source },
    newValues: {
      requestNo: request.request_no,
      dayKind: request.day_kind,
      approvedHours: request.approved_hours,
      rateMultiple: options.rateMultiple.trim(),
      rateSource: options.rateSource.trim(),
    },
    reason: options.rateSource.trim(),
  });
}

export async function listOvertime(
  db: Executor,
  filters: {
    employeeId?: string;
    status?: RequestStatus;
    from?: string;
    to?: string;
    unpaidOnly?: boolean;
    limit?: number;
  } = {},
): Promise<OvertimeView[]> {
  const where = [sql`true`];
  if (filters.employeeId) where.push(sql`o.employee_id = ${filters.employeeId}`);
  if (filters.status) where.push(sql`o.status = ${filters.status}`);
  if (filters.from) where.push(sql`o.work_date >= ${toIsoDate(parseIsoDate(filters.from, "from"))}::date`);
  if (filters.to) where.push(sql`o.work_date <= ${toIsoDate(parseIsoDate(filters.to, "to"))}::date`);
  if (filters.unpaidOnly) where.push(sql`o.payroll_run_id IS NULL`);

  const result = await db.execute<Record<string, never>>(sql`
    SELECT o.id, o.request_no, o.employee_id, e.full_name AS employee_name, o.work_date,
           o.starts_at, o.ends_at, o.requested_hours, o.approved_hours, o.day_kind,
           o.rate_multiple, o.rate_source, o.reason, o.status, o.is_retrospective,
           u.full_name AS decided_by_name, o.decision_note, o.payroll_run_id, o.created_at,
           a.extra_minutes
      FROM hr.overtime_request o
      JOIN hr.employee e ON e.id = o.employee_id
      LEFT JOIN auth."user" u ON u.id = o.decided_by
      -- The clock's own figure for the same day, so the screens can show what was
      -- claimed next to what the device recorded.
      LEFT JOIN hr.attendance a ON a.employee_id = o.employee_id AND a.work_date = o.work_date
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY o.work_date DESC, o.created_at DESC
     LIMIT ${Math.min(Math.max(filters.limit ?? 200, 1), 1000)}
  `);

  return (result.rows ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      requestNo: (row.request_no as string) ?? null,
      employeeId: String(row.employee_id),
      employeeName: String(row.employee_name),
      workDate: String(row.work_date).slice(0, 10),
      startsAt: row.starts_at ? String(row.starts_at).slice(0, 5) : null,
      endsAt: row.ends_at ? String(row.ends_at).slice(0, 5) : null,
      requestedHours: Number(row.requested_hours),
      approvedHours: row.approved_hours === null ? null : Number(row.approved_hours),
      dayKind: row.day_kind as DayKind,
      rateMultiple: (row.rate_multiple as string) ?? null,
      rateSource: (row.rate_source as string) ?? null,
      reason: String(row.reason),
      status: row.status as RequestStatus,
      isRetrospective: Boolean(row.is_retrospective),
      decidedByName: (row.decided_by_name as string) ?? null,
      decisionNote: (row.decision_note as string) ?? null,
      paid: row.payroll_run_id !== null,
      extraMinutesOnClock: row.extra_minutes === null ? null : Number(row.extra_minutes),
      createdAt: row.created_at as Date | string,
    };
  });
}

/**
 * Days where the clock recorded extra time that nobody has claimed.
 *
 * The honest other half of the distinction. Extra time with no request is not
 * something to pay; it is something to look at, because it is either unrecorded
 * overtime somebody is owed a conversation about, or a scan nobody closed properly.
 */
export async function unclaimedExtraTime(
  db: Executor,
  range: { from: string; to: string; minimumMinutes?: number },
): Promise<Array<{ employeeId: string; employeeName: string; workDate: string; extraMinutes: number }>> {
  const from = toIsoDate(parseIsoDate(range.from, "from"));
  const to = toIsoDate(parseIsoDate(range.to, "to"));
  const minimum = Math.max(range.minimumMinutes ?? 30, 1);

  const result = await db.execute<{
    employee_id: string;
    employee_name: string;
    work_date: string;
    extra_minutes: number;
  }>(sql`
    SELECT a.employee_id, e.full_name AS employee_name, a.work_date, a.extra_minutes
      FROM hr.attendance a
      JOIN hr.employee e ON e.id = a.employee_id
     WHERE a.work_date BETWEEN ${from}::date AND ${to}::date
       AND COALESCE(a.extra_minutes, 0) >= ${minimum}
       AND NOT EXISTS (
         SELECT 1 FROM hr.overtime_request o
          WHERE o.employee_id = a.employee_id AND o.work_date = a.work_date
       )
     ORDER BY a.extra_minutes DESC, a.work_date DESC
     LIMIT 200
  `);

  return (result.rows ?? []).map((row) => ({
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    workDate: String(row.work_date).slice(0, 10),
    extraMinutes: Number(row.extra_minutes),
  }));
}

// ---------------------------------------------------------------------------
// Time off and early clock-out
// ---------------------------------------------------------------------------

export type TimeoffKind = "late_in" | "early_out" | "during_day";

export interface TimeoffView {
  id: string;
  requestNo: string | null;
  employeeId: string;
  employeeName: string;
  workDate: string;
  kind: TimeoffKind;
  startsAt: string | null;
  endsAt: string | null;
  minutes: number;
  isPaid: boolean;
  reason: string;
  status: RequestStatus;
  decidedByName: string | null;
  decisionNote: string | null;
  createdAt: Date | string;
}

export async function requestTimeoff(
  db: Executor,
  principal: Principal,
  input: {
    employeeId: string;
    workDate: string;
    kind: TimeoffKind;
    startsAt?: string | null;
    endsAt?: string | null;
    minutes: number;
    isPaid?: boolean;
    reason: string;
  },
  context?: AuditContext,
): Promise<{ id: string }> {
  const forSomebodyElse = principal.employeeId !== input.employeeId;
  if (forSomebodyElse) requireCapability(principal, "hr.timeoff.approve");
  else requireCapability(principal, "hr.timeoff.request");

  const workDate = toIsoDate(parseIsoDate(input.workDate, "workDate"));
  if (!Number.isInteger(input.minutes) || input.minutes <= 0 || input.minutes > 720) {
    throw new ValidationError("Enter how many minutes, up to twelve hours.", "minutes");
  }
  if (!input.reason?.trim()) {
    throw new ValidationError("Say what the time is for.", "reason");
  }

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.timeoff_request
      (employee_id, work_date, kind, starts_at, ends_at, minutes, is_paid, reason, created_by)
    VALUES (${input.employeeId}, ${workDate}, ${input.kind}, ${input.startsAt?.trim() || null},
            ${input.endsAt?.trim() || null}, ${input.minutes}, ${input.isPaid ?? true},
            ${input.reason.trim()}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.TIMEOFF_REQUESTED,
    entityType: "timeoff_request",
    entityId: id,
    newValues: { employeeId: input.employeeId, workDate, kind: input.kind, minutes: input.minutes },
  });

  return { id };
}

export async function submitTimeoff(
  db: Executor,
  principal: Principal,
  requestId: string,
  context?: AuditContext,
): Promise<{ requestNo: string }> {
  const request = await db.execute<{ id: string; employee_id: string; status: string; work_date: string }>(
    sql`SELECT id, employee_id, status, work_date FROM hr.timeoff_request WHERE id = ${requestId} FOR UPDATE`,
  );
  const row = request.rows?.[0];
  if (!row) throw new NotFoundError("That request no longer exists.");
  if (row.status !== "draft") throw new ConflictError(`That request is already ${row.status}.`);

  if (row.employee_id !== principal.employeeId) {
    requireCapability(principal, "hr.timeoff.approve");
  } else {
    requireCapability(principal, "hr.timeoff.request");
  }

  const requestNo = await allocateDocumentNumber(db, "timeoff", { on: row.work_date });

  await db.execute(sql`
    UPDATE hr.timeoff_request
       SET status = 'submitted', request_no = ${requestNo}, submitted_at = now(),
           updated_by = ${principal.userId}
     WHERE id = ${requestId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.TIMEOFF_REQUESTED,
    entityType: "timeoff_request",
    entityId: requestId,
    newValues: { requestNo, submitted: true },
  });

  return { requestNo };
}

export async function decideTimeoff(
  db: Executor,
  principal: Principal,
  requestId: string,
  decision: "approved" | "rejected",
  options: { note?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "hr.timeoff.approve");

  const found = await db.execute<{ employee_id: string; status: string; minutes: number }>(
    sql`SELECT employee_id, status, minutes FROM hr.timeoff_request WHERE id = ${requestId} FOR UPDATE`,
  );
  const row = found.rows?.[0];
  if (!row) throw new NotFoundError("That request no longer exists.");
  if (row.status !== "submitted") {
    throw new ConflictError(
      row.status === "draft" ? "That request has not been submitted yet." : `That request is already ${row.status}.`,
    );
  }
  if (row.employee_id === principal.employeeId) {
    throw new ConflictError("You cannot approve your own time off.");
  }
  if (decision === "rejected" && !options.note?.trim()) {
    throw new ValidationError("Say why it is being refused.", "note");
  }

  await db.execute(sql`
    UPDATE hr.timeoff_request
       SET status = ${decision}, decided_at = now(), decided_by = ${principal.userId},
           decision_note = ${options.note?.trim() || null}, updated_by = ${principal.userId}
     WHERE id = ${requestId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.TIMEOFF_DECIDED,
    entityType: "timeoff_request",
    entityId: requestId,
    newValues: { decision, minutes: row.minutes },
    reason: options.note ?? null,
  });
}

export async function listTimeoff(
  db: Executor,
  filters: { employeeId?: string; status?: RequestStatus; from?: string; to?: string; limit?: number } = {},
): Promise<TimeoffView[]> {
  const where = [sql`true`];
  if (filters.employeeId) where.push(sql`t.employee_id = ${filters.employeeId}`);
  if (filters.status) where.push(sql`t.status = ${filters.status}`);
  if (filters.from) where.push(sql`t.work_date >= ${toIsoDate(parseIsoDate(filters.from, "from"))}::date`);
  if (filters.to) where.push(sql`t.work_date <= ${toIsoDate(parseIsoDate(filters.to, "to"))}::date`);

  const result = await db.execute<Record<string, never>>(sql`
    SELECT t.id, t.request_no, t.employee_id, e.full_name AS employee_name, t.work_date, t.kind,
           t.starts_at, t.ends_at, t.minutes, t.is_paid, t.reason, t.status,
           u.full_name AS decided_by_name, t.decision_note, t.created_at
      FROM hr.timeoff_request t
      JOIN hr.employee e ON e.id = t.employee_id
      LEFT JOIN auth."user" u ON u.id = t.decided_by
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY t.work_date DESC, t.created_at DESC
     LIMIT ${Math.min(Math.max(filters.limit ?? 200, 1), 1000)}
  `);

  return (result.rows ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      requestNo: (row.request_no as string) ?? null,
      employeeId: String(row.employee_id),
      employeeName: String(row.employee_name),
      workDate: String(row.work_date).slice(0, 10),
      kind: row.kind as TimeoffKind,
      startsAt: row.starts_at ? String(row.starts_at).slice(0, 5) : null,
      endsAt: row.ends_at ? String(row.ends_at).slice(0, 5) : null,
      minutes: Number(row.minutes),
      isPaid: Boolean(row.is_paid),
      reason: String(row.reason),
      status: row.status as RequestStatus,
      decidedByName: (row.decided_by_name as string) ?? null,
      decisionNote: (row.decision_note as string) ?? null,
      createdAt: row.created_at as Date | string,
    };
  });
}

interface LockedOvertime extends Record<string, unknown> {
  id: string;
  employee_id: string;
  work_date: string;
  requested_hours: string;
  approved_hours: string | null;
  status: RequestStatus;
  day_kind: DayKind;
  rate_multiple: string | null;
  rate_source: string | null;
  payroll_run_id: string | null;
  request_no: string | null;
}

async function lockOvertime(db: Executor, requestId: string): Promise<LockedOvertime> {
  const result = await db.execute<LockedOvertime>(sql`
    SELECT id, employee_id, work_date, requested_hours, approved_hours, status, day_kind,
           rate_multiple, rate_source, payroll_run_id, request_no
      FROM hr.overtime_request WHERE id = ${requestId} FOR UPDATE
  `);
  const row = result.rows?.[0];
  if (!row) throw new NotFoundError("That overtime request no longer exists.");
  return row;
}
