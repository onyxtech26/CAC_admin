import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { costCentre } from "./org.js";
import { user } from "./auth.js";

export const hrSchema = pgSchema("hr");

/**
 * The people.
 *
 * Mirrors migrations 0011/0012, where the constraints and triggers live. Three
 * things about this schema are not obvious from the column names and matter more
 * than anything else in it:
 *
 * **`nricEnc` and `bankAccountEnc` are ciphertext**, encrypted with the key from
 * the secret manager — the same arrangement as the TOTP seeds. Beside each is a
 * last-four column so a person can be identified in a list without decrypting
 * anything. Never select the encrypted column into a view model.
 *
 * **`basicSalary` on the employee is the figure in force now.** The figure in
 * force on a past date is in `employmentEvent`, and that is what a payroll rerun
 * reads. Keeping only the current salary would make every past payslip
 * irreproducible, which is the one property Phase 7 must have.
 *
 * **Attendance is staged before it is real.** A device export goes into
 * `attendanceImport` + `attendanceImportRow`, is validated and previewed, and
 * reaches `attendance` only on explicit confirmation. Attendance feeds payroll,
 * so a silently wrong import is a wrong payslip.
 */

const money = (name: string) => numeric(name, { precision: 18, scale: 4 });

export const department = hrSchema.table("department", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  parentId: uuid("parent_id"),
  costCentreId: uuid("cost_centre_id").references(() => costCentre.id),
  headEmployeeId: uuid("head_employee_id"),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => user.id),
  updatedBy: uuid("updated_by").references(() => user.id),
});

export const position = hrSchema.table("position", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  title: text("title").notNull(),
  departmentId: uuid("department_id").references(() => department.id),
  grade: text("grade"),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => user.id),
  updatedBy: uuid("updated_by").references(() => user.id),
});

/**
 * What a normal week looks like.
 *
 * `workDays` holds ISO weekday numbers (1 = Monday), which keeps a four-day week
 * or a Saturday morning expressible without a column per day. The Phase 6 engine
 * reads this to decide what "late" means, so the schedule has to state it rather
 * than the engine assuming nine to six.
 */
export const workSchedule = hrSchema.table(
  "work_schedule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    workDays: integer("work_days").array().notNull(),
    startsAt: time("starts_at").notNull(),
    endsAt: time("ends_at").notNull(),
    breakMinutes: integer("break_minutes").notNull().default(60),
    /** A company decision, not a statutory one. */
    graceMinutes: integer("grace_minutes").notNull().default(10),
    crossesMidnight: boolean("crosses_midnight").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    // Exactly one default, so an employee with no explicit schedule has an
    // unambiguous one rather than whichever row came back first.
    oneDefault: uniqueIndex("work_schedule_one_default")
      .on(table.isDefault)
      .where(sql`is_default`),
  }),
);

