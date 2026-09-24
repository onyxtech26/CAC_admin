import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, requireEmployeeScope, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, today, toIsoDate } from "./dates.js";
import { allocateDocumentNumber } from "./sequence.js";
import { weekdayOf } from "./attendance-engine.js";

/**
 * Leave: the types, the balances, and the requests.
 *
 * Two things about this module are deliberate and worth understanding before
 * reading it.
 *
 * **No entitlement is authored here.** How many days of annual or sick leave
 * somebody is entitled to depends on their length of service under the Employment
 * Act, and on whatever CAC's policy adds above the statutory floor. That is a legal
 * schedule. `leave_type.default_days` is nullable, requires a source before it can
 * hold a figure, and nothing is seeded. See Q-HR-3. A system that guesses fourteen
 * days because fourteen is a common number is a system that under-pays somebody
 * their statutory minimum.
 *
 * **Days are counted against the schedule, and stored.** A week of leave is not
 * five days for everybody: it depends on the working week, and on whether a public
 * holiday falls inside it. `countLeaveDays` works that out, and the figure is stored
 * on the request rather than recomputed on read — recomputing it later against a
 * changed schedule would silently restate how much leave somebody took.
 */

export type LeaveStatus = "draft" | "submitted" | "approved" | "rejected" | "cancelled";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeaveTypeInput {
  code: string;
  name: string;
  isPaid?: boolean;
  isStatutory?: boolean;
  defaultDays?: string | null;
  entitlementSource?: string | null;
  requiresDocument?: boolean;
  carryForwardMax?: string | null;
  allowsBackdating?: boolean;
  countsAsAttendance?: boolean;
  notes?: string | null;
  isActive?: boolean;
}

export interface LeaveTypeView {
  id: string;
  code: string;
  name: string;
  isPaid: boolean;
  isStatutory: boolean;
  defaultDays: string | null;
  entitlementSource: string | null;
  requiresDocument: boolean;
  carryForwardMax: string | null;
  allowsBackdating: boolean;
  countsAsAttendance: boolean;
  notes: string | null;
  isActive: boolean;
  /** True when the type is usable: it has an entitlement figure with a source. */
  isConfigured: boolean;
}

export async function saveLeaveType(
  db: Executor,
  principal: Principal,
  input: LeaveTypeInput & { leaveTypeId?: string },
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "hr.leave.manage_types");

  const code = requireText(input.code, "Give the leave type a short code.", "code").toUpperCase();
  const name = requireText(input.name, "Name the leave type.", "name");

  // A figure without a source is a figure nobody can defend. The same rule as a tax
  // rate, and for the same reason: this one decides whether somebody has been given
  // their statutory minimum.
  if (input.defaultDays !== undefined && input.defaultDays !== null && input.defaultDays !== "") {
    const days = Number(input.defaultDays);
    if (!Number.isFinite(days) || days < 0 || days > 365) {
      throw new ValidationError("That is not a number of days.", "defaultDays");
    }
    if (!input.entitlementSource?.trim()) {
      throw new ValidationError(
        "Say where the entitlement comes from — the Employment Act section, or the company " +
          "policy that grants more than it. A number nobody can source is a number nobody can " +
          "defend, and for statutory leave it decides whether somebody has had their minimum.",
        "entitlementSource",
      );
    }
  }

  if (input.leaveTypeId) {
    const before = await db.execute<{ name: string; default_days: string | null }>(
      sql`SELECT name, default_days FROM hr.leave_type WHERE id = ${input.leaveTypeId}`,
    );
    if (!before.rows?.[0]) throw new NotFoundError("That leave type no longer exists.");

    await db.execute(sql`
      UPDATE hr.leave_type SET
        name = ${name},
        is_paid = ${input.isPaid ?? true},
        is_statutory = ${input.isStatutory ?? false},
        default_days = ${emptyToNull(input.defaultDays)},
        entitlement_source = ${input.entitlementSource?.trim() || null},
        requires_document = ${input.requiresDocument ?? false},
        carry_forward_max = ${emptyToNull(input.carryForwardMax)},
        allows_backdating = ${input.allowsBackdating ?? false},
        counts_as_attendance = ${input.countsAsAttendance ?? true},
        notes = ${input.notes?.trim() || null},
        is_active = ${input.isActive ?? true},
        updated_by = ${principal.userId}
      WHERE id = ${input.leaveTypeId}
    `);

    await writeAudit(db, {
      ...context,
      actorUserId: principal.userId,
      actorLabel: principal.email,
      action: AUDIT.LEAVE_TYPE_SAVED,
      entityType: "leave_type",
      entityId: input.leaveTypeId,
      oldValues: { name: before.rows[0]!.name, defaultDays: before.rows[0]!.default_days },
      newValues: { name, defaultDays: input.defaultDays ?? null, source: input.entitlementSource ?? null },
    });

    return { id: input.leaveTypeId };
  }

  const existing = await db.execute<{ id: string }>(
    sql`SELECT id FROM hr.leave_type WHERE code = ${code}`,
  );
  if (existing.rows?.[0]) throw new ConflictError("There is already a leave type with that code.");

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.leave_type
      (code, name, is_paid, is_statutory, default_days, entitlement_source, requires_document,
       carry_forward_max, allows_backdating, counts_as_attendance, notes, created_by)
    VALUES (${code}, ${name}, ${input.isPaid ?? true}, ${input.isStatutory ?? false},
            ${emptyToNull(input.defaultDays)}, ${input.entitlementSource?.trim() || null},
            ${input.requiresDocument ?? false}, ${emptyToNull(input.carryForwardMax)},
            ${input.allowsBackdating ?? false}, ${input.countsAsAttendance ?? true},
            ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.LEAVE_TYPE_SAVED,
    entityType: "leave_type",
    entityId: id,
    newValues: {
      code,
      name,
      isStatutory: input.isStatutory ?? false,
      defaultDays: input.defaultDays ?? null,
      source: input.entitlementSource ?? null,
    },
  });

  return { id };
}

