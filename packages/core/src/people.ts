import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, today, toIsoDate } from "./dates.js";
import { amountToSql, parseAmount, type Amount } from "./money.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { allocateDocumentNumber } from "./sequence.js";

/**
 * The people, and the shape of the organisation they work in.
 *
 * This is the most privacy-sensitive module in the platform, and three rules run
 * through all of it.
 *
 * **Sensitive fields are separated from ordinary ones, in the types.** `Employee`
 * carries what anybody in HR may see; `EmployeeSensitive` carries the NRIC, the
 * bank account and the salary, is returned only by a function that demands
 * `hr.employee.view_sensitive`, and reading it writes an audit row. Two types
 * rather than one optional field, so a screen cannot accidentally render what it
 * did not ask for — the mistake is a compile error instead of a disclosure.
 *
 * **The NRIC and the bank account are decrypted only on request.** They are stored
 * as ciphertext with the key outside the database, and the last four digits live
 * in their own column so lists and search never decrypt anything.
 *
 * **Employment history is the record; the employee row is a convenience.** Every
 * change to salary, position, department, type or status writes an append-only
 * event. A payroll run for March, re-run in December, reads the event history and
 * finds the salary that was actually in force. That is the single property Phase 7
 * cannot be built without, and it has to be true from the first employee onwards
 * rather than retrofitted.
 */

export type EmployeeStatus = "active" | "on_leave" | "suspended" | "resigned" | "terminated";
export type EmploymentType = "permanent" | "contract" | "probation" | "part_time" | "intern";
export type EmploymentEventKind =
  | "hired"
  | "confirmed"
  | "promoted"
  | "transferred"
  | "salary_changed"
  | "type_changed"
  | "suspended"
  | "reinstated"
  | "resigned"
  | "terminated"
  | "corrected";

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export interface DepartmentInput {
  code: string;
  name: string;
  parentId?: string | null;
  costCentreId?: string | null;
  headEmployeeId?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export interface DepartmentView {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
  costCentreId: string | null;
  costCentreCode: string | null;
  headEmployeeId: string | null;
  headName: string | null;
  isActive: boolean;
  notes: string | null;
  employeeCount: number;
}

export async function createDepartment(
  db: Executor,
  principal: Principal,
  input: DepartmentInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "hr.org.manage");

  const code = requireText(input.code, "Give the department a short code.", "code").toUpperCase();
  const name = requireText(input.name, "Name the department.", "name");

  await assertUnique(db, "hr.department", "code", code, "There is already a department with that code.");

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.department (code, name, parent_id, cost_centre_id, notes, created_by)
    VALUES (${code}, ${name}, ${input.parentId ?? null}, ${input.costCentreId ?? null},
            ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.DEPARTMENT_CREATED,
    entityType: "department",
    entityId: id,
    newValues: { code, name },
  });

  return { id };
}

export async function updateDepartment(
  db: Executor,
  principal: Principal,
  departmentId: string,
  input: DepartmentInput,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.org.manage");

  const before = await db.execute<{ code: string; name: string }>(
    sql`SELECT code, name FROM hr.department WHERE id = ${departmentId}`,
  );
  const previous = before.rows?.[0];
  if (!previous) throw new NotFoundError("That department no longer exists.");

  const name = requireText(input.name, "Name the department.", "name");

  await db.execute(sql`
    UPDATE hr.department
       SET name = ${name},
           parent_id = ${input.parentId ?? null},
           cost_centre_id = ${input.costCentreId ?? null},
           head_employee_id = ${input.headEmployeeId ?? null},
           notes = ${input.notes?.trim() || null},
           is_active = ${input.isActive ?? true},
           updated_by = ${principal.userId}
     WHERE id = ${departmentId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.DEPARTMENT_UPDATED,
    entityType: "department",
    entityId: departmentId,
    oldValues: { name: previous.name },
    newValues: { name },
  });
}

export async function listDepartments(
  db: Executor,
  options: { includeInactive?: boolean } = {},
): Promise<DepartmentView[]> {
  const result = await db.execute<{
    id: string;
    code: string;
    name: string;
    parent_id: string | null;
    parent_name: string | null;
    cost_centre_id: string | null;
    cost_centre_code: string | null;
    head_employee_id: string | null;
    head_name: string | null;
    is_active: boolean;
    notes: string | null;
    employee_count: number;
  }>(sql`
    SELECT d.id, d.code, d.name, d.parent_id, p.name AS parent_name,
           d.cost_centre_id, cc.code AS cost_centre_code,
           d.head_employee_id, h.full_name AS head_name, d.is_active, d.notes,
           COALESCE(e.count, 0)::int AS employee_count
      FROM hr.department d
      LEFT JOIN hr.department p ON p.id = d.parent_id
      LEFT JOIN org.cost_centre cc ON cc.id = d.cost_centre_id
      LEFT JOIN hr.employee h ON h.id = d.head_employee_id
      LEFT JOIN (
        SELECT department_id, count(*) AS count FROM hr.employee
         WHERE status IN ('active', 'on_leave', 'suspended') GROUP BY department_id
      ) e ON e.department_id = d.id
     WHERE ${options.includeInactive ? sql`true` : sql`d.is_active`}
     ORDER BY d.code
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    parentId: row.parent_id,
    parentName: row.parent_name,
    costCentreId: row.cost_centre_id,
    costCentreCode: row.cost_centre_code,
    headEmployeeId: row.head_employee_id,
    headName: row.head_name,
    isActive: row.is_active,
    notes: row.notes,
    employeeCount: row.employee_count,
  }));
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export interface PositionInput {
  code: string;
  title: string;
  departmentId?: string | null;
  grade?: string | null;
  description?: string | null;
  isActive?: boolean;
}

export interface PositionView {
  id: string;
  code: string;
  title: string;
  departmentId: string | null;
  departmentName: string | null;
  grade: string | null;
  description: string | null;
  isActive: boolean;
  employeeCount: number;
}

export async function createPosition(
  db: Executor,
  principal: Principal,
  input: PositionInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "hr.org.manage");

  const code = requireText(input.code, "Give the position a short code.", "code").toUpperCase();
  const title = requireText(input.title, "Name the position.", "title");

  await assertUnique(db, "hr.position", "code", code, "There is already a position with that code.");

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.position (code, title, department_id, grade, description, created_by)
    VALUES (${code}, ${title}, ${input.departmentId ?? null}, ${input.grade?.trim() || null},
            ${input.description?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.POSITION_CREATED,
    entityType: "position",
    entityId: id,
    newValues: { code, title },
  });

  return { id };
}

