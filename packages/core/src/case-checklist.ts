import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, toIsoDate, today } from "./dates.js";
import {
  recordCaseEvent,
  requireCaseAccess,
  requireWritableCase,
  keep,
  optionalText,
  text,
} from "./cases.js";
import {
  evaluateCondition,
  loadCaseFacts,
  rulesInForce,
  type RequirementKind,
  type RequirementRule,
} from "./case-rules.js";

/**
 * The checklist, and the work that comes off it.
 *
 * A checklist here is **derived, snapshotted and never silently shortened.** Those three
 * words carry the whole design:
 *
 * *Derived* — it is computed from the case's facts against the approved rules, so two
 * probate matters with different facts get different lists. It is not a fixed list per
 * case type, which would be wrong for most matters and only look right.
 *
 * *Snapshotted* — each item keeps the code, version, title and authority of the rule
 * that produced it. A rule revised next year does not rewrite the list somebody worked
 * from last March.
 *
 * *Never silently shortened* — recomputation does not delete. An item that no longer
 * applies is marked `not_applicable` with the reason it fell away; an item already
 * satisfied is left entirely alone. And an item whose rule depends on a fact nobody
 * has answered *stays on the list*, flagged with the missing question, rather than
 * vanishing. A short checklist must mean "little is required", never "we forgot to
 * ask".
 *
 * When no rules have been approved, the checklist is empty and says so. That is the
 * honest state while Q-LEGAL-1 and Q-LEGAL-2 are open: this platform will not supply
 * Malaysian probate requirements from general knowledge.
 */

export type RequirementStatus =
  | "outstanding"
  | "in_progress"
  | "satisfied"
  | "waived"
  | "not_applicable";

export interface CaseRequirementView {
  id: string;
  ruleId: string | null;
  ruleCode: string | null;
  ruleVersion: number | null;
  title: string;
  detail: string | null;
  kind: RequirementKind;
  sourceRef: string | null;
  status: RequirementStatus;
  /** Questions the rule needed and did not have. Empty when the rule decided. */
  undecidedFacts: string[];
  documentId: string | null;
  documentTitle: string | null;
  satisfiedAt: string | null;
  satisfiedByName: string | null;
  waiveReason: string | null;
  waivedAt: string | null;
  waivedByName: string | null;
  droppedReason: string | null;
  dueOn: string | null;
  sortOrder: number;
  generatedAt: string;
  /** False for an item somebody typed in rather than one a rule produced. */
  fromRule: boolean;
}

export interface ChecklistReport {
  /** Approved rules that could apply to this matter at all. Zero is the Q-LEGAL state. */
  rulesConsidered: number;
  added: string[];
  reopened: string[];
  droppedNowIrrelevant: string[];
  /** Items carrying unanswered questions, with the questions. */
  undecided: { title: string; facts: string[] }[];
  unchanged: number;
  /** Items left alone because they are already satisfied or waived. */
  settled: number;
}

// ---------------------------------------------------------------------------
// Recomputation
// ---------------------------------------------------------------------------

/**
 * Rebuilds the checklist from the facts.
 *
 * Idempotent: running it twice with the same facts changes nothing the second time,
 * which is what makes it safe to call after every intake answer.
 */
