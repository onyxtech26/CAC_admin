import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, toIsoDate } from "./dates.js";

/**
 * Appraisals.
 *
 * The template is data, not code. CAC has not supplied the form it uses, and
 * inventing a competency framework would be inventing how the firm judges its staff
 * — which is a management decision, not an engineering one. So a cycle carries its
 * own template: sections, questions, and a rating scale. The application validates
 * an appraisal against the template of its cycle, so a round run last year with a
 * different form still reads correctly.
 *
 * The one thing enforced regardless of the template: **an acknowledged appraisal does
 * not change.** Editing a review after the person has read and accepted it is the
 * single act that would make the whole record worthless, and a trigger refuses it.
 */

export type AppraisalStatus = "draft" | "self_assessed" | "reviewed" | "acknowledged";
export type CycleStatus = "draft" | "open" | "closed";

export interface AppraisalTemplate {
  /** The rating scale, e.g. 1–5 with labels. Null where the form is comment-only. */
  scale?: { min: number; max: number; labels?: Record<string, string> } | null;
  sections: Array<{
    key: string;
    title: string;
    /** Whether the section is rated, commented, or both. */
    questions: Array<{ key: string; prompt: string; rated?: boolean; comment?: boolean }>;
  }>;
}

export interface CycleInput {
  code: string;
  name: string;
  periodFrom: string;
  periodTo: string;
  template?: AppraisalTemplate | null;
  opensOn?: string | null;
  dueOn?: string | null;
  notes?: string | null;
}

export interface CycleView {
  id: string;
  code: string;
  name: string;
  periodFrom: string;
  periodTo: string;
  status: CycleStatus;
  template: AppraisalTemplate | null;
  opensOn: string | null;
  dueOn: string | null;
  notes: string | null;
  appraisalCount: number;
  acknowledgedCount: number;
}

/**
 * Validates a template's shape.
 *
 * Not its content — what CAC asks about its staff is CAC's business. What is checked
 * is that the shape can be filled in and read back: unique keys, a scale that has a
 * range, and at least one question. A template with two sections sharing a key would
 * silently overwrite one set of answers with the other.
 */
export function validateTemplate(template: AppraisalTemplate): void {
  if (!Array.isArray(template.sections) || template.sections.length === 0) {
    throw new ValidationError("The form needs at least one section.", "template");
  }

  const sectionKeys = new Set<string>();
  for (const section of template.sections) {
    if (!section.key?.trim()) throw new ValidationError("Every section needs a key.", "template");
    if (sectionKeys.has(section.key)) {
      throw new ValidationError(
        `Two sections share the key "${section.key}", which would overwrite one set of answers ` +
          "with the other.",
        "template",
      );
    }
    sectionKeys.add(section.key);

    if (!Array.isArray(section.questions) || section.questions.length === 0) {
      throw new ValidationError(`Section "${section.title}" has no questions.`, "template");
    }

    const questionKeys = new Set<string>();
    for (const question of section.questions) {
      if (!question.key?.trim()) throw new ValidationError("Every question needs a key.", "template");
      if (questionKeys.has(question.key)) {
        throw new ValidationError(
          `Section "${section.title}" has two questions keyed "${question.key}".`,
          "template",
        );
      }
      questionKeys.add(question.key);

      if (question.rated && !template.scale) {
        throw new ValidationError(
          `"${question.prompt}" is to be rated, but the form has no rating scale.`,
          "template",
        );
      }
    }
  }

  if (template.scale) {
    const { min, max } = template.scale;
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      throw new ValidationError("The rating scale needs a range, lowest to highest.", "template");
    }
  }
}