export async function updatePosition(
  db: Executor,
  principal: Principal,
  positionId: string,
  input: PositionInput,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.org.manage");

  const before = await db.execute<{ title: string }>(
    sql`SELECT title FROM hr.position WHERE id = ${positionId}`,
  );
  if (!before.rows?.[0]) throw new NotFoundError("That position no longer exists.");

  const title = requireText(input.title, "Name the position.", "title");

  await db.execute(sql`
    UPDATE hr.position
       SET title = ${title}, department_id = ${input.departmentId ?? null},
           grade = ${input.grade?.trim() || null},
           description = ${input.description?.trim() || null},
           is_active = ${input.isActive ?? true},
           updated_by = ${principal.userId}
     WHERE id = ${positionId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.POSITION_UPDATED,
    entityType: "position",
    entityId: positionId,
    oldValues: { title: before.rows[0]!.title },
    newValues: { title },
  });
}

export async function listPositions(
  db: Executor,
  options: { includeInactive?: boolean } = {},
): Promise<PositionView[]> {
  const result = await db.execute<{
    id: string;
    code: string;
    title: string;
    department_id: string | null;
    department_name: string | null;
    grade: string | null;
    description: string | null;
    is_active: boolean;
    employee_count: number;
  }>(sql`
    SELECT p.id, p.code, p.title, p.department_id, d.name AS department_name,
           p.grade, p.description, p.is_active, COALESCE(e.count, 0)::int AS employee_count
      FROM hr.position p
      LEFT JOIN hr.department d ON d.id = p.department_id
      LEFT JOIN (
        SELECT position_id, count(*) AS count FROM hr.employee
         WHERE status IN ('active', 'on_leave', 'suspended') GROUP BY position_id
      ) e ON e.position_id = p.id
     WHERE ${options.includeInactive ? sql`true` : sql`p.is_active`}
     ORDER BY p.code
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    code: row.code,
    title: row.title,
    departmentId: row.department_id,
    departmentName: row.department_name,
    grade: row.grade,
    description: row.description,
    isActive: row.is_active,
    employeeCount: row.employee_count,
  }));
}

// ---------------------------------------------------------------------------
// Work schedules
// ---------------------------------------------------------------------------

export interface WorkScheduleInput {
  code: string;
  name: string;
  workDays: number[];
  startsAt: string;
  endsAt: string;
  breakMinutes?: number;
  graceMinutes?: number;
  crossesMidnight?: boolean;
  isDefault?: boolean;
  isActive?: boolean;
  notes?: string | null;
}

export interface WorkScheduleView {
  id: string;
  code: string;
  name: string;
  workDays: number[];
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  graceMinutes: number;
  crossesMidnight: boolean;
  isDefault: boolean;
  isActive: boolean;
  notes: string | null;
  /** Minutes in a scheduled day, net of the break. Derived, never stored. */
  scheduledMinutes: number;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

/** Minutes since midnight, for a "HH:MM" that has already been validated. */
export function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/**
 * How long a scheduled day is, net of the break.
 *
 * Exported and pure, because the Phase 6 engine needs exactly this arithmetic and
 * two implementations of it would eventually disagree about a night shift.
 */
export function scheduledMinutesFor(schedule: {
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  crossesMidnight: boolean;
}): number {
  const start = minutesOfDay(schedule.startsAt);
  const end = minutesOfDay(schedule.endsAt);
  const span = schedule.crossesMidnight ? 1440 - start + end : end - start;
  return Math.max(0, span - schedule.breakMinutes);
}

export async function createWorkSchedule(
  db: Executor,
  principal: Principal,
  input: WorkScheduleInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "hr.schedule.manage");

  const code = requireText(input.code, "Give the schedule a short code.", "code").toUpperCase();
  const name = requireText(input.name, "Name the schedule.", "name");

  validateSchedule(input);
  await assertUnique(db, "hr.work_schedule", "code", code, "There is already a schedule with that code.");

  // One default only; making this one default demotes the other, rather than the
  // unique index refusing the insert with a message about an index.
  if (input.isDefault) {
    await db.execute(sql`UPDATE hr.work_schedule SET is_default = false WHERE is_default`);
  }

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.work_schedule
      (code, name, work_days, starts_at, ends_at, break_minutes, grace_minutes,
       crosses_midnight, is_default, notes, created_by)
    VALUES (${code}, ${name}, ${sql.raw(pgIntArray(input.workDays))}, ${input.startsAt}, ${input.endsAt},
            ${input.breakMinutes ?? 60}, ${input.graceMinutes ?? 10},
            ${input.crossesMidnight ?? false}, ${input.isDefault ?? false},
            ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.SCHEDULE_CREATED,
    entityType: "work_schedule",
    entityId: id,
    newValues: {
      code,
      name,
      workDays: input.workDays,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      graceMinutes: input.graceMinutes ?? 10,
    },
  });

  return { id };
}