export async function recomputeChecklist(
  db: Executor,
  principal: Principal,
  caseId: string,
  context?: AuditContext,
): Promise<ChecklistReport> {
  requireCapability(principal, "case.checklist.manage");
  const record = await requireWritableCase(db, principal, caseId);

  const facts = await loadCaseFacts(db, caseId);
  const rules = await rulesInForce(db, record.matterType, toIsoDate(today()));

  const existing = await db.execute<{
    id: string;
    rule_id: string | null;
    status: string;
    title: string;
    undecided_facts: unknown;
  }>(sql`
    SELECT id, rule_id, status, title, undecided_facts
      FROM estate.case_requirement WHERE case_id = ${caseId}
  `);
  const byRule = new Map<string, { id: string; status: string; title: string; undecided: string[] }>();
  for (const row of existing.rows ?? []) {
    if (!row.rule_id) continue;
    byRule.set(row.rule_id, {
      id: row.id,
      status: row.status,
      title: row.title,
      undecided: readTextArray(row.undecided_facts),
    });
  }

  const report: ChecklistReport = {
    rulesConsidered: rules.length,
    added: [],
    reopened: [],
    droppedNowIrrelevant: [],
    undecided: [],
    unchanged: 0,
    settled: 0,
  };

  const seenRuleIds = new Set<string>();

  for (const rule of rules) {
    seenRuleIds.add(rule.id);
    const verdict = evaluateCondition(rule.appliesWhen, facts);
    const current = byRule.get(rule.id);

    // Decided not to apply: drop it if it is still open, leave it if somebody has
    // already dealt with it. Removing a satisfied item would erase work.
    if (verdict.decided && !verdict.applies) {
      if (!current) continue;
      if (current.status === "satisfied" || current.status === "waived") {
        report.settled += 1;
        continue;
      }
      if (current.status !== "not_applicable") {
        await db.execute(sql`
          UPDATE estate.case_requirement
             SET status = 'not_applicable',
                 dropped_reason = ${"No longer applies on the facts recorded."},
                 undecided_facts = '{}'::text[],
                 generated_at = now(), updated_by = ${principal.userId}
           WHERE id = ${current.id}
        `);
        report.droppedNowIrrelevant.push(current.title);
      } else {
        report.unchanged += 1;
      }
      continue;
    }

    // Applies, or cannot be ruled out. Either way the item belongs on the list.
    const undecided = verdict.decided ? [] : verdict.missing;
    if (!verdict.decided) {
      report.undecided.push({ title: rule.title, facts: undecided });
    }

    if (!current) {
      await db.execute(sql`
        INSERT INTO estate.case_requirement
          (case_id, rule_id, rule_code, rule_version, title, detail, kind, source_ref,
           status, undecided_facts, created_by)
        VALUES
          (${caseId}, ${rule.id}, ${rule.code}, ${rule.version}, ${rule.title},
           ${rule.detail}, ${rule.kind}, ${rule.sourceRef}, 'outstanding',
           ${toSqlTextArray(undecided)}::text[], ${principal.userId})
      `);
      report.added.push(rule.title);
      continue;
    }

    if (current.status === "satisfied" || current.status === "waived") {
      report.settled += 1;
      continue;
    }

    if (current.status === "not_applicable") {
      await db.execute(sql`
        UPDATE estate.case_requirement
           SET status = 'outstanding', dropped_reason = NULL,
               undecided_facts = ${toSqlTextArray(undecided)}::text[],
               generated_at = now(), updated_by = ${principal.userId}
         WHERE id = ${current.id}
      `);
      report.reopened.push(current.title);
      continue;
    }

    // Open already: only the missing-facts flag can have moved.
    if (!sameList(current.undecided, undecided)) {
      await db.execute(sql`
        UPDATE estate.case_requirement
           SET undecided_facts = ${toSqlTextArray(undecided)}::text[],
               generated_at = now(), updated_by = ${principal.userId}
         WHERE id = ${current.id}
      `);
    }
    report.unchanged += 1;
  }

  // Items from rules that are no longer in force — withdrawn, superseded, or out of
  // their effective window. The item is not deleted; it says why it fell away.
  for (const [ruleId, item] of byRule) {
    if (seenRuleIds.has(ruleId)) continue;
    if (item.status === "satisfied" || item.status === "waived") {
      report.settled += 1;
      continue;
    }
    if (item.status === "not_applicable") continue;
    await db.execute(sql`
      UPDATE estate.case_requirement
         SET status = 'not_applicable',
             dropped_reason = ${"The rule it came from is no longer in force."},
             undecided_facts = '{}'::text[],
             generated_at = now(), updated_by = ${principal.userId}
       WHERE id = ${item.id}
    `);
    report.droppedNowIrrelevant.push(item.title);
  }

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_CHECKLIST_GENERATED,
    entityType: "estate.case",
    entityId: caseId,
    newValues: {
      caseNo: record.caseNo,
      rulesConsidered: report.rulesConsidered,
      added: report.added.length,
      reopened: report.reopened.length,
      dropped: report.droppedNowIrrelevant.length,
      undecided: report.undecided.length,
    },
  });

  if (report.added.length > 0 || report.droppedNowIrrelevant.length > 0 || report.reopened.length > 0) {
    await recordCaseEvent(db, {
      caseId,
      kind: "checklist",
      summary:
        `Checklist rebuilt from the facts: ${report.added.length} added, ` +
        `${report.reopened.length} reinstated, ${report.droppedNowIrrelevant.length} no longer applicable.`,
      origin: "system",
      actorUserId: principal.userId,
      actorLabel: principal.fullName,
    });
  }

  return report;
}

