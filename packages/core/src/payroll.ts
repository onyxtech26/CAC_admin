import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { SYSTEM_ACCOUNTS } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import {
  requireCapability,
  requireDifferentApprover,
  requireEmployeeScope,
  type Principal,
} from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, toIsoDate } from "./dates.js";
import { amountToSql, formatAmount, parseAmount, type Amount } from "./money.js";
import { postSourceJournal, reverseJournal } from "./posting.js";
import { allocateDocumentNumber } from "./sequence.js";
import { salaryOn } from "./people.js";
import { countLeaveDays } from "./leave.js";
import { getSettingState } from "./settings.js";
import {
  applyRule,
  requireRulesFor,
  STATUTORY_LABELS,
  type StatutoryKind,
  type StatutoryResult,
} from "./statutory.js";

/**
 * Payroll.
 *
 * The exit criterion is reproducibility: re-running a past period after the rates
 * change produces identical output. Three things make that true, and all three are
 * load-bearing.
 *
 * **The salary comes from employment history, not from the employee row.**
 * `salaryOn(employee, date)` reads the dated events, so March's run uses March's
 * salary however many raises have happened since.
 *
 * **The statutory rules come from the version in force for the period.** Not the
 * current version — the one whose effective dates cover the pay date. Those versions
 * are immutable once approved, so the answer cannot drift.
 *
 * **And the four liability flags come from dated employment history too**, not from
 * the employee row, because they decide which contributions are computed at all.
 * Reading them from the row was a reproducibility hole with the same shape as reading
 * the salary from it: switching somebody's PCB liability on today gave every earlier
 * month a deduction it never had.
 *
 * **Every payslip line records the rule version that produced it.** So a payslip can
 * be explained years later without re-deriving anything, and a recomputation can be
 * checked against what was actually used.
 *
 * Two further boundaries, both of them honest rather than incidental.
 *
 * **A day not worked is deducted at the ordinary rate of pay**, which for a
 * monthly-rated employee is the monthly wages over 26 — the Employment Act's figure,
 * and the one Malaysian payroll uses to price unpaid leave and an unauthorised absence
 * alike. It is a payslip line of its own rather than a quietly smaller basic, and it
 * comes out of the statutory wage bases as well, because a contribution is on the
 * wages actually payable. Proration is a different thing and covers days *not
 * employed*: the incomplete-month formula for a joiner or a leaver.
 *
 * **Lateness is not deducted**, deliberately. Section 24 of the Employment Act limits
 * what may be taken out of wages and minutes are not among it; the disciplinary
 * process is where lateness belongs. The run reports it as a note rather than
 * swallowing it. See Q-HR-4.
 *
 * **Overtime counts as wages for SOCSO, EIS and PCB, and not for EPF.** Three answers
 * rather than one, which is why they are settings: KWSP lists overtime among the
 * payments not subject to contribution, PERKESO includes it in wages and EIS follows
 * SOCSO, and it is remuneration from employment so PCB is computed on it. Seeded with
 * those answers, flagged for review until CAC's accountant adopts them, and named on
 * every overtime payslip line. See Q-HR-1 item 7.
 *
 * And the boundary the whole phase waits on: **no statutory rule is seeded.** EPF is not a percentage,
 * SOCSO and EIS are contribution tables, PCB is a schedule. Preparing a run without
 * them raises `StatutoryRulesMissingError`, which names what is missing and why it is
 * not guessed at. That is Q-HR-1, and until it is answered this phase stops here —
 * visibly, with a screen that explains it, rather than with a plausible number.
 */

export type RunStatus =
  | "draft"
  | "prepared"
  | "approved"
  | "finalised"
  | "posted"
  | "abandoned";

export interface PayrollRunView {
  id: string;
  runNo: string | null;
  periodFrom: string;
  periodTo: string;
  payDate: string;
  kind: "regular" | "supplementary";
  correctsRunId: string | null;
  status: RunStatus;
  employeeCount: number;
  grossTotal: Amount;
  deductionTotal: Amount;
  netTotal: Amount;
  employerCostTotal: Amount;
  notes: string | null;
  preparedByName: string | null;
  approvedByName: string | null;
  finalisedByName: string | null;
  journalId: string | null;
  journalNo: string | null;
  abandonReason: string | null;
  /** Payslips that could not be computed. A run with any of these cannot be approved. */
  problemCount: number;
}

export interface PayslipLineView {
  id: string;
  lineNo: number;
  kind: "earning" | "deduction" | "employer";
  code: string;
  description: string;
  basis: string | null;
  quantity: string | null;
  rate: string | null;
  amount: Amount;
  accountCode: string | null;
  contraAccountCode: string | null;
  statutoryRuleId: string | null;
  statutorySource: string | null;
}

export interface PayslipView {
  id: string;
  runId: string;
  runNo: string | null;
  periodFrom: string;
  periodTo: string;
  payDate: string;
  runStatus: RunStatus;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  departmentName: string | null;
  positionTitle: string | null;
  bankName: string | null;
  bankAccountLast4: string | null;
  basicSalary: Amount;
  payableDays: string | null;
  periodDays: string | null;
  grossPay: Amount;
  totalDeductions: Amount;
  netPay: Amount;
  employerCost: Amount;
  notes: string | null;
  problem: string | null;
  lines: PayslipLineView[];
}

// ---------------------------------------------------------------------------
// Creating a run
// ---------------------------------------------------------------------------

