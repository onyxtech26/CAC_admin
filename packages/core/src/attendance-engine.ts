import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ValidationError } from "./errors.js";
import { parseIsoDate, toIsoDate } from "./dates.js";
import { minutesOfDay, scheduledMinutesFor } from "./people.js";

/**
 * Turning clock times into minutes.
 *
 * The arithmetic is deliberately a **pure function** with every input passed in:
 * the schedule, the holidays, the approved leave, the approved absences. Nothing in
 * `computeDay` reads a database, which is what makes it testable against the awkward
 * cases — a night shift, a public holiday somebody worked anyway, a day covered by
 * half a day's leave — without constructing a fixture for each.
 *
 * Two rules are worth stating before the code, because both are easy to get wrong
 * and expensive when wrong.
 *
 * **Extra time is not payable overtime.** `extraMinutes` is what the clock and the
 * schedule say. Whether any of it is paid is a separate decision recorded as an
 * approved overtime request, and the engine copies *that* figure into
 * `approvedOtMinutes`. A system that pays `extraMinutes` pays for every evening
 * somebody stayed late to finish something nobody asked them to.
 *
 * **An authorised absence is not lateness.** Approved time off reduces the
 * scheduled day rather than counting against the person. Without that distinction,
 * permission to attend a hospital appointment looks exactly like turning up two
 * hours late.
 */

export interface DayInputs {
  /** The date being computed, as an ISO date. */
  workDate: string;
  /** Instants, or null where the scan is missing. */
  clockIn: Date | string | null;
  clockOut: Date | string | null;
  /** The schedule in force for this person on this date. */
  schedule: {
    workDays: number[];
    startsAt: string;
    endsAt: string;
    breakMinutes: number;
    graceMinutes: number;
    crossesMidnight: boolean;
  } | null;
  /** Whether the date is a public holiday the person observes. */
  isHoliday: boolean;
  isHalfDayHoliday?: boolean;
  /** Set when approved leave covers the day, with the fraction covered. */
  leave?: { typeName: string; fraction: number; isPaid: boolean } | null;
  /** Approved short absences, in minutes. */
  approvedTimeoffMinutes?: number;
  /** Approved paid overtime for the day, in minutes. Never inferred from the clock. */
  approvedOvertimeMinutes?: number;
  /** True when the person was marked absent by hand. */
  markedAbsent?: boolean;
}

export interface DayResult {
  scheduledMinutes: number;
  workedMinutes: number;
  lateMinutes: number;
  earlyOutMinutes: number;
  /** Time beyond the scheduled day. Arithmetic, not a payment. */
  extraMinutes: number;
  /** Copied from an approved overtime request, never derived from the clock. */
  approvedOtMinutes: number;
  isAbsent: boolean;
  isRestDay: boolean;
  isHoliday: boolean;
  /** Set when the day cannot be computed honestly, and why. */
  note: string | null;
}

/** A weekday number where 1 is Monday, from an ISO date. */
export function weekdayOf(isoDate: string): number {
  const day = parseIsoDate(isoDate).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * Minutes between two instants, ignoring the calendar.
 *
 * A night shift's clock-out is on the following date, so subtracting the times of
 * day would give a negative span. Working from instants avoids the whole question.
 */
function minutesBetween(from: Date | string, to: Date | string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000);
}

/** The clock time in Malaysia, as minutes since midnight. */
function localMinutes(instant: Date | string): number {
  const text = new Date(instant).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kuala_Lumpur",
  });
  return minutesOfDay(text);
}

/**
 * Computes one day.
 *
 * The order of the checks is the substance of the function:
 *
 *   1. a rest day or a holiday has no scheduled time, so nothing can be late;
 *   2. approved leave covers its fraction of the day and nothing is owed for it;
 *   3. a missing clock-out cannot be guessed, so the day is reported rather than
 *      computed;
 *   4. only then is lateness, early departure and extra time arithmetic.
 */