export async function updateWorkSchedule(
  db: Executor,
  principal: Principal,
  scheduleId: string,
  input: WorkScheduleInput,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.schedule.manage");

  const before = await db.execute<{ name: string; starts_at: string; ends_at: string }>(
    sql`SELECT name, starts_at, ends_at FROM hr.work_schedule WHERE id = ${scheduleId}`,
  );
  const previous = before.rows?.[0];
  if (!previous) throw new NotFoundError("That schedule no longer exists.");

  validateSchedule(input);

  if (input.isDefault) {
    await db.execute(
      sql`UPDATE hr.work_schedule SET is_default = false WHERE is_default AND id <> ${scheduleId}`,
    );
  }

  await db.execute(sql`
    UPDATE hr.work_schedule
       SET name = ${requireText(input.name, "Name the schedule.", "name")},
           work_days = ${sql.raw(pgIntArray(input.workDays))},
           starts_at = ${input.startsAt},
           ends_at = ${input.endsAt},
           break_minutes = ${input.breakMinutes ?? 60},
           grace_minutes = ${input.graceMinutes ?? 10},
           crosses_midnight = ${input.crossesMidnight ?? false},
           is_default = ${input.isDefault ?? false},
           is_active = ${input.isActive ?? true},
           notes = ${input.notes?.trim() || null},
           updated_by = ${principal.userId}
     WHERE id = ${scheduleId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.SCHEDULE_UPDATED,
    entityType: "work_schedule",
    entityId: scheduleId,
    oldValues: { name: previous.name, startsAt: previous.starts_at, endsAt: previous.ends_at },
    newValues: { name: input.name, startsAt: input.startsAt, endsAt: input.endsAt },
  });
}

function validateSchedule(input: WorkScheduleInput): void {
  if (!TIME_PATTERN.test(input.startsAt)) {
    throw new ValidationError("The start time should read like 09:00.", "startsAt");
  }
  if (!TIME_PATTERN.test(input.endsAt)) {
    throw new ValidationError("The end time should read like 18:00.", "endsAt");
  }
  if (!Array.isArray(input.workDays) || input.workDays.length === 0) {
    throw new ValidationError("Choose at least one working day.", "workDays");
  }
  if (input.workDays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new ValidationError("Working days are 1 (Monday) to 7 (Sunday).", "workDays");
  }
  if (new Set(input.workDays).size !== input.workDays.length) {
    throw new ValidationError("A day appears twice in the working week.", "workDays");
  }

  if (!input.crossesMidnight && minutesOfDay(input.endsAt) <= minutesOfDay(input.startsAt)) {
    throw new ValidationError(
      "The day ends before it starts. If that is a night shift, say that it crosses midnight.",
      "endsAt",
    );
  }

  const net = scheduledMinutesFor({
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    breakMinutes: input.breakMinutes ?? 60,
    crossesMidnight: input.crossesMidnight ?? false,
  });
  if (net <= 0) {
    throw new ValidationError(
      "The break is as long as the working day, which leaves no time worked.",
      "breakMinutes",
    );
  }
}

/**
 * An integer array literal for PostgreSQL.
 *
 * Built by hand because the values are interpolated with `sql.raw`, so each one is
 * checked to be an integer in range first — `validateSchedule` has already done
 * that, and this re-checks rather than trusting a caller that skipped it. An array
 * parameter would be cleaner; drizzle's raw-SQL path does not bind one portably
 * across PGlite and node-postgres.
 */
function pgIntArray(values: number[]): string {
  for (const value of values) {
    if (!Number.isInteger(value) || value < 1 || value > 7) {
      throw new ValidationError("Working days are 1 (Monday) to 7 (Sunday).", "workDays");
    }
  }
  return `'{${values.join(",")}}'::integer[]`;
}

export async function listWorkSchedules(
  db: Executor,
  options: { includeInactive?: boolean } = {},
): Promise<WorkScheduleView[]> {
  const result = await db.execute<{
    id: string;
    code: string;
    name: string;
    work_days: number[] | string;
    starts_at: string;
    ends_at: string;
    break_minutes: number;
    grace_minutes: number;
    crosses_midnight: boolean;
    is_default: boolean;
    is_active: boolean;
    notes: string | null;
  }>(sql`
    SELECT id, code, name, work_days, starts_at, ends_at, break_minutes, grace_minutes,
           crosses_midnight, is_default, is_active, notes
      FROM hr.work_schedule
     WHERE ${options.includeInactive ? sql`true` : sql`is_active`}
     ORDER BY is_default DESC, code
  `);

  return (result.rows ?? []).map((row) => {
    const startsAt = String(row.starts_at).slice(0, 5);
    const endsAt = String(row.ends_at).slice(0, 5);
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      workDays: readIntArray(row.work_days),
      startsAt,
      endsAt,
      breakMinutes: row.break_minutes,
      graceMinutes: row.grace_minutes,
      crossesMidnight: row.crosses_midnight,
      isDefault: row.is_default,
      isActive: row.is_active,
      notes: row.notes,
      scheduledMinutes: scheduledMinutesFor({
        startsAt,
        endsAt,
        breakMinutes: row.break_minutes,
        crossesMidnight: row.crosses_midnight,
      }),
    };
  });
}

/**
 * Reads an integer array back.
 *
 * PGlite and node-postgres do not agree on whether an int[] column arrives as an
 * array or as the literal `{1,2,3}`. Handling both here means no caller has to
 * care, and the day the database moves nothing changes.
 */
function readIntArray(value: number[] | string | null): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value !== "string") return [];
  return value
    .replace(/[{}]/g, "")
    .split(",")
    .filter((part) => part.trim() !== "")
    .map(Number);
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export interface EmployeeInput {
  fullName: string;
  preferredName?: string | null;
  employeeNo?: string;
  /** Plain; encrypted before it is stored, and never returned by `getEmployee`. */
  nric?: string | null;
  passportNo?: string | null;
  nationality?: string;
  dateOfBirth?: string | null;
  gender?: string | null;
  maritalStatus?: string | null;
  email?: string | null;
  personalEmail?: string | null;
  phone?: string | null;
  address?: string | null;
  emergencyContact?: string | null;
  emergencyPhone?: string | null;
  positionId?: string | null;
  departmentId?: string | null;
  reportsToId?: string | null;
  costCentreId?: string | null;
  workScheduleId?: string | null;
  employmentType?: EmploymentType;
  joinedOn: string;
  probationMonths?: number;
  epfNo?: string | null;
  socsoNo?: string | null;
  incomeTaxNo?: string | null;
  epfApplicable?: boolean;
  socsoApplicable?: boolean;
  eisApplicable?: boolean;
  pcbApplicable?: boolean;
  taxDependants?: number;
  bankName?: string | null;
  /** Plain; encrypted before it is stored. */
  bankAccountNo?: string | null;
  basicSalary?: string;
  payFrequency?: "monthly" | "daily" | "hourly";
  deviceUserId?: string | null;
  userId?: string | null;
  notes?: string | null;
}

/** What anybody with `hr.employee.view` may see. */
export interface Employee {
  id: string;
  employeeNo: string;
  fullName: string;
  preferredName: string | null;
  nricLast4: string | null;
  nationality: string;
  gender: string | null;
  maritalStatus: string | null;
  email: string | null;
  phone: string | null;
  positionId: string | null;
  positionTitle: string | null;
  departmentId: string | null;
  departmentName: string | null;
  reportsToId: string | null;
  reportsToName: string | null;
  costCentreId: string | null;
  workScheduleId: string | null;
  workScheduleName: string | null;
  employmentType: EmploymentType;
  joinedOn: string;
  probationMonths: number;
  confirmedOn: string | null;
  status: EmployeeStatus;
  lastDay: string | null;
  exitReason: string | null;
  epfApplicable: boolean;
  socsoApplicable: boolean;
  eisApplicable: boolean;
  pcbApplicable: boolean;
  taxDependants: number;
  bankName: string | null;
  bankAccountLast4: string | null;
  payFrequency: string;
  deviceUserId: string | null;
  userId: string | null;
  notes: string | null;
  /** Derived: when probation would end, so a confirmation that is overdue shows. */
  probationEndsOn: string | null;
}

/**
 * The fields that need `hr.employee.view_sensitive`.
 *
 * A separate type on purpose. If these were optional fields on `Employee`, a
 * screen could render `employee.nric` and get `undefined` in the good case and a
 * disclosure in the bad one. Separating them makes the mistake a compile error.
 */
export interface EmployeeSensitive {
  employeeId: string;
  nric: string | null;
  passportNo: string | null;
  dateOfBirth: string | null;
  address: string | null;
  personalEmail: string | null;
  emergencyContact: string | null;
  emergencyPhone: string | null;
  epfNo: string | null;
  socsoNo: string | null;
  incomeTaxNo: string | null;
  bankName: string | null;
  bankAccountNo: string | null;
  basicSalary: Amount;
}

export async function createEmployee(
  db: Executor,
  principal: Principal,
  input: EmployeeInput,
  context?: AuditContext,
): Promise<{ id: string; employeeNo: string }> {
  requireCapability(principal, "hr.employee.create");

  const fullName = requireText(input.fullName, "The employee's full name is needed.", "fullName");
  const joinedOn = toIsoDate(parseIsoDate(input.joinedOn, "joinedOn"));
  const salary = parseAmount(input.basicSalary ?? "0", "basicSalary");
  if (salary < 0n) throw new ValidationError("A salary cannot be negative.", "basicSalary");

  const employeeNo = input.employeeNo?.trim()
    ? input.employeeNo.trim().toUpperCase()
    : await allocateDocumentNumber(db, "employee", { on: joinedOn });

  await assertUnique(
    db,
    "hr.employee",
    "employee_no",
    employeeNo,
    "There is already an employee with that number.",
  );

  if (input.deviceUserId?.trim()) {
    await assertUnique(
      db,
      "hr.employee",
      "device_user_id",
      input.deviceUserId.trim(),
      "Another employee is already mapped to that device number. Two people sharing one would " +
        "put one person's attendance on the other's record.",
    );
  }

  const nric = normaliseNric(input.nric);
  const bank = normaliseAccountNo(input.bankAccountNo);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.employee (
      employee_no, full_name, preferred_name, nric_enc, nric_last4, passport_no_enc,
      nationality, date_of_birth, gender, marital_status,
      email, personal_email, phone, address, emergency_contact, emergency_phone,
      position_id, department_id, reports_to_id, cost_centre_id, work_schedule_id,
      employment_type, joined_on, probation_months,
      epf_no, socso_no, income_tax_no,
      epf_applicable, socso_applicable, eis_applicable, pcb_applicable, tax_dependants,
      bank_name, bank_account_enc, bank_account_last4,
      basic_salary, pay_frequency, device_user_id, user_id, notes, created_by
    ) VALUES (
      ${employeeNo}, ${fullName}, ${input.preferredName?.trim() || null},
      ${nric.cipher}, ${nric.last4},
      ${input.passportNo?.trim() ? encryptSecret(input.passportNo.trim()) : null},
      ${input.nationality?.trim() || "Malaysian"},
      ${input.dateOfBirth ? toIsoDate(parseIsoDate(input.dateOfBirth, "dateOfBirth")) : null},
      ${input.gender?.trim() || null}, ${input.maritalStatus?.trim() || null},
      ${input.email?.trim()?.toLowerCase() || null}, ${input.personalEmail?.trim()?.toLowerCase() || null},
      ${input.phone?.trim() || null}, ${input.address?.trim() || null},
      ${input.emergencyContact?.trim() || null}, ${input.emergencyPhone?.trim() || null},
      ${input.positionId ?? null}, ${input.departmentId ?? null}, ${input.reportsToId ?? null},
      ${input.costCentreId ?? null}, ${input.workScheduleId ?? null},
      ${input.employmentType ?? "permanent"}, ${joinedOn}, ${input.probationMonths ?? 3},
      ${input.epfNo?.trim() || null}, ${input.socsoNo?.trim() || null}, ${input.incomeTaxNo?.trim() || null},
      ${input.epfApplicable ?? true}, ${input.socsoApplicable ?? true},
      ${input.eisApplicable ?? true}, ${input.pcbApplicable ?? true}, ${input.taxDependants ?? 0},
      ${input.bankName?.trim() || null}, ${bank.cipher}, ${bank.last4},
      ${amountToSql(salary)}, ${input.payFrequency ?? "monthly"},
      ${input.deviceUserId?.trim() || null}, ${input.userId ?? null},
      ${input.notes?.trim() || null}, ${principal.userId}
    ) RETURNING id
  `);
  const id = created.rows![0]!.id;

  // The first event, so the history is complete from the beginning rather than
  // starting at whatever the first change happens to be.
  await db.execute(sql`
    INSERT INTO hr.employment_event
      (employee_id, kind, effective_from, basic_salary, position_id, department_id,
       employment_type, status, reason, created_by)
    VALUES (${id}, 'hired', ${joinedOn}, ${amountToSql(salary)}, ${input.positionId ?? null},
            ${input.departmentId ?? null}, ${input.employmentType ?? "permanent"}, 'active',
            'Joined the company', ${principal.userId})
  `);

  if (input.workScheduleId) {
    await db.execute(sql`
      INSERT INTO hr.employee_schedule (employee_id, work_schedule_id, effective_from, created_by)
      VALUES (${id}, ${input.workScheduleId}, ${joinedOn}, ${principal.userId})
    `);
  }

  if (input.userId) {
    await db.execute(sql`UPDATE auth."user" SET employee_id = ${id} WHERE id = ${input.userId}`);
  }

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.EMPLOYEE_CREATED,
    entityType: "employee",
    entityId: id,
    // `redact` masks nric, salary and bank account; naming them here means the
    // audit records that they were set without recording what they were.
    newValues: {
      employeeNo,
      fullName,
      joinedOn,
      nric: nric.last4 ? `****${nric.last4}` : null,
      basic_salary: amountToSql(salary),
      bank_account: bank.last4 ? `****${bank.last4}` : null,
    },
  });

  return { id, employeeNo };
}

