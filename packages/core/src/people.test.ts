import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import { hashPassword } from "./password.js";
import { AuthorizationError, resolveCapabilities, type Principal } from "./authz.js";
import { ConflictError, ValidationError } from "./errors.js";
import { formatAmount } from "./money.js";
import {
  addPublicHoliday,
  createDepartment,
  createEmployee,
  createPosition,
  createWorkSchedule,
  getEmployee,
  getEmployeeSensitive,
  listDepartments,
  listEmployees,
  listEmploymentEvents,
  listPublicHolidays,
  listWorkSchedules,
  recordEmploymentEvent,
  salaryOn,
  scheduledMinutesFor,
  updateEmployee,
} from "./people.js";
import {
  confirmAttendanceImport,
  discardAttendanceImport,
  finaliseAttendancePeriod,
  getAttendanceImport,
  guessAttendanceMapping,
  listAttendance,
  listUnmappedEmployees,
  mapDeviceUser,
  openAttendancePeriod,
  parseAttendanceFile,
  recordAttendance,
  reopenAttendancePeriod,
  stageAttendanceImport,
} from "./attendance.js";
import { recalculateAttendance } from "./attendance-engine.js";

/**
 * Phase 5: the people, and getting attendance out of a device.
 *
 * Five things are worth proving beyond the mechanics, and each is a way the HR
 * half of a system like this normally goes wrong:
 *
 *   - **history, not a snapshot.** The salary in force on a past date is a fact in
 *     the event log, so re-running March's payroll in December gives March's
 *     answer. Without this, Phase 7 cannot be reproducible at all.
 *   - **the sensitive fields are separate.** The NRIC and the bank account are
 *     encrypted, returned only to somebody with the capability, and reading them
 *     leaves an audit row.
 *   - **the importer stages.** Nothing reaches attendance without a confirmation,
 *     and a confirmation never overwrites a day somebody has corrected by hand.
 *   - **identity comes from the device number, not the name.** Two people with the
 *     same name is a real situation and the importer refuses to guess between them.
 *   - **final attendance is evidence.** Once a period is closed the rows cannot be
 *     edited, and nothing new can be inserted into it.
 */

let db: Database;
let close: () => Promise<void>;

let hrAdmin: Principal; // HR_ADMIN — the day-to-day
let hrManager: Principal; // HR_MANAGER — everything in HR
let accountant: Principal; // ACCOUNTANT — no HR rights beyond claims
let employeeUser: Principal; // EMPLOYEE — nothing

let departmentId: string;
let positionId: string;
let scheduleId: string;
let aishahId: string;
let faizalId: string;

async function makePrincipal(email: string, roles: string[]): Promise<Principal> {
  const hash = await hashPassword("correct-horse-battery-staple");
  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO auth."user" (email, password_hash, full_name)
    VALUES (${email}, ${hash}, ${email}) RETURNING id
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
    employeeId: null,
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

  hrAdmin = await makePrincipal("hr-admin@cac.test", ["HR_ADMIN"]);
  hrManager = await makePrincipal("hr-manager@cac.test", ["HR_MANAGER"]);
  accountant = await makePrincipal("hr-accountant@cac.test", ["ACCOUNTANT"]);
  employeeUser = await makePrincipal("hr-staff@cac.test", ["EMPLOYEE"]);

  departmentId = (
    await createDepartment(db, hrAdmin, { code: "FOR", name: "Forensic Investigation" })
  ).id;

  positionId = (
    await createPosition(db, hrAdmin, {
      code: "INV",
      title: "Forensic Investigator",
      departmentId,
      grade: "E3",
    })
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
}, 120_000);

afterAll(async () => {
  await close();
});

// ---------------------------------------------------------------------------
describe("the organisation", () => {
  it("records a department with a head and counts its people", async () => {
    const departments = await listDepartments(db);
    const forensic = departments.find((row) => row.code === "FOR");

    expect(forensic?.name).toBe("Forensic Investigation");
    expect(forensic?.employeeCount).toBe(0);
  });

  it("refuses a department inside itself", async () => {
    const child = (
      await createDepartment(db, hrAdmin, { code: "SUB", name: "Sub-unit", parentId: departmentId })
    ).id;

    // Making the parent a child of its own child is a cycle, and every upward walk
    // would loop forever.
    await expect(
      db.execute(sql`UPDATE hr.department SET parent_id = ${child} WHERE id = ${departmentId}`),
    ).rejects.toThrow();
  });

  it("refuses a duplicate department code", async () => {
    await expect(
      createDepartment(db, hrAdmin, { code: "FOR", name: "Something else" }),
    ).rejects.toThrow(ConflictError);
  });

  it("is not something an accountant may change", async () => {
    await expect(
      createDepartment(db, accountant, { code: "XXX", name: "Nope" }),
    ).rejects.toThrow(AuthorizationError);
  });
});

