import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import { hashPassword } from "./password.js";
import { parseIsoDate, today, toIsoDate } from "./dates.js";
import { AuthorizationError, resolveCapabilities, type Principal } from "./authz.js";
import { ValidationError } from "./errors.js";
import {
  addPublicHoliday,
  createDepartment,
  createEmployee,
  createWorkSchedule,
} from "./people.js";
import { openAttendancePeriod, finaliseAttendancePeriod, recordAttendance } from "./attendance.js";
import {
  attendanceSummary,
  computeDay,
  recalculateAttendance,
  weekdayOf,
} from "./attendance-engine.js";
import {
  cancelLeave,
  countLeaveDays,
  decideLeave,
  listLeaveBalances,
  listLeaveRequests,
  requestLeave,
  saveLeaveType,
  setLeaveBalance,
  submitLeave,
} from "./leave.js";
import {
  dayKindFor,
  decideOvertime,
  decideTimeoff,
  listOvertime,
  requestOvertime,
  requestTimeoff,
  submitOvertime,
  submitTimeoff,
  unclaimedExtraTime,
} from "./overtime.js";
import {
  acknowledgeAppraisal,
  listAppraisals,
  openCycle,
  recordReview,
  recordSelfAssessment,
  saveCycle,
  validateTemplate,
} from "./appraisals.js";

/**
 * Phase 6: the workflows around attendance.
 *
 * The distinction this phase exists to hold is the first thing proven:
 *
 * > Extra time is calculated. Payable overtime is a separate decision.
 *
 * Then: an authorised absence is not lateness; a public holiday is not a normal day
 * worked; approved leave does not overlap approved leave; nobody approves their own
 * anything; and an acknowledged appraisal never changes.
 */

let db: Database;
let close: () => Promise<void>;

let hrManager: Principal;
let hrAdmin: Principal;
let accountant: Principal;
/** An ordinary employee, with their own employee record attached. */
let staff: Principal;
let manager: Principal;

let scheduleId: string;
let aishahId: string;
let faizalId: string;
let annualLeaveId: string;
let sickLeaveId: string;

/**
 * Leave has to be requested for a day that has not happened yet, so the fixture
 * works forwards from the clock rather than hard-coding a year. A hard-coded future
 * date is a test that passes until that date arrives and then fails for a reason
 * nobody remembers.
 */
function nextWeekdayAtLeast(daysAhead: number, weekday: number): string {
  const date = today();
  date.setUTCDate(date.getUTCDate() + daysAhead);
  while (weekdayOf(toIsoDate(date)) !== weekday) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return toIsoDate(date);
}