export async function updateEmployee(
  db: Executor,
  principal: Principal,
  employeeId: string,
  input: EmployeeInput,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.employee.edit");

  const before = await lockEmployee(db, employeeId);

  const fullName = requireText(input.fullName, "The employee's full name is needed.", "fullName");
  const salary = parseAmount(input.basicSalary ?? String(before.basic_salary), "basicSalary");
  if (salary < 0n) throw new ValidationError("A salary cannot be negative.", "basicSalary");

  if (input.deviceUserId?.trim() && input.deviceUserId.trim() !== before.device_user_id) {
    await assertUnique(
      db,
      "hr.employee",
      "device_user_id",
      input.deviceUserId.trim(),
      "Another employee is already mapped to that device number.",
    );
  }

  // Changing a salary here writes history, because a change with no effective date
  // is a change no payroll rerun can locate. The event is dated today unless the
  // caller uses `recordEmploymentEvent` directly with a date.
  const salaryChanged = salary !== parseAmount(String(before.basic_salary));

  const nric = input.nric === undefined
    ? { cipher: before.nric_enc, last4: before.nric_last4 }
    : normaliseNric(input.nric);
  const bank = input.bankAccountNo === undefined
    ? { cipher: before.bank_account_enc, last4: before.bank_account_last4 }
    : normaliseAccountNo(input.bankAccountNo);

  // `undefined` means "leave this alone"; an explicit null or empty string means
  // "clear it".
  //
  // The distinction is not pedantry. Treating an absent field as "set to null"
  // makes every partial update a silent deletion — and the field it silently
  // deleted first, in testing, was the device number that ties this person to their
  // attendance. Nothing on screen would have shown it had gone.
  const keep = (value: unknown, column: string) =>
    value === undefined ? sql.raw(column) : sql`${value}`;

  const optionalText = (value: string | null | undefined, column: string) =>
    value === undefined ? sql.raw(column) : sql`${value?.trim() || null}`;

  await db.execute(sql`
    UPDATE hr.employee SET
      full_name = ${fullName},
      preferred_name = ${optionalText(input.preferredName, "preferred_name")},
      nric_enc = ${keep(input.nric === undefined ? undefined : nric.cipher, "nric_enc")},
      nric_last4 = ${keep(input.nric === undefined ? undefined : nric.last4, "nric_last4")},
      nationality = ${keep(input.nationality?.trim() || undefined, "nationality")},
      date_of_birth = ${
        input.dateOfBirth === undefined
          ? sql.raw("date_of_birth")
          : sql`${input.dateOfBirth ? toIsoDate(parseIsoDate(input.dateOfBirth, "dateOfBirth")) : null}`
      },
      gender = ${optionalText(input.gender, "gender")},
      marital_status = ${optionalText(input.maritalStatus, "marital_status")},
      email = ${
        input.email === undefined
          ? sql.raw("email")
          : sql`${input.email?.trim()?.toLowerCase() || null}`
      },
      personal_email = ${
        input.personalEmail === undefined
          ? sql.raw("personal_email")
          : sql`${input.personalEmail?.trim()?.toLowerCase() || null}`
      },
      phone = ${optionalText(input.phone, "phone")},
      address = ${optionalText(input.address, "address")},
      emergency_contact = ${optionalText(input.emergencyContact, "emergency_contact")},
      emergency_phone = ${optionalText(input.emergencyPhone, "emergency_phone")},
      position_id = ${keep(input.positionId, "position_id")},
      department_id = ${keep(input.departmentId, "department_id")},
      reports_to_id = ${keep(input.reportsToId, "reports_to_id")},
      cost_centre_id = ${keep(input.costCentreId, "cost_centre_id")},
      work_schedule_id = ${keep(input.workScheduleId, "work_schedule_id")},
      employment_type = ${input.employmentType ?? before.employment_type},
      probation_months = ${input.probationMonths ?? before.probation_months},
      epf_no = ${optionalText(input.epfNo, "epf_no")},
      socso_no = ${optionalText(input.socsoNo, "socso_no")},
      income_tax_no = ${optionalText(input.incomeTaxNo, "income_tax_no")},
      epf_applicable = ${input.epfApplicable ?? before.epf_applicable},
      socso_applicable = ${input.socsoApplicable ?? before.socso_applicable},
      eis_applicable = ${input.eisApplicable ?? before.eis_applicable},
      pcb_applicable = ${input.pcbApplicable ?? before.pcb_applicable},
      tax_dependants = ${input.taxDependants ?? before.tax_dependants},
      bank_name = ${optionalText(input.bankName, "bank_name")},
      bank_account_enc = ${
        keep(input.bankAccountNo === undefined ? undefined : bank.cipher, "bank_account_enc")
      },
      bank_account_last4 = ${
        keep(input.bankAccountNo === undefined ? undefined : bank.last4, "bank_account_last4")
      },
      basic_salary = ${amountToSql(salary)},
      pay_frequency = ${input.payFrequency ?? before.pay_frequency},
      device_user_id = ${optionalText(input.deviceUserId, "device_user_id")},
      notes = ${optionalText(input.notes, "notes")},
      updated_by = ${principal.userId}
    WHERE id = ${employeeId}
  `);

  if (salaryChanged) {
    await db.execute(sql`
      INSERT INTO hr.employment_event
        (employee_id, kind, effective_from, basic_salary, reason, created_by)
      VALUES (${employeeId}, 'salary_changed', ${toIsoDate(today())}, ${amountToSql(salary)},
              'Changed on the employee record', ${principal.userId})
    `);
  }

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.EMPLOYEE_UPDATED,
    entityType: "employee",
    entityId: employeeId,
    oldValues: { fullName: before.full_name, basic_salary: String(before.basic_salary) },
    newValues: { fullName, basic_salary: amountToSql(salary) },
  });
}