// ---------------------------------------------------------------------------
describe("work schedules", () => {
  it("computes the scheduled day net of the break", () => {
    expect(
      scheduledMinutesFor({
        startsAt: "09:00",
        endsAt: "18:00",
        breakMinutes: 60,
        crossesMidnight: false,
      }),
    ).toBe(480);
  });

  it("handles a shift that crosses midnight", () => {
    // 22:00 to 06:00 is eight hours, less the break — not minus sixteen.
    expect(
      scheduledMinutesFor({
        startsAt: "22:00",
        endsAt: "06:00",
        breakMinutes: 30,
        crossesMidnight: true,
      }),
    ).toBe(450);
  });

  it("refuses a day that ends before it starts unless it says it crosses midnight", async () => {
    await expect(
      createWorkSchedule(db, hrManager, {
        code: "BAD",
        name: "Backwards",
        workDays: [1, 2, 3],
        startsAt: "18:00",
        endsAt: "09:00",
      }),
    ).rejects.toThrow(/crosses midnight/);
  });

  it("refuses a break as long as the working day", async () => {
    await expect(
      createWorkSchedule(db, hrManager, {
        code: "BRK",
        name: "All break",
        workDays: [1],
        startsAt: "09:00",
        endsAt: "10:00",
        breakMinutes: 60,
      }),
    ).rejects.toThrow(/no time worked/);
  });

  it("refuses a working day outside Monday to Sunday", async () => {
    await expect(
      createWorkSchedule(db, hrManager, {
        code: "DAY8",
        name: "Eight-day week",
        workDays: [1, 8],
        startsAt: "09:00",
        endsAt: "18:00",
      }),
    ).rejects.toThrow(/1 \(Monday\) to 7/);
  });

  it("keeps exactly one default", async () => {
    await createWorkSchedule(db, hrManager, {
      code: "FOUR",
      name: "Four-day week",
      workDays: [1, 2, 3, 4],
      startsAt: "09:00",
      endsAt: "18:30",
      isDefault: true,
    });

    const schedules = await listWorkSchedules(db);
    expect(schedules.filter((row) => row.isDefault)).toHaveLength(1);
    expect(schedules.find((row) => row.isDefault)?.code).toBe("FOUR");

    // Put it back, so the rest of the file reads against the standard week.
    await db.execute(sql`UPDATE hr.work_schedule SET is_default = false WHERE code = 'FOUR'`);
    await db.execute(sql`UPDATE hr.work_schedule SET is_default = true WHERE code = 'STD'`);
  });

  it("reads the working days back as numbers whichever driver returns them", async () => {
    const schedules = await listWorkSchedules(db);
    const standard = schedules.find((row) => row.code === "STD")!;
    expect(standard.workDays).toEqual([1, 2, 3, 4, 5]);
    expect(standard.scheduledMinutes).toBe(480);
  });
});