export async function listLeaveTypes(
  db: Executor,
  options: { includeInactive?: boolean } = {},
): Promise<LeaveTypeView[]> {
  const result = await db.execute<{
    id: string;
    code: string;
    name: string;
    is_paid: boolean;
    is_statutory: boolean;
    default_days: string | null;
    entitlement_source: string | null;
    requires_document: boolean;
    carry_forward_max: string | null;
    allows_backdating: boolean;
    counts_as_attendance: boolean;
    notes: string | null;
    is_active: boolean;
  }>(sql`
    SELECT id, code, name, is_paid, is_statutory, default_days, entitlement_source,
           requires_document, carry_forward_max, allows_backdating, counts_as_attendance,
           notes, is_active
      FROM hr.leave_type
     WHERE ${options.includeInactive ? sql`true` : sql`is_active`}
     ORDER BY is_statutory DESC, code
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    isPaid: row.is_paid,
    isStatutory: row.is_statutory,
    defaultDays: row.default_days,
    entitlementSource: row.entitlement_source,
    requiresDocument: row.requires_document,
    carryForwardMax: row.carry_forward_max,
    allowsBackdating: row.allows_backdating,
    countsAsAttendance: row.counts_as_attendance,
    notes: row.notes,
    isActive: row.is_active,
    isConfigured: row.default_days !== null && row.entitlement_source !== null,
  }));
}

// ---------------------------------------------------------------------------
// Counting days
// ---------------------------------------------------------------------------

export interface LeaveDayCount {
  days: number;
  /** Dates inside the span that were not working days, so were not counted. */
  skipped: Array<{ date: string; why: "rest day" | "public holiday" }>;
}

/**
 * How many days of leave a span actually uses.
 *
 * Not simply the number of dates: a week is five days for a five-day week and four
 * for a four-day one, a public holiday inside the span is not leave, and a half day
 * at either end counts as a half.
 *
 * Pure, so the awkward cases can be tested directly: a request that starts on a
 * Friday and ends on a Monday uses two days, not four.
 */
export function countLeaveDays(input: {
  startsOn: string;
  endsOn: string;
  halfDayStart?: boolean;
  halfDayEnd?: boolean;
  workDays: number[];
  holidays: string[];
}): LeaveDayCount {
  const holidays = new Set(input.holidays);
  const skipped: LeaveDayCount["skipped"] = [];
  let days = 0;

  for (let date = input.startsOn; date <= input.endsOn; date = addOneDay(date)) {
    if (holidays.has(date)) {
      skipped.push({ date, why: "public holiday" });
      continue;
    }
    if (!input.workDays.includes(weekdayOf(date))) {
      skipped.push({ date, why: "rest day" });
      continue;
    }

    const isFirst = date === input.startsOn;
    const isLast = date === input.endsOn;
    const half = (isFirst && input.halfDayStart) || (isLast && input.halfDayEnd);
    days += half ? 0.5 : 1;
  }

  return { days, skipped };
}

function addOneDay(isoDate: string): string {
  const date = parseIsoDate(isoDate);
  date.setUTCDate(date.getUTCDate() + 1);
  return toIsoDate(date);
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export interface LeaveBalanceView {
  id: string;
  employeeId: string;
  employeeName: string;
  leaveTypeId: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  year: number;
  entitledDays: number;
  carriedDays: number;
  adjustmentDays: number;
  takenDays: number;
  /** entitled + carried + adjustment − taken. */
  remainingDays: number;
  notes: string | null;
}

export async function setLeaveBalance(
  db: Executor,
  principal: Principal,
  input: {
    employeeId: string;
    leaveTypeId: string;
    year: number;
    entitledDays: string;
    carriedDays?: string;
    adjustmentDays?: string;
    notes?: string | null;
    reason?: string | null;
  },
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "hr.leave.manage_balance");

  const entitled = Number(input.entitledDays);
  if (!Number.isFinite(entitled) || entitled < 0) {
    throw new ValidationError("That is not a number of days.", "entitledDays");
  }

  const adjustment = Number(input.adjustmentDays ?? "0");
  if (!Number.isFinite(adjustment)) {
    throw new ValidationError("That is not a number of days.", "adjustmentDays");
  }

  // An adjustment is a correction to somebody's entitlement. Without a reason on the
  // record it is indistinguishable from a mistake.
  if (adjustment !== 0 && !input.reason?.trim()) {
    throw new ValidationError(
      "An adjustment changes somebody's entitlement. Say why — it is recorded against your name.",
      "reason",
    );
  }

  const existing = await db.execute<{ id: string; entitled_days: string; adjustment_days: string }>(sql`
    SELECT id, entitled_days, adjustment_days FROM hr.leave_balance
     WHERE employee_id = ${input.employeeId} AND leave_type_id = ${input.leaveTypeId}
       AND year = ${input.year}
  `);
  const current = existing.rows?.[0];

  let id: string;
  if (current) {
    await db.execute(sql`
      UPDATE hr.leave_balance SET
        entitled_days = ${input.entitledDays},
        carried_days = ${input.carriedDays ?? "0"},
        adjustment_days = ${input.adjustmentDays ?? "0"},
        notes = ${input.notes?.trim() || null},
        updated_by = ${principal.userId}
      WHERE id = ${current.id}
    `);
    id = current.id;
  } else {
    const created = await db.execute<{ id: string }>(sql`
      INSERT INTO hr.leave_balance
        (employee_id, leave_type_id, year, entitled_days, carried_days, adjustment_days, notes, created_by)
      VALUES (${input.employeeId}, ${input.leaveTypeId}, ${input.year}, ${input.entitledDays},
              ${input.carriedDays ?? "0"}, ${input.adjustmentDays ?? "0"},
              ${input.notes?.trim() || null}, ${principal.userId})
      RETURNING id
    `);
    id = created.rows![0]!.id;
  }

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.LEAVE_BALANCE_SET,
    entityType: "leave_balance",
    entityId: id,
    oldValues: current
      ? { entitledDays: current.entitled_days, adjustmentDays: current.adjustment_days }
      : undefined,
    newValues: {
      year: input.year,
      entitledDays: input.entitledDays,
      carriedDays: input.carriedDays ?? "0",
      adjustmentDays: input.adjustmentDays ?? "0",
    },
    reason: input.reason ?? null,
  });

  return { id };
}

export async function listLeaveBalances(
  db: Executor,
  filters: { employeeId?: string; year?: number } = {},
): Promise<LeaveBalanceView[]> {
  const year = filters.year ?? today().getUTCFullYear();

  const result = await db.execute<{
    id: string;
    employee_id: string;
    employee_name: string;
    leave_type_id: string;
    leave_type_code: string;
    leave_type_name: string;
    year: number;
    entitled_days: string;
    carried_days: string;
    adjustment_days: string;
    taken_days: string;
    notes: string | null;
  }>(sql`
    SELECT b.id, b.employee_id, e.full_name AS employee_name,
           b.leave_type_id, t.code AS leave_type_code, t.name AS leave_type_name,
           b.year, b.entitled_days, b.carried_days, b.adjustment_days, b.taken_days, b.notes
      FROM hr.leave_balance b
      JOIN hr.employee e ON e.id = b.employee_id
      JOIN hr.leave_type t ON t.id = b.leave_type_id
     WHERE b.year = ${year}
       AND ${filters.employeeId ? sql`b.employee_id = ${filters.employeeId}` : sql`true`}
     ORDER BY e.full_name, t.code
  `);

  return (result.rows ?? []).map((row) => {
    const entitled = Number(row.entitled_days);
    const carried = Number(row.carried_days);
    const adjustment = Number(row.adjustment_days);
    const taken = Number(row.taken_days);
    return {
      id: row.id,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      leaveTypeId: row.leave_type_id,
      leaveTypeCode: row.leave_type_code,
      leaveTypeName: row.leave_type_name,
      year: row.year,
      entitledDays: entitled,
      carriedDays: carried,
      adjustmentDays: adjustment,
      takenDays: taken,
      remainingDays: entitled + carried + adjustment - taken,
      notes: row.notes,
    };
  });
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface LeaveRequestInput {
  employeeId: string;
  leaveTypeId: string;
  startsOn: string;
  endsOn: string;
  halfDayStart?: boolean;
  halfDayEnd?: boolean;
  reason?: string | null;
  documentPath?: string | null;
}

export interface LeaveRequestView {
  id: string;
  requestNo: string | null;
  employeeId: string;
  employeeName: string;
  leaveTypeId: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  isPaid: boolean;
  startsOn: string;
  endsOn: string;
  halfDayStart: boolean;
  halfDayEnd: boolean;
  days: number;
  reason: string | null;
  status: LeaveStatus;
  documentPath: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  cancelReason: string | null;
  createdAt: Date | string;
}

/**
 * Raises a leave request.
 *
 * Somebody may raise their own; raising one for somebody else needs the approval
 * capability, because otherwise "requesting leave" is a way to put a day of absence
 * on a colleague's record.
 */
export async function requestLeave(
  db: Executor,
  principal: Principal,
  input: LeaveRequestInput,
  context?: AuditContext,
): Promise<{ id: string; days: number }> {
  const forSomebodyElse = principal.employeeId !== input.employeeId;
  if (forSomebodyElse) requireCapability(principal, "hr.leave.approve");
  else requireCapability(principal, "hr.leave.request");

  const startsOn = toIsoDate(parseIsoDate(input.startsOn, "startsOn"));
  const endsOn = toIsoDate(parseIsoDate(input.endsOn, "endsOn"));
  if (endsOn < startsOn) throw new ValidationError("The leave ends before it begins.", "endsOn");

  const type = await db.execute<{
    id: string;
    name: string;
    allows_backdating: boolean;
    requires_document: boolean;
    is_active: boolean;
    default_days: string | null;
    entitlement_source: string | null;
  }>(sql`
    SELECT id, name, allows_backdating, requires_document, is_active, default_days, entitlement_source
      FROM hr.leave_type WHERE id = ${input.leaveTypeId}
  `);
  const leaveType = type.rows?.[0];
  if (!leaveType) throw new NotFoundError("That leave type no longer exists.");
  if (!leaveType.is_active) throw new ConflictError(`${leaveType.name} is no longer in use.`);

  if (leaveType.default_days === null || leaveType.entitlement_source === null) {
    throw new ConflictError(
      `${leaveType.name} has no entitlement recorded, so there is nothing to draw against. ` +
        "The entitlement and its source have to be set first — see Q-HR-3.",
    );
  }

  const now = toIsoDate(today());
  if (startsOn < now && !leaveType.allows_backdating) {
    throw new ValidationError(
      `${leaveType.name} cannot be requested for a day that has passed. If it should be able to ` +
        "be, mark the type as allowing it.",
      "startsOn",
    );
  }

  if (leaveType.requires_document && !input.documentPath?.trim()) {
    throw new ValidationError(
      `${leaveType.name} needs supporting evidence attached.`,
      "documentPath",
    );
  }

  // The working week and the holidays as they are now. The resulting day count is
  // stored, so a later change to either does not restate this request.
  const schedule = await scheduleFor(db, input.employeeId);
  const holidays = await db.execute<{ holiday_on: string }>(sql`
    SELECT holiday_on FROM hr.public_holiday
     WHERE holiday_on BETWEEN ${startsOn}::date AND ${endsOn}::date
  `);

  const counted = countLeaveDays({
    startsOn,
    endsOn,
    halfDayStart: input.halfDayStart,
    halfDayEnd: input.halfDayEnd,
    workDays: schedule.workDays,
    holidays: (holidays.rows ?? []).map((row) => String(row.holiday_on).slice(0, 10)),
  });

  if (counted.days <= 0) {
    throw new ValidationError(
      "That span contains no working days — it is entirely rest days or public holidays, so no " +
        "leave would be used.",
      "startsOn",
    );
  }

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.leave_request
      (employee_id, leave_type_id, starts_on, ends_on, half_day_start, half_day_end, days,
       reason, document_path, created_by)
    VALUES (${input.employeeId}, ${input.leaveTypeId}, ${startsOn}, ${endsOn},
            ${input.halfDayStart ?? false}, ${input.halfDayEnd ?? false}, ${counted.days},
            ${input.reason?.trim() || null}, ${input.documentPath?.trim() || null},
            ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.LEAVE_REQUESTED,
    entityType: "leave_request",
    entityId: id,
    newValues: {
      employeeId: input.employeeId,
      type: leaveType.name,
      startsOn,
      endsOn,
      days: counted.days,
      raisedForSomebodyElse: forSomebodyElse || undefined,
    },
  });

  return { id, days: counted.days };
}

export async function submitLeave(
  db: Executor,
  principal: Principal,
  requestId: string,
  context?: AuditContext,
): Promise<{ requestNo: string }> {
  const request = await lockLeave(db, requestId);
  if (request.status !== "draft") {
    throw new ConflictError(`That request is already ${request.status}.`);
  }

  // Your own, or somebody's whose leave you may approve.
  if (request.employee_id !== principal.employeeId) {
    requireCapability(principal, "hr.leave.approve");
  } else {
    requireCapability(principal, "hr.leave.request");
  }

  const requestNo = await allocateDocumentNumber(db, "leave", { on: request.starts_on });

  await db.execute(sql`
    UPDATE hr.leave_request
       SET status = 'submitted', request_no = ${requestNo}, submitted_at = now(),
           updated_by = ${principal.userId}
     WHERE id = ${requestId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.LEAVE_SUBMITTED,
    entityType: "leave_request",
    entityId: requestId,
    newValues: { requestNo },
  });

  return { requestNo };
}