/**
 * The NRIC, normalised and encrypted.
 *
 * Punctuation is stripped so that `860101-14-5566` and `860101145566` are the same
 * person; the last four digits are kept in the clear for identification. A
 * Malaysian NRIC is twelve digits, and anything else is refused rather than stored
 * as a mystery — it is used for statutory filing, where a wrong one is somebody
 * else's contribution.
 */
function normaliseNric(nric: string | null | undefined): { cipher: string | null; last4: string | null } {
  const raw = (nric ?? "").trim();
  if (raw === "") return { cipher: null, last4: null };

  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 12) {
    throw new ValidationError(
      "A Malaysian identity card number is twelve digits. Use the passport field for a " +
        "non-Malaysian employee.",
      "nric",
    );
  }

  return { cipher: encryptSecret(digits), last4: digits.slice(-4) };
}

function normaliseAccountNo(
  accountNo: string | null | undefined,
): { cipher: string | null; last4: string | null } {
  const raw = (accountNo ?? "").trim();
  if (raw === "") return { cipher: null, last4: null };

  const digits = raw.replace(/\s/g, "");
  if (digits.length < 5) {
    throw new ValidationError("That does not look like a bank account number.", "bankAccountNo");
  }

  return { cipher: encryptSecret(digits), last4: digits.slice(-4) };
}

export async function getEmployee(db: Executor, employeeId: string): Promise<Employee | null> {
  const rows = await selectEmployees(db, sql`e.id = ${employeeId}`, 1);
  return rows[0] ?? null;
}

export async function listEmployees(
  db: Executor,
  filters: {
    status?: EmployeeStatus;
    departmentId?: string;
    search?: string;
    includeLeavers?: boolean;
    limit?: number;
  } = {},
): Promise<Employee[]> {
  const where = [sql`true`];
  if (filters.status) where.push(sql`e.status = ${filters.status}`);
  else if (!filters.includeLeavers) {
    where.push(sql`e.status IN ('active', 'on_leave', 'suspended')`);
  }
  if (filters.departmentId) where.push(sql`e.department_id = ${filters.departmentId}`);
  if (filters.search?.trim()) {
    const term = `%${filters.search.trim().toLowerCase()}%`;
    where.push(sql`(
      lower(e.full_name) LIKE ${term}
      OR lower(e.employee_no) LIKE ${term}
      OR lower(COALESCE(e.email, '')) LIKE ${term}
      OR COALESCE(e.nric_last4, '') LIKE ${term}
    )`);
  }

  return selectEmployees(db, sql.join(where, sql` AND `), filters.limit ?? 500);
}