/**
 * What a recomputation *would* do, without doing it.
 *
 * Worth having separately: somebody about to answer a batch of intake questions can
 * see the effect before it lands, and a reviewer can check a rule change against a
 * live matter without touching it.
 */
export async function previewChecklist(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<
  {
    rule: RequirementRule;
    verdict: "applies" | "does not apply" | "undecided";
    missing: string[];
    alreadyOnList: boolean;
  }[]
> {
  const record = await requireCaseAccess(db, principal, caseId);
  const facts = await loadCaseFacts(db, caseId);
  const rules = await rulesInForce(db, record.matterType, toIsoDate(today()));

  const existing = await db.execute<{ rule_id: string | null }>(
    sql`SELECT rule_id FROM estate.case_requirement WHERE case_id = ${caseId}`,
  );
  const onList = new Set((existing.rows ?? []).map((row) => String(row.rule_id)));

  return rules.map((rule) => {
    const verdict = evaluateCondition(rule.appliesWhen, facts);
    return {
      rule,
      verdict: verdict.decided ? (verdict.applies ? "applies" : "does not apply") : "undecided",
      missing: verdict.decided ? [] : verdict.missing,
      alreadyOnList: onList.has(rule.id),
    };
  });
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function listRequirements(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<CaseRequirementView[]> {
  await requireCaseAccess(db, principal, caseId);

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT r.*, d.title AS document_title,
           sat.full_name AS satisfied_by_name, wav.full_name AS waived_by_name
      FROM estate.case_requirement r
      LEFT JOIN estate.case_document d ON d.id = r.document_id
      LEFT JOIN auth."user" sat ON sat.id = r.satisfied_by
      LEFT JOIN auth."user" wav ON wav.id = r.waived_by
     WHERE r.case_id = ${caseId}
     ORDER BY CASE r.status
                WHEN 'outstanding' THEN 0 WHEN 'in_progress' THEN 1
                WHEN 'satisfied' THEN 2 WHEN 'waived' THEN 3 ELSE 4 END,
              r.sort_order, r.title
  `);

  return (result.rows ?? []).map((row) => ({
    id: String(row.id),
    ruleId: (row.rule_id as string) ?? null,
    ruleCode: (row.rule_code as string) ?? null,
    ruleVersion: row.rule_version === null ? null : Number(row.rule_version),
    title: String(row.title),
    detail: (row.detail as string) ?? null,
    kind: row.kind as RequirementKind,
    sourceRef: (row.source_ref as string) ?? null,
    status: row.status as RequirementStatus,
    undecidedFacts: readTextArray(row.undecided_facts),
    documentId: (row.document_id as string) ?? null,
    documentTitle: (row.document_title as string) ?? null,
    satisfiedAt: row.satisfied_at ? new Date(String(row.satisfied_at)).toISOString() : null,
    satisfiedByName: (row.satisfied_by_name as string) ?? null,
    waiveReason: (row.waive_reason as string) ?? null,
    waivedAt: row.waived_at ? new Date(String(row.waived_at)).toISOString() : null,
    waivedByName: (row.waived_by_name as string) ?? null,
    droppedReason: (row.dropped_reason as string) ?? null,
    dueOn: row.due_on ? String(row.due_on).slice(0, 10) : null,
    sortOrder: Number(row.sort_order),
    generatedAt: new Date(String(row.generated_at)).toISOString(),
    fromRule: row.rule_id !== null,
  }));
}

/**
 * Adds an item by hand.
 *
 * Legitimate and necessary — a matter throws up work no rule anticipated — and
 * visibly different from a rule-produced item: no code, no version, and `sourceRef`
 * is whatever the person writing it can point at. What it must never become is the
 * back door through which a legal requirement enters the platform unreviewed, so it
 * carries no authority of its own and the screen says so.
 */
export async function addRequirement(
  db: Executor,
  principal: Principal,
  input: {
    caseId: string;
    title: string;
    detail?: string | null;
    kind: RequirementKind;
    sourceRef?: string | null;
    dueOn?: string | null;
    sortOrder?: number;
  },
  context?: AuditContext,
): Promise<string> {
  requireCapability(principal, "case.checklist.manage");
  const record = await requireWritableCase(db, principal, input.caseId);

  const title = input.title.trim();
  if (!title) throw new ValidationError("The item needs a title.", "title");
  if (input.dueOn) parseIsoDate(input.dueOn);

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO estate.case_requirement
      (case_id, title, detail, kind, source_ref, due_on, sort_order, created_by)
    VALUES
      (${input.caseId}, ${title}, ${input.detail?.trim() || null}, ${input.kind},
       ${input.sourceRef?.trim() || null}, ${input.dueOn ?? null},
       ${input.sortOrder ?? 100}, ${principal.userId})
    RETURNING id
  `);
  const id = inserted.rows![0].id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_REQUIREMENT_ADDED,
    entityType: "estate.case_requirement",
    entityId: id,
    newValues: { caseNo: record.caseNo, kind: input.kind, fromRule: false },
  });

  return id;
}