export async function createPayrollRun(
  db: Executor,
  principal: Principal,
  input: {
    periodFrom: string;
    periodTo: string;
    payDate: string;
    kind?: "regular" | "supplementary";
    correctsRunId?: string | null;
    notes?: string | null;
  },
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "hr.payroll.prepare");

  const periodFrom = toIsoDate(parseIsoDate(input.periodFrom, "periodFrom"));
  const periodTo = toIsoDate(parseIsoDate(input.periodTo, "periodTo"));
  const payDate = toIsoDate(parseIsoDate(input.payDate, "payDate"));

  if (periodTo < periodFrom) {
    throw new ValidationError("The period ends before it begins.", "periodTo");
  }
  if (payDate < periodFrom) {
    throw new ValidationError(
      "The pay date is before the period it pays for, which is almost certainly a mistake.",
      "payDate",
    );
  }

  const kind = input.kind ?? "regular";
  if (kind === "supplementary" && !input.correctsRunId) {
    throw new ValidationError(
      "A supplementary run has to say which run it corrects.",
      "correctsRunId",
    );
  }

  if (kind === "regular") {
    const existing = await db.execute<{ id: string; run_no: string | null; status: string }>(sql`
      SELECT id, run_no, status FROM hr.payroll_run
       WHERE kind = 'regular' AND period_from = ${periodFrom} AND period_to = ${periodTo}
         AND status <> 'abandoned'
    `);
    if (existing.rows?.[0]) {
      throw new ConflictError(
        `${existing.rows[0]!.run_no ?? "A run"} already covers ${periodFrom} to ${periodTo} ` +
          `(${existing.rows[0]!.status}). A second would pay the month twice — correct the first ` +
          "with a supplementary run instead.",
      );
    }
  }

  // How much of the period's attendance is still open, recorded on the run's audit entry. Creating a
  // run while a month is still being corrected is reasonable — preparing it is not, and that is where
  // it is refused.
  const openPeriods = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM hr.attendance
     WHERE work_date BETWEEN ${periodFrom}::date AND ${periodTo}::date AND status = 'draft'
  `);
  const drafts = openPeriods.rows?.[0]?.count ?? 0;

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.payroll_run
      (period_from, period_to, pay_date, kind, corrects_run_id, notes, created_by)
    VALUES (${periodFrom}, ${periodTo}, ${payDate}, ${kind}, ${input.correctsRunId ?? null},
            ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PAYROLL_RUN_CREATED,
    entityType: "payroll_run",
    entityId: id,
    newValues: { periodFrom, periodTo, payDate, kind, draftAttendanceDays: drafts },
  });

  return { id };
}

// ---------------------------------------------------------------------------
// Preparing
// ---------------------------------------------------------------------------

export interface PrepareResult {
  runNo: string;
  payslips: number;
  /** People left out, with why — a leaver, a joiner after the period, no salary. */
  skipped: Array<{ employeeName: string; why: string }>;
  problems: Array<{ employeeName: string; problem: string }>;
  /**
   * Things the run saw and did not act on.
   *
   * Lateness is the reason this exists: it is measured to the minute and deliberately not deducted,
   * and a run that simply ignored it would leave nobody any the wiser. A note is not a problem — it
   * does not block approval — but it is put in front of whoever prepares the run.
   */
  notes: Array<{ employeeName: string; note: string }>;
}

/**
 * Computes the run.
 *
 * Everything is fetched for the whole run first, then each payslip is built from it,
 * so the arithmetic per person is a function of data already in hand. The order
 * inside a payslip is: earnings (basic, allowances, approved overtime), then the
 * statutory deductions on those earnings, then the employer's own contributions.
 *
 * A person whose figures cannot be produced gets a payslip carrying the problem
 * rather than being silently dropped — a missing payslip is invisible, and a run that
 * quietly paid twenty-nine of thirty people is the worst possible outcome.
 */
export async function preparePayrollRun(
  db: Executor,
  principal: Principal,
  runId: string,
  context?: AuditContext,
): Promise<PrepareResult> {
  requireCapability(principal, "hr.payroll.prepare");

  const run = await lockRun(db, runId);
  if (run.status !== "draft" && run.status !== "prepared") {
    throw new ConflictError(
      `This run is ${run.status}. Only a draft or an already-prepared run can be computed.`,
    );
  }

  const periodFrom = String(run.period_from).slice(0, 10);
  const periodTo = String(run.period_to).slice(0, 10);
  const payDate = String(run.pay_date).slice(0, 10);

  /**
   * A supplementary run pays what the run it corrects missed — and nothing else.
   *
   * This function used to ignore `kind` altogether. A supplementary run recomputed the whole month
   * for everybody: full basic salary, full recurring allowances, full statutory deductions. Posting
   * it paid the month a second time. The payroll screen describes a supplementary run as how a
   * correction is made, so the advertised correction mechanism was a duplicate payment, and nothing
   * in the run's own figures would have looked wrong.
   *
   * What a correction is, in practice, is wages the earlier run left out — overtime approved without
   * a rate, given one after the payslips had gone out. So that is what a supplementary run pays: the
   * overtime for the period that no run has claimed, plus the statutory contributions those
   * additional wages attract, and no basic salary or allowance at all. Anybody with nothing
   * outstanding gets no payslip and is listed as skipped with the reason.
   */
  const supplementary = run.kind === "supplementary";

  /**
   * Whether an overtime payment counts as wages, per contribution.
   *
   * Not one answer but three, which is why it is data rather than a constant. The ordinary Malaysian
   * treatment, and what these are seeded with: **not** wages for EPF — KWSP lists overtime among the
   * payments not subject to contribution — but wages for SOCSO and EIS, whose definition includes
   * overtime payments, and wages for PCB, since it is remuneration from employment.
   *
   * They are flagged for review until CAC's accountant confirms them, because that is the common
   * treatment as this platform understands it rather than anybody qualified reading the statutes.
   * Each payslip line says which basis it was computed on, so a payslip can be defended whichever
   * way the settings stand. See Q-HR-1 item 7.
   */
  const [otEpf, otSocso, otPcb] = await Promise.all([
    getSettingState<boolean>(db, "payroll.overtime_is_epf_wages", false),
    getSettingState<boolean>(db, "payroll.overtime_is_socso_wages", true),
    getSettingState<boolean>(db, "payroll.overtime_is_pcb_wages", true),
  ]);
  const overtimeIsWagesFor = {
    epf: otEpf.value,
    socso: otSocso.value,
    pcb: otPcb.value,
    /** True when all three are still the platform's defaults rather than CAC's decision. */
    unconfirmed: !otEpf.confirmed || !otSocso.confirmed || !otPcb.confirmed,
  };

  /**
   * Attendance for the period has to be settled first.
   *
   * The module said this and did not check it: the draft-day count was read once, put in an audit
   * payload, and never acted on. A month still being corrected is a month whose figures are not yet
   * anybody's statement, and a payslip computed from it is a figure somebody will be asked to defend.
   *
   * It matters more than it looks, because of what payroll does *not* read. Absence, lateness and
   * short days change nothing in a payslip — see Q-HR-4, which asks what CAC's policy is, since
   * deducting for an unauthorised absence is taking money from somebody and is not a rule this
   * platform may invent. Until that is answered, the one protection is that the month is closed and
   * looked at before it is paid.
   */
  const stillDraft = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM hr.attendance
     WHERE work_date BETWEEN ${periodFrom}::date AND ${periodTo}::date AND status = 'draft'
  `);
  const draftDays = stillDraft.rows?.[0]?.count ?? 0;
  if (draftDays > 0) {
    throw new ConflictError(
      `${draftDays} attendance day${draftDays === 1 ? "" : "s"} in this period ${
        draftDays === 1 ? "is" : "are"
      } still a draft. Finalise the attendance period first: a month that is still being corrected ` +
        "is not yet anybody's statement of what happened, and a payslip computed from it is a figure " +
        "somebody will have to defend.",
    );
  }

  if (supplementary) {
    if (!run.corrects_run_id) {
      throw new ConflictError(
        "This supplementary run does not say which run it corrects, so there is nothing to work a " +
          "difference out from.",
      );
    }
    const corrected = await db.execute<{
      run_no: string | null;
      status: string;
      period_from: string;
      period_to: string;
    }>(sql`
      SELECT run_no, status, period_from, period_to
        FROM hr.payroll_run WHERE id = ${run.corrects_run_id}
    `);
    const target = corrected.rows?.[0];
    if (!target) {
      throw new NotFoundError("The run this one corrects no longer exists.");
    }
    if (
      String(target.period_from).slice(0, 10) !== periodFrom ||
      String(target.period_to).slice(0, 10) !== periodTo
    ) {
      throw new ConflictError(
        `${target.run_no ?? "The run being corrected"} covers ` +
          `${String(target.period_from).slice(0, 10)} to ${String(target.period_to).slice(0, 10)}, ` +
          `not ${periodFrom} to ${periodTo}. A correction has to be for the same period, because the ` +
          "contributions it works out are the month's contributions less what that month has already " +
          "had.",
      );
    }
    if (target.status !== "finalised" && target.status !== "posted") {
      throw new ConflictError(
        `${target.run_no ?? "The run being corrected"} is ${target.status}, so nothing has gone out ` +
          "to correct. Prepare that run again instead — re-preparing replaces its figures, which is " +
          "the cheaper correction while it is still unfinalised.",
      );
    }
  }

  const employees = await db.execute<{
    id: string;
    employee_no: string;
    full_name: string;
    date_of_birth: string | null;
    joined_on: string;
    last_day: string | null;
    status: string;
    department_name: string | null;
    position_title: string | null;
    bank_name: string | null;
    bank_account_last4: string | null;
    epf_applicable: boolean;
    socso_applicable: boolean;
    eis_applicable: boolean;
    pcb_applicable: boolean;
  }>(sql`
    SELECT e.id, e.employee_no, e.full_name, e.date_of_birth, e.joined_on, e.last_day, e.status,
           d.name AS department_name, p.title AS position_title,
           e.bank_name, e.bank_account_last4,
           -- The four liability flags as they stood at the end of the period, from dated employment
           -- history rather than from the employee row.
           --
           -- Reading them from the row made a past run irreproducible in exactly the way this module
           -- exists to prevent: switching somebody's PCB liability on today gave every earlier month
           -- a deduction it never had, silently, while the salary and the rates a few lines away were
           -- being sourced from dated records. Migration 0027 put the flags on employment_event and
           -- gave everybody an opening event dated to their joining day, so the COALESCE only falls
           -- back to the row for an employee with no history at all.
           COALESCE(f.epf_applicable, e.epf_applicable) AS epf_applicable,
           COALESCE(f.socso_applicable, e.socso_applicable) AS socso_applicable,
           COALESCE(f.eis_applicable, e.eis_applicable) AS eis_applicable,
           COALESCE(f.pcb_applicable, e.pcb_applicable) AS pcb_applicable
      FROM hr.employee e
      LEFT JOIN LATERAL (
        SELECT v.epf_applicable, v.socso_applicable, v.eis_applicable, v.pcb_applicable
          FROM hr.employment_event v
         WHERE v.employee_id = e.id
           AND v.effective_from <= ${periodTo}::date
           AND v.epf_applicable IS NOT NULL
         ORDER BY v.effective_from DESC, v.created_at DESC
         LIMIT 1
      ) f ON true
      LEFT JOIN hr.department d ON d.id = e.department_id
      LEFT JOIN hr.position p ON p.id = e.position_id
     WHERE e.joined_on <= ${periodTo}::date
       AND (e.last_day IS NULL OR e.last_day >= ${periodFrom}::date)
     ORDER BY e.full_name
  `);

  const people = employees.rows ?? [];
  if (people.length === 0) {
    throw new ConflictError("Nobody was employed during this period, so there is nothing to pay.");
  }

  // Which rules this run actually needs, from who is in it. Demanding the SOCSO
  // table for a run where nobody is liable would be a refusal with no purpose.
  const required = new Set<StatutoryKind>();
  for (const person of people) {
    if (person.epf_applicable) {
      required.add("epf_employee");
      required.add("epf_employer");
    }
    if (person.socso_applicable) required.add("socso");
    if (person.eis_applicable) required.add("eis");
    if (person.pcb_applicable) required.add("pcb");
  }

  // Raises StatutoryRulesMissingError, naming what is absent. This is where the
  // phase stops while Q-HR-1 is open.
  const rules = await requireRulesFor(db, payDate, [...required]);

  // Everything else the run needs, in three queries rather than three per person.
  const elements = await db.execute<{
    employee_id: string;
    kind: string;
    code: string;
    description: string;
    amount: string;
    is_epf_liable: boolean;
    is_socso_liable: boolean;
    is_pcb_liable: boolean;
    account_code: string | null;
  }>(sql`
    SELECT employee_id, kind, code, description, amount, is_epf_liable, is_socso_liable,
           is_pcb_liable, account_code
      FROM hr.pay_element
     WHERE effective_from <= ${periodTo}::date
       AND (effective_to IS NULL OR effective_to >= ${periodFrom}::date)
     ORDER BY employee_id, kind, code
  `);

  const overtime = await db.execute<{
    id: string;
    employee_id: string;
    work_date: string;
    approved_hours: string;
    rate_multiple: string | null;
    day_kind: string;
    rate_source: string | null;
  }>(sql`
    SELECT id, employee_id, work_date, approved_hours, rate_multiple, day_kind, rate_source
      FROM hr.overtime_request
     WHERE status = 'approved' AND approved_hours IS NOT NULL AND payroll_run_id IS NULL
       AND work_date BETWEEN ${periodFrom}::date AND ${periodTo}::date
  `);

  // The unpaid days that fall *inside* this period, counted the way the proration denominator is
  // counted.
  //
  // This summed `r.days` -- the whole request's length -- for any request merely overlapping the
  // period, so unpaid leave from 27 February to 4 March was deducted in full from February and then
  // in full again from March. It also mixed units: `r.days` counts working days, because it excludes
  // rest days and holidays, while `periodDays` and `employedDays` are calendar days, so the
  // numerator and the denominator of one fraction were measuring different things and a week of
  // unpaid leave cost five days' pay out of thirty-one rather than seven.
  //
  // Clipping the request to the period and counting calendar days fixes both, and matches the basis
  // the module already applies to joiners and leavers. If CAC prorates on a different divisor,
  // `periodDays` is the single line to change, and every payslip states which basis was used.
  /**
   * The unpaid leave that falls inside this period, counted in working days.
   *
   * Three things have been wrong here in turn, and it is worth recording all of them because the
   * third only looks like a step backwards.
   *
   * It began by summing `r.days` — the whole request's length — for any request merely *overlapping*
   * the period, so leave from 27 February to 4 March was deducted in full from February and again in
   * full from March.
   *
   * The audit fix clipped each request to the period and counted calendar days, which stopped the
   * double count but priced a day wrongly: the denominator it fed was the days in the month, so a day
   * off cost 1/31 of a month in March and 1/28 in February.
   *
   * What Malaysian payroll actually does is price a day at the ordinary rate of pay — the monthly
   * wages over 26 — and count the days the person would otherwise have worked. So the clipping stays
   * and the unit goes back to working days, which is also the unit the leave module already counts
   * in. The counting is done in TypeScript rather than SQL because "a working day" depends on the
   * person's schedule and the holiday calendar, and `countLeaveDays` already knows both.
   */
  const unpaidLeaveRequests = await db.execute<{
    employee_id: string;
    starts_on: string;
    ends_on: string;
    half_day_start: boolean;
    half_day_end: boolean;
    type_name: string;
  }>(sql`
    SELECT r.employee_id, r.starts_on, r.ends_on, r.half_day_start, r.half_day_end,
           t.name AS type_name
      FROM hr.leave_request r
      JOIN hr.leave_type t ON t.id = r.leave_type_id
     WHERE r.status = 'approved' AND NOT t.is_paid
       AND r.starts_on <= ${periodTo}::date AND r.ends_on >= ${periodFrom}::date
     ORDER BY r.starts_on
  `);

  /**
   * Days the person was absent without leave, from the attendance the period finalised.
   *
   * Payroll read nothing out of `hr.attendance` before this: an absent day cost nothing, which is
   * not how anybody runs a payroll. Only `is_absent` days with no leave against them count — a day
   * covered by approved leave is already handled by the leave itself, paid or unpaid.
   */
  const absences = await db.execute<{ employee_id: string; days: string; first: string; last: string }>(sql`
    SELECT employee_id, count(*)::text AS days,
           min(work_date)::text AS first, max(work_date)::text AS last
      FROM hr.attendance
     WHERE work_date BETWEEN ${periodFrom}::date AND ${periodTo}::date
       AND is_absent AND on_leave_type IS NULL AND leave_request_id IS NULL
     GROUP BY employee_id
  `);
  const absenceByEmployee = new Map(
    (absences.rows ?? []).map((row) => [
      row.employee_id,
      { days: Number(row.days), first: row.first, last: row.last },
    ]),
  );

  /** Late minutes in the period, reported rather than deducted. See `deductLateness`. */
  const lateness = await db.execute<{ employee_id: string; days: string; minutes: string }>(sql`
    SELECT employee_id, count(*)::text AS days, SUM(late_minutes)::text AS minutes
      FROM hr.attendance
     WHERE work_date BETWEEN ${periodFrom}::date AND ${periodTo}::date
       AND COALESCE(late_minutes, 0) > 0
     GROUP BY employee_id
  `);
  const latenessByEmployee = new Map(
    (lateness.rows ?? []).map((row) => [
      row.employee_id,
      { days: Number(row.days), minutes: Number(row.minutes) },
    ]),
  );

  /**
   * How a day is priced, and whether an absence or a late morning is deducted at all.
   *
   * The divisor is the Employment Act's ordinary rate of pay for a monthly-rated employee: monthly
   * wages over 26. Nought means "the days in that particular month" instead, for a firm that prices
   * a day on the calendar.
   *
   * Lateness is **not** deducted, and that is the ordinary position rather than an omission: section
   * 24 of the Employment Act limits what may be taken out of wages, and minutes are not among the
   * deductions it permits without authority. The attendance screens report every late minute and the
   * disciplinary process is where it belongs. The setting exists so the position is stated, and so a
   * firm that has the authority can say so.
   */
  const [divisorSetting, deductAbsence, deductLateness] = await Promise.all([
    getSettingState<number>(db, "hr.daily_rate_divisor", 26),
    getSettingState<boolean>(db, "hr.deduct_unauthorised_absence", true),
    getSettingState<boolean>(db, "hr.deduct_lateness", false),
  ]);

  // The calendar a working day is counted against: the holidays in the period, and each person's
  // own week. Fetched once for the run rather than per request.
  const holidayRows = await db.execute<{ holiday_on: string }>(sql`
    SELECT holiday_on FROM hr.public_holiday
     WHERE holiday_on BETWEEN ${periodFrom}::date AND ${periodTo}::date
  `);
  const holidays = (holidayRows.rows ?? []).map((row) => String(row.holiday_on).slice(0, 10));

  const scheduleRows = await db.execute<{ employee_id: string; work_days: number[] | string | null }>(sql`
    SELECT e.id AS employee_id, COALESCE(ws.work_days, dflt.work_days) AS work_days
      FROM hr.employee e
      LEFT JOIN LATERAL (
        SELECT s.work_schedule_id
          FROM hr.employee_schedule s
         WHERE s.employee_id = e.id AND s.effective_from <= ${periodTo}::date
           AND (s.effective_to IS NULL OR s.effective_to >= ${periodFrom}::date)
         ORDER BY s.effective_from DESC
         LIMIT 1
      ) es ON true
      LEFT JOIN hr.work_schedule ws ON ws.id = COALESCE(es.work_schedule_id, e.work_schedule_id)
      LEFT JOIN hr.work_schedule dflt ON dflt.is_default
  `);
  const workDaysByEmployee = new Map(
    (scheduleRows.rows ?? []).map((row) => [row.employee_id, readWorkDays(row.work_days)]),
  );

  /**
   * What this period has already paid each person, for a supplementary run.
   *
   * A contribution is on the month's wages, not on a payment. EPF is a flat percentage, so a
   * percentage of the additional wages happens to give the right answer; SOCSO and EIS are *read out
   * of a band table*, and the band covering RM 300 of overtime is not the difference between two
   * bands of the month's total — it would deduct a few sen where tens of ringgit are owed. PCB is a
   * table too. The only figure that is right for all of them is the contribution on the combined
   * wages less what has already been contributed, which is why migration 0028 records the wage base
   * each contribution was computed on.
   *
   * Summed across every finalised run for the period rather than only the one named, so a second
   * correction corrects the month and not one earlier run.
   */
  interface PriorPay {
    epfWages: Amount;
    socsoWages: Amount;
    pcbWages: Amount;
    /** Already contributed, by payslip line code: EPF, EPF-ER, SOCSO, SOCSO-ER, EIS, EIS-ER, PCB. */
    paid: Map<string, Amount>;
    /**
     * True when a payslip for the period predates migration 0028 and so does not record the wages
     * its contributions were computed on. The difference cannot be worked out, and a supplementary
     * run says so on the payslip rather than computing a wrong one.
     */
    basesMissing: boolean;
  }

  const priorByEmployee = new Map<string, PriorPay>();

  if (supplementary) {
    const bases = await db.execute<{
      employee_id: string;
      epf_wages: string | null;
      socso_wages: string | null;
      pcb_wages: string | null;
      payslips: number;
      with_bases: number;
    }>(sql`
      SELECT s.employee_id,
             SUM(s.epf_wages) AS epf_wages,
             SUM(s.socso_wages) AS socso_wages,
             SUM(s.pcb_wages) AS pcb_wages,
             count(*)::int AS payslips,
             count(s.epf_wages)::int AS with_bases
        FROM hr.payslip s
        JOIN hr.payroll_run r ON r.id = s.run_id
       WHERE r.period_from = ${periodFrom}::date AND r.period_to = ${periodTo}::date
         AND r.status IN ('finalised', 'posted') AND r.id <> ${runId}
       GROUP BY s.employee_id
    `);

    const paid = await db.execute<{ employee_id: string; code: string; amount: string }>(sql`
      SELECT s.employee_id, l.code, SUM(l.amount) AS amount
        FROM hr.payslip_line l
        JOIN hr.payslip s ON s.id = l.payslip_id
        JOIN hr.payroll_run r ON r.id = s.run_id
       WHERE r.period_from = ${periodFrom}::date AND r.period_to = ${periodTo}::date
         AND r.status IN ('finalised', 'posted') AND r.id <> ${runId}
       GROUP BY s.employee_id, l.code
    `);

    for (const row of bases.rows ?? []) {
      priorByEmployee.set(row.employee_id, {
        epfWages: row.epf_wages === null ? 0n : parseAmount(row.epf_wages),
        socsoWages: row.socso_wages === null ? 0n : parseAmount(row.socso_wages),
        pcbWages: row.pcb_wages === null ? 0n : parseAmount(row.pcb_wages),
        paid: new Map(),
        basesMissing: row.with_bases < row.payslips,
      });
    }
    for (const row of paid.rows ?? []) {
      priorByEmployee.get(row.employee_id)?.paid.set(row.code, parseAmount(row.amount));
    }
  }

  // Clear any previous attempt: preparing twice replaces, it does not add.
  await db.execute(sql`DELETE FROM hr.payslip WHERE run_id = ${runId}`);

  const periodDays = daysBetween(periodFrom, periodTo);
  const skipped: PrepareResult["skipped"] = [];
  const problems: PrepareResult["problems"] = [];
  const notes: PrepareResult["notes"] = [];

  for (const person of people) {
    const salary = await salaryOn(db, person.id, periodTo);
    if (salary === null) {
      skipped.push({
        employeeName: person.full_name,
        why: "no salary is recorded as in force during this period",
      });
      continue;
    }

    // Prorate a joiner or a leaver. Somebody who joined on the twentieth is not paid
    // a full month, and this is the only honest way to say so.
    const employedFrom =
      String(person.joined_on).slice(0, 10) > periodFrom
        ? String(person.joined_on).slice(0, 10)
        : periodFrom;
    const employedTo =
      person.last_day && String(person.last_day).slice(0, 10) < periodTo
        ? String(person.last_day).slice(0, 10)
        : periodTo;
    const employedDays = daysBetween(employedFrom, employedTo);

    /**
     * Days employed, and days not paid for — kept apart on purpose.
     *
     * `payableDays` used to be the employed days less the unpaid leave, so unpaid leave shrank the
     * basic salary silently and the payslip showed a smaller figure with no line saying why. The
     * Employment Act's incomplete-month formula — monthly wages over the days in that month, times
     * the days employed — is right for a joiner or a leaver, and it is not what a day off costs.
     * Those are now two separate things: the basic is prorated for employment only, and a day not
     * worked is a deduction of its own, at its own rate, with its own line.
     */
    const workDays = workDaysByEmployee.get(person.id) ?? [1, 2, 3, 4, 5];

    let unpaidLeaveDays = 0;
    const unpaidLeaveNames = new Set<string>();
    for (const request of unpaidLeaveRequests.rows ?? []) {
      if (request.employee_id !== person.id) continue;
      const from = String(request.starts_on).slice(0, 10);
      const to = String(request.ends_on).slice(0, 10);
      const clippedFrom = from > periodFrom ? from : periodFrom;
      const clippedTo = to < periodTo ? to : periodTo;
      if (clippedTo < clippedFrom) continue;

      const counted = countLeaveDays({
        startsOn: clippedFrom,
        endsOn: clippedTo,
        // A half day at either end only counts as a half if that end is inside the period.
        halfDayStart: request.half_day_start && clippedFrom === from,
        halfDayEnd: request.half_day_end && clippedTo === to,
        workDays,
        holidays,
      });
      if (counted.days > 0) {
        unpaidLeaveDays += counted.days;
        unpaidLeaveNames.add(request.type_name);
      }
    }

    const absence = absenceByEmployee.get(person.id);
    const absentDays = deductAbsence.value ? (absence?.days ?? 0) : 0;
    const payableDays = employedDays;

    // Their unclaimed overtime, read before anything is written, because on a supplementary run it
    // decides whether this person is in the run at all.
    const theirs = (overtime.rows ?? []).filter((row) => row.employee_id === person.id);

    if (supplementary && !theirs.some((claim) => claim.rate_multiple !== null)) {
      skipped.push({
        employeeName: person.full_name,
        why: "there is no unpaid rated overtime for this period, so a correction would pay nothing",
      });
      continue;
    }

    const payslip = await db.execute<{ id: string }>(sql`
      INSERT INTO hr.payslip
        (run_id, employee_id, employee_no, employee_name, department_name, position_title,
         bank_name, bank_account_last4, basic_salary, payable_days, period_days)
      VALUES (${runId}, ${person.id}, ${person.employee_no}, ${person.full_name},
              ${person.department_name}, ${person.position_title},
              ${person.bank_name}, ${person.bank_account_last4},
              -- basic_salary is the salary on record, which a supplementary run still needs: the
              -- hourly rate its overtime is paid at is derived from it. payable_days is nought on a
              -- correction, because no days are being paid -- the days were paid by the run being
              -- corrected, and repeating them here is what made a supplementary run a second payment.
              ${amountToSql(salary)}, ${String(supplementary ? 0 : payableDays)},
              ${String(periodDays)})
      RETURNING id
    `);
    const payslipId = payslip.rows![0]!.id;

    let lineNo = 0;
    const addLine = async (line: {
      kind: "earning" | "deduction" | "employer";
      code: string;
      description: string;
      amount: Amount;
      basis?: string | null;
      quantity?: string | null;
      rate?: string | null;
      accountCode?: string | null;
      contraAccountCode?: string | null;
      statutoryRuleId?: string | null;
      /**
       * The overtime claim an overtime line paid.
       *
       * Finalisation reads it back, so a run can claim only the overtime it actually put on a
       * payslip. A unique index makes a second line for the same claim impossible.
       */
      overtimeRequestId?: string | null;
    }) => {
      lineNo += 1;
      await db.execute(sql`
        INSERT INTO hr.payslip_line
          (payslip_id, line_no, kind, code, description, basis, quantity, rate, amount,
           account_code, contra_account_code, statutory_rule_id, overtime_request_id)
        VALUES (${payslipId}, ${lineNo}, ${line.kind}, ${line.code}, ${line.description},
                ${line.basis ?? null}, ${line.quantity ?? null}, ${line.rate ?? null},
                ${amountToSql(line.amount)}, ${line.accountCode ?? null},
                ${line.contraAccountCode ?? null}, ${line.statutoryRuleId ?? null},
                ${line.overtimeRequestId ?? null})
      `);
    };

    const prior = priorByEmployee.get(person.id);

    try {
      if (supplementary && (!prior || prior.basesMissing)) {
        // Recorded on the payslip rather than thrown out of the whole run: the run keeps going, this
        // person's payslip carries the reason, and a run with any problem cannot be approved.
        throw new ValidationError(
          !prior
            ? "There is no finalised payslip for this person in this period, so there is nothing to " +
                "correct. A supplementary run pays the difference against a month that has already " +
                "been paid."
            : "A payslip for this period does not record the wages its statutory contributions were " +
                "computed on, so the difference cannot be worked out. Contributions are on the " +
                "month's wages, and guessing the earlier base would produce a figure nobody could " +
                "check.",
          "correctsRunId",
        );
      }

      // --- Earnings -------------------------------------------------------
      // A correction starts from nothing: the basic salary and the recurring allowances were paid by
      // the run being corrected.
      const prorated = supplementary
        ? 0n
        : payableDays >= periodDays
          ? salary
          : (salary * BigInt(Math.round(payableDays * 100))) / BigInt(Math.round(periodDays * 100));

      if (!supplementary) {
        await addLine({
          kind: "earning",
          code: "BASIC",
          description: "Basic salary",
          amount: prorated,
          basis:
            payableDays >= periodDays
              ? "full month"
              : `${payableDays} of ${periodDays} days employed` +
                " (Employment Act incomplete-month basis: monthly wages over the days in the month)",
          quantity: String(payableDays),
          accountCode: SYSTEM_ACCOUNTS.salariesExpense,
        });
      }

      // EPF-liable wages start as the basic; each allowance says whether it counts.
      let epfWages = prorated;
      let socsoWages = prorated;
      let pcbWages = prorated;
      let gross = prorated;

      if (!supplementary) {
        for (const element of (elements.rows ?? []).filter((row) => row.employee_id === person.id)) {
          const amount = parseAmount(element.amount);
          if (element.kind === "earning") {
            await addLine({
              kind: "earning",
              code: element.code,
              description: element.description,
              amount,
              basis: "recurring allowance",
              accountCode: element.account_code ?? SYSTEM_ACCOUNTS.allowancesExpense,
            });
            gross += amount;
            if (element.is_epf_liable) epfWages += amount;
            if (element.is_socso_liable) socsoWages += amount;
            if (element.is_pcb_liable) pcbWages += amount;
          }
        }
      }

      // Approved overtime, at the rate somebody recorded. No rate means it is not
      // paid — the hours are agreed, the multiple is not known, and inventing one
      // would be inventing what the person is owed.
      const hourly = hourlyRateFrom(salary);

      for (const claim of theirs) {
        if (claim.rate_multiple === null) {
          await addLine({
            kind: "earning",
            code: "OT-UNRATED",
            description: `Overtime ${String(claim.work_date).slice(0, 10)} — not paid, no rate recorded`,
            amount: 0n,
            basis:
              `${claim.approved_hours} hours approved on a ${claim.day_kind.replace(/_/g, " ")}. ` +
              "The Employment Act multiple has not been supplied (Q-HR-1), so nothing is paid " +
              "rather than a rate being guessed.",
            quantity: claim.approved_hours,
          });
          continue;
        }

        const multiple = Number(claim.rate_multiple);
        const hours = Number(claim.approved_hours);
        const amount =
          (hourly * BigInt(Math.round(hours * multiple * 10_000))) / 10_000n;

        await addLine({
          kind: "earning",
          code: "OT",
          description: `Overtime ${String(claim.work_date).slice(0, 10)}`,
          amount,
          basis:
            `${claim.approved_hours} hours × ${claim.rate_multiple} × hourly rate ` +
            `${formatAmount(hourly)} (${claim.rate_source ?? "rate source not recorded"}). ` +
            `Counts as wages for ${describeWageBases(overtimeIsWagesFor)}.`,
          quantity: claim.approved_hours,
          rate: claim.rate_multiple,
          accountCode: SYSTEM_ACCOUNTS.overtimeExpense,
          overtimeRequestId: claim.id,
        });

        // Which bases this reaches is the question Q-HR-1 item 7 asks, and the answer differs per
        // contribution: ordinarily not EPF, but yes for SOCSO, EIS and PCB.
        gross += amount;
        if (overtimeIsWagesFor.epf) epfWages += amount;
        if (overtimeIsWagesFor.socso) socsoWages += amount;
        if (overtimeIsWagesFor.pcb) pcbWages += amount;
      }

      /**
       * A day not worked, priced at the ordinary rate of pay.
       *
       * Deducted rather than folded into the basic, because a payslip that simply shows a smaller
       * number answers no question. The rate is the Employment Act's ordinary rate for a
       * monthly-rated employee — monthly wages over 26 — not the calendar-day rate, so a day off
       * costs the same in February as in March.
       *
       * It comes out of the statutory wage bases as well as the gross, because a contribution is on
       * the wages actually payable for the month. Taking it off afterwards would have contributed on
       * money nobody was paid.
       */
      const divisor =
        divisorSetting.value > 0 ? BigInt(Math.round(divisorSetting.value)) : BigInt(periodDays);
      const dailyRate = salary / divisor;

      const deductDays = async (code: string, description: string, days: number, note: string) => {
        if (supplementary || days <= 0) return 0n;
        const amount = (dailyRate * BigInt(Math.round(days * 100))) / 100n;
        if (amount <= 0n) return 0n;

        await addLine({
          kind: "deduction",
          code,
          description,
          amount,
          basis:
            `${days} day${days === 1 ? "" : "s"} at ${formatAmount(dailyRate)} — the ordinary rate ` +
            `of pay, ${formatAmount(salary)} over ${divisor}. ${note}`,
          quantity: String(days),
          accountCode: SYSTEM_ACCOUNTS.salariesExpense,
        });
        return amount;
      };

      const unpaidAmount = await deductDays(
        "UNPAID",
        unpaidLeaveNames.size > 0
          ? `Unpaid leave — ${[...unpaidLeaveNames].join(", ")}`
          : "Unpaid leave",
        unpaidLeaveDays,
        "Working days only: a rest day or a public holiday inside the leave is not a day of it.",
      );

      const absentAmount = await deductDays(
        "ABSENT",
        "Absent without leave",
        absentDays,
        absence
          ? `From the finalised attendance for this period${
              absence.first === absence.last
                ? `, on ${absence.first}`
                : `, between ${absence.first} and ${absence.last}`
            }.`
          : "From the finalised attendance for this period.",
      );

      const notPaidFor = unpaidAmount + absentAmount;
      gross -= notPaidFor;
      epfWages -= notPaidFor;
      socsoWages -= notPaidFor;
      pcbWages -= notPaidFor;

      if (epfWages < 0n) epfWages = 0n;
      if (socsoWages < 0n) socsoWages = 0n;
      if (pcbWages < 0n) pcbWages = 0n;

      // Lateness is measured and not deducted. Reported here so that the run does not simply swallow
      // it: somebody should see it, and the place they see it is not a payslip.
      const late = latenessByEmployee.get(person.id);
      if (late && late.minutes > 0 && !deductLateness.value) {
        notes.push({
          employeeName: person.full_name,
          note:
            `Late on ${late.days} day${late.days === 1 ? "" : "s"}, ${late.minutes} minutes in all. ` +
            "Not deducted — section 24 of the Employment Act limits what may be taken out of wages, " +
            "and lateness is handled through the disciplinary process.",
        });
      }

      // --- Statutory deductions -------------------------------------------
      const age = ageOn(person.date_of_birth, payDate);
      const used: Partial<Record<StatutoryKind, string>> = {};

      /**
       * A contribution on this payslip's wages — or, on a correction, the month's contribution less
       * what the month has already had.
       *
       * The second form is the only correct one for a supplementary run. SOCSO, EIS and PCB are read
       * out of band tables, so applying the table to RM 300 of overtime gives the contribution of
       * somebody earning RM 300 a month rather than the extra owed by somebody earning RM 4,800 and
       * then RM 5,100. EPF is a percentage and comes out the same either way; it goes through here
       * too so that one rule governs all four.
       *
       * `codes` names the payslip line codes the earlier runs recorded, per side, so "already
       * contributed" is read from what was actually paid rather than recomputed.
       */
      const contribute = (
        kind: StatutoryKind,
        wagesNow: Amount,
        wagesBefore: Amount,
        codes: { employee?: string; employer?: string },
        options: { age?: number | null } = {},
      ): StatutoryResult => {
        const rule = rules.get(kind)!;
        if (!supplementary) return applyRule(rule, wagesNow, options);

        const combined = wagesBefore + wagesNow;
        const total = applyRule(rule, combined, options);
        const paidEmployee = codes.employee ? (prior!.paid.get(codes.employee) ?? 0n) : 0n;
        const paidEmployer = codes.employer ? (prior!.paid.get(codes.employer) ?? 0n) : 0n;
        const employee = total.employee - paidEmployee;
        const employer = total.employer - paidEmployer;

        if (employee < 0n || employer < 0n) {
          throw new ValidationError(
            `The ${STATUTORY_LABELS[kind]} already contributed for this period is more than the ` +
              `contribution due on the corrected wages of ${formatAmount(combined)}, so this run ` +
              "would have to take money back. Payroll does not do that on its own: the run that " +
              "over-contributed has to be reversed.",
            "wages",
          );
        }

        return {
          employee,
          employer,
          basis:
            `${total.basis} on the period's wages of ${formatAmount(combined)}, less the ` +
            `${formatAmount(paidEmployee + paidEmployer)} already contributed on ` +
            `${formatAmount(wagesBefore)}`,
          ruleId: total.ruleId,
        };
      };

      if (person.epf_applicable) {
        const employeeShare = contribute(
          "epf_employee",
          epfWages,
          prior?.epfWages ?? 0n,
          { employee: "EPF" },
          { age },
        );
        const employerShare = contribute(
          "epf_employer",
          epfWages,
          prior?.epfWages ?? 0n,
          { employer: "EPF-ER" },
          { age },
        );

        await addLine({
          kind: "deduction",
          code: "EPF",
          description: "EPF — employee's share",
          amount: employeeShare.employee,
          basis: employeeShare.basis,
          accountCode: SYSTEM_ACCOUNTS.epfPayable,
          statutoryRuleId: employeeShare.ruleId,
        });
        await addLine({
          kind: "employer",
          code: "EPF-ER",
          description: "EPF — employer's share",
          amount: employerShare.employer,
          basis: employerShare.basis,
          // A cost to the firm and money owed to KWSP: both sides, or the journal
          // does not balance.
          accountCode: SYSTEM_ACCOUNTS.epfExpense,
          contraAccountCode: SYSTEM_ACCOUNTS.epfPayable,
          statutoryRuleId: employerShare.ruleId,
        });

        used.epf_employee = employeeShare.ruleId;
        used.epf_employer = employerShare.ruleId;
      }

      if (person.socso_applicable) {
        const socso = contribute("socso", socsoWages, prior?.socsoWages ?? 0n, {
          employee: "SOCSO",
          employer: "SOCSO-ER",
        });
        await addLine({
          kind: "deduction",
          code: "SOCSO",
          description: "SOCSO — employee's share",
          amount: socso.employee,
          basis: socso.basis,
          accountCode: SYSTEM_ACCOUNTS.socsoPayable,
          statutoryRuleId: socso.ruleId,
        });
        await addLine({
          kind: "employer",
          code: "SOCSO-ER",
          description: "SOCSO — employer's share",
          amount: socso.employer,
          basis: socso.basis,
          accountCode: SYSTEM_ACCOUNTS.socsoExpense,
          contraAccountCode: SYSTEM_ACCOUNTS.socsoPayable,
          statutoryRuleId: socso.ruleId,
        });
        used.socso = socso.ruleId;
      }

      if (person.eis_applicable) {
        const eis = contribute("eis", socsoWages, prior?.socsoWages ?? 0n, {
          employee: "EIS",
          employer: "EIS-ER",
        });
        await addLine({
          kind: "deduction",
          code: "EIS",
          description: "EIS — employee's share",
          amount: eis.employee,
          basis: eis.basis,
          accountCode: SYSTEM_ACCOUNTS.eisPayable,
          statutoryRuleId: eis.ruleId,
        });
        await addLine({
          kind: "employer",
          code: "EIS-ER",
          description: "EIS — employer's share",
          amount: eis.employer,
          basis: eis.basis,
          accountCode: SYSTEM_ACCOUNTS.eisExpense,
          contraAccountCode: SYSTEM_ACCOUNTS.eisPayable,
          statutoryRuleId: eis.ruleId,
        });
        used.eis = eis.ruleId;
      }

      if (person.pcb_applicable) {
        const pcb = contribute("pcb", pcbWages, prior?.pcbWages ?? 0n, { employee: "PCB" });
        await addLine({
          kind: "deduction",
          code: "PCB",
          description: "PCB — monthly tax deduction",
          amount: pcb.employee,
          basis: pcb.basis,
          accountCode: SYSTEM_ACCOUNTS.pcbPayable,
          statutoryRuleId: pcb.ruleId,
        });
        used.pcb = pcb.ruleId;
      }

      // Other recurring deductions, after the statutory ones.
      for (const element of (elements.rows ?? []).filter(
        (row) => row.employee_id === person.id && row.kind === "deduction",
      )) {
        await addLine({
          kind: "deduction",
          code: element.code,
          description: element.description,
          amount: parseAmount(element.amount),
          basis: "recurring deduction",
          accountCode: element.account_code,
        });
      }

      // The wage bases are recorded whether or not the contribution applied to this person, because
      // "no EPF wages" and "no EPF liability" are different facts and a later correction has to tell
      // them apart. They are also what makes a payslip line's "11% of 4,500.00" a queryable figure
      // rather than only a sentence.
      await db.execute(sql`
        UPDATE hr.payslip SET
          epf_employee_rule_id = ${used.epf_employee ?? null},
          epf_employer_rule_id = ${used.epf_employer ?? null},
          socso_rule_id = ${used.socso ?? null},
          eis_rule_id = ${used.eis ?? null},
          pcb_rule_id = ${used.pcb ?? null},
          epf_wages = ${amountToSql(epfWages)},
          socso_wages = ${amountToSql(socsoWages)},
          pcb_wages = ${amountToSql(pcbWages)}
        WHERE id = ${payslipId}
      `);
    } catch (error) {
      // The payslip stays, carrying the problem. A run with any of these cannot be
      // approved, which is how somebody is made to look at it.
      const problem = error instanceof Error ? error.message : "The figures could not be computed.";
      await db.execute(sql`UPDATE hr.payslip SET problem = ${problem} WHERE id = ${payslipId}`);
      problems.push({ employeeName: person.full_name, problem });
    }
  }

  const runNo = run.run_no ?? (await allocateDocumentNumber(db, "payroll", { on: payDate }));

  await db.execute(sql`
    UPDATE hr.payroll_run
       SET status = 'prepared', run_no = ${runNo}, prepared_at = now(),
           prepared_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${runId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PAYROLL_RUN_PREPARED,
    entityType: "payroll_run",
    entityId: runId,
    newValues: {
      runNo,
      kind: run.kind,
      correctsRunId: run.corrects_run_id,
      overtimeWageBasis: overtimeIsWagesFor,
      periodFrom,
      periodTo,
      payslips: people.length - skipped.length,
      skipped: skipped.length,
      problems: problems.length,
      rulesUsed: [...rules.keys()],
    },
  });

  return { runNo, payslips: people.length - skipped.length, skipped, problems, notes };
}

/**
 * Which contributions an overtime payment counted towards, in words, for the payslip line.
 *
 * On the line rather than in a footnote because it is the part somebody would query, and because the
 * answer can change: a payslip has to be explicable years later with whatever the settings say then.
 */
function describeWageBases(bases: { epf: boolean; socso: boolean; pcb: boolean }): string {
  const named = [
    bases.epf ? "EPF" : null,
    bases.socso ? "SOCSO and EIS" : null,
    bases.pcb ? "PCB" : null,
  ].filter((entry): entry is string => entry !== null);

  if (named.length === 0) return "none of EPF, SOCSO, EIS or PCB";
  if (named.length === 1) return named[0]!;
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/**
 * A schedule's working days, whatever shape the driver hands them back in.
 *
 * `work_days` is `integer[]`, which arrives as an array from one driver and as `{1,2,3,4,5}` from
 * another. Falling back to Monday–Friday rather than to nothing: a person with no schedule at all
 * would otherwise have no working days, and every day of unpaid leave would count as zero.
 */
function readWorkDays(value: number[] | string | null): number[] {
  if (Array.isArray(value) && value.length > 0) return value.map(Number);
  if (typeof value === "string") {
    const parsed = value
      .replace(/[{}]/g, "")
      .split(",")
      .map((entry) => Number(entry.trim()))
      .filter((entry) => Number.isFinite(entry));
    if (parsed.length > 0) return parsed;
  }
  return [1, 2, 3, 4, 5];
}

/** A monthly salary as an hourly rate, on the conventional 26-day, 8-hour basis. */
function hourlyRateFrom(monthly: Amount): Amount {
  // 26 working days of 8 hours is the customary Malaysian divisor for a monthly
  // salary. It is a convention rather than a statute, so it is stated here rather
  // than hidden: if CAC uses a different one, this is the line to change.
  return monthly / 208n;
}

function daysBetween(from: string, to: string): number {
  const start = parseIsoDate(from).getTime();
  const end = parseIsoDate(to).getTime();
  return Math.round((end - start) / 86_400_000) + 1;
}

function ageOn(dateOfBirth: string | null, onDate: string): number | null {
  if (!dateOfBirth) return null;
  const born = parseIsoDate(String(dateOfBirth).slice(0, 10));
  const at = parseIsoDate(onDate);
  let age = at.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday =
    at.getUTCMonth() < born.getUTCMonth() ||
    (at.getUTCMonth() === born.getUTCMonth() && at.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

// ---------------------------------------------------------------------------
// Approving, finalising, posting
// ---------------------------------------------------------------------------

export async function approvePayrollRun(
  db: Executor,
  principal: Principal,
  runId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.payroll.approve");

  const run = await lockRun(db, runId);
  if (run.status !== "prepared") {
    throw new ConflictError(
      run.status === "draft"
        ? "This run has not been computed yet."
        : `This run is already ${run.status}.`,
    );
  }

  requireDifferentApprover({
    principal,
    createdByUserId: run.prepared_by,
    action: "approve a payroll run",
  });

  const problems = await db.execute<{ count: number }>(
    sql`SELECT count(*)::int AS count FROM hr.payslip WHERE run_id = ${runId} AND problem IS NOT NULL`,
  );
  const failing = problems.rows?.[0]?.count ?? 0;
  if (failing > 0) {
    throw new ConflictError(
      `${failing} payslip${failing === 1 ? "" : "s"} could not be computed. A run cannot be ` +
        "approved while any figure is unexplained — look at those people first.",
    );
  }

  await db.execute(sql`
    UPDATE hr.payroll_run
       SET status = 'approved', approved_at = now(), approved_by = ${principal.userId},
           updated_by = ${principal.userId}
     WHERE id = ${runId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PAYROLL_RUN_APPROVED,
    entityType: "payroll_run",
    entityId: runId,
    newValues: {
      runNo: run.run_no,
      employees: run.employee_count,
      netTotal: run.net_total,
    },
  });
}