/**
 * Approves or refuses a request.
 *
 * Refuses to approve leave the person does not have, unless the balance is
 * deliberately overridden — which is recorded. An approver who cannot see that the
 * balance is short will approve it, and the shortfall surfaces at year end when it
 * cannot be fixed.
 */
export async function decideLeave(
  db: Executor,
  principal: Principal,
  requestId: string,
  decision: "approved" | "rejected",
  options: { note?: string | null; allowNegativeBalance?: boolean; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "hr.leave.approve");

  const request = await lockLeave(db, requestId);
  if (request.status !== "submitted") {
    throw new ConflictError(
      request.status === "draft"
        ? "That request has not been submitted yet."
        : `That request is already ${request.status}.`,
    );
  }

  // Nobody approves their own leave, however senior.
  if (request.employee_id === principal.employeeId) {
    throw new ConflictError(
      "You cannot approve your own leave. Somebody else has to decide it.",
    );
  }

  if (decision === "rejected" && !options.note?.trim()) {
    throw new ValidationError(
      "Say why it is being refused. The person sees this.",
      "note",
    );
  }

  if (decision === "approved") {
    const year = Number(String(request.starts_on).slice(0, 4));
    const balance = await db.execute<{
      entitled_days: string;
      carried_days: string;
      adjustment_days: string;
      taken_days: string;
    }>(sql`
      SELECT entitled_days, carried_days, adjustment_days, taken_days FROM hr.leave_balance
       WHERE employee_id = ${request.employee_id} AND leave_type_id = ${request.leave_type_id}
         AND year = ${year}
    `);
    const row = balance.rows?.[0];

    if (!row) {
      throw new ConflictError(
        `No ${year} balance has been set for this person and leave type, so there is nothing to ` +
          "draw against. Set the entitlement first.",
      );
    }

    const remaining =
      Number(row.entitled_days) +
      Number(row.carried_days) +
      Number(row.adjustment_days) -
      Number(row.taken_days);

    if (Number(request.days) > remaining && !options.allowNegativeBalance) {
      throw new ConflictError(
        `That would take ${request.days} days against a remaining balance of ${remaining}. ` +
          "Approve it deliberately as an exception, or correct the entitlement first.",
      );
    }
  }

  await db.execute(sql`
    UPDATE hr.leave_request
       SET status = ${decision}, decided_at = now(), decided_by = ${principal.userId},
           decision_note = ${options.note?.trim() || null}, updated_by = ${principal.userId}
     WHERE id = ${requestId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: decision === "approved" ? AUDIT.LEAVE_APPROVED : AUDIT.LEAVE_REJECTED,
    entityType: "leave_request",
    entityId: requestId,
    newValues: {
      requestNo: request.request_no,
      days: request.days,
      overrodeBalance: options.allowNegativeBalance ? true : undefined,
    },
    reason: options.note ?? null,
  });
}

export async function cancelLeave(
  db: Executor,
  principal: Principal,
  requestId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  if (!reason?.trim()) throw new ValidationError("Say why it is being cancelled.", "reason");

  const request = await lockLeave(db, requestId);

  // Your own, or somebody's whose leave you may approve.
  if (request.employee_id !== principal.employeeId) {
    requireCapability(principal, "hr.leave.approve");
  } else {
    requireCapability(principal, "hr.leave.request");
  }

  if (request.status !== "approved" && request.status !== "submitted") {
    throw new ConflictError(`A ${request.status} request cannot be cancelled.`);
  }

  await db.execute(sql`
    UPDATE hr.leave_request
       SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${principal.userId},
           cancel_reason = ${reason.trim()}, updated_by = ${principal.userId}
     WHERE id = ${requestId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.LEAVE_CANCELLED,
    entityType: "leave_request",
    entityId: requestId,
    oldValues: { status: request.status, days: request.days },
    reason: reason.trim(),
  });
}