/**
 * Marks an item satisfied, waived, in progress, or back to outstanding.
 *
 * A `document` requirement cannot be satisfied without naming the document that
 * satisfies it — the database enforces that too, because a checklist that reads as
 * complete with nothing behind it is the single most misleading thing this module
 * could produce. Waiving is the honest alternative and takes a reason.
 */
export async function setRequirementStatus(
  db: Executor,
  principal: Principal,
  params: {
    requirementId: string;
    status: RequirementStatus;
    documentId?: string | null;
    reason?: string | null;
  },
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.checklist.manage");

  const current = await db.execute<{
    case_id: string;
    status: string;
    kind: string;
    title: string;
  }>(sql`
    SELECT case_id, status, kind, title FROM estate.case_requirement
     WHERE id = ${params.requirementId}
  `);
  const item = current.rows?.[0];
  if (!item) throw new NotFoundError("That checklist item no longer exists.");
  const record = await requireWritableCase(db, principal, item.case_id);

  if (params.status === "not_applicable") {
    throw new ConflictError(
      "Items fall away by recomputation, from the facts — not by hand. If it genuinely does not apply, waive it with the reason, or correct the facts and rebuild the checklist.",
    );
  }

  if (params.status === "satisfied") {
    if (item.kind === "document" && !params.documentId) {
      throw new ValidationError(
        "Name the document that satisfies this. If there is no document, waive the item with a reason instead.",
        "documentId",
      );
    }
    if (params.documentId) {
      const document = await db.execute<{ case_id: string }>(
        sql`SELECT case_id FROM estate.case_document WHERE id = ${params.documentId}`,
      );
      const owner = document.rows?.[0];
      if (!owner) throw new NotFoundError("That document is not on the register.");
      if (owner.case_id !== item.case_id) {
        throw new ConflictError("That document is filed under a different case.");
      }
    }
  }

  if (params.status === "waived" && !params.reason?.trim()) {
    throw new ValidationError(
      "Say why the requirement is being waived. This is the note somebody reads when they ask why it was not done.",
      "reason",
    );
  }

  const satisfied = params.status === "satisfied";
  const waived = params.status === "waived";

  await db.execute(sql`
    UPDATE estate.case_requirement
       SET status = ${params.status},
           document_id = ${satisfied ? (params.documentId ?? null) : null},
           satisfied_at = ${satisfied ? sql`now()` : sql`NULL`},
           satisfied_by = ${satisfied ? principal.userId : null},
           waived_at = ${waived ? sql`now()` : sql`NULL`},
           waived_by = ${waived ? principal.userId : null},
           waive_reason = ${waived ? params.reason!.trim() : null},
           dropped_reason = NULL,
           updated_by = ${principal.userId}
     WHERE id = ${params.requirementId}
  `);

  const action = satisfied
    ? AUDIT.CASE_REQUIREMENT_SATISFIED
    : waived
      ? AUDIT.CASE_REQUIREMENT_WAIVED
      : AUDIT.CASE_REQUIREMENT_REOPENED;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action,
    entityType: "estate.case_requirement",
    entityId: params.requirementId,
    newValues: { caseNo: record.caseNo, status: params.status },
    reason: params.reason?.trim() || null,
  });

  if (satisfied || waived) {
    await recordCaseEvent(db, {
      caseId: item.case_id,
      kind: "checklist",
      summary: satisfied
        ? `Requirement satisfied: ${item.title}.`
        : `Requirement waived: ${item.title}. ${params.reason!.trim()}`,
      origin: "system",
      actorUserId: principal.userId,
      actorLabel: principal.fullName,
    });
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";

export interface CaseTaskView {
  id: string;
  caseId: string;
  caseNo: string;
  requirementId: string | null;
  requirementTitle: string | null;
  title: string;
  detail: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  dueOn: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  status: TaskStatus;
  blockedReason: string | null;
  completedAt: string | null;
  completedByName: string | null;
  cancelReason: string | null;
  /** Open and past its date. Computed here so a screen does not recompute per row. */
  overdue: boolean;
}

export interface CaseTaskInput {
  caseId: string;
  title: string;
  detail?: string | null;
  requirementId?: string | null;
  assigneeId?: string | null;
  dueOn?: string | null;
  priority?: CaseTaskView["priority"];
}

export async function createTask(
  db: Executor,
  principal: Principal,
  input: CaseTaskInput,
  context?: AuditContext,
): Promise<string> {
  requireCapability(principal, "case.task.manage");
  const record = await requireWritableCase(db, principal, input.caseId);

  const title = input.title.trim();
  if (!title) throw new ValidationError("The task needs a title.", "title");
  if (input.dueOn) parseIsoDate(input.dueOn);

  if (input.assigneeId) {
    const employee = await db.execute<{ status: string; full_name: string }>(
      sql`SELECT status, full_name FROM hr.employee WHERE id = ${input.assigneeId}`,
    );
    const person = employee.rows?.[0];
    if (!person) throw new NotFoundError("That employee does not exist.");
    if (person.status !== "active") {
      throw new ConflictError(`${person.full_name} is not an active employee.`);
    }
  }

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO estate.case_task
      (case_id, requirement_id, title, detail, assignee_id, due_on, priority, created_by)
    VALUES
      (${input.caseId}, ${input.requirementId ?? null}, ${title},
       ${input.detail?.trim() || null}, ${input.assigneeId ?? null}, ${input.dueOn ?? null},
       ${input.priority ?? "normal"}, ${principal.userId})
    RETURNING id
  `);
  const id = inserted.rows![0].id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_TASK_CREATED,
    entityType: "estate.case_task",
    entityId: id,
    newValues: {
      caseNo: record.caseNo,
      priority: input.priority ?? "normal",
      assigned: Boolean(input.assigneeId),
      dueOn: input.dueOn ?? null,
    },
  });

  return id;
}

export async function updateTask(
  db: Executor,
  principal: Principal,
  taskId: string,
  input: Partial<Omit<CaseTaskInput, "caseId">> & {
    status?: Extract<TaskStatus, "open" | "in_progress" | "blocked">;
    blockedReason?: string | null;
  },
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.task.manage");

  const current = await db.execute<{ case_id: string; status: string; blocked_reason: string | null }>(
    sql`SELECT case_id, status, blocked_reason FROM estate.case_task WHERE id = ${taskId}`,
  );
  const existing = current.rows?.[0];
  if (!existing) throw new NotFoundError("That task no longer exists.");
  const record = await requireWritableCase(db, principal, existing.case_id);

  if (existing.status === "done" || existing.status === "cancelled") {
    throw new ConflictError(`That task is already ${existing.status}.`);
  }
  if (input.dueOn) parseIsoDate(input.dueOn);

  const status = input.status ?? (existing.status as TaskStatus);
  const blockedReason =
    input.blockedReason !== undefined
      ? input.blockedReason?.trim() || null
      : existing.blocked_reason;
  if (status === "blocked" && !blockedReason) {
    throw new ValidationError("Say what it is blocked on.", "blockedReason");
  }

  await db.execute(sql`
    UPDATE estate.case_task
       SET title = ${text(input.title, "title")},
           detail = ${optionalText(input.detail, "detail")},
           requirement_id = ${keep(input.requirementId, "requirement_id")},
           assignee_id = ${keep(input.assigneeId, "assignee_id")},
           due_on = ${keep(input.dueOn, "due_on")},
           priority = ${keep(input.priority, "priority")},
           status = ${status},
           blocked_reason = ${status === "blocked" ? blockedReason : null},
           updated_by = ${principal.userId}
     WHERE id = ${taskId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_TASK_UPDATED,
    entityType: "estate.case_task",
    entityId: taskId,
    newValues: { caseNo: record.caseNo, fields: Object.keys(input).sort(), status },
  });
}