async function selectEmployees(
  db: Executor,
  where: ReturnType<typeof sql>,
  limit: number,
): Promise<Employee[]> {
  const result = await db.execute<Record<string, never>>(sql`
    SELECT e.id, e.employee_no, e.full_name, e.preferred_name, e.nric_last4, e.nationality,
           e.gender, e.marital_status, e.email, e.phone,
           e.position_id, p.title AS position_title,
           e.department_id, d.name AS department_name,
           e.reports_to_id, m.full_name AS reports_to_name,
           e.cost_centre_id, e.work_schedule_id, ws.name AS work_schedule_name,
           e.employment_type, e.joined_on, e.probation_months, e.confirmed_on,
           e.status, e.last_day, e.exit_reason,
           e.epf_applicable, e.socso_applicable, e.eis_applicable, e.pcb_applicable,
           e.tax_dependants, e.bank_name, e.bank_account_last4, e.pay_frequency,
           e.device_user_id, e.user_id, e.notes,
           (e.joined_on + (e.probation_months || ' months')::interval)::date AS probation_ends_on
      FROM hr.employee e
      LEFT JOIN hr.position p ON p.id = e.position_id
      LEFT JOIN hr.department d ON d.id = e.department_id
      LEFT JOIN hr.employee m ON m.id = e.reports_to_id
      LEFT JOIN hr.work_schedule ws ON ws.id = e.work_schedule_id
     WHERE ${where}
     ORDER BY e.full_name
     LIMIT ${Math.min(Math.max(limit, 1), 2000)}
  `);

  return (result.rows ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      employeeNo: String(row.employee_no),
      fullName: String(row.full_name),
      preferredName: (row.preferred_name as string) ?? null,
      nricLast4: (row.nric_last4 as string) ?? null,
      nationality: String(row.nationality),
      gender: (row.gender as string) ?? null,
      maritalStatus: (row.marital_status as string) ?? null,
      email: (row.email as string) ?? null,
      phone: (row.phone as string) ?? null,
      positionId: (row.position_id as string) ?? null,
      positionTitle: (row.position_title as string) ?? null,
      departmentId: (row.department_id as string) ?? null,
      departmentName: (row.department_name as string) ?? null,
      reportsToId: (row.reports_to_id as string) ?? null,
      reportsToName: (row.reports_to_name as string) ?? null,
      costCentreId: (row.cost_centre_id as string) ?? null,
      workScheduleId: (row.work_schedule_id as string) ?? null,
      workScheduleName: (row.work_schedule_name as string) ?? null,
      employmentType: row.employment_type as EmploymentType,
      joinedOn: String(row.joined_on).slice(0, 10),
      probationMonths: Number(row.probation_months),
      confirmedOn: row.confirmed_on ? String(row.confirmed_on).slice(0, 10) : null,
      status: row.status as EmployeeStatus,
      lastDay: row.last_day ? String(row.last_day).slice(0, 10) : null,
      exitReason: (row.exit_reason as string) ?? null,
      epfApplicable: Boolean(row.epf_applicable),
      socsoApplicable: Boolean(row.socso_applicable),
      eisApplicable: Boolean(row.eis_applicable),
      pcbApplicable: Boolean(row.pcb_applicable),
      taxDependants: Number(row.tax_dependants),
      bankName: (row.bank_name as string) ?? null,
      bankAccountLast4: (row.bank_account_last4 as string) ?? null,
      payFrequency: String(row.pay_frequency),
      deviceUserId: (row.device_user_id as string) ?? null,
      userId: (row.user_id as string) ?? null,
      notes: (row.notes as string) ?? null,
      probationEndsOn: row.probation_ends_on
        ? String(row.probation_ends_on).slice(0, 10)
        : null,
    };
  });
}

/**
 * The sensitive fields, decrypted, and the fact of the reading recorded.
 *
 * The audit row is the point as much as the capability check is. "Who looked at
 * this person's identity card number, and when" is a question PDPA makes real, and
 * it cannot be answered unless looking leaves a trace. `reason` is optional but
 * offered, because a lookup with a stated purpose is worth far more later than one
 * without.
 */
export async function getEmployeeSensitive(
  db: Executor,
  principal: Principal,
  employeeId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<EmployeeSensitive | null> {
  requireCapability(principal, "hr.employee.view_sensitive");

  const result = await db.execute<{
    id: string;
    nric_enc: string | null;
    passport_no_enc: string | null;
    date_of_birth: string | null;
    address: string | null;
    personal_email: string | null;
    emergency_contact: string | null;
    emergency_phone: string | null;
    epf_no: string | null;
    socso_no: string | null;
    income_tax_no: string | null;
    bank_name: string | null;
    bank_account_enc: string | null;
    basic_salary: string;
    employee_no: string;
  }>(sql`
    SELECT id, nric_enc, passport_no_enc, date_of_birth, address, personal_email,
           emergency_contact, emergency_phone, epf_no, socso_no, income_tax_no,
           bank_name, bank_account_enc, basic_salary, employee_no
      FROM hr.employee WHERE id = ${employeeId}
  `);
  const row = result.rows?.[0];
  if (!row) return null;

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.EXPORT_SENSITIVE,
    entityType: "employee",
    entityId: employeeId,
    newValues: { employeeNo: row.employee_no, fields: ["nric", "bank_account", "salary"] },
    reason: options.reason ?? null,
  });

  return {
    employeeId: row.id,
    nric: row.nric_enc ? decryptSecret(row.nric_enc) : null,
    passportNo: row.passport_no_enc ? decryptSecret(row.passport_no_enc) : null,
    dateOfBirth: row.date_of_birth ? String(row.date_of_birth).slice(0, 10) : null,
    address: row.address,
    personalEmail: row.personal_email,
    emergencyContact: row.emergency_contact,
    emergencyPhone: row.emergency_phone,
    epfNo: row.epf_no,
    socsoNo: row.socso_no,
    incomeTaxNo: row.income_tax_no,
    bankName: row.bank_name,
    bankAccountNo: row.bank_account_enc ? decryptSecret(row.bank_account_enc) : null,
    basicSalary: parseAmount(row.basic_salary),
  };
}

// ---------------------------------------------------------------------------
// Employment events
// ---------------------------------------------------------------------------

export interface EmploymentEventInput {
  kind: EmploymentEventKind;
  effectiveFrom: string;
  basicSalary?: string | null;
  positionId?: string | null;
  departmentId?: string | null;
  employmentType?: EmploymentType | null;
  reason?: string | null;
  notes?: string | null;
}

export interface EmploymentEventView {
  id: string;
  kind: EmploymentEventKind;
  effectiveFrom: string;
  basicSalary: Amount | null;
  positionTitle: string | null;
  departmentName: string | null;
  employmentType: string | null;
  status: string | null;
  reason: string | null;
  notes: string | null;
  createdAt: Date | string;
  createdByName: string | null;
}