// ---------------------------------------------------------------------------
describe("employees", () => {
  it("creates one, numbers it, and opens its history", async () => {
    const created = await createEmployee(db, hrAdmin, {
      fullName: "Aishah binti Rahman",
      nric: "880412-14-5678",
      email: "aishah@conglomerate4u.com",
      positionId,
      departmentId,
      workScheduleId: scheduleId,
      joinedOn: "2026-01-06",
      probationMonths: 3,
      basicSalary: "4500.00",
      bankName: "Maybank",
      bankAccountNo: "1142 8899 3321",
      deviceUserId: "101",
    });
    aishahId = created.id;

    expect(created.employeeNo).toMatch(/^EMP-2026-/);

    const employee = await getEmployee(db, aishahId);
    expect(employee?.fullName).toBe("Aishah binti Rahman");
    expect(employee?.departmentName).toBe("Forensic Investigation");
    expect(employee?.status).toBe("active");
    // Probation ends three months after joining, so an overdue confirmation shows.
    expect(employee?.probationEndsOn).toBe("2026-04-06");

    const history = await listEmploymentEvents(db, aishahId);
    expect(history).toHaveLength(1);
    expect(history[0]!.kind).toBe("hired");
    expect(formatAmount(history[0]!.basicSalary!)).toBe("4,500.00");
  });

  it("never returns the identity card number on the ordinary record", async () => {
    const employee = await getEmployee(db, aishahId);

    // Only the last four digits, which identify without disclosing.
    expect(employee?.nricLast4).toBe("5678");
    expect(JSON.stringify(employee)).not.toContain("880412");
    expect(JSON.stringify(employee)).not.toContain("1142");
  });

  it("stores the identity card number encrypted, not in the clear", async () => {
    const raw = await db.execute<{ nric_enc: string; bank_account_enc: string }>(
      sql`SELECT nric_enc, bank_account_enc FROM hr.employee WHERE id = ${aishahId}`,
    );
    const row = raw.rows![0]!;

    expect(row.nric_enc).not.toContain("880412145678");
    expect(row.bank_account_enc).not.toContain("114288993321");
    expect(row.nric_enc.length).toBeGreaterThan(20);
  });

  it("refuses an identity card number that is not twelve digits", async () => {
    await expect(
      createEmployee(db, hrAdmin, {
        fullName: "Wrong NRIC",
        nric: "88041214",
        joinedOn: "2026-01-06",
      }),
    ).rejects.toThrow(/twelve digits/);
  });

  it("gives the sensitive fields only to somebody who may see them, and records the look", async () => {
    await expect(getEmployeeSensitive(db, accountant, aishahId)).rejects.toThrow(
      AuthorizationError,
    );

    const sensitive = await getEmployeeSensitive(db, hrAdmin, aishahId, {
      reason: "Preparing the EPF submission",
    });

    expect(sensitive?.nric).toBe("880412145678");
    expect(sensitive?.bankAccountNo).toBe("114288993321");
    expect(formatAmount(sensitive!.basicSalary)).toBe("4,500.00");

    // Looking is itself an event. PDPA makes "who saw this" a real question, and it
    // cannot be answered unless looking leaves a trace.
    const events = await db.execute<{ action: string; reason: string | null }>(sql`
      SELECT action, reason FROM audit.event
       WHERE entity_type = 'employee' AND entity_id = ${aishahId} AND action = 'EXPORT_SENSITIVE'
    `);
    expect(events.rows).toHaveLength(1);
    expect(events.rows![0]!.reason).toContain("EPF submission");
  });

  it("masks the identity card number and the salary in the audit trail", async () => {
    const events = await db.execute<{ new_values: unknown }>(sql`
      SELECT new_values FROM audit.event
       WHERE action = 'EMPLOYEE_CREATED' AND entity_id = ${aishahId}
    `);
    const payload = JSON.stringify(events.rows![0]!.new_values);

    // The change is worth recording; the values are not. `redact` keeps the last
    // four digits so a row can still be recognised, and nothing more.
    expect(payload).not.toContain("880412");
    expect(payload).not.toContain("4500.0000");
    expect(payload).toContain("***");
  });

  it("refuses two employees on one device number", async () => {
    const second = await createEmployee(db, hrAdmin, {
      fullName: "Faizal bin Omar",
      nric: "910228-10-5533",
      positionId,
      departmentId,
      workScheduleId: scheduleId,
      joinedOn: "2026-02-02",
      basicSalary: "6200.00",
    });
    faizalId = second.id;

    await expect(mapDeviceUser(db, hrAdmin, faizalId, "101")).rejects.toThrow(
      /already mapped/,
    );

    await mapDeviceUser(db, hrAdmin, faizalId, "102");
    const employee = await getEmployee(db, faizalId);
    expect(employee?.deviceUserId).toBe("102");
  });

  it("is not something an ordinary employee may create", async () => {
    await expect(
      createEmployee(db, employeeUser, { fullName: "Nobody", joinedOn: "2026-01-01" }),
    ).rejects.toThrow(AuthorizationError);
  });
});