/**
 * Fixes the run.
 *
 * After this the payslips are documents, the overtime it paid is marked as paid so it
 * cannot be claimed again, and nothing in the run can be edited. A correction is a
 * supplementary run.
 */
export async function finalisePayrollRun(
  db: Executor,
  principal: Principal,
  runId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.payroll.finalise");

  const run = await lockRun(db, runId);
  if (run.status !== "approved") {
    throw new ConflictError(
      run.status === "prepared"
        ? "This run has not been approved yet."
        : `This run is ${run.status}.`,
    );
  }

  /**
   * Claim the overtime this run paid, so no other run can pay it again. Done here rather than at
   * preparation, so that re-preparing does not strand the claims of the first attempt.
   *
   * Read from the payslip lines, not from the period. Matching by date claimed every rated, unclaimed
   * request whose work date fell in the period *as at finalise time* — which is not the set the run
   * computed. A claim given its rate after the run was prepared got stamped with this run's id,
   * vanished from every future run's unclaimed filter, and was then paid by nothing at all. The hours
   * were lost, no screen showed it, and the employee's only evidence was a payslip that did not
   * mention them. Migration 0027 put the claim's id on the line that paid it, so this claims exactly
   * what went out, and the period no longer comes into it.
   */
  const claimed = await db.execute<{ id: string }>(sql`
    UPDATE hr.overtime_request o
       SET payroll_run_id = ${runId}, updated_by = ${principal.userId}
     WHERE o.payroll_run_id IS NULL
       AND o.id IN (
         SELECT l.overtime_request_id
           FROM hr.payslip_line l
           JOIN hr.payslip s ON s.id = l.payslip_id
          WHERE s.run_id = ${runId} AND l.overtime_request_id IS NOT NULL
       )
    RETURNING o.id
  `);

  await db.execute(sql`
    UPDATE hr.payroll_run
       SET status = 'finalised', finalised_at = now(), finalised_by = ${principal.userId},
           updated_by = ${principal.userId}
     WHERE id = ${runId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PAYROLL_RUN_FINALISED,
    entityType: "payroll_run",
    entityId: runId,
    newValues: {
      runNo: run.run_no,
      netTotal: run.net_total,
      overtimeClaimsPaid: (claimed.rows ?? []).length,
    },
  });
}

/**
 * Posts the run to the ledger.
 *
 *   Dr  salaries, overtime, allowances, employer contributions   (the cost)
 *   Cr  EPF / SOCSO / EIS / PCB payable                          (owed to the agencies)
 *   Cr  salaries payable                                         (owed to the staff)
 *
 * Net pay is credited to salaries payable rather than to the bank: paying it is a
 * separate act, recorded as a payment voucher against that account, and the ledger
 * should show what is owed between the two.
 */
export async function postPayrollRun(
  db: Executor,
  principal: Principal,
  runId: string,
  context?: AuditContext,
): Promise<{ journalNo: string }> {
  requireCapability(principal, "hr.payroll.post");

  const run = await lockRun(db, runId);
  if (run.status !== "finalised") {
    throw new ConflictError(
      run.status === "posted"
        ? "This run has already been posted."
        : "Only a finalised run can be posted.",
    );
  }

  // Every figure, grouped by the account it belongs to. Grouping in SQL keeps the
  // journal to one line per account rather than one per person, which is what an
  // accountant expects to see.
  const lines = await db.execute<{
    kind: string;
    account_code: string | null;
    contra_account_code: string | null;
    total: string;
  }>(sql`
    SELECT l.kind, l.account_code, l.contra_account_code, SUM(l.amount)::text AS total
      FROM hr.payslip_line l
      JOIN hr.payslip p ON p.id = l.payslip_id
     WHERE p.run_id = ${runId} AND l.amount > 0
     GROUP BY l.kind, l.account_code, l.contra_account_code
     ORDER BY l.kind, l.account_code
  `);

  const journalLines: Array<{
    accountCode: string;
    debit?: string;
    credit?: string;
    description: string;
  }> = [];

  for (const row of lines.rows ?? []) {
    const amount = parseAmount(row.total);
    if (amount === 0n) continue;

    if (!row.account_code) {
      throw new ConflictError(
        "A payslip line has no ledger account, so the run cannot be posted. That is a " +
          "configuration gap rather than a payroll error.",
      );
    }

    if (row.kind === "earning") {
      // Gross pay is a cost. The credit side of it is net pay plus the deductions
      // withheld from it, both below.
      journalLines.push({
        accountCode: row.account_code,
        debit: amountToSql(amount),
        description: `Payroll ${run.run_no}`,
      });
    } else if (row.kind === "employer") {
      // An employer contribution is a cost *and* a liability, so it is two entries.
      // Debiting it alone was the bug the balanced-journal test caught: the ledger
      // knew the expense and not the obligation.
      if (!row.contra_account_code) {
        throw new ConflictError(
          "An employer contribution line has no payable account, so it cannot be posted " +
            "without leaving the journal out of balance.",
        );
      }
      journalLines.push({
        accountCode: row.account_code,
        debit: amountToSql(amount),
        description: `Payroll ${run.run_no}`,
      });
      journalLines.push({
        accountCode: row.contra_account_code,
        credit: amountToSql(amount),
        description: `Payroll ${run.run_no} — owed to the agency`,
      });
    } else {
      // A deduction is money withheld from pay and owed to somebody else. The
      // earning it came out of has already been debited, so this is the credit.
      journalLines.push({
        accountCode: row.account_code,
        credit: amountToSql(amount),
        description: `Payroll ${run.run_no}`,
      });
    }
  }

  const netTotal = parseAmount(String(run.net_total));
  if (netTotal > 0n) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNTS.salariesPayable,
      credit: amountToSql(netTotal),
      description: `Payroll ${run.run_no} — net pay owed to staff`,
    });
  }

  const journal = await postSourceJournal(
    db,
    principal,
    {
      entryDate: String(run.pay_date).slice(0, 10),
      memo: `Payroll ${run.run_no} for ${String(run.period_from).slice(0, 10)} to ${String(run.period_to).slice(0, 10)}`,
      sourceType: "payroll",
      sourceId: runId,
      authorisedBy: "hr.payroll.post",
      lines: journalLines,
    },
    context,
  );

  await db.execute(sql`
    UPDATE hr.payroll_run
       SET status = 'posted', journal_id = ${journal.id}, posted_at = now(),
           posted_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${runId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PAYROLL_RUN_POSTED,
    entityType: "payroll_run",
    entityId: runId,
    newValues: { runNo: run.run_no, journalNo: journal.journalNo, netTotal: run.net_total },
  });

  return { journalNo: journal.journalNo };
}

