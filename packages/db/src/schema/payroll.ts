import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hrSchema, employee } from "./hr.js";
import { journal } from "./accounting.js";
import { user } from "./auth.js";

/**
 * Payroll.
 *
 * Mirrors migrations 0015/0016. The whole shape follows from one requirement:
 * **re-running a past period after the rates change must produce the same output.**
 *
 * That is why `statutoryRuleVersion` exists as effective-dated, sourced, immutable
 * data rather than as percentages in code, and why every payslip line names the rule
 * *version* that produced it. March's payslip points at the version in force in
 * March; recomputing March reads that version, not today's. Without both, the
 * reproducibility claim is a claim rather than a property.
 *
 * **Nothing is seeded.** EPF is not a percentage — it varies by age and wage band.
 * SOCSO and EIS are contribution *tables* read by band, not multiplications. PCB is
 * a schedule with reliefs. Encoding any of them from general knowledge would be
 * inventing Malaysian law, so the table is empty and payroll refuses to run. See
 * Q-HR-1.
 */

const money = (name: string) => numeric(name, { precision: 18, scale: 4 });

export const statutoryRuleVersion = hrSchema.table(
  "statutory_rule_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** epf_employee | epf_employer | socso | eis | pcb | hrd_levy */
    kind: text("kind").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    /** The gazette or official table. NOT NULL: a statutory figure needs a citation. */
    sourceRef: text("source_ref").notNull(),
    sourceUrl: text("source_url"),
    /**
     * The band table. Shape differs by kind and is validated by the application —
     * a column per possibility would be a column per possibility CAC has not
     * confirmed.
     */
    tableData: jsonb("table_data").notNull(),
    notes: text("notes"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => user.id),
    /** draft | approved | superseded. Only approved versions are used. */
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    lookup: index("statutory_rule_lookup_idx").on(table.kind, table.effectiveFrom),
  }),
);

/**
 * One period's run.
 *
 * The lifecycle is long on purpose and each step belongs to a different person:
 * prepared (computed), approved (somebody else agreed), finalised (fixed), posted
 * (in the ledger). After finalising, a correction is a supplementary run — visible —
 * never an edit.
 */
export const payrollRun = hrSchema.table(
  "payroll_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runNo: text("run_no"),
    /** Real dates rather than a month string, so a mid-month joiner can be prorated. */
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),
    payDate: date("pay_date").notNull(),
    /** regular | supplementary */
    kind: text("kind").notNull().default("regular"),
    correctsRunId: uuid("corrects_run_id"),
    status: text("status").notNull().default("draft"),
    /** All derived from the payslips by trigger. */
    employeeCount: integer("employee_count").notNull().default(0),
    grossTotal: money("gross_total").notNull().default("0"),
    deductionTotal: money("deduction_total").notNull().default("0"),
    netTotal: money("net_total").notNull().default("0"),
    employerCostTotal: money("employer_cost_total").notNull().default("0"),
    notes: text("notes"),
    preparedAt: timestamp("prepared_at", { withTimezone: true }),
    preparedBy: uuid("prepared_by").references(() => user.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => user.id),
    finalisedAt: timestamp("finalised_at", { withTimezone: true }),
    finalisedBy: uuid("finalised_by").references(() => user.id),
    journalId: uuid("journal_id").references(() => journal.id),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by").references(() => user.id),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    abandonReason: text("abandon_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    numberUnique: uniqueIndex("payroll_run_no_unique")
      .on(table.runNo)
      .where(sql`run_no IS NOT NULL`),
    // Two live regular runs for one period would pay the month twice.
    oneRegular: uniqueIndex("payroll_run_one_regular_per_period")
      .on(table.periodFrom, table.periodTo)
      .where(sql`kind = 'regular' AND status <> 'abandoned'`),
  }),
);

/**
 * One person's pay for the period.
 *
 * Everything is snapshotted — name, department, salary, the rule versions used —
 * because the payslip has to read the same in five years when the person has left
 * and the rates have changed four times.
 */