export const employee = hrSchema.table(
  "employee",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeNo: text("employee_no").notNull().unique(),
    fullName: text("full_name").notNull(),
    preferredName: text("preferred_name"),

    /** Ciphertext. Never put this in a view model. */
    nricEnc: text("nric_enc"),
    /** For display and search, so nothing has to be decrypted to list people. */
    nricLast4: text("nric_last4"),
    passportNoEnc: text("passport_no_enc"),
    nationality: text("nationality").notNull().default("Malaysian"),
    dateOfBirth: date("date_of_birth"),
    gender: text("gender"),
    maritalStatus: text("marital_status"),

    email: text("email"),
    personalEmail: text("personal_email"),
    phone: text("phone"),
    address: text("address"),
    emergencyContact: text("emergency_contact"),
    emergencyPhone: text("emergency_phone"),

    positionId: uuid("position_id").references(() => position.id),
    departmentId: uuid("department_id").references(() => department.id),
    reportsToId: uuid("reports_to_id"),
    costCentreId: uuid("cost_centre_id").references(() => costCentre.id),
    workScheduleId: uuid("work_schedule_id").references(() => workSchedule.id),
    employmentType: text("employment_type").notNull().default("permanent"),
    joinedOn: date("joined_on").notNull(),
    probationMonths: integer("probation_months").notNull().default(3),
    confirmedOn: date("confirmed_on"),
    /** active | on_leave | suspended | resigned | terminated */
    status: text("status").notNull().default("active"),
    lastDay: date("last_day"),
    exitReason: text("exit_reason"),

    epfNo: text("epf_no"),
    socsoNo: text("socso_no"),
    incomeTaxNo: text("income_tax_no"),
    /** Whether each applies. The schedules themselves are Q-HR-1 and unseeded. */
    epfApplicable: boolean("epf_applicable").notNull().default(true),
    socsoApplicable: boolean("socso_applicable").notNull().default(true),
    eisApplicable: boolean("eis_applicable").notNull().default(true),
    pcbApplicable: boolean("pcb_applicable").notNull().default(true),
    taxDependants: integer("tax_dependants").notNull().default(0),

    bankName: text("bank_name"),
    /** Ciphertext. */
    bankAccountEnc: text("bank_account_enc"),
    bankAccountLast4: text("bank_account_last4"),

    /** The figure in force now. History is in `employmentEvent`. */
    basicSalary: money("basic_salary").notNull().default("0"),
    payFrequency: text("pay_frequency").notNull().default("monthly"),

    userId: uuid("user_id")
      .unique()
      .references(() => user.id),

    /**
     * What the thumbprint device calls this person.
     *
     * Kept because a device export identifies people by its own number, and
     * matching on name is how one person's attendance lands on another's record.
     */
    deviceUserId: text("device_user_id"),

    photoPath: text("photo_path"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    deviceUnique: uniqueIndex("employee_device_user_unique")
      .on(table.deviceUserId)
      .where(sql`device_user_id IS NOT NULL`),
    byDepartment: index("employee_department_idx").on(table.departmentId),
    byStatus: index("employee_status_idx").on(table.status),
  }),
);

/**
 * Append-only employment history.
 *
 * This is what makes a payroll rerun reproducible. A trigger refuses UPDATE and
 * DELETE outright; a mistake is corrected by recording a `corrected` event, which
 * is visible rather than silent.
 */
export const employmentEvent = hrSchema.table(
  "employment_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employee.id, { onDelete: "cascade" }),
    /** hired | confirmed | promoted | transferred | salary_changed | … */
    kind: text("kind").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    /** The salary in force from this date. Null where the event does not change pay. */
    basicSalary: money("basic_salary"),
    positionId: uuid("position_id").references(() => position.id),
    departmentId: uuid("department_id").references(() => department.id),
    employmentType: text("employment_type"),
    status: text("status"),
    reason: text("reason"),
    notes: text("notes"),
    /** The letter that authorised it, once Phase 8 generates them. */
    letterId: uuid("letter_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
  },
  (table) => ({
    byEmployee: index("employment_event_employee_idx").on(table.employeeId, table.effectiveFrom),
  }),
);

export const employeeSchedule = hrSchema.table(
  "employee_schedule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employee.id, { onDelete: "cascade" }),
    workScheduleId: uuid("work_schedule_id")
      .notNull()
      .references(() => workSchedule.id),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
  },
  (table) => ({
    lookup: index("employee_schedule_lookup_idx").on(table.employeeId, table.effectiveFrom),
  }),
);

/**
 * Public holidays.
 *
 * `appliesTo` is a list of state codes, empty meaning everywhere, because
 * Malaysian holidays are partly federal and partly by state. None are seeded: a
 * wrong holiday makes a present employee absent and an absent one present, and
 * which states CAC's staff work in has not been stated.
 */
export const publicHoliday = hrSchema.table(
  "public_holiday",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    holidayOn: date("holiday_on").notNull(),
    name: text("name").notNull(),
    appliesTo: text("applies_to").array().notNull(),
    isHalfDay: boolean("is_half_day").notNull().default(false),
    sourceRef: text("source_ref"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
  },
  (table) => ({
    dateName: unique().on(table.holidayOn, table.name),
    byDate: index("public_holiday_date_idx").on(table.holidayOn),
  }),
);

export const attendanceImport = hrSchema.table("attendance_import", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceFilename: text("source_filename"),
  sourceDigest: text("source_digest"),
  deviceLabel: text("device_label"),
  columnMapping: jsonb("column_mapping"),
  periodFrom: date("period_from"),
  periodTo: date("period_to"),
  /** staged | confirmed | discarded */
  status: text("status").notNull().default("staged"),
  rowCount: integer("row_count").notNull().default(0),
  acceptedCount: integer("accepted_count").notNull().default(0),
  rejectedCount: integer("rejected_count").notNull().default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => user.id),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  confirmedBy: uuid("confirmed_by").references(() => user.id),
});