export async function saveCycle(
  db: Executor,
  principal: Principal,
  input: CycleInput & { cycleId?: string },
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "hr.appraisal.manage");

  const code = requireText(input.code, "Give the cycle a short code.", "code").toUpperCase();
  const name = requireText(input.name, "Name the cycle.", "name");
  const periodFrom = toIsoDate(parseIsoDate(input.periodFrom, "periodFrom"));
  const periodTo = toIsoDate(parseIsoDate(input.periodTo, "periodTo"));
  if (periodTo < periodFrom) {
    throw new ValidationError("The period ends before it begins.", "periodTo");
  }

  if (input.template) validateTemplate(input.template);

  if (input.cycleId) {
    const before = await db.execute<{ status: CycleStatus }>(
      sql`SELECT status FROM hr.appraisal_cycle WHERE id = ${input.cycleId}`,
    );
    const current = before.rows?.[0];
    if (!current) throw new NotFoundError("That cycle no longer exists.");

    // Once appraisals exist against a cycle, changing the form changes what those
    // answers were answers to.
    if (current.status !== "draft" && input.template) {
      const used = await db.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM hr.appraisal WHERE cycle_id = ${input.cycleId} AND status <> 'draft'`,
      );
      if ((used.rows?.[0]?.count ?? 0) > 0) {
        throw new ConflictError(
          "People have already answered this form. Changing it now would leave their answers " +
            "attached to questions that are no longer there — close this cycle and open another.",
        );
      }
    }

    await db.execute(sql`
      UPDATE hr.appraisal_cycle SET
        name = ${name}, period_from = ${periodFrom}, period_to = ${periodTo},
        template = ${input.template ? JSON.stringify(input.template) : null}::jsonb,
        opens_on = ${input.opensOn ?? null}, due_on = ${input.dueOn ?? null},
        notes = ${input.notes?.trim() || null}, updated_by = ${principal.userId}
      WHERE id = ${input.cycleId}
    `);

    await writeAudit(db, {
      ...context,
      actorUserId: principal.userId,
      actorLabel: principal.email,
      action: AUDIT.APPRAISAL_CYCLE_SAVED,
      entityType: "appraisal_cycle",
      entityId: input.cycleId,
      newValues: { name, periodFrom, periodTo },
    });

    return { id: input.cycleId };
  }

  const existing = await db.execute<{ id: string }>(
    sql`SELECT id FROM hr.appraisal_cycle WHERE code = ${code}`,
  );
  if (existing.rows?.[0]) throw new ConflictError("There is already a cycle with that code.");

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.appraisal_cycle
      (code, name, period_from, period_to, template, opens_on, due_on, notes, created_by)
    VALUES (${code}, ${name}, ${periodFrom}, ${periodTo},
            ${input.template ? JSON.stringify(input.template) : null}::jsonb,
            ${input.opensOn ?? null}, ${input.dueOn ?? null},
            ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.APPRAISAL_CYCLE_SAVED,
    entityType: "appraisal_cycle",
    entityId: id,
    newValues: { code, name, periodFrom, periodTo },
  });

  return { id };
}

/**
 * Opens a cycle and creates an appraisal per person.
 *
 * The reviewer is the person's manager. Somebody with no manager recorded is
 * reported rather than assigned to an arbitrary reviewer — an appraisal by the wrong
 * person is worse than one nobody has started.
 */
export async function openCycle(
  db: Executor,
  principal: Principal,
  cycleId: string,
  context?: AuditContext,
): Promise<{ created: number; withoutReviewer: Array<{ employeeId: string; fullName: string }> }> {
  requireCapability(principal, "hr.appraisal.manage");

  const found = await db.execute<{ status: CycleStatus; template: unknown; name: string }>(
    sql`SELECT status, template, name FROM hr.appraisal_cycle WHERE id = ${cycleId} FOR UPDATE`,
  );
  const cycle = found.rows?.[0];
  if (!cycle) throw new NotFoundError("That cycle no longer exists.");
  if (cycle.status !== "draft") throw new ConflictError(`That cycle is already ${cycle.status}.`);
  if (!cycle.template) {
    throw new ConflictError(
      "The cycle has no form. Without one there is nothing for anybody to fill in.",
    );
  }

  const employees = await db.execute<{ id: string; full_name: string; reports_to_id: string | null }>(sql`
    SELECT id, full_name, reports_to_id FROM hr.employee
     WHERE status IN ('active', 'on_leave') ORDER BY full_name
  `);

  const withoutReviewer: Array<{ employeeId: string; fullName: string }> = [];
  let created = 0;

  for (const employee of employees.rows ?? []) {
    if (!employee.reports_to_id) {
      withoutReviewer.push({ employeeId: employee.id, fullName: employee.full_name });
      continue;
    }

    await db.execute(sql`
      INSERT INTO hr.appraisal (cycle_id, employee_id, reviewer_id, created_by)
      VALUES (${cycleId}, ${employee.id}, ${employee.reports_to_id}, ${principal.userId})
      ON CONFLICT (cycle_id, employee_id) DO NOTHING
    `);
    created += 1;
  }

  await db.execute(
    sql`UPDATE hr.appraisal_cycle SET status = 'open', updated_by = ${principal.userId} WHERE id = ${cycleId}`,
  );

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.APPRAISAL_OPENED,
    entityType: "appraisal_cycle",
    entityId: cycleId,
    newValues: { cycle: cycle.name, appraisals: created, withoutReviewer: withoutReviewer.length },
  });

  return { created, withoutReviewer };
}

export interface AppraisalView {
  id: string;
  cycleId: string;
  cycleName: string;
  cycleStatus: CycleStatus;
  template: AppraisalTemplate | null;
  employeeId: string;
  employeeName: string;
  reviewerId: string;
  reviewerName: string;
  status: AppraisalStatus;
  selfAssessment: Record<string, unknown> | null;
  review: Record<string, unknown> | null;
  overallScore: number | null;
  overallComment: string | null;
  employeeComment: string | null;
  reviewedAt: Date | string | null;
  acknowledgedAt: Date | string | null;
}

/**
 * Records the employee's own assessment.
 *
 * Only the person themselves may write it, whatever capabilities anybody else holds.
 * A self-assessment written by somebody else is not a self-assessment.
 */
export async function recordSelfAssessment(
  db: Executor,
  principal: Principal,
  appraisalId: string,
  answers: Record<string, unknown>,
  context?: AuditContext,
): Promise<void> {
  const appraisal = await lockAppraisal(db, appraisalId);

  if (appraisal.employee_id !== principal.employeeId) {
    throw new ConflictError(
      "Only the person being appraised can write their own assessment.",
    );
  }
  if (appraisal.status !== "draft") {
    throw new ConflictError(`That appraisal is already ${appraisal.status.replace(/_/g, " ")}.`);
  }

  await db.execute(sql`
    UPDATE hr.appraisal
       SET self_assessment = ${JSON.stringify(answers)}::jsonb,
           status = 'self_assessed', self_assessed_at = now(), updated_by = ${principal.userId}
     WHERE id = ${appraisalId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.APPRAISAL_SELF_ASSESSED,
    entityType: "appraisal",
    entityId: appraisalId,
  });
}

