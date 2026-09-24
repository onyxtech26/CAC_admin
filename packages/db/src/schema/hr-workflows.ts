import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hrSchema, employee } from "./hr.js";
import { user } from "./auth.js";

/**
 * What happens around attendance: leave, overtime, short absences, appraisals.
 *
 * Mirrors migrations 0013/0014. One distinction runs through the whole file and is
 * the reason `overtimeRequest` exists at all:
 *
 * **Extra time is not payable overtime.** `attendance.extraMinutes` is what the
 * clock and the schedule say, computed whether anybody asked or not.
 * `overtimeRequest.approvedHours` is what somebody authorised paying for. They are
 * different numbers in different tables, and conflating them pays overtime nobody
 * asked for — the commonest expensive error in a system like this.
 *
 * **The statutory numbers are absent on purpose.** Leave entitlements depend on
 * length of service under the Employment Act; overtime multiples depend on whether
 * the day was a working day, a rest day or a public holiday. Both are legal
 * schedules, both are nullable here, and both require a source before they can be
 * used. See Q-HR-1 and Q-HR-3.
 */

const days = (name: string) => numeric(name, { precision: 6, scale: 2 });

export const leaveType = hrSchema.table("leave_type", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  /** Unpaid leave is still recorded: it changes attendance and, in Phase 7, pay. */
  isPaid: boolean("is_paid").notNull().default(true),
  /** Marks the kinds whose minimum is set by law rather than by the company. */
  isStatutory: boolean("is_statutory").notNull().default(false),
  /** Null means "not yet known", which is not the same as nil days. */
  defaultDays: days("default_days"),
  /** Required before a figure may be used, like a tax rate's citation. */
  entitlementSource: text("entitlement_source"),
  requiresDocument: boolean("requires_document").notNull().default(false),
  carryForwardMax: days("carry_forward_max"),
  /** Sick leave is claimed after the fact; annual leave usually is not. */
  allowsBackdating: boolean("allows_backdating").notNull().default(false),
  countsAsAttendance: boolean("counts_as_attendance").notNull().default(true),
  colour: text("colour"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => user.id),
  updatedBy: uuid("updated_by").references(() => user.id),
});

/**
 * One row per person, per type, per year.
 *
 * `takenDays` is derived from approved requests by trigger. A balance that
 * disagrees with the requests beneath it is worse than no balance, because somebody
 * reads it, believes it, and approves leave that is not there.
 */
export const leaveBalance = hrSchema.table(
  "leave_balance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employee.id, { onDelete: "cascade" }),
    leaveTypeId: uuid("leave_type_id")
      .notNull()
      .references(() => leaveType.id),
    year: integer("year").notNull(),
    entitledDays: days("entitled_days").notNull().default("0"),
    carriedDays: days("carried_days").notNull().default("0"),
    /** Manual corrections; each has a reason in the audit trail. */
    adjustmentDays: days("adjustment_days").notNull().default("0"),
    /** Derived. Do not write this. */
    takenDays: days("taken_days").notNull().default("0"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    perYear: unique().on(table.employeeId, table.leaveTypeId, table.year),
    byEmployee: index("leave_balance_employee_idx").on(table.employeeId, table.year),
  }),
);

/**
 * A leave request.
 *
 * `days` is stored rather than recomputed on read, because it depends on the work
 * schedule and the public holidays *as they were when the request was decided*.
 * Recomputing it later against a changed schedule would silently restate how much
 * leave somebody took.
 */
export const leaveRequest = hrSchema.table(
  "leave_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestNo: text("request_no"),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employee.id, { onDelete: "cascade" }),
    leaveTypeId: uuid("leave_type_id")
      .notNull()
      .references(() => leaveType.id),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    halfDayStart: boolean("half_day_start").notNull().default(false),
    halfDayEnd: boolean("half_day_end").notNull().default(false),
    days: days("days").notNull(),
    reason: text("reason"),
    /** draft | submitted | approved | rejected | cancelled */
    status: text("status").notNull().default("draft"),
    documentPath: text("document_path"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => user.id),
    decisionNote: text("decision_note"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => user.id),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    numberUnique: uniqueIndex("leave_request_no_unique")
      .on(table.requestNo)
      .where(sql`request_no IS NOT NULL`),
    byEmployee: index("leave_request_employee_idx").on(table.employeeId, table.startsOn),
    byStatus: index("leave_request_status_idx").on(table.status),
  }),
);