/**
 * Records a change in somebody's employment, and applies it.
 *
 * The event is the record and the employee row is the projection of it, in that
 * order. Writing the event first and then updating the row means the history can
 * never be missing an entry for a change that happened, which is the failure mode
 * that makes a payroll rerun produce a different answer.
 *
 * A confirmation, a promotion and an exit are all this function. They differ in
 * which columns the event carries and what it does to the employee's status, not
 * in kind.
 */
export async function recordEmploymentEvent(
  db: Executor,
  principal: Principal,
  employeeId: string,
  input: EmploymentEventInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  // Ending somebody's employment is a different decision from amending their
  // record, and needs its own capability.
  const exiting = input.kind === "resigned" || input.kind === "terminated";
  requireCapability(principal, exiting ? "hr.employee.terminate" : "hr.employee.edit");

  const employee = await lockEmployee(db, employeeId);
  const effectiveFrom = toIsoDate(parseIsoDate(input.effectiveFrom, "effectiveFrom"));

  if (effectiveFrom < String(employee.joined_on).slice(0, 10)) {
    throw new ValidationError(
      `${employee.full_name} joined on ${String(employee.joined_on).slice(0, 10)}; an event cannot ` +
        "predate that.",
      "effectiveFrom",
    );
  }

  if (employee.status === "resigned" || employee.status === "terminated") {
    if (input.kind !== "corrected") {
      throw new ConflictError(
        `${employee.full_name} has already left. Only a correction can be recorded against a ` +
          "former employee.",
      );
    }
  }

  if (exiting && !input.reason?.trim()) {
    throw new ValidationError(
      "Record why the employment ended. It is the first thing anybody asks afterwards.",
      "reason",
    );
  }

  const salary =
    input.basicSalary === undefined || input.basicSalary === null || input.basicSalary === ""
      ? null
      : parseAmount(input.basicSalary, "basicSalary");
  if (salary !== null && salary < 0n) {
    throw new ValidationError("A salary cannot be negative.", "basicSalary");
  }

  const status = statusAfter(input.kind, employee.status as EmployeeStatus);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.employment_event
      (employee_id, kind, effective_from, basic_salary, position_id, department_id,
       employment_type, status, reason, notes, created_by)
    VALUES (${employeeId}, ${input.kind}, ${effectiveFrom},
            ${salary === null ? null : amountToSql(salary)},
            ${input.positionId ?? null}, ${input.departmentId ?? null},
            ${input.employmentType ?? null}, ${status},
            ${input.reason?.trim() || null}, ${input.notes?.trim() || null},
            ${principal.userId})
    RETURNING id
  `);

  // Then the projection onto the employee row. COALESCE so that an event which
  // says nothing about a field leaves it alone.
  await db.execute(sql`
    UPDATE hr.employee SET
      basic_salary = ${salary === null ? sql`basic_salary` : sql`${amountToSql(salary)}`},
      position_id = COALESCE(${input.positionId ?? null}, position_id),
      department_id = COALESCE(${input.departmentId ?? null}, department_id),
      employment_type = COALESCE(${input.employmentType ?? null}, employment_type),
      status = ${status},
      confirmed_on = ${input.kind === "confirmed" ? sql`${effectiveFrom}` : sql`confirmed_on`},
      last_day = ${exiting ? sql`${effectiveFrom}` : sql`last_day`},
      exit_reason = ${exiting ? sql`${input.reason?.trim() ?? null}` : sql`exit_reason`},
      updated_by = ${principal.userId}
    WHERE id = ${employeeId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: exiting ? AUDIT.EMPLOYEE_TERMINATED : AUDIT.EMPLOYMENT_EVENT_RECORDED,
    entityType: "employee",
    entityId: employeeId,
    newValues: {
      kind: input.kind,
      effectiveFrom,
      status,
      basic_salary: salary === null ? undefined : amountToSql(salary),
    },
    reason: input.reason ?? null,
  });

  return { id: created.rows![0]!.id };
}

function statusAfter(kind: EmploymentEventKind, current: EmployeeStatus): EmployeeStatus {
  switch (kind) {
    case "resigned":
      return "resigned";
    case "terminated":
      return "terminated";
    case "suspended":
      return "suspended";
    case "reinstated":
      return "active";
    case "hired":
    case "confirmed":
      return "active";
    default:
      return current;
  }
}

export async function listEmploymentEvents(
  db: Executor,
  employeeId: string,
): Promise<EmploymentEventView[]> {
  const result = await db.execute<{
    id: string;
    kind: EmploymentEventKind;
    effective_from: string;
    basic_salary: string | null;
    position_title: string | null;
    department_name: string | null;
    employment_type: string | null;
    status: string | null;
    reason: string | null;
    notes: string | null;
    created_at: Date | string;
    created_by_name: string | null;
  }>(sql`
    SELECT ev.id, ev.kind, ev.effective_from, ev.basic_salary,
           p.title AS position_title, d.name AS department_name,
           ev.employment_type, ev.status, ev.reason, ev.notes, ev.created_at,
           u.full_name AS created_by_name
      FROM hr.employment_event ev
      LEFT JOIN hr.position p ON p.id = ev.position_id
      LEFT JOIN hr.department d ON d.id = ev.department_id
      LEFT JOIN auth."user" u ON u.id = ev.created_by
     WHERE ev.employee_id = ${employeeId}
     ORDER BY ev.effective_from DESC, ev.created_at DESC
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    effectiveFrom: String(row.effective_from).slice(0, 10),
    basicSalary: row.basic_salary === null ? null : parseAmount(row.basic_salary),
    positionTitle: row.position_title,
    departmentName: row.department_name,
    employmentType: row.employment_type,
    status: row.status,
    reason: row.reason,
    notes: row.notes,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
  }));
}

/**
 * The salary in force on a date.
 *
 * What Phase 7 calls. It reads the event history rather than the employee row, so
 * re-running March's payroll in December produces March's answer. Returns null when
 * the person was not employed on that date, which is different from a salary of
 * nil and has to stay different.
 */
export async function salaryOn(
  db: Executor,
  employeeId: string,
  onDate: string,
): Promise<Amount | null> {
  const date = toIsoDate(parseIsoDate(onDate, "onDate"));

  const employment = await db.execute<{ joined_on: string; last_day: string | null }>(
    sql`SELECT joined_on, last_day FROM hr.employee WHERE id = ${employeeId}`,
  );
  const row = employment.rows?.[0];
  if (!row) return null;
  if (date < String(row.joined_on).slice(0, 10)) return null;
  if (row.last_day && date > String(row.last_day).slice(0, 10)) return null;

  const found = await db.execute<{ basic_salary: string }>(sql`
    SELECT basic_salary FROM hr.employment_event
     WHERE employee_id = ${employeeId}
       AND basic_salary IS NOT NULL
       AND effective_from <= ${date}::date
     ORDER BY effective_from DESC, created_at DESC
     LIMIT 1
  `);

  const salary = found.rows?.[0]?.basic_salary;
  return salary === undefined ? null : parseAmount(salary);
}

// ---------------------------------------------------------------------------
// Public holidays
// ---------------------------------------------------------------------------

export interface PublicHolidayInput {
  holidayOn: string;
  name: string;
  appliesTo?: string[];
  isHalfDay?: boolean;
  sourceRef?: string | null;
  notes?: string | null;
}

export async function addPublicHoliday(
  db: Executor,
  principal: Principal,
  input: PublicHolidayInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "hr.holiday.manage");

  const holidayOn = toIsoDate(parseIsoDate(input.holidayOn, "holidayOn"));
  const name = requireText(input.name, "Name the holiday.", "name");

  // A holiday with no source is a holiday somebody remembered. It makes a present
  // employee absent and an absent one present, so the gazette or circular it came
  // from is asked for.
  if (!input.sourceRef?.trim()) {
    throw new ValidationError(
      "Say where this holiday comes from — the federal gazette, a state circular, or the " +
        "company's own declaration. A holiday nobody can source is one nobody can defend.",
      "sourceRef",
    );
  }

  const states = (input.appliesTo ?? [])
    .map((state) => state.trim().toUpperCase())
    .filter((state) => state !== "");

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.public_holiday (holiday_on, name, applies_to, is_half_day, source_ref, notes, created_by)
    VALUES (${holidayOn}, ${name}, ${sql.raw(pgTextArray(states))}, ${input.isHalfDay ?? false},
            ${input.sourceRef.trim()}, ${input.notes?.trim() || null}, ${principal.userId})
    ON CONFLICT (holiday_on, name) DO NOTHING
    RETURNING id
  `);

  const id = created.rows?.[0]?.id;
  if (!id) throw new ConflictError(`${name} is already recorded for ${holidayOn}.`);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.HOLIDAY_ADDED,
    entityType: "public_holiday",
    entityId: id,
    newValues: { holidayOn, name, appliesTo: states, sourceRef: input.sourceRef.trim() },
  });

  return { id };
}