export const payslip = hrSchema.table(
  "payslip",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => payrollRun.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employee.id),
    employeeNo: text("employee_no").notNull(),
    employeeName: text("employee_name").notNull(),
    departmentName: text("department_name"),
    positionTitle: text("position_title"),
    bankName: text("bank_name"),
    bankAccountLast4: text("bank_account_last4"),

    /** Read from employment history for the period, not from the employee row. */
    basicSalary: money("basic_salary").notNull().default("0"),
    payableDays: numeric("payable_days", { precision: 8, scale: 2 }),
    periodDays: numeric("period_days", { precision: 8, scale: 2 }),

    /** All four derived from the lines by trigger. */
    grossPay: money("gross_pay").notNull().default("0"),
    totalDeductions: money("total_deductions").notNull().default("0"),
    netPay: money("net_pay").notNull().default("0"),
    /** The employer's own contributions: a cost, not part of net pay. */
    employerCost: money("employer_cost").notNull().default("0"),

    epfEmployeeRuleId: uuid("epf_employee_rule_id").references(() => statutoryRuleVersion.id),
    epfEmployerRuleId: uuid("epf_employer_rule_id").references(() => statutoryRuleVersion.id),
    socsoRuleId: uuid("socso_rule_id").references(() => statutoryRuleVersion.id),
    eisRuleId: uuid("eis_rule_id").references(() => statutoryRuleVersion.id),
    pcbRuleId: uuid("pcb_rule_id").references(() => statutoryRuleVersion.id),

    notes: text("notes"),
    /** Set when the figures could not be computed. Blocks the run rather than paying. */
    problem: text("problem"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    perRun: unique().on(table.runId, table.employeeId),
    byEmployee: index("payslip_employee_idx").on(table.employeeId),
  }),
);

/**
 * Every figure on a payslip, with the rule that produced it.
 *
 * `basis` is the plain-words explanation — "11% of 4,500" — so a payslip query is
 * answerable without re-running anything.
 */
export const payslipLine = hrSchema.table(
  "payslip_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payslipId: uuid("payslip_id")
      .notNull()
      .references(() => payslip.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    /** earning | deduction | employer */
    kind: text("kind").notNull(),
    code: text("code").notNull(),
    description: text("description").notNull(),
    basis: text("basis"),
    quantity: numeric("quantity", { precision: 12, scale: 4 }),
    rate: numeric("rate", { precision: 18, scale: 6 }),
    amount: money("amount").notNull(),
    accountCode: text("account_code"),
    /**
     * The other side, where a line needs two.
     *
     * An employer contribution is both a cost and a liability: `accountCode` is the
     * expense, this is the payable. A deduction needs only one side, because the
     * earning it comes out of has already been debited.
     */
    contraAccountCode: text("contra_account_code"),
    statutoryRuleId: uuid("statutory_rule_id").references(() => statutoryRuleVersion.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    perPayslip: unique().on(table.payslipId, table.lineNo),
    byPayslip: index("payslip_line_payslip_idx").on(table.payslipId, table.lineNo),
  }),
);

/**
 * A recurring allowance or deduction.
 *
 * Whether an allowance counts as "wages" for EPF and the rest is not obvious and is
 * part of Q-HR-1, so each element says so per contribution rather than the engine
 * assuming.
 */
export const payElement = hrSchema.table(
  "pay_element",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employee.id, { onDelete: "cascade" }),
    /** earning | deduction */
    kind: text("kind").notNull(),
    code: text("code").notNull(),
    description: text("description").notNull(),
    amount: money("amount").notNull(),
    isEpfLiable: boolean("is_epf_liable").notNull().default(false),
    isSocsoLiable: boolean("is_socso_liable").notNull().default(false),
    isPcbLiable: boolean("is_pcb_liable").notNull().default(true),
    accountCode: text("account_code"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    byEmployee: index("pay_element_employee_idx").on(table.employeeId, table.effectiveFrom),
  }),
);