/**
 * Paid overtime, kept separate from extra time on purpose.
 *
 * `requestedHours` is what was asked for; `approvedHours` is what an approver
 * allowed, and only that is payable — approving less is normal and the difference
 * has to stay visible. `rateMultiple` has no default: Malaysian rates depend on the
 * kind of day and on the Employment Act, so leaving it null forces the question
 * rather than quietly paying 1.5×.
 */
export const overtimeRequest = hrSchema.table(
  "overtime_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestNo: text("request_no"),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employee.id, { onDelete: "cascade" }),
    workDate: date("work_date").notNull(),
    startsAt: time("starts_at"),
    endsAt: time("ends_at"),
    requestedHours: days("requested_hours").notNull(),
    approvedHours: days("approved_hours"),
    /** normal | rest_day | public_holiday — decides which rate applies. */
    dayKind: text("day_kind").notNull().default("normal"),
    rateMultiple: numeric("rate_multiple", { precision: 6, scale: 4 }),
    rateSource: text("rate_source"),
    reason: text("reason").notNull(),
    /** draft | submitted | approved | rejected */
    status: text("status").notNull().default("draft"),
    isRetrospective: boolean("is_retrospective").notNull().default(false),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => user.id),
    decisionNote: text("decision_note"),
    /** Set once payroll has taken it, after which it is frozen. */
    payrollRunId: uuid("payroll_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    // One claim per person per day: two would be two payments for one evening.
    perDay: unique().on(table.employeeId, table.workDate),
    numberUnique: uniqueIndex("overtime_request_no_unique")
      .on(table.requestNo)
      .where(sql`request_no IS NOT NULL`),
    byStatus: index("overtime_request_status_idx").on(table.status, table.workDate),
  }),
);

/**
 * Short absences within a day, with permission.
 *
 * This table exists because without it an approved two-hour absence looks identical
 * to being two hours late, and the attendance engine has no way to tell them apart.
 */
export const timeoffRequest = hrSchema.table(
  "timeoff_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestNo: text("request_no"),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employee.id, { onDelete: "cascade" }),
    workDate: date("work_date").notNull(),
    /** late_in | early_out | during_day */
    kind: text("kind").notNull(),
    startsAt: time("starts_at"),
    endsAt: time("ends_at"),
    minutes: integer("minutes").notNull(),
    isPaid: boolean("is_paid").notNull().default(true),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("draft"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => user.id),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    numberUnique: uniqueIndex("timeoff_request_no_unique")
      .on(table.requestNo)
      .where(sql`request_no IS NOT NULL`),
    byEmployee: index("timeoff_request_employee_idx").on(table.employeeId, table.workDate),
  }),
);

/**
 * An appraisal round.
 *
 * `template` is jsonb because the form CAC uses has not been supplied, and inventing
 * a competency framework would be inventing how the firm judges its staff. The
 * application validates an appraisal against its cycle's template.
 */
export const appraisalCycle = hrSchema.table("appraisal_cycle", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  periodFrom: date("period_from").notNull(),
  periodTo: date("period_to").notNull(),
  template: jsonb("template"),
  /** draft | open | closed */
  status: text("status").notNull().default("draft"),
  opensOn: date("opens_on"),
  dueOn: date("due_on"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => user.id),
  updatedBy: uuid("updated_by").references(() => user.id),
});

export const appraisal = hrSchema.table(
  "appraisal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cycleId: uuid("cycle_id")
      .notNull()
      .references(() => appraisalCycle.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employee.id, { onDelete: "cascade" }),
    reviewerId: uuid("reviewer_id")
      .notNull()
      .references(() => employee.id),
    /** draft | self_assessed | reviewed | acknowledged */
    status: text("status").notNull().default("draft"),
    selfAssessment: jsonb("self_assessment"),
    review: jsonb("review"),
    overallScore: numeric("overall_score", { precision: 6, scale: 2 }),
    overallComment: text("overall_comment"),
    employeeComment: text("employee_comment"),
    selfAssessedAt: timestamp("self_assessed_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    perCycle: unique().on(table.cycleId, table.employeeId),
    byEmployee: index("appraisal_employee_idx").on(table.employeeId),
    byReviewer: index("appraisal_reviewer_idx").on(table.reviewerId, table.status),
  }),
);