/**
 * Finishes a task.
 *
 * `case.task.manage` or being the assignee. Somebody doing the work should be able to
 * say it is done without needing the capability to reassign other people's work.
 */
export async function completeTask(
  db: Executor,
  principal: Principal,
  taskId: string,
  context?: AuditContext,
): Promise<void> {
  const current = await db.execute<{
    case_id: string;
    status: string;
    assignee_id: string | null;
    title: string;
  }>(sql`
    SELECT case_id, status, assignee_id, title FROM estate.case_task WHERE id = ${taskId}
  `);
  const task = current.rows?.[0];
  if (!task) throw new NotFoundError("That task no longer exists.");

  const isAssignee = Boolean(principal.employeeId) && principal.employeeId === task.assignee_id;
  if (!isAssignee) requireCapability(principal, "case.task.manage");

  const record = await requireWritableCase(db, principal, task.case_id);

  if (task.status === "done") return;
  if (task.status === "cancelled") {
    throw new ConflictError("That task was cancelled. Create a new one if it is needed after all.");
  }

  await db.execute(sql`
    UPDATE estate.case_task
       SET status = 'done', completed_at = now(), completed_by = ${principal.userId},
           blocked_reason = NULL, updated_by = ${principal.userId}
     WHERE id = ${taskId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_TASK_COMPLETED,
    entityType: "estate.case_task",
    entityId: taskId,
    newValues: { caseNo: record.caseNo },
  });

  await recordCaseEvent(db, {
    caseId: task.case_id,
    kind: "task",
    summary: `Task completed: ${task.title}.`,
    origin: "system",
    actorUserId: principal.userId,
    actorLabel: principal.fullName,
  });
}

export async function cancelTask(
  db: Executor,
  principal: Principal,
  taskId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.task.manage");

  const current = await db.execute<{ case_id: string; status: string; title: string }>(
    sql`SELECT case_id, status, title FROM estate.case_task WHERE id = ${taskId}`,
  );
  const task = current.rows?.[0];
  if (!task) throw new NotFoundError("That task no longer exists.");
  const record = await requireWritableCase(db, principal, task.case_id);

  if (task.status === "done") {
    throw new ConflictError("That task is finished; it cannot be cancelled.");
  }
  const why = reason.trim();
  if (!why) throw new ValidationError("Say why it is being cancelled.", "reason");

  await db.execute(sql`
    UPDATE estate.case_task
       SET status = 'cancelled', cancel_reason = ${why}, blocked_reason = NULL,
           updated_by = ${principal.userId}
     WHERE id = ${taskId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_TASK_CANCELLED,
    entityType: "estate.case_task",
    entityId: taskId,
    newValues: { caseNo: record.caseNo },
    reason: why,
  });
}