function plusDays(isoDate: string, days: number): string {
  const date = parseIsoDate(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

/** The Monday at least a fortnight out, and the days around it. */
let futureMonday: string;
let futureTuesday: string;
let futureWednesday: string;
let futureSaturday: string;
let futureSunday: string;
let leaveYear: number;

async function makePrincipal(
  email: string,
  roles: string[],
  employeeId?: string,
): Promise<Principal> {
  const hash = await hashPassword("correct-horse-battery-staple");
  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO auth."user" (email, password_hash, full_name, employee_id)
    VALUES (${email}, ${hash}, ${email}, ${employeeId ?? null}) RETURNING id
  `);
  const userId = created.rows![0]!.id;
  for (const role of roles) {
    await db.execute(sql`
      INSERT INTO auth.user_role (user_id, role_id)
      SELECT ${userId}, id FROM auth.role WHERE key = ${role}
    `);
  }
  return {
    userId,
    email,
    fullName: email,
    roles,
    capabilities: await resolveCapabilities(db, userId),
    employeeId: employeeId ?? null,
    sessionId: "00000000-0000-0000-0000-000000000000",
    mfaSatisfied: true,
    mustChangePassword: false,
  };
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  await runMigrations(db);
  await seed(db);

  hrManager = await makePrincipal("wf-hr-manager@cac.test", ["HR_MANAGER"]);
  hrAdmin = await makePrincipal("wf-hr-admin@cac.test", ["HR_ADMIN"]);
  accountant = await makePrincipal("wf-accountant@cac.test", ["ACCOUNTANT"]);

  const departmentId = (
    await createDepartment(db, hrManager, { code: "OPS", name: "Operations" })
  ).id;

  scheduleId = (
    await createWorkSchedule(db, hrManager, {
      code: "STD",
      name: "Standard week",
      workDays: [1, 2, 3, 4, 5],
      startsAt: "09:00",
      endsAt: "18:00",
      breakMinutes: 60,
      graceMinutes: 10,
      isDefault: true,
    })
  ).id;

  faizalId = (
    await createEmployee(db, hrManager, {
      fullName: "Faizal bin Omar",
      joinedOn: "2026-01-05",
      departmentId,
      workScheduleId: scheduleId,
      basicSalary: "8000.00",
      deviceUserId: "200",
    })
  ).id;

  aishahId = (
    await createEmployee(db, hrManager, {
      fullName: "Aishah binti Rahman",
      joinedOn: "2026-01-05",
      departmentId,
      workScheduleId: scheduleId,
      reportsToId: faizalId,
      basicSalary: "4500.00",
      deviceUserId: "201",
    })
  ).id;

  staff = await makePrincipal("wf-aishah@cac.test", ["EMPLOYEE"], aishahId);
  manager = await makePrincipal("wf-faizal@cac.test", ["MANAGEMENT"], faizalId);

  // One holiday in the past, for the engine, and one in the future, for leave.
  await addPublicHoliday(db, hrManager, {
    holidayOn: "2026-05-01",
    name: "Labour Day",
    sourceRef: "Federal gazette, as advised by CAC",
  });

  futureMonday = nextWeekdayAtLeast(14, 1);
  futureTuesday = plusDays(futureMonday, 1);
  futureWednesday = plusDays(futureMonday, 2);
  futureSaturday = plusDays(futureMonday, 5);
  futureSunday = plusDays(futureMonday, 6);
  leaveYear = Number(futureMonday.slice(0, 4));

  await addPublicHoliday(db, hrManager, {
    holidayOn: futureTuesday,
    name: "Fixture holiday",
    sourceRef: "Test fixture, not a real holiday",
  });
}, 120_000);

afterAll(async () => {
  await close();
});

// ---------------------------------------------------------------------------
describe("the arithmetic of a day", () => {
  const schedule = {
    workDays: [1, 2, 3, 4, 5],
    startsAt: "09:00",
    endsAt: "18:00",
    breakMinutes: 60,
    graceMinutes: 10,
    crossesMidnight: false,
  };

  it("knows which weekday a date is, with Monday as one", () => {
    expect(weekdayOf("2026-05-04")).toBe(1); // a Monday
    expect(weekdayOf("2026-05-10")).toBe(7); // a Sunday
  });

  it("computes a plain day", () => {
    const result = computeDay({
      workDate: "2026-05-04",
      clockIn: "2026-05-04T09:00:00+08:00",
      clockOut: "2026-05-04T18:00:00+08:00",
      schedule,
      isHoliday: false,
    });

    expect(result.scheduledMinutes).toBe(480);
    expect(result.workedMinutes).toBe(480);
    expect(result.lateMinutes).toBe(0);
    expect(result.extraMinutes).toBe(0);
  });

  it("forgives lateness inside the grace period and counts it beyond", () => {
    const withinGrace = computeDay({
      workDate: "2026-05-04",
      clockIn: "2026-05-04T09:08:00+08:00",
      clockOut: "2026-05-04T18:00:00+08:00",
      schedule,
      isHoliday: false,
    });
    expect(withinGrace.lateMinutes).toBe(0);

    const beyond = computeDay({
      workDate: "2026-05-04",
      clockIn: "2026-05-04T09:25:00+08:00",
      clockOut: "2026-05-04T18:00:00+08:00",
      schedule,
      isHoliday: false,
    });
    // The whole lateness, not just the part beyond the grace period: grace decides
    // whether it counts, not how much of it counts.
    expect(beyond.lateMinutes).toBe(25);
  });

  it("does not treat an authorised absence as lateness", () => {
    // Two hours' approved time off, arriving two hours late.
    const result = computeDay({
      workDate: "2026-05-04",
      clockIn: "2026-05-04T11:00:00+08:00",
      clockOut: "2026-05-04T18:00:00+08:00",
      schedule,
      isHoliday: false,
      approvedTimeoffMinutes: 120,
    });

    // Permission to be away is not lateness, and what was expected of the day
    // shrinks by the same amount rather than the person being short.
    expect(result.lateMinutes).toBe(0);
    expect(result.scheduledMinutes).toBe(360);
    expect(result.workedMinutes).toBe(360);
    expect(result.extraMinutes).toBe(0);
  });

  it("counts extra time beyond the scheduled day, and never calls it payable", () => {
    const result = computeDay({
      workDate: "2026-05-04",
      clockIn: "2026-05-04T09:00:00+08:00",
      clockOut: "2026-05-04T20:30:00+08:00",
      schedule,
      isHoliday: false,
    });

    expect(result.workedMinutes).toBe(630);
    expect(result.extraMinutes).toBe(150);
    // Nothing is payable until somebody approves it. The clock cannot decide that.
    expect(result.approvedOtMinutes).toBe(0);
  });

  it("carries approved overtime through, separately from extra time", () => {
    const result = computeDay({
      workDate: "2026-05-04",
      clockIn: "2026-05-04T09:00:00+08:00",
      clockOut: "2026-05-04T20:30:00+08:00",
      schedule,
      isHoliday: false,
      approvedOvertimeMinutes: 120,
    });

    // Two and a half hours on the clock, two hours approved. The difference is the
    // point of having both numbers.
    expect(result.extraMinutes).toBe(150);
    expect(result.approvedOtMinutes).toBe(120);
  });

  it("treats a rest day as having no schedule, so nothing is late", () => {
    const result = computeDay({
      workDate: "2026-05-09", // a Saturday
      clockIn: "2026-05-09T10:00:00+08:00",
      clockOut: "2026-05-09T14:00:00+08:00",
      schedule,
      isHoliday: false,
    });

    expect(result.isRestDay).toBe(true);
    expect(result.scheduledMinutes).toBe(0);
    expect(result.lateMinutes).toBe(0);
    expect(result.extraMinutes).toBe(180);
    expect(result.note).toContain("rest day");
  });

  it("treats a public holiday the same way, and says so", () => {
    const result = computeDay({
      workDate: "2026-05-01", // a Friday, and Labour Day
      clockIn: "2026-05-01T09:00:00+08:00",
      clockOut: "2026-05-01T13:00:00+08:00",
      schedule,
      isHoliday: true,
    });

    expect(result.isHoliday).toBe(true);
    expect(result.extraMinutes).toBe(180);
    expect(result.note).toContain("public holiday");
  });

  it("handles a shift that crosses midnight without reporting a huge early departure", () => {
    const night = {
      workDays: [1, 2, 3, 4, 5],
      startsAt: "22:00",
      endsAt: "06:00",
      breakMinutes: 30,
      graceMinutes: 10,
      crossesMidnight: true,
    };

    const result = computeDay({
      workDate: "2026-05-04",
      clockIn: "2026-05-04T22:00:00+08:00",
      clockOut: "2026-05-05T06:00:00+08:00",
      schedule: night,
      isHoliday: false,
    });

    expect(result.workedMinutes).toBe(450);
    expect(result.scheduledMinutes).toBe(450);
    // Comparing times of day would report a twelve-hour early departure here.
    expect(result.earlyOutMinutes).toBe(0);
    expect(result.extraMinutes).toBe(0);
  });

  it("refuses to compute a day with half its evidence", () => {
    const result = computeDay({
      workDate: "2026-05-04",
      clockIn: "2026-05-04T08:50:00+08:00",
      clockOut: null,
      schedule,
      isHoliday: false,
    });

    // Guessing the other half would invent a figure that becomes a payslip.
    expect(result.workedMinutes).toBe(0);
    expect(result.isAbsent).toBe(false);
    expect(result.note).toContain("cannot be measured");
  });

  it("reads no scan at all on a working day as an absence", () => {
    const result = computeDay({
      workDate: "2026-05-04",
      clockIn: null,
      clockOut: null,
      schedule,
      isHoliday: false,
    });

    expect(result.isAbsent).toBe(true);
    expect(result.scheduledMinutes).toBe(480);
  });

  it("expects nothing of a day covered by full-day leave", () => {
    const result = computeDay({
      workDate: "2026-05-04",
      clockIn: null,
      clockOut: null,
      schedule,
      isHoliday: false,
      leave: { typeName: "Annual leave", fraction: 1, isPaid: true },
    });

    expect(result.isAbsent).toBe(false);
    expect(result.scheduledMinutes).toBe(0);
    expect(result.note).toContain("Annual leave");
  });

  it("halves the expected day for half a day's leave", () => {
    const result = computeDay({
      workDate: "2026-05-04",
      clockIn: "2026-05-04T14:00:00+08:00",
      clockOut: "2026-05-04T18:00:00+08:00",
      schedule,
      isHoliday: false,
      leave: { typeName: "Annual leave", fraction: 0.5, isPaid: true },
    });

    expect(result.scheduledMinutes).toBe(240);
    expect(result.workedMinutes).toBe(180);
    expect(result.extraMinutes).toBe(0);
  });

  it("says so rather than guessing when nobody has a schedule", () => {
    const result = computeDay({
      workDate: "2026-05-04",
      clockIn: "2026-05-04T09:00:00+08:00",
      clockOut: "2026-05-04T18:00:00+08:00",
      schedule: null,
      isHoliday: false,
    });

    expect(result.note).toContain("No work schedule");
    expect(result.workedMinutes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("counting leave days", () => {
  it("counts working days only, not dates", () => {
    // Friday to Monday is two working days, not four.
    const counted = countLeaveDays({
      startsOn: "2026-05-08",
      endsOn: "2026-05-11",
      workDays: [1, 2, 3, 4, 5],
      holidays: [],
    });

    expect(counted.days).toBe(2);
    expect(counted.skipped.map((row) => row.why)).toEqual(["rest day", "rest day"]);
  });

  it("does not charge leave for a public holiday inside the span", () => {
    const counted = countLeaveDays({
      startsOn: "2026-04-30",
      endsOn: "2026-05-04",
      workDays: [1, 2, 3, 4, 5],
      holidays: ["2026-05-01"],
    });

    // Thursday, [Labour Day], [Sat], [Sun], Monday = two days.
    expect(counted.days).toBe(2);
    expect(counted.skipped.find((row) => row.date === "2026-05-01")?.why).toBe("public holiday");
  });

  it("counts a half day as a half", () => {
    const counted = countLeaveDays({
      startsOn: "2026-05-04",
      endsOn: "2026-05-06",
      halfDayStart: true,
      workDays: [1, 2, 3, 4, 5],
      holidays: [],
    });

    expect(counted.days).toBe(2.5);
  });

  it("gives a four-day week four days for a full week", () => {
    const counted = countLeaveDays({
      startsOn: "2026-05-04",
      endsOn: "2026-05-08",
      workDays: [1, 2, 3, 4],
      holidays: [],
    });

    expect(counted.days).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe("leave types and entitlements", () => {
  it("refuses an entitlement figure with no source", async () => {
    await expect(
      saveLeaveType(db, hrManager, { code: "AL", name: "Annual leave", defaultDays: "14" }),
    ).rejects.toThrow(/where the entitlement comes from/);
  });

  it("records a type with its source", async () => {
    annualLeaveId = (
      await saveLeaveType(db, hrManager, {
        code: "AL",
        name: "Annual leave",
        isStatutory: true,
        defaultDays: "14",
        entitlementSource: "Employment Act 1955 s.60E, as advised by CAC",
      })
    ).id;

    sickLeaveId = (
      await saveLeaveType(db, hrManager, {
        code: "SL",
        name: "Sick leave",
        isStatutory: true,
        defaultDays: "14",
        entitlementSource: "Employment Act 1955 s.60F, as advised by CAC",
        requiresDocument: true,
        allowsBackdating: true,
      })
    ).id;

    expect(annualLeaveId).toBeTruthy();
    expect(sickLeaveId).toBeTruthy();
  });

  it("is not something an accountant may configure", async () => {
    await expect(
      saveLeaveType(db, accountant, { code: "XX", name: "Nope" }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("refuses leave against a type with no entitlement recorded", async () => {
    const unconfigured = await saveLeaveType(db, hrManager, {
      code: "UNPAID",
      name: "Unpaid leave",
      isPaid: false,
    });

    await expect(
      requestLeave(db, staff, {
        employeeId: aishahId,
        leaveTypeId: unconfigured.id,
        startsOn: futureMonday,
        endsOn: futureMonday,
      }),
    ).rejects.toThrow(/no entitlement recorded/);
  });

  it("needs a reason for an adjustment to somebody's entitlement", async () => {
    await expect(
      setLeaveBalance(db, hrManager, {
        employeeId: aishahId,
        leaveTypeId: annualLeaveId,
        year: leaveYear,
        entitledDays: "14",
        adjustmentDays: "2",
      }),
    ).rejects.toThrow(/Say why/);
  });

  it("sets a balance", async () => {
    for (const year of [leaveYear, leaveYear + 1]) {
      await setLeaveBalance(db, hrManager, {
        employeeId: aishahId,
        leaveTypeId: annualLeaveId,
        year,
        entitledDays: "14",
      });
      await setLeaveBalance(db, hrManager, {
        employeeId: faizalId,
        leaveTypeId: annualLeaveId,
        year,
        entitledDays: "18",
      });
      await setLeaveBalance(db, hrManager, {
        employeeId: aishahId,
        leaveTypeId: sickLeaveId,
        year,
        entitledDays: "14",
      });
    }

    const balances = await listLeaveBalances(db, { employeeId: aishahId, year: leaveYear });
    const annual = balances.find((row) => row.leaveTypeCode === "AL")!;
    expect(annual.entitledDays).toBe(14);
    expect(annual.remainingDays).toBe(14);
  });
});

// ---------------------------------------------------------------------------
describe("leave requests", () => {
  let requestId: string;

  it("counts the days from the schedule and the holidays", async () => {
    // Monday to Wednesday with a public holiday on the Tuesday: two days, not
    // three. Proves the request reads the schedule and the calendar rather than
    // counting dates.
    const created = await requestLeave(db, staff, {
      employeeId: aishahId,
      leaveTypeId: annualLeaveId,
      startsOn: futureMonday,
      endsOn: futureWednesday,
      reason: "Family trip",
    });
    requestId = created.id;

    expect(created.days).toBe(2);
  });

  it("refuses a backdated request for a type that does not allow it", async () => {
    await expect(
      requestLeave(db, staff, {
        employeeId: aishahId,
        leaveTypeId: annualLeaveId,
        startsOn: "2026-01-06",
        endsOn: "2026-01-06",
      }),
    ).rejects.toThrow(/cannot be requested for a day that has passed/);
  });

  it("insists on evidence where the type requires it", async () => {
    await expect(
      requestLeave(db, staff, {
        employeeId: aishahId,
        leaveTypeId: sickLeaveId,
        startsOn: futureMonday,
        endsOn: futureMonday,
      }),
    ).rejects.toThrow(/supporting evidence/);
  });

  it("refuses a span made entirely of rest days", async () => {
    await expect(
      requestLeave(db, staff, {
        employeeId: aishahId,
        leaveTypeId: annualLeaveId,
        startsOn: futureSaturday,
        endsOn: futureSunday,
      }),
    ).rejects.toThrow(/no working days/);
  });

  it("will not let somebody raise leave on a colleague record without the authority", async () => {
    await expect(
      requestLeave(db, staff, {
        employeeId: faizalId,
        leaveTypeId: annualLeaveId,
        startsOn: futureMonday,
        endsOn: futureMonday,
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("submits, and numbers itself", async () => {
    const submitted = await submitLeave(db, staff, requestId);
    expect(submitted.requestNo).toMatch(new RegExp(`^LV-${leaveYear}-`));
  });

  it("will not let somebody approve their own leave", async () => {
    // Even with the capability: the guard is about the person, not the role.
    const selfApprover = await makePrincipal("wf-self@cac.test", ["HR_MANAGER"], aishahId);
    await expect(decideLeave(db, selfApprover, requestId, "approved")).rejects.toThrow(
      /cannot approve your own leave/,
    );
  });

  it("approves it, and the balance follows from the requests", async () => {
    await decideLeave(db, manager, requestId, "approved", { note: "Enjoy" });

    const balances = await listLeaveBalances(db, { employeeId: aishahId, year: leaveYear });
    const annual = balances.find((row) => row.leaveTypeCode === "AL")!;
    // Derived by trigger from the approved requests, not written by the application.
    expect(annual.takenDays).toBe(2);
    expect(annual.remainingDays).toBe(12);
  });

  it("refuses approved leave that overlaps approved leave", async () => {
    const overlapping = await requestLeave(db, manager, {
      employeeId: aishahId,
      leaveTypeId: annualLeaveId,
      startsOn: futureWednesday,
      endsOn: plusDays(futureWednesday, 1),
      reason: "Overlaps the last day of the trip",
    });
    await submitLeave(db, manager, overlapping.id);

    await expect(decideLeave(db, manager, overlapping.id, "approved")).rejects.toThrow(/overlaps/);
  });

  it("refuses to approve more than the balance without a deliberate override", async () => {
    const big = await requestLeave(db, staff, {
      employeeId: aishahId,
      leaveTypeId: annualLeaveId,
      startsOn: plusDays(futureMonday, 28),
      endsOn: plusDays(futureMonday, 53),
      reason: "A long holiday",
    });
    await submitLeave(db, staff, big.id);

    await expect(decideLeave(db, manager, big.id, "approved")).rejects.toThrow(
      /remaining balance/,
    );

    // Deliberately, as an exception, and the audit records that it was.
    await decideLeave(db, manager, big.id, "approved", {
      allowNegativeBalance: true,
      note: "Agreed against next year's entitlement",
    });

    const events = await db.execute<{ new_values: unknown }>(sql`
      SELECT new_values FROM audit.event
       WHERE action = 'LEAVE_APPROVED' AND entity_id = ${big.id}
    `);
    expect(JSON.stringify(events.rows![0]!.new_values)).toContain("overrodeBalance");

    await cancelLeave(db, manager, big.id, "Reverting the test fixture");
  });

  it("needs a reason to refuse, and the person sees it", async () => {
    const request = await requestLeave(db, staff, {
      employeeId: aishahId,
      leaveTypeId: annualLeaveId,
      startsOn: plusDays(futureMonday, 70),
      endsOn: plusDays(futureMonday, 70),
    });
    await submitLeave(db, staff, request.id);

    await expect(decideLeave(db, manager, request.id, "rejected")).rejects.toThrow(
      ValidationError,
    );

    await decideLeave(db, manager, request.id, "rejected", { note: "Two people already away" });

    const requests = await listLeaveRequests(db, { employeeId: aishahId, status: "rejected" });
    expect(requests[0]!.decisionNote).toBe("Two people already away");
  });

  it("will not let a decided request be edited into something else", async () => {
    await expect(
      db.execute(sql`UPDATE hr.leave_request SET days = 10 WHERE id = ${requestId}`),
    ).rejects.toThrow(/already been decided/);
  });

  it("cancels an approved request, and the balance comes back", async () => {
    await cancelLeave(db, staff, requestId, "Trip called off");

    const balances = await listLeaveBalances(db, { employeeId: aishahId, year: leaveYear });
    expect(balances.find((row) => row.leaveTypeCode === "AL")!.takenDays).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("overtime, kept separate from extra time", () => {
  let overtimeId: string;

  beforeAll(async () => {
    // A long Monday on the clock: nine to half past eight.
    await recordAttendance(db, hrAdmin, {
      employeeId: aishahId,
      workDate: "2026-06-01",
      clockIn: "2026-06-01T09:00:00+08:00",
      clockOut: "2026-06-01T20:30:00+08:00",
    });
  });

  it("works out what kind of day it was rather than being told", async () => {
    expect(await dayKindFor(db, aishahId, "2026-06-01")).toBe("normal");
    expect(await dayKindFor(db, aishahId, "2026-06-06")).toBe("rest_day");
    expect(await dayKindFor(db, aishahId, "2026-05-01")).toBe("public_holiday");
  });

  it("records extra time on the clock without paying any of it", async () => {
    const result = await recalculateAttendance(db, hrAdmin, {
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(result.updated).toBeGreaterThan(0);

    const day = await db.execute<{ extra_minutes: number; approved_ot_minutes: number }>(sql`
      SELECT extra_minutes, approved_ot_minutes FROM hr.attendance
       WHERE employee_id = ${aishahId} AND work_date = '2026-06-01'
    `);
    // Two and a half hours beyond the scheduled day, and nothing payable.
    expect(day.rows![0]!.extra_minutes).toBe(150);
    expect(day.rows![0]!.approved_ot_minutes).toBe(0);
  });

  it("lists extra time nobody has claimed, as something to look at", async () => {
    const unclaimed = await unclaimedExtraTime(db, { from: "2026-06-01", to: "2026-06-30" });
    expect(unclaimed).toHaveLength(1);
    expect(unclaimed[0]!.extraMinutes).toBe(150);
  });

  it("takes a request, and refuses a second for the same day", async () => {
    const created = await requestOvertime(db, staff, {
      employeeId: aishahId,
      workDate: "2026-06-01",
      requestedHours: "2.5",
      reason: "Finishing the Skudai report for the Tuesday hearing",
    });
    overtimeId = created.id;
    expect(created.dayKind).toBe("normal");

    await expect(
      requestOvertime(db, staff, {
        employeeId: aishahId,
        workDate: "2026-06-01",
        requestedHours: "1",
        reason: "Again",
      }),
    ).rejects.toThrow(/already a draft overtime request/);
  });

  it("will not let somebody approve their own overtime", async () => {
    await submitOvertime(db, staff, overtimeId);

    const selfApprover = await makePrincipal("wf-ot-self@cac.test", ["HR_MANAGER"], aishahId);
    await expect(decideOvertime(db, selfApprover, overtimeId, "approved")).rejects.toThrow(
      /cannot approve your own overtime/,
    );
  });

  it("refuses a rate with no source", async () => {
    await expect(
      decideOvertime(db, manager, overtimeId, "approved", {
        approvedHours: "2",
        rateMultiple: "1.5",
      }),
    ).rejects.toThrow(/where the rate comes from/);
  });

  it("approves fewer hours than were claimed, and keeps both figures", async () => {
    await decideOvertime(db, manager, overtimeId, "approved", {
      approvedHours: "2",
      rateMultiple: "1.5",
      rateSource: "Employment Act 1955 s.60A(3)(a), as advised by CAC",
      note: "Two hours agreed",
    });

    const requests = await listOvertime(db, { employeeId: aishahId });
    const request = requests[0]!;
    expect(request.requestedHours).toBe(2.5);
    expect(request.approvedHours).toBe(2);
    // And the clock's own figure sits beside it, for comparison.
    expect(request.extraMinutesOnClock).toBe(150);
  });

  it("refuses to approve more than was claimed", async () => {
    const another = await requestOvertime(db, staff, {
      employeeId: aishahId,
      workDate: "2026-06-02",
      requestedHours: "1",
      reason: "Catching up",
    });
    await submitOvertime(db, staff, another.id);

    await expect(
      decideOvertime(db, manager, another.id, "approved", { approvedHours: "5" }),
    ).rejects.toThrow(/cannot be approved/);
  });

  it("carries only the approved hours into attendance", async () => {
    await recalculateAttendance(db, hrAdmin, { from: "2026-06-01", to: "2026-06-30" });

    const day = await db.execute<{ extra_minutes: number; approved_ot_minutes: number }>(sql`
      SELECT extra_minutes, approved_ot_minutes FROM hr.attendance
       WHERE employee_id = ${aishahId} AND work_date = '2026-06-01'
    `);

    // The distinction the whole phase exists for: 150 minutes happened, 120 are
    // payable.
    expect(day.rows![0]!.extra_minutes).toBe(150);
    expect(day.rows![0]!.approved_ot_minutes).toBe(120);
  });

  it("refuses to change overtime a payroll run has taken", async () => {
    await db.execute(sql`
      UPDATE hr.overtime_request SET payroll_run_id = gen_random_uuid() WHERE id = ${overtimeId}
    `);

    await expect(
      db.execute(sql`UPDATE hr.overtime_request SET approved_hours = 9 WHERE id = ${overtimeId}`),
    ).rejects.toThrow(/has been paid/);
  });
});

// ---------------------------------------------------------------------------
describe("time off within a day", () => {
  it("is approved by somebody else and then reduces the expected day", async () => {
    await recordAttendance(db, hrAdmin, {
      employeeId: aishahId,
      workDate: "2026-06-08",
      clockIn: "2026-06-08T11:00:00+08:00",
      clockOut: "2026-06-08T18:00:00+08:00",
    });

    const request = await requestTimeoff(db, staff, {
      employeeId: aishahId,
      workDate: "2026-06-08",
      kind: "late_in",
      minutes: 120,
      reason: "Hospital appointment",
    });
    await submitTimeoff(db, staff, request.id);

    const selfApprover = await makePrincipal("wf-to-self@cac.test", ["HR_MANAGER"], aishahId);
    await expect(decideTimeoff(db, selfApprover, request.id, "approved")).rejects.toThrow(
      /cannot approve your own time off/,
    );

    await decideTimeoff(db, manager, request.id, "approved");
    await recalculateAttendance(db, hrAdmin, { from: "2026-06-08", to: "2026-06-08" });

    const day = await db.execute<{
      late_minutes: number;
      scheduled_minutes: number;
      timeoff_minutes: number;
    }>(sql`
      SELECT late_minutes, scheduled_minutes, timeoff_minutes FROM hr.attendance
       WHERE employee_id = ${aishahId} AND work_date = '2026-06-08'
    `);

    // Two hours late with permission is not two hours late.
    expect(day.rows![0]!.timeoff_minutes).toBe(120);
    expect(day.rows![0]!.late_minutes).toBe(0);
    expect(day.rows![0]!.scheduled_minutes).toBe(360);
  });

  it("counts the same lateness against somebody without permission", async () => {
    await recordAttendance(db, hrAdmin, {
      employeeId: faizalId,
      workDate: "2026-06-08",
      clockIn: "2026-06-08T11:00:00+08:00",
      clockOut: "2026-06-08T18:00:00+08:00",
    });
    await recalculateAttendance(db, hrAdmin, { from: "2026-06-08", to: "2026-06-08" });

    const day = await db.execute<{ late_minutes: number; scheduled_minutes: number }>(sql`
      SELECT late_minutes, scheduled_minutes FROM hr.attendance
       WHERE employee_id = ${faizalId} AND work_date = '2026-06-08'
    `);

    expect(day.rows![0]!.late_minutes).toBe(120);
    expect(day.rows![0]!.scheduled_minutes).toBe(480);
  });
});

// ---------------------------------------------------------------------------
describe("the engine over stored days", () => {
  it("leaves finalised days alone and says how many it skipped", async () => {
    const period = await openAttendancePeriod(db, hrManager, {
      periodFrom: "2026-06-01",
      periodTo: "2026-06-30",
    });
    await finaliseAttendancePeriod(db, hrManager, period.id);

    const result = await recalculateAttendance(db, hrAdmin, {
      from: "2026-06-01",
      to: "2026-06-30",
    });

    // A final day is evidence payroll may already have read; recomputing it would
    // change a payslip's basis after the fact.
    expect(result.updated).toBe(0);
    expect(result.skippedFinal).toBeGreaterThan(0);
  });

  it("summarises a month from final days only, and admits what was not calculated", async () => {
    const summary = await attendanceSummary(db, { from: "2026-06-01", to: "2026-06-30" });
    const aishah = summary.find((row) => row.employeeId === aishahId)!;

    expect(aishah.daysFinal).toBeGreaterThan(0);
    expect(aishah.extraMinutes).toBe(150);
    expect(aishah.approvedOtMinutes).toBe(120);
    expect(aishah.daysNotCalculated).toBe(0);
  });

  it("is not something an accountant may run", async () => {
    await expect(
      recalculateAttendance(db, accountant, { from: "2026-06-01", to: "2026-06-30" }),
    ).rejects.toThrow(AuthorizationError);
  });
});

// ---------------------------------------------------------------------------
describe("appraisals", () => {
  let cycleId: string;
  let appraisalId: string;

  const template = {
    scale: { min: 1, max: 5 },
    sections: [
      {
        key: "delivery",
        title: "Delivery",
        questions: [
          { key: "quality", prompt: "Quality of investigation reports", rated: true, comment: true },
          { key: "timeliness", prompt: "Meeting agreed dates", rated: true },
        ],
      },
      {
        key: "conduct",
        title: "Conduct",
        questions: [{ key: "clients", prompt: "Dealing with clients", rated: true }],
      },
    ],
  };

  it("refuses a form whose sections share a key", () => {
    expect(() =>
      validateTemplate({
        sections: [
          { key: "a", title: "A", questions: [{ key: "q", prompt: "Q" }] },
          { key: "a", title: "Also A", questions: [{ key: "q", prompt: "Q" }] },
        ],
      }),
    ).toThrow(/share the key/);
  });

  it("refuses a rated question with no scale", () => {
    expect(() =>
      validateTemplate({
        sections: [{ key: "a", title: "A", questions: [{ key: "q", prompt: "Q", rated: true }] }],
      }),
    ).toThrow(/no rating scale/);
  });

  it("creates a cycle and opens it, reporting anybody with no reviewer", async () => {
    cycleId = (
      await saveCycle(db, hrManager, {
        code: "FY26",
        name: "FY2026 review",
        periodFrom: "2026-01-01",
        periodTo: "2026-12-31",
        template,
      })
    ).id;

    const opened = await openCycle(db, hrManager, cycleId);

    // Aishah reports to Faizal, so she gets one. Faizal reports to nobody, so he is
    // reported rather than assigned an arbitrary reviewer.
    expect(opened.created).toBe(1);
    expect(opened.withoutReviewer.map((row) => row.fullName)).toContain("Faizal bin Omar");

    const appraisals = await listAppraisals(db, { cycleId });
    appraisalId = appraisals[0]!.id;
    expect(appraisals[0]!.employeeName).toBe("Aishah binti Rahman");
    expect(appraisals[0]!.reviewerName).toBe("Faizal bin Omar");
  });

  it("lets only the subject write their own assessment", async () => {
    await expect(
      recordSelfAssessment(db, manager, appraisalId, { delivery: { quality: 4 } }),
    ).rejects.toThrow(/only the person being appraised/i);

    await recordSelfAssessment(db, staff, appraisalId, {
      delivery: { quality: 4, timeliness: 4 },
      conduct: { clients: 5 },
    });

    const appraisal = (await listAppraisals(db, { cycleId }))[0]!;
    expect(appraisal.status).toBe("self_assessed");
  });

  it("refuses a score outside the cycle's own scale", async () => {
    await expect(
      recordReview(db, manager, appraisalId, {
        review: { delivery: { quality: 4 } },
        overallScore: "9",
      }),
    ).rejects.toThrow(/runs from 1 to 5/);
  });

  it("records the reviewer's assessment", async () => {
    await recordReview(db, manager, appraisalId, {
      review: { delivery: { quality: 4, timeliness: 3 }, conduct: { clients: 5 } },
      overallScore: "4",
      overallComment: "Strong on reports; dates slipped twice.",
    });

    const appraisal = (await listAppraisals(db, { cycleId }))[0]!;
    expect(appraisal.status).toBe("reviewed");
    expect(appraisal.overallScore).toBe(4);
  });

  it("lets the employee acknowledge it, disagreeing if they wish", async () => {
    await expect(acknowledgeAppraisal(db, manager, appraisalId, null)).rejects.toThrow(
      /Only the person appraised/,
    );

    // Acknowledgement is not agreement, and the comment is where that is said.
    await acknowledgeAppraisal(
      db,
      staff,
      appraisalId,
      "Noted. The two slipped dates were waiting on the land office.",
    );

    const appraisal = (await listAppraisals(db, { cycleId }))[0]!;
    expect(appraisal.status).toBe("acknowledged");
    expect(appraisal.employeeComment).toContain("land office");
  });

  it("will not let an acknowledged appraisal be changed", async () => {
    await expect(
      recordReview(db, manager, appraisalId, { review: { delivery: { quality: 1 } } }),
    ).rejects.toThrow(/acknowledged/);

    await expect(
      db.execute(sql`UPDATE hr.appraisal SET overall_score = 1 WHERE id = ${appraisalId}`),
    ).rejects.toThrow(/acknowledged/);
  });

  it("refuses to change the form once people have answered it", async () => {
    await expect(
      saveCycle(db, hrManager, {
        cycleId,
        code: "FY26",
        name: "FY2026 review",
        periodFrom: "2026-01-01",
        periodTo: "2026-12-31",
        template: {
          scale: { min: 1, max: 10 },
          sections: [{ key: "new", title: "New", questions: [{ key: "q", prompt: "Q" }] }],
        },
      }),
    ).rejects.toThrow(/already answered/);
  });

  it("refuses a reviewer who is the subject", async () => {
    await expect(
      db.execute(sql`
        INSERT INTO hr.appraisal (cycle_id, employee_id, reviewer_id, created_by)
        VALUES (${cycleId}, ${faizalId}, ${faizalId}, ${hrManager.userId})
      `),
    ).rejects.toThrow();
  });
});