/**
 * Records the reviewer's assessment.
 *
 * Only the named reviewer, or somebody who may configure cycles — the second because
 * a reviewer who leaves the firm mid-cycle would otherwise block every appraisal they
 * held.
 */
export async function recordReview(
  db: Executor,
  principal: Principal,
  appraisalId: string,
  input: { review: Record<string, unknown>; overallScore?: string | null; overallComment?: string | null },
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.appraisal.review");

  const appraisal = await lockAppraisal(db, appraisalId);

  const isReviewer = appraisal.reviewer_id === principal.employeeId;
  if (!isReviewer) {
    requireCapability(principal, "hr.appraisal.manage");
  }

  if (appraisal.status === "acknowledged") {
    throw new ConflictError(
      "The employee has acknowledged this appraisal. It is their copy now and does not change.",
    );
  }

  const score = input.overallScore?.trim();
  if (score) {
    const value = Number(score);
    if (!Number.isFinite(value)) throw new ValidationError("That is not a score.", "overallScore");

    const cycle = await db.execute<{ template: unknown }>(
      sql`SELECT template FROM hr.appraisal_cycle WHERE id = ${appraisal.cycle_id}`,
    );
    const template = cycle.rows?.[0]?.template as AppraisalTemplate | null;
    if (template?.scale) {
      if (value < template.scale.min || value > template.scale.max) {
        throw new ValidationError(
          `The scale for this cycle runs from ${template.scale.min} to ${template.scale.max}.`,
          "overallScore",
        );
      }
    }
  }

  await db.execute(sql`
    UPDATE hr.appraisal
       SET review = ${JSON.stringify(input.review)}::jsonb,
           overall_score = ${score || null},
           overall_comment = ${input.overallComment?.trim() || null},
           status = 'reviewed', reviewed_at = now(), updated_by = ${principal.userId}
     WHERE id = ${appraisalId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.APPRAISAL_REVIEWED,
    entityType: "appraisal",
    entityId: appraisalId,
    newValues: { overallScore: score || null, byNamedReviewer: isReviewer },
  });
}

/**
 * The employee accepts it, and it becomes fixed.
 *
 * Acknowledgement is not agreement — the comment field exists so somebody can accept
 * that they have read a review while saying they disagree with it, which is a
 * distinction that matters if it is ever produced in a dispute.
 */
export async function acknowledgeAppraisal(
  db: Executor,
  principal: Principal,
  appraisalId: string,
  comment: string | null,
  context?: AuditContext,
): Promise<void> {
  const appraisal = await lockAppraisal(db, appraisalId);

  if (appraisal.employee_id !== principal.employeeId) {
    throw new ConflictError("Only the person appraised can acknowledge it.");
  }
  if (appraisal.status !== "reviewed") {
    throw new ConflictError(
      appraisal.status === "acknowledged"
        ? "You have already acknowledged this."
        : "There is no completed review to acknowledge yet.",
    );
  }

  await db.execute(sql`
    UPDATE hr.appraisal
       SET status = 'acknowledged', acknowledged_at = now(),
           employee_comment = ${comment?.trim() || null}, updated_by = ${principal.userId}
     WHERE id = ${appraisalId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.APPRAISAL_ACKNOWLEDGED,
    entityType: "appraisal",
    entityId: appraisalId,
    newValues: { withComment: Boolean(comment?.trim()) },
  });
}