export function computeDay(inputs: DayInputs): DayResult {
  const base: DayResult = {
    scheduledMinutes: 0,
    workedMinutes: 0,
    lateMinutes: 0,
    earlyOutMinutes: 0,
    extraMinutes: 0,
    approvedOtMinutes: inputs.approvedOvertimeMinutes ?? 0,
    isAbsent: false,
    isRestDay: false,
    isHoliday: inputs.isHoliday,
    note: null,
  };

  const schedule = inputs.schedule;
  if (!schedule) {
    return {
      ...base,
      note: "No work schedule applies to this person on this date, so nothing can be measured.",
    };
  }

  const isWorkingDay = schedule.workDays.includes(weekdayOf(inputs.workDate));
  const fullDay = scheduledMinutesFor(schedule);

  // A rest day or a public holiday: no scheduled time, so nothing is late, nothing
  // is early, and every minute worked is extra.
  if (!isWorkingDay || inputs.isHoliday) {
    const worked =
      inputs.clockIn && inputs.clockOut
        ? Math.max(0, minutesBetween(inputs.clockIn, inputs.clockOut) - schedule.breakMinutes)
        : 0;

    return {
      ...base,
      isRestDay: !isWorkingDay,
      scheduledMinutes: inputs.isHoliday && inputs.isHalfDayHoliday ? Math.round(fullDay / 2) : 0,
      workedMinutes: worked,
      extraMinutes: worked,
      note:
        worked > 0
          ? `Worked on ${inputs.isHoliday ? "a public holiday" : "a rest day"}. Whether any of it is ` +
            "paid, and at what rate, is an overtime decision rather than arithmetic."
          : null,
    };
  }

  // Approved leave. A full day covered means nothing is expected; a half day halves
  // what is expected.
  const leaveFraction = Math.min(Math.max(inputs.leave?.fraction ?? 0, 0), 1);
  const timeoff = Math.max(inputs.approvedTimeoffMinutes ?? 0, 0);

  // Approved absence reduces what was expected rather than counting against the
  // person: permission to be away is not lateness.
  const scheduled = Math.max(0, Math.round(fullDay * (1 - leaveFraction)) - timeoff);

  if (leaveFraction >= 1) {
    return {
      ...base,
      scheduledMinutes: 0,
      workedMinutes: 0,
      note: `Covered by approved ${inputs.leave?.typeName ?? "leave"}.`,
    };
  }

  if (inputs.markedAbsent) {
    return {
      ...base,
      scheduledMinutes: scheduled,
      isAbsent: true,
      note: "Recorded as absent.",
    };
  }

  if (!inputs.clockIn && !inputs.clockOut) {
    return {
      ...base,
      scheduledMinutes: scheduled,
      isAbsent: true,
      note: "No scan at all on a working day, which reads as an absence until somebody says otherwise.",
    };
  }

  if (!inputs.clockIn || !inputs.clockOut) {
    // Half a day's evidence. Guessing the other half would invent a figure that
    // then becomes a payslip, so the day is left uncomputed and reported.
    return {
      ...base,
      scheduledMinutes: scheduled,
      note:
        inputs.clockIn === null
          ? "There is a clock-out but no clock-in, so the day cannot be measured."
          : "There is a clock-in but no clock-out, so the day cannot be measured.",
    };
  }

  const worked = Math.max(0, minutesBetween(inputs.clockIn, inputs.clockOut) - schedule.breakMinutes);

  const scheduledStart = minutesOfDay(schedule.startsAt);
  const scheduledEnd = minutesOfDay(schedule.endsAt);
  const actualStart = localMinutes(inputs.clockIn);
  const actualEnd = localMinutes(inputs.clockOut);

  // Lateness is measured against the grace period, which is a company decision and
  // lives on the schedule rather than in this function.
  const lateness = actualStart - scheduledStart;
  const late = lateness > schedule.graceMinutes ? lateness : 0;

  // On a shift that crosses midnight the clock-out is on the next calendar day, so
  // comparing times of day would report a twelve-hour early departure.
  const early = schedule.crossesMidnight
    ? 0
    : Math.max(0, scheduledEnd - actualEnd);

  return {
    ...base,
    scheduledMinutes: scheduled,
    workedMinutes: worked,
    // Lateness that was authorised as time off is not lateness. The approved
    // minutes are deducted before the lateness is reported.
    lateMinutes: Math.max(0, late - timeoff),
    earlyOutMinutes: Math.max(0, early - Math.max(0, timeoff - late)),
    extraMinutes: Math.max(0, worked - scheduled),
    isAbsent: false,
    note: null,
  };
}

// ---------------------------------------------------------------------------
// Running the engine over stored days
// ---------------------------------------------------------------------------

export interface RecalculationResult {
  considered: number;
  updated: number;
  /** Days the engine refused to compute, with the reason, rather than guessing. */
  unresolved: Array<{ employeeName: string; workDate: string; note: string }>;
  skippedFinal: number;
}