export const attendanceImportRow = hrSchema.table(
  "attendance_import_row",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importId: uuid("import_id")
      .notNull()
      .references(() => attendanceImport.id, { onDelete: "cascade" }),
    rowNo: integer("row_no").notNull(),
    /** Exactly what was in the file, so a rejection can be explained by showing it. */
    raw: jsonb("raw").notNull(),
    deviceUserId: text("device_user_id"),
    employeeId: uuid("employee_id").references(() => employee.id),
    workDate: date("work_date"),
    clockIn: timestamp("clock_in", { withTimezone: true }),
    clockOut: timestamp("clock_out", { withTimezone: true }),
    /** ok | problem | duplicate | imported */
    state: text("state").notNull().default("ok"),
    problem: text("problem"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    importRow: unique().on(table.importId, table.rowNo),
    byImport: index("attendance_import_row_import_idx").on(table.importId, table.rowNo),
  }),
);

export const attendance = hrSchema.table(
  "attendance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employee.id, { onDelete: "cascade" }),
    workDate: date("work_date").notNull(),
    clockIn: timestamp("clock_in", { withTimezone: true }),
    clockOut: timestamp("clock_out", { withTimezone: true }),
    /**
     * device | manual | imported_corrected | leave | holiday
     *
     * Matters more than it looks: a day entered by hand and a day off the device
     * are different kinds of evidence, and when a payslip is queried the first
     * question is which.
     */
    source: text("source").notNull().default("device"),
    importId: uuid("import_id").references(() => attendanceImport.id),

    /** Filled by the Phase 6 engine. Null means "not calculated", not zero. */
    scheduledMinutes: integer("scheduled_minutes"),
    workedMinutes: integer("worked_minutes"),
    lateMinutes: integer("late_minutes"),
    earlyOutMinutes: integer("early_out_minutes"),
    /** Arithmetic. Payable overtime is a separate decision with its own approval. */
    extraMinutes: integer("extra_minutes"),
    isAbsent: boolean("is_absent").notNull().default(false),
    isHoliday: boolean("is_holiday").notNull().default(false),
    isRestDay: boolean("is_rest_day").notNull().default(false),
    onLeaveType: text("on_leave_type"),

    /**
     * Approved paid overtime for the day, in minutes.
     *
     * NOT the same as `extraMinutes`. Extra time is what the clock says; this is
     * what somebody authorised paying for. Conflating them pays overtime nobody
     * asked for.
     */
    approvedOtMinutes: integer("approved_ot_minutes").notNull().default(0),
    /** Approved short absences within the day — late in, early out, an errand. */
    timeoffMinutes: integer("timeoff_minutes").notNull().default(0),
    /** The approved leave request covering this day, where one does. */
    leaveRequestId: uuid("leave_request_id"),
    /** Null means the figures are stale or were never computed, and screens say so. */
    calculatedAt: timestamp("calculated_at", { withTimezone: true }),

    /** draft | final. Payroll reads final only. */
    status: text("status").notNull().default("draft"),
    remarks: text("remarks"),
    correctedReason: text("corrected_reason"),
    finalisedAt: timestamp("finalised_at", { withTimezone: true }),
    finalisedBy: uuid("finalised_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    // One record per person per day, so two imports of the same day cannot both
    // land and double the hours.
    perDay: unique().on(table.employeeId, table.workDate),
    byEmployeeDate: index("attendance_employee_date_idx").on(table.employeeId, table.workDate),
    byDate: index("attendance_date_idx").on(table.workDate),
  }),
);

/**
 * Finalising is per period, not per row.
 *
 * Payroll for March needs to know March is settled, and "every row is final" is
 * not the same statement as "HR has closed March".
 */
export const attendancePeriod = hrSchema.table(
  "attendance_period",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),
    /** open | finalised */
    status: text("status").notNull().default("open"),
    notes: text("notes"),
    finalisedAt: timestamp("finalised_at", { withTimezone: true }),
    finalisedBy: uuid("finalised_by").references(() => user.id),
    reopenedAt: timestamp("reopened_at", { withTimezone: true }),
    reopenedBy: uuid("reopened_by").references(() => user.id),
    reopenReason: text("reopen_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
  },
  (table) => ({
    period: unique().on(table.periodFrom, table.periodTo),
  }),
);