export async function abandonPayrollRun(
  db: Executor,
  principal: Principal,
  runId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.payroll.prepare");

  if (!reason?.trim()) throw new ValidationError("Say why it is being abandoned.", "reason");

  const run = await lockRun(db, runId);
  if (run.status === "finalised" || run.status === "posted") {
    throw new ConflictError(
      "A finalised run is part of the record. Correct it with a supplementary run.",
    );
  }
  if (run.status === "abandoned") throw new ConflictError("That run is already abandoned.");

  await db.execute(sql`
    UPDATE hr.payroll_run
       SET status = 'abandoned', abandoned_at = now(), abandon_reason = ${reason.trim()},
           updated_by = ${principal.userId}
     WHERE id = ${runId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PAYROLL_RUN_ABANDONED,
    entityType: "payroll_run",
    entityId: runId,
    reason: reason.trim(),
  });
}

/**
 * Reverses a posted run's ledger entry.
 *
 * The run stays posted and the payslips stay as they were: what is reversed is the
 * accounting, not the fact of the payroll. A run whose journal was wrong is corrected
 * by reversing and re-posting; a run whose *figures* were wrong needs a supplementary
 * run, which is a different problem.
 */
export async function reversePayrollPosting(
  db: Executor,
  principal: Principal,
  runId: string,
  reason: string,
  context?: AuditContext,
): Promise<{ journalNo: string }> {
  requireCapability(principal, "hr.payroll.post");
  requireCapability(principal, "accounting.journal.reverse");

  if (!reason?.trim()) throw new ValidationError("Say why it is being reversed.", "reason");

  const run = await lockRun(db, runId);
  if (run.status !== "posted" || !run.journal_id) {
    throw new ConflictError("That run has no ledger entry to reverse.");
  }

  const reversal = await reverseJournal(
    db,
    principal,
    run.journal_id,
    { reason: reason.trim(), context },
  );

  await db.execute(sql`
    UPDATE hr.payroll_run
       SET status = 'finalised', journal_id = NULL, posted_at = NULL, posted_by = NULL,
           updated_by = ${principal.userId}
     WHERE id = ${runId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PAYROLL_POSTING_REVERSED,
    entityType: "payroll_run",
    entityId: runId,
    oldValues: { journalId: run.journal_id },
    newValues: { reversalJournalNo: reversal.journalNo },
    reason: reason.trim(),
  });

  return { journalNo: reversal.journalNo };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listPayrollRuns(
  db: Executor,
  limit = 50,
): Promise<PayrollRunView[]> {
  const result = await db.execute<Record<string, never>>(sql`
    SELECT r.id, r.run_no, r.period_from, r.period_to, r.pay_date, r.kind, r.corrects_run_id,
           r.status, r.employee_count, r.gross_total, r.deduction_total, r.net_total,
           r.employer_cost_total, r.notes,
           pb.full_name AS prepared_by_name, ab.full_name AS approved_by_name,
           fb.full_name AS finalised_by_name, r.journal_id, j.journal_no, r.abandon_reason,
           COALESCE(pr.count, 0)::int AS problem_count
      FROM hr.payroll_run r
      LEFT JOIN auth."user" pb ON pb.id = r.prepared_by
      LEFT JOIN auth."user" ab ON ab.id = r.approved_by
      LEFT JOIN auth."user" fb ON fb.id = r.finalised_by
      LEFT JOIN accounting.journal j ON j.id = r.journal_id
      LEFT JOIN (
        SELECT run_id, count(*) AS count FROM hr.payslip WHERE problem IS NOT NULL GROUP BY run_id
      ) pr ON pr.run_id = r.id
     ORDER BY r.period_from DESC, r.created_at DESC
     LIMIT ${Math.min(Math.max(limit, 1), 200)}
  `);

  return (result.rows ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      runNo: (row.run_no as string) ?? null,
      periodFrom: String(row.period_from).slice(0, 10),
      periodTo: String(row.period_to).slice(0, 10),
      payDate: String(row.pay_date).slice(0, 10),
      kind: row.kind as "regular" | "supplementary",
      correctsRunId: (row.corrects_run_id as string) ?? null,
      status: row.status as RunStatus,
      employeeCount: Number(row.employee_count),
      grossTotal: parseAmount(String(row.gross_total)),
      deductionTotal: parseAmount(String(row.deduction_total)),
      netTotal: parseAmount(String(row.net_total)),
      employerCostTotal: parseAmount(String(row.employer_cost_total)),
      notes: (row.notes as string) ?? null,
      preparedByName: (row.prepared_by_name as string) ?? null,
      approvedByName: (row.approved_by_name as string) ?? null,
      finalisedByName: (row.finalised_by_name as string) ?? null,
      journalId: (row.journal_id as string) ?? null,
      journalNo: (row.journal_no as string) ?? null,
      abandonReason: (row.abandon_reason as string) ?? null,
      problemCount: Number(row.problem_count),
    };
  });
}