export async function removePublicHoliday(
  db: Executor,
  principal: Principal,
  holidayId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.holiday.manage");

  if (!reason?.trim()) {
    throw new ValidationError("Say why the holiday is being removed.", "reason");
  }

  const found = await db.execute<{ holiday_on: string; name: string }>(
    sql`SELECT holiday_on, name FROM hr.public_holiday WHERE id = ${holidayId}`,
  );
  const holiday = found.rows?.[0];
  if (!holiday) throw new NotFoundError("That holiday is not recorded.");

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.HOLIDAY_REMOVED,
    entityType: "public_holiday",
    entityId: holidayId,
    oldValues: { holidayOn: String(holiday.holiday_on).slice(0, 10), name: holiday.name },
    reason: reason.trim(),
  });

  await db.execute(sql`DELETE FROM hr.public_holiday WHERE id = ${holidayId}`);
}

export interface PublicHolidayView {
  id: string;
  holidayOn: string;
  name: string;
  appliesTo: string[];
  isHalfDay: boolean;
  sourceRef: string | null;
  notes: string | null;
}

export async function listPublicHolidays(
  db: Executor,
  filters: { from?: string; to?: string } = {},
): Promise<PublicHolidayView[]> {
  const where = [sql`true`];
  if (filters.from) where.push(sql`holiday_on >= ${toIsoDate(parseIsoDate(filters.from, "from"))}::date`);
  if (filters.to) where.push(sql`holiday_on <= ${toIsoDate(parseIsoDate(filters.to, "to"))}::date`);

  const result = await db.execute<{
    id: string;
    holiday_on: string;
    name: string;
    applies_to: string[] | string;
    is_half_day: boolean;
    source_ref: string | null;
    notes: string | null;
  }>(sql`
    SELECT id, holiday_on, name, applies_to, is_half_day, source_ref, notes
      FROM hr.public_holiday
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY holiday_on
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    holidayOn: String(row.holiday_on).slice(0, 10),
    name: row.name,
    appliesTo: readTextArray(row.applies_to),
    isHalfDay: row.is_half_day,
    sourceRef: row.source_ref,
    notes: row.notes,
  }));
}

function pgTextArray(values: string[]): string {
  for (const value of values) {
    // Interpolated with sql.raw, so anything but plain letters and digits is
    // refused rather than escaped — a state code has no business containing else.
    if (!/^[A-Z0-9_]{1,16}$/.test(value)) {
      throw new ValidationError(`"${value}" is not a state code.`, "appliesTo");
    }
  }
  return values.length === 0 ? `'{}'::text[]` : `'{${values.join(",")}}'::text[]`;
}

function readTextArray(value: string[] | string | null): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  return value
    .replace(/[{}"]/g, "")
    .split(",")
    .filter((part) => part.trim() !== "");
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface LockedEmployee extends Record<string, unknown> {
  id: string;
  full_name: string;
  status: string;
  joined_on: string;
  employment_type: string;
  probation_months: number;
  basic_salary: string;
  pay_frequency: string;
  device_user_id: string | null;
  nric_enc: string | null;
  nric_last4: string | null;
  bank_account_enc: string | null;
  bank_account_last4: string | null;
  epf_applicable: boolean;
  socso_applicable: boolean;
  eis_applicable: boolean;
  pcb_applicable: boolean;
  tax_dependants: number;
}

async function lockEmployee(db: Executor, employeeId: string): Promise<LockedEmployee> {
  const result = await db.execute<LockedEmployee>(sql`
    SELECT id, full_name, status, joined_on, employment_type, probation_months, basic_salary,
           pay_frequency, device_user_id, nric_enc, nric_last4, bank_account_enc,
           bank_account_last4, epf_applicable, socso_applicable, eis_applicable,
           pcb_applicable, tax_dependants
      FROM hr.employee WHERE id = ${employeeId} FOR UPDATE
  `);
  const row = result.rows?.[0];
  if (!row) throw new NotFoundError("That employee no longer exists.");
  return row;
}

function requireText(value: string | null | undefined, message: string, field: string): string {
  const text = (value ?? "").trim();
  if (text === "") throw new ValidationError(message, field);
  return text;
}

async function assertUnique(
  db: Executor,
  table: string,
  column: string,
  value: string,
  message: string,
): Promise<void> {
  // The table and column are literals from this file, never from input.
  const found = await db.execute<{ id: string }>(
    sql`SELECT id FROM ${sql.raw(table)} WHERE ${sql.raw(column)} = ${value} LIMIT 1`,
  );
  if (found.rows?.[0]) throw new ConflictError(message);
}