/**
 * Recomputes a range of attendance.
 *
 * Only **draft** rows are touched. A finalised day is evidence that payroll may
 * already have read, and silently recomputing it would change a payslip's basis
 * after the fact; those are counted and reported instead.
 *
 * Everything the arithmetic needs is fetched once and handed to `computeDay`, so the
 * function that decides the numbers has no access to the database and can be tested
 * on its own.
 */
export async function recalculateAttendance(
  db: Executor,
  principal: Principal,
  range: { from: string; to: string; employeeId?: string },
  context?: AuditContext,
): Promise<RecalculationResult> {
  requireCapability(principal, "hr.attendance.edit");

  const from = toIsoDate(parseIsoDate(range.from, "from"));
  const to = toIsoDate(parseIsoDate(range.to, "to"));
  if (to < from) throw new ValidationError("The range ends before it begins.", "to");

  const rows = await db.execute<{
    id: string;
    employee_id: string;
    employee_name: string;
    work_date: string;
    clock_in: Date | string | null;
    clock_out: Date | string | null;
    is_absent: boolean;
    status: string;
    work_days: number[] | string | null;
    starts_at: string | null;
    ends_at: string | null;
    break_minutes: number | null;
    grace_minutes: number | null;
    crosses_midnight: boolean | null;
  }>(sql`
    SELECT a.id, a.employee_id, e.full_name AS employee_name, a.work_date,
           a.clock_in, a.clock_out, a.is_absent, a.status,
           ws.work_days, ws.starts_at, ws.ends_at, ws.break_minutes, ws.grace_minutes,
           ws.crosses_midnight
      FROM hr.attendance a
      JOIN hr.employee e ON e.id = a.employee_id
      -- The person's own schedule, falling back to the default. A LEFT JOIN so a
      -- person with neither is reported rather than silently dropped.
      LEFT JOIN hr.work_schedule ws
        ON ws.id = COALESCE(e.work_schedule_id, (SELECT id FROM hr.work_schedule WHERE is_default LIMIT 1))
     WHERE a.work_date BETWEEN ${from}::date AND ${to}::date
       AND ${range.employeeId ? sql`a.employee_id = ${range.employeeId}` : sql`true`}
     ORDER BY a.work_date, e.full_name
  `);

  const holidays = await db.execute<{ holiday_on: string; is_half_day: boolean }>(sql`
    SELECT holiday_on, is_half_day FROM hr.public_holiday
     WHERE holiday_on BETWEEN ${from}::date AND ${to}::date
  `);
  const holidayMap = new Map(
    (holidays.rows ?? []).map((row) => [String(row.holiday_on).slice(0, 10), row.is_half_day]),
  );

  // Approved leave in the window, expanded to the days it covers.
  const leave = await db.execute<{
    employee_id: string;
    starts_on: string;
    ends_on: string;
    half_day_start: boolean;
    half_day_end: boolean;
    type_name: string;
    is_paid: boolean;
    request_id: string;
  }>(sql`
    SELECT r.employee_id, r.starts_on, r.ends_on, r.half_day_start, r.half_day_end,
           t.name AS type_name, t.is_paid, r.id AS request_id
      FROM hr.leave_request r
      JOIN hr.leave_type t ON t.id = r.leave_type_id
     WHERE r.status = 'approved'
       AND daterange(r.starts_on, r.ends_on, '[]') && daterange(${from}::date, ${to}::date, '[]')
  `);

  const leaveByDay = new Map<
    string,
    { typeName: string; fraction: number; isPaid: boolean; requestId: string }
  >();
  for (const row of leave.rows ?? []) {
    const startsOn = String(row.starts_on).slice(0, 10);
    const endsOn = String(row.ends_on).slice(0, 10);
    for (let date = startsOn; date <= endsOn; date = nextDay(date)) {
      const isFirst = date === startsOn;
      const isLast = date === endsOn;
      const fraction =
        (isFirst && row.half_day_start) || (isLast && row.half_day_end) ? 0.5 : 1;
      leaveByDay.set(`${row.employee_id}|${date}`, {
        typeName: row.type_name,
        fraction,
        isPaid: row.is_paid,
        requestId: row.request_id,
      });
    }
  }

  const timeoff = await db.execute<{ employee_id: string; work_date: string; minutes: number }>(sql`
    SELECT employee_id, work_date, SUM(minutes)::int AS minutes
      FROM hr.timeoff_request
     WHERE status = 'approved' AND work_date BETWEEN ${from}::date AND ${to}::date
     GROUP BY employee_id, work_date
  `);
  const timeoffMap = new Map(
    (timeoff.rows ?? []).map((row) => [
      `${row.employee_id}|${String(row.work_date).slice(0, 10)}`,
      row.minutes,
    ]),
  );

  // Approved overtime — the payable figure, which the clock never decides.
  const overtime = await db.execute<{
    employee_id: string;
    work_date: string;
    approved_hours: string;
  }>(sql`
    SELECT employee_id, work_date, approved_hours FROM hr.overtime_request
     WHERE status = 'approved' AND approved_hours IS NOT NULL
       AND work_date BETWEEN ${from}::date AND ${to}::date
  `);
  const overtimeMap = new Map(
    (overtime.rows ?? []).map((row) => [
      `${row.employee_id}|${String(row.work_date).slice(0, 10)}`,
      Math.round(Number(row.approved_hours) * 60),
    ]),
  );

  const unresolved: RecalculationResult["unresolved"] = [];
  let updated = 0;
  let skippedFinal = 0;

  for (const row of rows.rows ?? []) {
    const workDate = String(row.work_date).slice(0, 10);

    if (row.status === "final") {
      skippedFinal += 1;
      continue;
    }

    const key = `${row.employee_id}|${workDate}`;
    const leaveForDay = leaveByDay.get(key) ?? null;

    const result = computeDay({
      workDate,
      clockIn: row.clock_in,
      clockOut: row.clock_out,
      schedule:
        row.starts_at === null || row.ends_at === null
          ? null
          : {
              workDays: readIntArray(row.work_days),
              startsAt: String(row.starts_at).slice(0, 5),
              endsAt: String(row.ends_at).slice(0, 5),
              breakMinutes: row.break_minutes ?? 60,
              graceMinutes: row.grace_minutes ?? 0,
              crossesMidnight: row.crosses_midnight ?? false,
            },
      isHoliday: holidayMap.has(workDate),
      isHalfDayHoliday: holidayMap.get(workDate) ?? false,
      leave: leaveForDay,
      approvedTimeoffMinutes: timeoffMap.get(key) ?? 0,
      approvedOvertimeMinutes: overtimeMap.get(key) ?? 0,
      markedAbsent: row.is_absent,
    });

    await db.execute(sql`
      UPDATE hr.attendance SET
        scheduled_minutes = ${result.scheduledMinutes},
        worked_minutes = ${result.workedMinutes},
        late_minutes = ${result.lateMinutes},
        early_out_minutes = ${result.earlyOutMinutes},
        extra_minutes = ${result.extraMinutes},
        approved_ot_minutes = ${result.approvedOtMinutes},
        timeoff_minutes = ${timeoffMap.get(key) ?? 0},
        is_absent = ${result.isAbsent},
        is_holiday = ${result.isHoliday},
        is_rest_day = ${result.isRestDay},
        on_leave_type = ${leaveForDay?.typeName ?? null},
        leave_request_id = ${leaveForDay?.requestId ?? null},
        calculated_at = now(),
        updated_by = ${principal.userId}
      WHERE id = ${row.id}
    `);
    updated += 1;

    // A note means the engine declined to produce a figure. Those are the days
    // somebody has to look at, and finalising the period will refuse until they do.
    if (result.note && result.workedMinutes === 0 && !result.isAbsent && !leaveForDay) {
      unresolved.push({ employeeName: row.employee_name, workDate, note: result.note });
    }
  }

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ATTENDANCE_CALCULATED,
    entityType: "attendance",
    entityId: `${from}..${to}`,
    newValues: {
      from,
      to,
      considered: rows.rows?.length ?? 0,
      updated,
      skippedFinal,
      unresolved: unresolved.length,
    },
  });

  return { considered: rows.rows?.length ?? 0, updated, unresolved, skippedFinal };
}