export async function listTasks(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<CaseTaskView[]> {
  requireCapability(principal, "case.task.view");
  await requireCaseAccess(db, principal, caseId);

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT t.*, c.case_no, e.full_name AS assignee_name, u.full_name AS completed_by_name,
           r.title AS requirement_title,
           (t.status IN ('open', 'in_progress', 'blocked')
            AND t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE) AS overdue
      FROM estate.case_task t
      JOIN estate.case c ON c.id = t.case_id
      LEFT JOIN hr.employee e ON e.id = t.assignee_id
      LEFT JOIN auth."user" u ON u.id = t.completed_by
      LEFT JOIN estate.case_requirement r ON r.id = t.requirement_id
     WHERE t.case_id = ${caseId}
     ORDER BY CASE t.status
                WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'open' THEN 2 ELSE 3 END,
              t.due_on NULLS LAST, t.created_at
  `);

  return (result.rows ?? []).map(toTaskView);
}

/**
 * The signed-in person's own case work, across every matter they are on.
 *
 * Scoped by `caseAccessClause` through the join, so it cannot show work on a matter
 * they are not assigned to even if a task somehow names them.
 */
export async function myCaseTasks(
  db: Executor,
  principal: Principal,
  limit = 100,
): Promise<CaseTaskView[]> {
  if (!principal.employeeId) return [];
  requireCapability(principal, "case.task.view");

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT t.*, c.case_no, e.full_name AS assignee_name, u.full_name AS completed_by_name,
           r.title AS requirement_title,
           (t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE) AS overdue
      FROM estate.case_task t
      JOIN estate.case c ON c.id = t.case_id
      LEFT JOIN hr.employee e ON e.id = t.assignee_id
      LEFT JOIN auth."user" u ON u.id = t.completed_by
      LEFT JOIN estate.case_requirement r ON r.id = t.requirement_id
     WHERE t.assignee_id = ${principal.employeeId}
       AND t.status IN ('open', 'in_progress', 'blocked')
       AND c.status IN ('intake', 'open', 'on_hold')
       AND EXISTS (
         SELECT 1 FROM estate.case_assignment a
          WHERE a.case_id = c.id AND a.employee_id = ${principal.employeeId}
            AND a.removed_at IS NULL
       )
     ORDER BY t.due_on NULLS LAST,
              CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END
     LIMIT ${limit}
  `);

  return (result.rows ?? []).map(toTaskView);
}

function toTaskView(row: Record<string, unknown>): CaseTaskView {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    caseNo: String(row.case_no),
    requirementId: (row.requirement_id as string) ?? null,
    requirementTitle: (row.requirement_title as string) ?? null,
    title: String(row.title),
    detail: (row.detail as string) ?? null,
    assigneeId: (row.assignee_id as string) ?? null,
    assigneeName: (row.assignee_name as string) ?? null,
    dueOn: row.due_on ? String(row.due_on).slice(0, 10) : null,
    priority: row.priority as CaseTaskView["priority"],
    status: row.status as TaskStatus,
    blockedReason: (row.blocked_reason as string) ?? null,
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null,
    completedByName: (row.completed_by_name as string) ?? null,
    cancelReason: (row.cancel_reason as string) ?? null,
    overdue: row.overdue === true,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** PGlite and node-postgres disagree about text[]: one returns an array, one a literal. */
function readTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    const inner = value.replace(/^\{|\}$/g, "");
    if (inner === "") return [];
    return inner.split(",").map((entry) => entry.replace(/^"|"$/g, ""));
  }
  return [];
}

function toSqlTextArray(values: string[]): string {
  return `{${values.map((value) => `"${value.replace(/"/g, '\\"')}"`).join(",")}}`;
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}