export async function listLeaveRequests(
  db: Executor,
  filters: {
    employeeId?: string;
    status?: LeaveStatus;
    from?: string;
    to?: string;
    limit?: number;
  } = {},
): Promise<LeaveRequestView[]> {
  const where = [sql`true`];
  if (filters.employeeId) where.push(sql`r.employee_id = ${filters.employeeId}`);
  if (filters.status) where.push(sql`r.status = ${filters.status}`);
  if (filters.from) where.push(sql`r.ends_on >= ${toIsoDate(parseIsoDate(filters.from, "from"))}::date`);
  if (filters.to) where.push(sql`r.starts_on <= ${toIsoDate(parseIsoDate(filters.to, "to"))}::date`);

  const result = await db.execute<Record<string, never>>(sql`
    SELECT r.id, r.request_no, r.employee_id, e.full_name AS employee_name,
           r.leave_type_id, t.code AS leave_type_code, t.name AS leave_type_name, t.is_paid,
           r.starts_on, r.ends_on, r.half_day_start, r.half_day_end, r.days, r.reason,
           r.status, r.document_path, u.full_name AS decided_by_name, r.decision_note,
           r.cancel_reason, r.created_at
      FROM hr.leave_request r
      JOIN hr.employee e ON e.id = r.employee_id
      JOIN hr.leave_type t ON t.id = r.leave_type_id
      LEFT JOIN auth."user" u ON u.id = r.decided_by
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY r.starts_on DESC, r.created_at DESC
     LIMIT ${Math.min(Math.max(filters.limit ?? 200, 1), 1000)}
  `);

  return (result.rows ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      requestNo: (row.request_no as string) ?? null,
      employeeId: String(row.employee_id),
      employeeName: String(row.employee_name),
      leaveTypeId: String(row.leave_type_id),
      leaveTypeCode: String(row.leave_type_code),
      leaveTypeName: String(row.leave_type_name),
      isPaid: Boolean(row.is_paid),
      startsOn: String(row.starts_on).slice(0, 10),
      endsOn: String(row.ends_on).slice(0, 10),
      halfDayStart: Boolean(row.half_day_start),
      halfDayEnd: Boolean(row.half_day_end),
      days: Number(row.days),
      reason: (row.reason as string) ?? null,
      status: row.status as LeaveStatus,
      documentPath: (row.document_path as string) ?? null,
      decidedByName: (row.decided_by_name as string) ?? null,
      decisionNote: (row.decision_note as string) ?? null,
      cancelReason: (row.cancel_reason as string) ?? null,
      createdAt: row.created_at as Date | string,
    };
  });
}