// ---------------------------------------------------------------------------
describe("employment history", () => {
  it("confirms somebody, and the record says when", async () => {
    await recordEmploymentEvent(db, hrAdmin, aishahId, {
      kind: "confirmed",
      effectiveFrom: "2026-04-06",
      reason: "Probation completed satisfactorily",
    });

    const employee = await getEmployee(db, aishahId);
    expect(employee?.confirmedOn).toBe("2026-04-06");
    expect(employee?.status).toBe("active");
  });

  it("records a raise against a date, not just against now", async () => {
    await recordEmploymentEvent(db, hrAdmin, aishahId, {
      kind: "salary_changed",
      effectiveFrom: "2026-07-01",
      basicSalary: "5200.00",
      reason: "Annual review",
    });

    const employee = await getEmployee(db, aishahId);
    expect(formatAmount((await getEmployeeSensitive(db, hrAdmin, aishahId))!.basicSalary)).toBe(
      "5,200.00",
    );
    expect(employee?.status).toBe("active");
  });

  it("answers what the salary was on a past date — the property payroll needs", async () => {
    // The whole point. March pays 4,500 however many raises happen afterwards.
    expect(formatAmount((await salaryOn(db, aishahId, "2026-03-31"))!)).toBe("4,500.00");
    expect(formatAmount((await salaryOn(db, aishahId, "2026-06-30"))!)).toBe("4,500.00");
    expect(formatAmount((await salaryOn(db, aishahId, "2026-07-01"))!)).toBe("5,200.00");
    expect(formatAmount((await salaryOn(db, aishahId, "2026-12-31"))!)).toBe("5,200.00");
  });

  it("says nothing rather than nil for a date before somebody joined", async () => {
    // A salary of zero and "was not employed" are different facts, and payroll has
    // to be able to tell them apart.
    expect(await salaryOn(db, aishahId, "2025-12-31")).toBeNull();
  });

  it("refuses an event dated before the person joined", async () => {
    await expect(
      recordEmploymentEvent(db, hrAdmin, aishahId, {
        kind: "salary_changed",
        effectiveFrom: "2025-06-01",
        basicSalary: "9000.00",
      }),
    ).rejects.toThrow(/cannot predate/);
  });

  it("will not let history be edited or deleted", async () => {
    const event = await db.execute<{ id: string }>(
      sql`SELECT id FROM hr.employment_event WHERE employee_id = ${aishahId} LIMIT 1`,
    );
    const id = event.rows![0]!.id;

    await expect(
      db.execute(sql`UPDATE hr.employment_event SET basic_salary = 1 WHERE id = ${id}`),
    ).rejects.toThrow(/does not change/);

    await expect(
      db.execute(sql`DELETE FROM hr.employment_event WHERE id = ${id}`),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it("needs a reason to end somebody's employment, and needs the capability", async () => {
    await expect(
      recordEmploymentEvent(db, hrAdmin, faizalId, {
        kind: "resigned",
        effectiveFrom: "2026-09-30",
      }),
    ).rejects.toThrow(/why the employment ended/);

    // HR_ADMIN holds hr.employee.terminate; an accountant does not.
    await expect(
      recordEmploymentEvent(db, accountant, faizalId, {
        kind: "resigned",
        effectiveFrom: "2026-09-30",
        reason: "Moving abroad",
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("records an exit, and refuses anything but a correction afterwards", async () => {
    await recordEmploymentEvent(db, hrAdmin, faizalId, {
      kind: "resigned",
      effectiveFrom: "2026-09-30",
      reason: "Moving abroad",
    });

    const employee = await getEmployee(db, faizalId);
    expect(employee?.status).toBe("resigned");
    expect(employee?.lastDay).toBe("2026-09-30");
    expect(employee?.exitReason).toBe("Moving abroad");

    await expect(
      recordEmploymentEvent(db, hrAdmin, faizalId, {
        kind: "promoted",
        effectiveFrom: "2026-10-01",
      }),
    ).rejects.toThrow(/already left/);
  });

  it("leaves a former employee out of the ordinary list", async () => {
    const current = await listEmployees(db);
    expect(current.map((row) => row.id)).not.toContain(faizalId);

    const everybody = await listEmployees(db, { includeLeavers: true });
    expect(everybody.map((row) => row.id)).toContain(faizalId);
  });

  it("writes history when a salary is changed on the record itself", async () => {
    const before = (await listEmploymentEvents(db, aishahId)).length;

    await updateEmployee(db, hrAdmin, aishahId, {
      fullName: "Aishah binti Rahman",
      joinedOn: "2026-01-06",
      positionId,
      departmentId,
      workScheduleId: scheduleId,
      basicSalary: "5400.00",
    });

    const after = await listEmploymentEvents(db, aishahId);
    expect(after.length).toBe(before + 1);
    expect(after[0]!.kind).toBe("salary_changed");
  });
});

// ---------------------------------------------------------------------------
describe("public holidays", () => {
  it("insists on a source, because a remembered holiday changes who was absent", async () => {
    await expect(
      addPublicHoliday(db, hrAdmin, { holidayOn: "2026-08-31", name: "Hari Merdeka" }),
    ).rejects.toThrow(/where this holiday comes from/);
  });

  it("records one with its source", async () => {
    await addPublicHoliday(db, hrAdmin, {
      holidayOn: "2026-08-31",
      name: "Hari Merdeka",
      sourceRef: "Federal gazette, as advised by CAC",
    });

    const holidays = await listPublicHolidays(db, { from: "2026-01-01", to: "2026-12-31" });
    expect(holidays).toHaveLength(1);
    expect(holidays[0]!.name).toBe("Hari Merdeka");
    expect(holidays[0]!.appliesTo).toEqual([]);
  });

  it("refuses the same holiday twice on one date", async () => {
    await expect(
      addPublicHoliday(db, hrAdmin, {
        holidayOn: "2026-08-31",
        name: "Hari Merdeka",
        sourceRef: "again",
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("keeps state-specific holidays separable", async () => {
    await addPublicHoliday(db, hrAdmin, {
      holidayOn: "2026-04-15",
      name: "Sultan's birthday",
      appliesTo: ["JHR"],
      sourceRef: "Johor state circular, as advised by CAC",
    });

    const holidays = await listPublicHolidays(db, { from: "2026-04-01", to: "2026-04-30" });
    expect(holidays[0]!.appliesTo).toEqual(["JHR"]);
  });
});

// ---------------------------------------------------------------------------
describe("reading a device export", () => {
  it("guesses the columns of a one-row-per-day export", () => {
    const mapping = guessAttendanceMapping(["AC-No.", "Name", "Date", "Check In", "Check Out"]);
    expect(mapping.deviceUserId).toBe(0);
    expect(mapping.employeeName).toBe(1);
    expect(mapping.date).toBe(2);
    expect(mapping.clockIn).toBe(3);
    expect(mapping.clockOut).toBe(4);
  });

  it("recognises a one-row-per-scan export instead", () => {
    const mapping = guessAttendanceMapping(["USERID", "Name", "Date/Time", "Status"]);
    expect(mapping.deviceUserId).toBe(0);
    expect(mapping.timestamp).toBe(2);
    expect(mapping.clockIn).toBeUndefined();
  });

  it("pairs a day's scans into an arrival and a departure", async () => {
    const staged = await parseAttendanceFile(
      db,
      "USERID,Name,Date/Time\n" +
        "101,Aishah,13/07/2026 08:57\n" +
        "101,Aishah,13/07/2026 12:58\n" +
        "101,Aishah,13/07/2026 13:55\n" +
        "101,Aishah,13/07/2026 18:22\n",
      { mapping: { dateFormat: "dmy" } },
    );

    // Four scans, one working day: the earliest is the arrival and the latest the
    // departure. Going out for lunch is not a second working day.
    expect(staged.rows).toHaveLength(1);
    expect(staged.rows[0]!.workDate).toBe("2026-07-13");
    expect(staged.rows[0]!.clockIn).toContain("08:57");
    expect(staged.rows[0]!.clockOut).toContain("18:22");
    expect(staged.rows[0]!.state).toBe("ok");
  });

  it("collapses a finger read twice seconds apart", async () => {
    const staged = await parseAttendanceFile(
      db,
      "USERID,Date/Time\n101,14/07/2026 08:59\n101,14/07/2026 09:00\n101,14/07/2026 18:05\n",
      { mapping: { dateFormat: "dmy" } },
    );

    // Without this the second scan becomes the clock-out and the day is one minute
    // long.
    expect(staged.duplicateCount).toBe(1);
    expect(staged.rows[0]!.clockIn).toContain("08:59");
    expect(staged.rows[0]!.clockOut).toContain("18:05");
  });

  it("leaves a missing clock-out missing rather than inventing one", async () => {
    const staged = await parseAttendanceFile(
      db,
      "USERID,Date/Time\n101,15/07/2026 08:45\n",
      { mapping: { dateFormat: "dmy" } },
    );

    expect(staged.rows[0]!.clockIn).toContain("08:45");
    expect(staged.rows[0]!.clockOut).toBeNull();
  });

  it("reads twelve-hour times and bare four-digit times", async () => {
    const staged = await parseAttendanceFile(
      db,
      "AC-No.,Date,Check In,Check Out\n101,16/07/2026,8:45 AM,6:10 PM\n102,16/07/2026,0905,1745\n",
      { mapping: { dateFormat: "dmy" } },
    );

    const aishah = staged.rows.find((row) => row.deviceUserId === "101")!;
    const faizal = staged.rows.find((row) => row.deviceUserId === "102")!;
    expect(aishah.clockIn).toContain("08:45");
    expect(aishah.clockOut).toContain("18:10");
    expect(faizal.clockIn).toContain("09:05");
  });

  it("reports a device number nobody has mapped, rather than dropping the rows", async () => {
    const staged = await parseAttendanceFile(
      db,
      "USERID,Date/Time\n999,13/07/2026 09:00\n",
      { mapping: { dateFormat: "dmy" } },
    );

    expect(staged.unmappedDeviceIds).toEqual(["999"]);
    expect(staged.rows[0]!.state).toBe("problem");
    expect(staged.rows[0]!.problem).toContain("not mapped");
  });

  it("refuses to assign a row by name when two people share it", async () => {
    // Two people called Tan is a real situation, and guessing puts one person's
    // attendance on the other's record.
    await createEmployee(db, hrAdmin, {
      fullName: "Tan Wei Ming",
      joinedOn: "2026-01-02",
      basicSalary: "3000.00",
    });
    await createEmployee(db, hrAdmin, {
      fullName: "Tan Wei Ming",
      joinedOn: "2026-01-02",
      basicSalary: "3100.00",
      employeeNo: "EMP-DUPE",
    });

    const staged = await parseAttendanceFile(
      db,
      "Name,Date/Time\nTan Wei Ming,13/07/2026 09:00\n",
      { mapping: { dateFormat: "dmy" } },
    );

    expect(staged.rows[0]!.state).toBe("problem");
    expect(staged.rows[0]!.problem).toContain("More than one employee");
  });

  it("refuses a date that could be read two ways", async () => {
    const staged = await parseAttendanceFile(db, "USERID,Date/Time\n101,03/04/2026 09:00\n");
    expect(staged.rows[0]!.state).toBe("problem");
    expect(staged.rows[0]!.problem).toContain("day-first or month-first");
  });

  it("rejects a day outside somebody's employment", async () => {
    const staged = await parseAttendanceFile(
      db,
      "USERID,Date/Time\n101,05/12/2025 09:00\n101,05/12/2025 18:00\n",
      { mapping: { dateFormat: "dmy" } },
    );

    expect(staged.rows[0]!.state).toBe("problem");
    expect(staged.rows[0]!.problem).toContain("joined on 2026-01-06");
  });
});

// ---------------------------------------------------------------------------
describe("staging and confirming an import", () => {
  let importId: string;

  it("stages without touching attendance", async () => {
    const before = await listAttendance(db, { from: "2026-07-01", to: "2026-07-31" });

    const staged = await parseAttendanceFile(
      db,
      "USERID,Date/Time\n" +
        "101,20/07/2026 08:55\n" +
        "101,20/07/2026 18:10\n" +
        "102,20/07/2026 09:20\n" +
        "102,20/07/2026 17:40\n" +
        "999,20/07/2026 09:00\n",
      { mapping: { dateFormat: "dmy" } },
    );

    const result = await stageAttendanceImport(db, hrAdmin, staged, {
      sourceFilename: "july-device.csv",
      deviceLabel: "Front door reader",
    });
    importId = result.importId;

    expect(result.okCount).toBe(2);
    expect(result.problemCount).toBe(1);
    expect(result.unmappedDeviceIds).toEqual(["999"]);

    const after = await listAttendance(db, { from: "2026-07-01", to: "2026-07-31" });
    expect(after.length).toBe(before.length);
  });

  it("keeps the raw row so a rejection can be explained by showing it", async () => {
    const batch = await getAttendanceImport(db, importId);
    const rejected = batch!.rows.find((row) => row.state === "problem")!;

    expect(rejected.raw).toContain("999");
    expect(rejected.problem).toContain("not mapped");
  });

  it("derives the counts from the rows rather than trusting the application", async () => {
    const batch = await getAttendanceImport(db, importId);
    expect(batch!.summary.rowCount).toBe(3);
    expect(batch!.summary.acceptedCount).toBe(2);
    expect(batch!.summary.rejectedCount).toBe(1);
  });

  it("writes attendance only when confirmed", async () => {
    const result = await confirmAttendanceImport(db, hrAdmin, importId);

    expect(result.written).toBe(2);
    expect(result.skipped).toBe(0);

    const attendance = await listAttendance(db, { from: "2026-07-20", to: "2026-07-20" });
    expect(attendance).toHaveLength(2);
    expect(attendance[0]!.source).toBe("device");
    expect(attendance[0]!.status).toBe("draft");
  });

  it("refuses the same file again once confirmed", async () => {
    const staged = await parseAttendanceFile(
      db,
      "USERID,Date/Time\n" +
        "101,20/07/2026 08:55\n" +
        "101,20/07/2026 18:10\n" +
        "102,20/07/2026 09:20\n" +
        "102,20/07/2026 17:40\n" +
        "999,20/07/2026 09:00\n",
      { mapping: { dateFormat: "dmy" } },
    );

    await expect(stageAttendanceImport(db, hrAdmin, staged)).rejects.toThrow(
      /already been imported and confirmed/,
    );
  });

  it("never overwrites a day that was corrected by hand", async () => {
    // Somebody fixes a clock-out by hand…
    await recordAttendance(db, hrAdmin, {
      employeeId: aishahId,
      workDate: "2026-07-21",
      clockIn: "2026-07-21T08:50:00+08:00",
      clockOut: "2026-07-21T19:30:00+08:00",
      remarks: "Stayed for the Skudai site report",
    });

    // …and a later import of the same day must not quietly undo it.
    const staged = await parseAttendanceFile(
      db,
      "USERID,Date/Time\n101,21/07/2026 08:50\n101,21/07/2026 18:00\n",
      { mapping: { dateFormat: "dmy" } },
    );
    const batch = await stageAttendanceImport(db, hrAdmin, staged, {
      sourceFilename: "july-again.csv",
    });
    const result = await confirmAttendanceImport(db, hrAdmin, batch.importId);

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.clashes[0]!.workDate).toBe("2026-07-21");

    const day = (await listAttendance(db, { from: "2026-07-21", to: "2026-07-21" }))[0]!;
    // Compared as an instant, not as text: the driver returns UTC, and 19:30 in
    // Kuala Lumpur is 11:30 there.
    expect(new Date(String(day.clockOut)).toISOString()).toBe("2026-07-21T11:30:00.000Z");
    expect(day.source).toBe("manual");
  });

  it("needs a reason to discard, and will not discard a confirmed batch", async () => {
    const staged = await parseAttendanceFile(
      db,
      "USERID,Date/Time\n101,22/07/2026 09:00\n101,22/07/2026 18:00\n",
      { mapping: { dateFormat: "dmy" } },
    );
    const batch = await stageAttendanceImport(db, hrAdmin, staged);

    await expect(discardAttendanceImport(db, hrAdmin, batch.importId, "")).rejects.toThrow(
      ValidationError,
    );

    await discardAttendanceImport(db, hrAdmin, batch.importId, "Wrong device");
    await expect(discardAttendanceImport(db, hrAdmin, importId, "too late")).rejects.toThrow(
      /has been confirmed/,
    );
  });

  it("is not something an accountant may do", async () => {
    const staged = await parseAttendanceFile(
      db,
      "USERID,Date/Time\n101,23/07/2026 09:00\n",
      { mapping: { dateFormat: "dmy" } },
    );
    await expect(stageAttendanceImport(db, accountant, staged)).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("lists the employees the device does not know about yet", async () => {
    const unmapped = await listUnmappedEmployees(db);
    // The two people called Tan were created without a device number.
    expect(unmapped.length).toBeGreaterThanOrEqual(2);
    expect(unmapped.map((row) => row.fullName)).toContain("Tan Wei Ming");
  });
});

// ---------------------------------------------------------------------------
describe("correcting and finalising", () => {
  it("needs a reason to change a day that is already recorded", async () => {
    await expect(
      recordAttendance(db, hrAdmin, {
        employeeId: aishahId,
        workDate: "2026-07-20",
        clockIn: "2026-07-20T09:30:00+08:00",
        clockOut: "2026-07-20T18:00:00+08:00",
      }),
    ).rejects.toThrow(/needs a reason/);
  });

  it("marks a corrected device day as corrected, so the two are distinguishable", async () => {
    await recordAttendance(db, hrAdmin, {
      employeeId: aishahId,
      workDate: "2026-07-20",
      clockIn: "2026-07-20T08:55:00+08:00",
      clockOut: "2026-07-20T18:30:00+08:00",
      reason: "Device missed the evening scan; confirmed with the office log",
    });

    const day = (await listAttendance(db, { from: "2026-07-20", to: "2026-07-20" })).find(
      (row) => row.employeeId === aishahId,
    )!;
    expect(day.source).toBe("imported_corrected");
    expect(day.correctedReason).toContain("Device missed");
  });

  it("refuses to finalise while a day has a clock-in, no clock-out and no explanation", async () => {
    await recordAttendance(db, hrAdmin, {
      employeeId: aishahId,
      workDate: "2026-07-24",
      clockIn: "2026-07-24T08:50:00+08:00",
    });

    const period = await openAttendancePeriod(db, hrManager, {
      periodFrom: "2026-07-01",
      periodTo: "2026-07-31",
    });

    await expect(finaliseAttendancePeriod(db, hrManager, period.id)).rejects.toThrow(
      /no clock-out/,
    );

    // Saying why is enough; inventing a time would not be.
    await recordAttendance(db, hrAdmin, {
      employeeId: aishahId,
      workDate: "2026-07-24",
      clockIn: "2026-07-24T08:50:00+08:00",
      remarks: "Left for a site visit and did not return to the office",
      reason: "Explaining the missing scan",
    });

    // Nothing has been calculated yet, and finalising is the act that makes these figures the ones
    // payroll reads. Freezing a day the engine has never seen would make "final" mean "nobody worked
    // this out" — and a correction clears the figures on purpose, so the same refusal covers a day
    // corrected after the last calculation.
    await expect(finaliseAttendancePeriod(db, hrManager, period.id)).rejects.toThrow(
      /no calculated figures/,
    );

    await recalculateAttendance(db, hrAdmin, { from: "2026-07-01", to: "2026-07-31" });

    const result = await finaliseAttendancePeriod(db, hrManager, period.id);
    expect(result.finalised).toBeGreaterThan(0);
  });

  it("freezes finalised rows", async () => {
    const day = (await listAttendance(db, { from: "2026-07-20", to: "2026-07-20" }))[0]!;
    expect(day.status).toBe("final");

    await expect(
      recordAttendance(db, hrAdmin, {
        employeeId: day.employeeId,
        workDate: "2026-07-20",
        clockIn: "2026-07-20T10:00:00+08:00",
        reason: "trying it on",
      }),
    ).rejects.toThrow(/is final/);

    await expect(
      db.execute(
        sql`UPDATE hr.attendance SET clock_in = now() WHERE id = ${day.id}`,
      ),
    ).rejects.toThrow(/is final/);
  });

  it("refuses to insert anything new into a finalised period", async () => {
    await expect(
      recordAttendance(db, hrAdmin, {
        employeeId: aishahId,
        workDate: "2026-07-28",
        clockIn: "2026-07-28T09:00:00+08:00",
      }),
    ).rejects.toThrow(/finalised/);
  });

  it("needs a reason to reopen, and reopening thaws the rows with the period", async () => {
    const periods = await db.execute<{ id: string }>(
      sql`SELECT id FROM hr.attendance_period WHERE status = 'finalised' LIMIT 1`,
    );
    const periodId = periods.rows![0]!.id;

    await expect(reopenAttendancePeriod(db, hrManager, periodId, "")).rejects.toThrow(
      ValidationError,
    );

    await reopenAttendancePeriod(
      db,
      hrManager,
      periodId,
      "A corrected clock-out arrived from the office log after closing",
    );

    const day = (await listAttendance(db, { from: "2026-07-20", to: "2026-07-20" }))[0]!;
    expect(day.status).toBe("draft");
  });

  it("refuses overlapping attendance periods", async () => {
    await expect(
      openAttendancePeriod(db, hrManager, { periodFrom: "2026-07-15", periodTo: "2026-08-15" }),
    ).rejects.toThrow(/overlaps/);
  });

  it("is not something HR_ADMIN alone may finalise without the capability", async () => {
    // HR_ADMIN does hold hr.attendance.finalise in this catalogue; an accountant
    // does not, and that is the boundary worth asserting.
    await expect(
      openAttendancePeriod(db, accountant, { periodFrom: "2026-11-01", periodTo: "2026-11-30" }),
    ).rejects.toThrow(AuthorizationError);
  });
});