export async function getPayrollRun(
  db: Executor,
  runId: string,
): Promise<PayrollRunView | null> {
  const runs = await listPayrollRuns(db, 200);
  return runs.find((row) => row.id === runId) ?? null;
}

export async function listPayslips(
  db: Executor,
  filters: { runId?: string; employeeId?: string; limit?: number } = {},
): Promise<Omit<PayslipView, "lines">[]> {
  const where = [sql`true`];
  if (filters.runId) where.push(sql`p.run_id = ${filters.runId}`);
  if (filters.employeeId) where.push(sql`p.employee_id = ${filters.employeeId}`);

  const result = await db.execute<Record<string, never>>(sql`
    SELECT p.id, p.run_id, r.run_no, r.period_from, r.period_to, r.pay_date, r.status AS run_status,
           p.employee_id, p.employee_no, p.employee_name, p.department_name, p.position_title,
           p.bank_name, p.bank_account_last4, p.basic_salary, p.payable_days, p.period_days,
           p.gross_pay, p.total_deductions, p.net_pay, p.employer_cost, p.notes, p.problem
      FROM hr.payslip p
      JOIN hr.payroll_run r ON r.id = p.run_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY r.period_from DESC, p.employee_name
     LIMIT ${Math.min(Math.max(filters.limit ?? 500, 1), 2000)}
  `);

  return (result.rows ?? []).map((raw) => readPayslipRow(raw as Record<string, unknown>));
}