/**
 * One person's own leave, scoped by the session.
 *
 * `requireEmployeeScope` is the same guard the payslip screens use: changing the id
 * in the URL does not work.
 */
export async function leaveForEmployee(
  db: Executor,
  principal: Principal,
  employeeId: string,
): Promise<LeaveRequestView[]> {
  requireEmployeeScope({
    principal,
    targetEmployeeId: employeeId,
    viewAllCapability: "hr.leave.view",
    viewOwnCapability: "hr.leave.request",
  });

  return listLeaveRequests(db, { employeeId, limit: 500 });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface LockedLeave extends Record<string, unknown> {
  id: string;
  employee_id: string;
  leave_type_id: string;
  starts_on: string;
  ends_on: string;
  days: string;
  status: LeaveStatus;
  request_no: string | null;
}

async function lockLeave(db: Executor, requestId: string): Promise<LockedLeave> {
  const result = await db.execute<LockedLeave>(sql`
    SELECT id, employee_id, leave_type_id, starts_on, ends_on, days, status, request_no
      FROM hr.leave_request WHERE id = ${requestId} FOR UPDATE
  `);
  const row = result.rows?.[0];
  if (!row) throw new NotFoundError("That leave request no longer exists.");
  return row;
}

/**
 * The work schedule in force for somebody, falling back to the default.
 *
 * Shared by leave counting and the attendance engine's SQL. A person with neither
 * their own schedule nor a default gets a five-day week, and the caller is told
 * nothing — which is why `listWorkSchedules` surfaces "no default" as a problem on
 * the organisation screen rather than leaving it to be discovered here.
 */
async function scheduleFor(
  db: Executor,
  employeeId: string,
): Promise<{ workDays: number[] }> {
  const result = await db.execute<{ work_days: number[] | string | null }>(sql`
    SELECT ws.work_days
      FROM hr.employee e
      LEFT JOIN hr.work_schedule ws
        ON ws.id = COALESCE(e.work_schedule_id, (SELECT id FROM hr.work_schedule WHERE is_default LIMIT 1))
     WHERE e.id = ${employeeId}
  `);
  const raw = result.rows?.[0]?.work_days;

  if (Array.isArray(raw)) return { workDays: raw.map(Number) };
  if (typeof raw === "string") {
    return {
      workDays: raw
        .replace(/[{}]/g, "")
        .split(",")
        .filter((part) => part.trim() !== "")
        .map(Number),
    };
  }
  return { workDays: [1, 2, 3, 4, 5] };
}

function requireText(value: string | null | undefined, message: string, field: string): string {
  const text = (value ?? "").trim();
  if (text === "") throw new ValidationError(message, field);
  return text;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = value.trim();
  return text === "" ? null : text;
}