function nextDay(isoDate: string): string {
  const date = parseIsoDate(isoDate);
  date.setUTCDate(date.getUTCDate() + 1);
  return toIsoDate(date);
}

/** PGlite and node-postgres disagree on how an int[] arrives; handle both. */
function readIntArray(value: number[] | string | null): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value !== "string") return [];
  return value
    .replace(/[{}]/g, "")
    .split(",")
    .filter((part) => part.trim() !== "")
    .map(Number);
}

/**
 * A month's figures per person, for the payroll screen and the monthly report.
 *
 * Draws only from **final** days, because a draft figure is one nobody has agreed
 * to yet. `daysNotCalculated` is reported rather than hidden: a month where the
 * engine has not run is a month whose totals mean nothing.
 */
export interface AttendanceSummary {
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  daysRecorded: number;
  daysFinal: number;
  daysNotCalculated: number;
  daysWorked: number;
  daysAbsent: number;
  daysOnLeave: number;
  daysOnHoliday: number;
  scheduledMinutes: number;
  workedMinutes: number;
  lateMinutes: number;
  lateOccasions: number;
  earlyOutMinutes: number;
  extraMinutes: number;
  approvedOtMinutes: number;
}

export async function attendanceSummary(
  db: Executor,
  range: { from: string; to: string; departmentId?: string },
): Promise<AttendanceSummary[]> {
  const from = toIsoDate(parseIsoDate(range.from, "from"));
  const to = toIsoDate(parseIsoDate(range.to, "to"));

  const result = await db.execute<Record<string, never>>(sql`
    SELECT e.id AS employee_id, e.employee_no, e.full_name AS employee_name,
           count(a.id)::int AS days_recorded,
           count(a.id) FILTER (WHERE a.status = 'final')::int AS days_final,
           count(a.id) FILTER (WHERE a.calculated_at IS NULL)::int AS days_not_calculated,
           count(a.id) FILTER (WHERE a.status = 'final' AND COALESCE(a.worked_minutes, 0) > 0)::int AS days_worked,
           count(a.id) FILTER (WHERE a.status = 'final' AND a.is_absent)::int AS days_absent,
           count(a.id) FILTER (WHERE a.status = 'final' AND a.on_leave_type IS NOT NULL)::int AS days_on_leave,
           count(a.id) FILTER (WHERE a.status = 'final' AND a.is_holiday)::int AS days_on_holiday,
           COALESCE(SUM(a.scheduled_minutes) FILTER (WHERE a.status = 'final'), 0)::int AS scheduled_minutes,
           COALESCE(SUM(a.worked_minutes) FILTER (WHERE a.status = 'final'), 0)::int AS worked_minutes,
           COALESCE(SUM(a.late_minutes) FILTER (WHERE a.status = 'final'), 0)::int AS late_minutes,
           count(a.id) FILTER (WHERE a.status = 'final' AND COALESCE(a.late_minutes, 0) > 0)::int AS late_occasions,
           COALESCE(SUM(a.early_out_minutes) FILTER (WHERE a.status = 'final'), 0)::int AS early_out_minutes,
           COALESCE(SUM(a.extra_minutes) FILTER (WHERE a.status = 'final'), 0)::int AS extra_minutes,
           COALESCE(SUM(a.approved_ot_minutes) FILTER (WHERE a.status = 'final'), 0)::int AS approved_ot_minutes
      FROM hr.employee e
      LEFT JOIN hr.attendance a
        ON a.employee_id = e.id AND a.work_date BETWEEN ${from}::date AND ${to}::date
     WHERE e.status IN ('active', 'on_leave', 'suspended')
       AND ${range.departmentId ? sql`e.department_id = ${range.departmentId}` : sql`true`}
     GROUP BY e.id, e.employee_no, e.full_name
     ORDER BY e.full_name
  `);

  return (result.rows ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      employeeId: String(row.employee_id),
      employeeNo: String(row.employee_no),
      employeeName: String(row.employee_name),
      daysRecorded: Number(row.days_recorded),
      daysFinal: Number(row.days_final),
      daysNotCalculated: Number(row.days_not_calculated),
      daysWorked: Number(row.days_worked),
      daysAbsent: Number(row.days_absent),
      daysOnLeave: Number(row.days_on_leave),
      daysOnHoliday: Number(row.days_on_holiday),
      scheduledMinutes: Number(row.scheduled_minutes),
      workedMinutes: Number(row.worked_minutes),
      lateMinutes: Number(row.late_minutes),
      lateOccasions: Number(row.late_occasions),
      earlyOutMinutes: Number(row.early_out_minutes),
      extraMinutes: Number(row.extra_minutes),
      approvedOtMinutes: Number(row.approved_ot_minutes),
    };
  });
}