function readPayslipRow(row: Record<string, unknown>): Omit<PayslipView, "lines"> {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    runNo: (row.run_no as string) ?? null,
    periodFrom: String(row.period_from).slice(0, 10),
    periodTo: String(row.period_to).slice(0, 10),
    payDate: String(row.pay_date).slice(0, 10),
    runStatus: row.run_status as RunStatus,
    employeeId: String(row.employee_id),
    employeeNo: String(row.employee_no),
    employeeName: String(row.employee_name),
    departmentName: (row.department_name as string) ?? null,
    positionTitle: (row.position_title as string) ?? null,
    bankName: (row.bank_name as string) ?? null,
    bankAccountLast4: (row.bank_account_last4 as string) ?? null,
    basicSalary: parseAmount(String(row.basic_salary)),
    payableDays: (row.payable_days as string) ?? null,
    periodDays: (row.period_days as string) ?? null,
    grossPay: parseAmount(String(row.gross_pay)),
    totalDeductions: parseAmount(String(row.total_deductions)),
    netPay: parseAmount(String(row.net_pay)),
    employerCost: parseAmount(String(row.employer_cost)),
    notes: (row.notes as string) ?? null,
    problem: (row.problem as string) ?? null,
  };
}

/**
 * One payslip in full.
 *
 * Scoped: somebody with `hr.payslip.view_own` sees only their own, and changing the
 * id in the URL does not work. A payslip is the most personal document in the system.
 */