export async function listCycles(db: Executor): Promise<CycleView[]> {
  const result = await db.execute<{
    id: string;
    code: string;
    name: string;
    period_from: string;
    period_to: string;
    status: CycleStatus;
    template: unknown;
    opens_on: string | null;
    due_on: string | null;
    notes: string | null;
    appraisal_count: number;
    acknowledged_count: number;
  }>(sql`
    SELECT c.id, c.code, c.name, c.period_from, c.period_to, c.status, c.template,
           c.opens_on, c.due_on, c.notes,
           COALESCE(a.total, 0)::int AS appraisal_count,
           COALESCE(a.acknowledged, 0)::int AS acknowledged_count
      FROM hr.appraisal_cycle c
      LEFT JOIN LATERAL (
        SELECT count(*) AS total, count(*) FILTER (WHERE status = 'acknowledged') AS acknowledged
          FROM hr.appraisal WHERE cycle_id = c.id
      ) a ON true
     ORDER BY c.period_to DESC
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    periodFrom: String(row.period_from).slice(0, 10),
    periodTo: String(row.period_to).slice(0, 10),
    status: row.status,
    template: (row.template as AppraisalTemplate | null) ?? null,
    opensOn: row.opens_on ? String(row.opens_on).slice(0, 10) : null,
    dueOn: row.due_on ? String(row.due_on).slice(0, 10) : null,
    notes: row.notes,
    appraisalCount: row.appraisal_count,
    acknowledgedCount: row.acknowledged_count,
  }));
}

export async function listAppraisals(
  db: Executor,
  filters: { cycleId?: string; employeeId?: string; reviewerId?: string; status?: AppraisalStatus } = {},
): Promise<AppraisalView[]> {
  const where = [sql`true`];
  if (filters.cycleId) where.push(sql`a.cycle_id = ${filters.cycleId}`);
  if (filters.employeeId) where.push(sql`a.employee_id = ${filters.employeeId}`);
  if (filters.reviewerId) where.push(sql`a.reviewer_id = ${filters.reviewerId}`);
  if (filters.status) where.push(sql`a.status = ${filters.status}`);

  const result = await db.execute<Record<string, never>>(sql`
    SELECT a.id, a.cycle_id, c.name AS cycle_name, c.status AS cycle_status, c.template,
           a.employee_id, e.full_name AS employee_name,
           a.reviewer_id, r.full_name AS reviewer_name,
           a.status, a.self_assessment, a.review, a.overall_score, a.overall_comment,
           a.employee_comment, a.reviewed_at, a.acknowledged_at
      FROM hr.appraisal a
      JOIN hr.appraisal_cycle c ON c.id = a.cycle_id
      JOIN hr.employee e ON e.id = a.employee_id
      JOIN hr.employee r ON r.id = a.reviewer_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY c.period_to DESC, e.full_name
  `);

  return (result.rows ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      cycleId: String(row.cycle_id),
      cycleName: String(row.cycle_name),
      cycleStatus: row.cycle_status as CycleStatus,
      template: (row.template as AppraisalTemplate | null) ?? null,
      employeeId: String(row.employee_id),
      employeeName: String(row.employee_name),
      reviewerId: String(row.reviewer_id),
      reviewerName: String(row.reviewer_name),
      status: row.status as AppraisalStatus,
      selfAssessment: (row.self_assessment as Record<string, unknown> | null) ?? null,
      review: (row.review as Record<string, unknown> | null) ?? null,
      overallScore: row.overall_score === null ? null : Number(row.overall_score),
      overallComment: (row.overall_comment as string) ?? null,
      employeeComment: (row.employee_comment as string) ?? null,
      reviewedAt: (row.reviewed_at as Date | string) ?? null,
      acknowledgedAt: (row.acknowledged_at as Date | string) ?? null,
    };
  });
}

interface LockedAppraisal extends Record<string, unknown> {
  id: string;
  cycle_id: string;
  employee_id: string;
  reviewer_id: string;
  status: AppraisalStatus;
}

async function lockAppraisal(db: Executor, appraisalId: string): Promise<LockedAppraisal> {
  const result = await db.execute<LockedAppraisal>(sql`
    SELECT id, cycle_id, employee_id, reviewer_id, status
      FROM hr.appraisal WHERE id = ${appraisalId} FOR UPDATE
  `);
  const row = result.rows?.[0];
  if (!row) throw new NotFoundError("That appraisal no longer exists.");
  return row;
}

function requireText(value: string | null | undefined, message: string, field: string): string {
  const text = (value ?? "").trim();
  if (text === "") throw new ValidationError(message, field);
  return text;
}