export async function getPayslip(
  db: Executor,
  principal: Principal,
  payslipId: string,
): Promise<PayslipView | null> {
  const header = await db.execute<Record<string, never>>(sql`
    SELECT p.id, p.run_id, r.run_no, r.period_from, r.period_to, r.pay_date, r.status AS run_status,
           p.employee_id, p.employee_no, p.employee_name, p.department_name, p.position_title,
           p.bank_name, p.bank_account_last4, p.basic_salary, p.payable_days, p.period_days,
           p.gross_pay, p.total_deductions, p.net_pay, p.employer_cost, p.notes, p.problem
      FROM hr.payslip p
      JOIN hr.payroll_run r ON r.id = p.run_id
     WHERE p.id = ${payslipId}
  `);
  const raw = header.rows?.[0] as Record<string, unknown> | undefined;
  if (!raw) return null;

  requireEmployeeScope({
    principal,
    targetEmployeeId: String(raw.employee_id),
    viewAllCapability: "hr.payslip.view_all",
    viewOwnCapability: "hr.payslip.view_own",
  });

  const lines = await db.execute<{
    id: string;
    line_no: number;
    kind: "earning" | "deduction" | "employer";
    code: string;
    description: string;
    basis: string | null;
    quantity: string | null;
    rate: string | null;
    amount: string;
    account_code: string | null;
    contra_account_code: string | null;
    statutory_rule_id: string | null;
    source_ref: string | null;
  }>(sql`
    SELECT l.id, l.line_no, l.kind, l.code, l.description, l.basis, l.quantity, l.rate,
           l.amount, l.account_code, l.contra_account_code, l.statutory_rule_id, s.source_ref
      FROM hr.payslip_line l
      LEFT JOIN hr.statutory_rule_version s ON s.id = l.statutory_rule_id
     WHERE l.payslip_id = ${payslipId}
     ORDER BY l.line_no
  `);

  return {
    ...readPayslipRow(raw),
    lines: (lines.rows ?? []).map((row) => ({
      id: row.id,
      lineNo: row.line_no,
      kind: row.kind,
      code: row.code,
      description: row.description,
      basis: row.basis,
      quantity: row.quantity,
      rate: row.rate,
      amount: parseAmount(row.amount),
      accountCode: row.account_code,
      contraAccountCode: row.contra_account_code,
      statutoryRuleId: row.statutory_rule_id,
      statutorySource: row.source_ref,
    })),
  };
}

/**
 * The statutory contribution summary for a period, per agency.
 *
 * What goes on the EPF, SOCSO, EIS and PCB returns. Drawn from finalised runs only:
 * a draft run's figures are not yet anybody's statement.
 */
export interface StatutorySummary {
  kind: StatutoryKind;
  label: string;
  employeeTotal: Amount;
  employerTotal: Amount;
  employeeCount: number;
  /** The rule versions that produced these, so the return can cite them. */
  sources: string[];
}

export async function statutorySummary(
  db: Executor,
  range: { from: string; to: string },
): Promise<StatutorySummary[]> {
  const from = toIsoDate(parseIsoDate(range.from, "from"));
  const to = toIsoDate(parseIsoDate(range.to, "to"));

  const result = await db.execute<{
    code: string;
    kind: string;
    total: string;
    people: number;
    sources: string[] | string | null;
  }>(sql`
    SELECT l.code, l.kind, SUM(l.amount)::text AS total,
           count(DISTINCT p.employee_id)::int AS people,
           array_agg(DISTINCT s.source_ref) AS sources
      FROM hr.payslip_line l
      JOIN hr.payslip p ON p.id = l.payslip_id
      JOIN hr.payroll_run r ON r.id = p.run_id
      LEFT JOIN hr.statutory_rule_version s ON s.id = l.statutory_rule_id
     WHERE r.status IN ('finalised', 'posted')
       AND r.pay_date BETWEEN ${from}::date AND ${to}::date
       AND l.code IN ('EPF', 'EPF-ER', 'SOCSO', 'SOCSO-ER', 'EIS', 'EIS-ER', 'PCB')
     GROUP BY l.code, l.kind
  `);

  const byKind = new Map<StatutoryKind, StatutorySummary>();
  const kindOf: Record<string, StatutoryKind> = {
    EPF: "epf_employee",
    "EPF-ER": "epf_employer",
    SOCSO: "socso",
    "SOCSO-ER": "socso",
    EIS: "eis",
    "EIS-ER": "eis",
    PCB: "pcb",
  };

  for (const row of result.rows ?? []) {
    const kind = kindOf[row.code];
    if (!kind) continue;

    const existing = byKind.get(kind) ?? {
      kind,
      label: STATUTORY_LABELS[kind],
      employeeTotal: 0n,
      employerTotal: 0n,
      employeeCount: 0,
      sources: [] as string[],
    };

    const amount = parseAmount(row.total);
    if (row.kind === "deduction") existing.employeeTotal += amount;
    else existing.employerTotal += amount;

    existing.employeeCount = Math.max(existing.employeeCount, row.people);

    const sources = Array.isArray(row.sources)
      ? row.sources
      : typeof row.sources === "string"
        ? row.sources.replace(/[{}"]/g, "").split(",")
        : [];
    for (const source of sources) {
      if (source && source !== "NULL" && !existing.sources.includes(source)) {
        existing.sources.push(source);
      }
    }

    byKind.set(kind, existing);
  }

  return [...byKind.values()];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface LockedRun extends Record<string, unknown> {
  id: string;
  run_no: string | null;
  period_from: string;
  period_to: string;
  pay_date: string;
  kind: string;
  corrects_run_id: string | null;
  status: RunStatus;
  prepared_by: string | null;
  journal_id: string | null;
  net_total: string;
  employee_count: number;
}

async function lockRun(db: Executor, runId: string): Promise<LockedRun> {
  const result = await db.execute<LockedRun>(sql`
    SELECT id, run_no, period_from, period_to, pay_date, kind, corrects_run_id, status,
           prepared_by, journal_id, net_total, employee_count
      FROM hr.payroll_run WHERE id = ${runId} FOR UPDATE
  `);
  const row = result.rows?.[0];
  if (!row) throw new NotFoundError("That payroll run no longer exists.");
  return row;
}
