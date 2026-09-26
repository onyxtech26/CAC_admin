import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, redact, writeAudit, type AuditContext } from "./audit.js";
import {
  AuthorizationError,
  requireCapability,
  type Principal,
} from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, toIsoDate, today } from "./dates.js";
import { allocateDocumentNumber } from "./sequence.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { formatAmount, parseAmount, sumAmounts, type Amount } from "./money.js";

/**
 * Estate cases: the matter, who may see it, and what happened in it.
 *
 * Two things in this file are load-bearing.
 *
 * **Access is a join, not a filter.** `case.view` means the cases somebody is
 * assigned to; `case.view_all` means every case. An estate matter holds a family's
 * identification, their holdings and their disagreements, and there is no reason for
 * the whole firm to read one. So every read goes through `caseAccessClause`, which
 * becomes part of the SQL — changing an id in a URL produces a 404, not somebody
 * else's family.
 *
 * **Audit rows here do not carry the contents of the file.** The platform-wide rule
 * is that NRIC, bank details, salary, case contents and beneficiary information are
 * not logged. So a party's audit row says a beneficiary was recorded; it does not say
 * who, or what they are said to be entitled to. The record itself holds that, behind
 * the capability, and the timeline holds the narrative. An audit trail that quietly
 * accumulates a second copy of the case file is a second place it can leak from.
 */

export type MatterType =
  | "probate"
  | "letters_of_administration"
  | "estate_inventory"
  | "valuation"
  | "advisory"
  | "other";

export type CaseStatus = "intake" | "open" | "on_hold" | "closed" | "withdrawn";

export const MATTER_TYPES: { value: MatterType; label: string }[] = [
  { value: "probate", label: "Probate" },
  { value: "letters_of_administration", label: "Letters of administration" },
  { value: "estate_inventory", label: "Estate inventory" },
  { value: "valuation", label: "Valuation" },
  { value: "advisory", label: "Advisory" },
  { value: "other", label: "Other" },
];

export interface CaseSummary {
  id: string;
  caseNo: string;
  matterType: MatterType;
  title: string;
  status: CaseStatus;
  deceasedName: string;
  deceasedIdLast4: string | null;
  dateOfDeath: string | null;
  customerId: string | null;
  customerName: string | null;
  openedOn: string;
  targetOn: string | null;
  closedOn: string | null;
  courtReference: string | null;
  leadName: string | null;
  /** Counts for the list, so a screen does not need a query per row. */
  outstandingRequirements: number;
  openTasks: number;
  overdueTasks: number;
  undecidedRequirements: number;
}

export interface CaseDetail extends CaseSummary {
  instructedBy: string | null;
  placeOfDeath: string | null;
  domicileState: string | null;
  registry: string | null;
  closeReason: string | null;
  engagementRef: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  assignments: CaseAssignmentView[];
}

export interface CaseAssignmentView {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNo: string;
  role: "lead" | "reviewer" | "contributor" | "observer";
  assignedAt: string;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * The SQL that decides which cases a principal may read.
 *
 * Returned as a fragment rather than applied, so it can be dropped into any query
 * over `estate.case c`. A caller that forgets it is a caller that shows one family's
 * file to another, so every read in this module and the ones beside it uses it.
 */
export function caseAccessClause(principal: Principal, alias = "c") {
  if (principal.capabilities.has("case.view_all")) return sql`true`;

  if (!principal.capabilities.has("case.view")) {
    // No case capability at all: match nothing. Raising here instead would make every
    // list screen throw for somebody who simply has no cases, which is not an error.
    return sql`false`;
  }

  // Without an employee record there is nothing to be assigned to. Staff accounts are
  // linked to an employee at creation; a service account is not, and should see none.
  if (!principal.employeeId) return sql`false`;

  const table = sql.raw(alias);
  return sql`EXISTS (
    SELECT 1 FROM estate.case_assignment a
     WHERE a.case_id = ${table}.id
       AND a.employee_id = ${principal.employeeId}
       AND a.removed_at IS NULL
  )`;
}

/**
 * Loads a case if the principal may see it, and raises the right error if not.
 *
 * The two failures are deliberately different. A case that does not exist is a 404. A
 * case that exists and is not yours is *also* a 404 — probing ids must not reveal
 * that a matter exists — but an explicit lack of `case.view` is a 403, because that
 * is a permissions problem somebody should be told about rather than a puzzle.
 */
export async function requireCaseAccess(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<{ id: string; caseNo: string; status: CaseStatus; matterType: MatterType }> {
  if (
    !principal.capabilities.has("case.view") &&
    !principal.capabilities.has("case.view_all")
  ) {
    throw new AuthorizationError("You do not have permission to view cases.", "case.view");
  }

  const result = await db.execute<{
    id: string;
    case_no: string;
    status: string;
    matter_type: string;
  }>(sql`
    SELECT c.id, c.case_no, c.status, c.matter_type
      FROM estate.case c
     WHERE c.id = ${caseId} AND ${caseAccessClause(principal)}
  `);
  const row = result.rows?.[0];
  if (!row) throw new NotFoundError("That case does not exist, or is not one of yours.");
  return {
    id: row.id,
    caseNo: row.case_no,
    status: row.status as CaseStatus,
    matterType: row.matter_type as MatterType,
  };
}

/** Access plus a check that the file is still open to writing. */
export async function requireWritableCase(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<{ id: string; caseNo: string; status: CaseStatus; matterType: MatterType }> {
  const record = await requireCaseAccess(db, principal, caseId);
  if (record.status === "closed" || record.status === "withdrawn") {
    throw new ConflictError(
      `${record.caseNo} is ${record.status}. Reopen it before changing the file.`,
    );
  }
  return record;
}

// ---------------------------------------------------------------------------
// Opening a case
// ---------------------------------------------------------------------------

export interface OpenCaseInput {
  matterType: MatterType;
  title: string;
  deceasedName: string;
  /** Identification, encrypted at rest. Optional — often not to hand at intake. */
  deceasedId?: string | null;
  dateOfDeath?: string | null;
  placeOfDeath?: string | null;
  domicileState?: string | null;
  customerId?: string | null;
  instructedBy?: string | null;
  openedOn?: string;
  targetOn?: string | null;
  engagementRef?: string | null;
  notes?: string | null;
  /** The employee who leads the matter. Assigning at intake avoids an orphan case. */
  leadEmployeeId?: string | null;
}

export async function openCase(
  db: Executor,
  principal: Principal,
  input: OpenCaseInput,
  context?: AuditContext,
): Promise<{ id: string; caseNo: string }> {
  requireCapability(principal, "case.create");

  const title = input.title.trim();
  if (!title) throw new ValidationError("The matter needs a title.", "title");

  const deceasedName = input.deceasedName.trim();
  if (!deceasedName) {
    throw new ValidationError("An estate matter needs the name of the deceased.", "deceasedName");
  }
  if (!MATTER_TYPES.some((entry) => entry.value === input.matterType)) {
    throw new ValidationError("Choose what kind of matter this is.", "matterType");
  }

  const openedOn = input.openedOn ?? toIsoDate(today());
  parseIsoDate(openedOn);

  if (input.dateOfDeath) {
    parseIsoDate(input.dateOfDeath);
    if (input.dateOfDeath > openedOn) {
      throw new ValidationError(
        "The date of death is after the date the matter was opened.",
        "dateOfDeath",
      );
    }
  }
  if (input.targetOn) {
    parseIsoDate(input.targetOn);
    if (input.targetOn < openedOn) {
      throw new ValidationError("The target date is before the matter was opened.", "targetOn");
    }
  }

  const identity = encryptOptional(input.deceasedId);
  const caseNo = await allocateDocumentNumber(db, "case", { on: openedOn });

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO estate.case
      (case_no, matter_type, title, status, customer_id, instructed_by, deceased_name,
       deceased_id_enc, deceased_id_last4, date_of_death, place_of_death, domicile_state,
       opened_on, target_on, engagement_ref, notes, created_by)
    VALUES
      (${caseNo}, ${input.matterType}, ${title}, 'intake', ${input.customerId ?? null},
       ${input.instructedBy?.trim() || null}, ${deceasedName},
       ${identity.cipher}, ${identity.last4}, ${input.dateOfDeath ?? null},
       ${input.placeOfDeath?.trim() || null}, ${input.domicileState?.trim() || null},
       ${openedOn}, ${input.targetOn ?? null}, ${input.engagementRef?.trim() || null},
       ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = inserted.rows![0].id;

  if (input.leadEmployeeId) {
    await db.execute(sql`
      INSERT INTO estate.case_assignment (case_id, employee_id, role, assigned_by)
      VALUES (${id}, ${input.leadEmployeeId}, 'lead', ${principal.userId})
    `);
  }

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_OPENED,
    entityType: "estate.case",
    entityId: id,
    // The case number and the kind of matter; not the deceased's name.
    newValues: { caseNo, matterType: input.matterType, openedOn },
  });

  await recordCaseEvent(db, {
    caseId: id,
    kind: "case_opened",
    summary: `Matter opened as ${caseNo}.`,
    origin: "system",
    actorUserId: principal.userId,
    actorLabel: principal.fullName,
  });

  if (input.dateOfDeath) {
    await recordCaseEvent(db, {
      caseId: id,
      occurredAt: `${input.dateOfDeath}T00:00:00+08:00`,
      kind: "death",
      summary: "Date of death as recorded at intake.",
      origin: "recorded",
      actorUserId: principal.userId,
      actorLabel: principal.fullName,
    });
  }

  return { id, caseNo };
}

export interface UpdateCaseInput {
  title?: string;
  matterType?: MatterType;
  deceasedName?: string;
  /** `undefined` leaves it alone; `null` clears it. */
  deceasedId?: string | null;
  dateOfDeath?: string | null;
  placeOfDeath?: string | null;
  domicileState?: string | null;
  customerId?: string | null;
  instructedBy?: string | null;
  targetOn?: string | null;
  courtReference?: string | null;
  registry?: string | null;
  engagementRef?: string | null;
  notes?: string | null;
  status?: Extract<CaseStatus, "intake" | "open" | "on_hold">;
}

/**
 * Amends the matter.
 *
 * `undefined` means leave alone, `null` means clear. The distinction matters here for
 * the same reason it mattered in `updateEmployee`: a form that posts only what it
 * shows must not wipe what it does not.
 */
export async function updateCase(
  db: Executor,
  principal: Principal,
  caseId: string,
  input: UpdateCaseInput,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.edit");
  const record = await requireWritableCase(db, principal, caseId);

  const before = await db.execute<{ opened_on: string; status: string }>(
    sql`SELECT opened_on, status FROM estate.case WHERE id = ${caseId}`,
  );
  const openedOn = String(before.rows![0].opened_on).slice(0, 10);

  if (input.dateOfDeath) {
    parseIsoDate(input.dateOfDeath);
    if (input.dateOfDeath > openedOn) {
      throw new ValidationError(
        "The date of death is after the date the matter was opened.",
        "dateOfDeath",
      );
    }
  }
  if (input.targetOn) parseIsoDate(input.targetOn);
  if (input.matterType && !MATTER_TYPES.some((entry) => entry.value === input.matterType)) {
    throw new ValidationError("That is not a kind of matter.", "matterType");
  }
  if (input.title !== undefined && !input.title.trim()) {
    throw new ValidationError("The matter needs a title.", "title");
  }
  if (input.deceasedName !== undefined && !input.deceasedName.trim()) {
    throw new ValidationError("An estate matter needs the name of the deceased.", "deceasedName");
  }

  const identity =
    input.deceasedId === undefined ? undefined : encryptOptional(input.deceasedId);

  await db.execute(sql`
    UPDATE estate.case
       SET title = ${text(input.title, "title")},
           matter_type = ${keep(input.matterType, "matter_type")},
           status = ${keep(input.status, "status")},
           deceased_name = ${text(input.deceasedName, "deceased_name")},
           deceased_id_enc = ${keep(identity === undefined ? undefined : identity.cipher, "deceased_id_enc")},
           deceased_id_last4 = ${keep(identity === undefined ? undefined : identity.last4, "deceased_id_last4")},
           date_of_death = ${keep(input.dateOfDeath, "date_of_death")},
           place_of_death = ${optionalText(input.placeOfDeath, "place_of_death")},
           domicile_state = ${optionalText(input.domicileState, "domicile_state")},
           customer_id = ${keep(input.customerId, "customer_id")},
           instructed_by = ${optionalText(input.instructedBy, "instructed_by")},
           target_on = ${keep(input.targetOn, "target_on")},
           court_reference = ${optionalText(input.courtReference, "court_reference")},
           registry = ${optionalText(input.registry, "registry")},
           engagement_ref = ${optionalText(input.engagementRef, "engagement_ref")},
           notes = ${optionalText(input.notes, "notes")},
           updated_by = ${principal.userId}
     WHERE id = ${caseId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_UPDATED,
    entityType: "estate.case",
    entityId: caseId,
    // Which fields were touched, not what they now say.
    newValues: { caseNo: record.caseNo, fields: Object.keys(input).sort() },
  });

  // A court reference arriving is a real event in the matter, not just a field change.
  if (input.courtReference) {
    await recordCaseEvent(db, {
      caseId,
      kind: "court_reference",
      summary: `Court reference recorded: ${input.courtReference.trim()}.`,
      origin: "recorded",
      actorUserId: principal.userId,
      actorLabel: principal.fullName,
    });
  }
}

/**
 * Closes or withdraws a matter.
 *
 * Closing is refused while requirements are outstanding or tasks are open — the
 * database holds that, so it cannot be bypassed by another write path. Withdrawing is
 * the honest route for a matter that stops before it is finished, and it is not the
 * same word on the record.
 */
export async function closeCase(
  db: Executor,
  principal: Principal,
  caseId: string,
  params: { outcome: "closed" | "withdrawn"; reason: string; closedOn?: string },
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.close");
  const record = await requireCaseAccess(db, principal, caseId);

  if (record.status === "closed" || record.status === "withdrawn") {
    throw new ConflictError(`${record.caseNo} is already ${record.status}.`);
  }

  const reason = params.reason.trim();
  if (!reason) {
    throw new ValidationError(
      params.outcome === "closed"
        ? "Say how the matter concluded. A closed file with no outcome on it is not a closed file."
        : "Say why the matter was withdrawn.",
      "reason",
    );
  }

  const closedOn = params.closedOn ?? toIsoDate(today());
  parseIsoDate(closedOn);

  await db.execute(sql`
    UPDATE estate.case
       SET status = ${params.outcome}, closed_on = ${closedOn}, close_reason = ${reason},
           updated_by = ${principal.userId}
     WHERE id = ${caseId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: params.outcome === "closed" ? AUDIT.CASE_CLOSED : AUDIT.CASE_WITHDRAWN,
    entityType: "estate.case",
    entityId: caseId,
    newValues: { caseNo: record.caseNo, closedOn },
    reason,
  });

  await recordCaseEvent(db, {
    caseId,
    kind: params.outcome === "closed" ? "case_closed" : "case_withdrawn",
    summary:
      params.outcome === "closed" ? `Matter closed. ${reason}` : `Matter withdrawn. ${reason}`,
    origin: "system",
    actorUserId: principal.userId,
    actorLabel: principal.fullName,
  });
}

/** Reopens a closed matter, which is an explicit act and leaves a trail. */
export async function reopenCase(
  db: Executor,
  principal: Principal,
  caseId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.close");
  const record = await requireCaseAccess(db, principal, caseId);

  if (record.status !== "closed" && record.status !== "withdrawn") {
    throw new ConflictError(`${record.caseNo} is not closed.`);
  }
  const why = reason.trim();
  if (!why) throw new ValidationError("Say why the matter is being reopened.", "reason");

  await db.execute(sql`
    UPDATE estate.case
       SET status = 'open', closed_on = NULL, close_reason = NULL, updated_by = ${principal.userId}
     WHERE id = ${caseId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_REOPENED,
    entityType: "estate.case",
    entityId: caseId,
    newValues: { caseNo: record.caseNo },
    reason: why,
  });

  await recordCaseEvent(db, {
    caseId,
    kind: "case_reopened",
    summary: `Matter reopened. ${why}`,
    origin: "system",
    actorUserId: principal.userId,
    actorLabel: principal.fullName,
  });
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export async function assignToCase(
  db: Executor,
  principal: Principal,
  params: {
    caseId: string;
    employeeId: string;
    role?: CaseAssignmentView["role"];
  },
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.assign");
  // Assigning somebody to a case you cannot see is not a coherent act.
  const record = await requireWritableCase(db, principal, params.caseId);

  const role = params.role ?? "contributor";

  const employee = await db.execute<{ full_name: string; status: string }>(
    sql`SELECT full_name, status FROM hr.employee WHERE id = ${params.employeeId}`,
  );
  const person = employee.rows?.[0];
  if (!person) throw new NotFoundError("That employee does not exist.");
  if (person.status !== "active") {
    throw new ConflictError(`${person.full_name} is not an active employee.`);
  }

  const existing = await db.execute<{ id: string; role: string }>(sql`
    SELECT id, role FROM estate.case_assignment
     WHERE case_id = ${params.caseId} AND employee_id = ${params.employeeId}
       AND removed_at IS NULL
  `);
  if (existing.rows?.[0]) {
    if (existing.rows[0].role === role) return;
    await db.execute(sql`
      UPDATE estate.case_assignment SET role = ${role} WHERE id = ${existing.rows[0].id}
    `);
  } else {
    await db.execute(sql`
      INSERT INTO estate.case_assignment (case_id, employee_id, role, assigned_by)
      VALUES (${params.caseId}, ${params.employeeId}, ${role}, ${principal.userId})
    `);
  }

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_ASSIGNED,
    entityType: "estate.case",
    entityId: params.caseId,
    newValues: { caseNo: record.caseNo, employeeId: params.employeeId, role },
  });

  await recordCaseEvent(db, {
    caseId: params.caseId,
    kind: "assignment",
    summary: `${person.full_name} assigned as ${role}.`,
    origin: "system",
    actorUserId: principal.userId,
    actorLabel: principal.fullName,
  });
}

export async function removeFromCase(
  db: Executor,
  principal: Principal,
  params: { caseId: string; employeeId: string },
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.assign");
  const record = await requireWritableCase(db, principal, params.caseId);

  const result = await db.execute<{ id: string; full_name: string; role: string }>(sql`
    SELECT a.id, e.full_name, a.role
      FROM estate.case_assignment a
      JOIN hr.employee e ON e.id = a.employee_id
     WHERE a.case_id = ${params.caseId} AND a.employee_id = ${params.employeeId}
       AND a.removed_at IS NULL
  `);
  const assignment = result.rows?.[0];
  if (!assignment) throw new NotFoundError("That person is not assigned to this case.");

  // Somebody has to be able to see the matter. Removing the last person is how a case
  // becomes invisible to everyone without `case.view_all`.
  const remaining = await db.execute<{ count: string }>(sql`
    SELECT count(*) AS count FROM estate.case_assignment
     WHERE case_id = ${params.caseId} AND removed_at IS NULL AND employee_id <> ${params.employeeId}
  `);
  if (Number(remaining.rows![0].count) === 0) {
    throw new ConflictError(
      `${assignment.full_name} is the only person assigned to ${record.caseNo}. Assign somebody else first.`,
    );
  }

  await db.execute(sql`
    UPDATE estate.case_assignment
       SET removed_at = now(), removed_by = ${principal.userId}
     WHERE id = ${assignment.id}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_UNASSIGNED,
    entityType: "estate.case",
    entityId: params.caseId,
    newValues: { caseNo: record.caseNo, employeeId: params.employeeId },
  });

  await recordCaseEvent(db, {
    caseId: params.caseId,
    kind: "assignment",
    summary: `${assignment.full_name} removed from the matter.`,
    origin: "system",
    actorUserId: principal.userId,
    actorLabel: principal.fullName,
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface CaseListOptions {
  status?: CaseStatus | "active";
  matterType?: MatterType;
  search?: string;
  limit?: number;
}

export async function listCases(
  db: Executor,
  principal: Principal,
  options: CaseListOptions = {},
): Promise<CaseSummary[]> {
  const search = options.search?.trim() || null;

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT c.id, c.case_no, c.matter_type, c.title, c.status, c.deceased_name,
           c.deceased_id_last4, c.date_of_death, c.customer_id, c.opened_on, c.target_on,
           c.closed_on, c.court_reference,
           cust.name AS customer_name,
           lead.full_name AS lead_name,
           (SELECT count(*) FROM estate.case_requirement r
             WHERE r.case_id = c.id AND r.status IN ('outstanding', 'in_progress')) AS outstanding_requirements,
           (SELECT count(*) FROM estate.case_requirement r
             WHERE r.case_id = c.id AND cardinality(r.undecided_facts) > 0
               AND r.status IN ('outstanding', 'in_progress')) AS undecided_requirements,
           (SELECT count(*) FROM estate.case_task t
             WHERE t.case_id = c.id AND t.status IN ('open', 'in_progress', 'blocked')) AS open_tasks,
           (SELECT count(*) FROM estate.case_task t
             WHERE t.case_id = c.id AND t.status IN ('open', 'in_progress', 'blocked')
               AND t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE) AS overdue_tasks
      FROM estate.case c
      LEFT JOIN accounting.customer cust ON cust.id = c.customer_id
      LEFT JOIN LATERAL (
        SELECT e.full_name
          FROM estate.case_assignment a
          JOIN hr.employee e ON e.id = a.employee_id
         WHERE a.case_id = c.id AND a.removed_at IS NULL AND a.role = 'lead'
         ORDER BY a.assigned_at
         LIMIT 1
      ) lead ON true
     WHERE ${caseAccessClause(principal)}
       AND (${options.status ?? null}::text IS NULL
            OR (${options.status ?? null} = 'active' AND c.status IN ('intake', 'open', 'on_hold'))
            OR c.status = ${options.status ?? null})
       AND (${options.matterType ?? null}::text IS NULL OR c.matter_type = ${options.matterType ?? null})
       AND (${search}::text IS NULL
            OR c.case_no ILIKE '%' || ${search} || '%'
            OR c.title ILIKE '%' || ${search} || '%'
            OR c.deceased_name ILIKE '%' || ${search} || '%'
            OR c.court_reference ILIKE '%' || ${search} || '%')
     ORDER BY c.opened_on DESC, c.case_no DESC
     LIMIT ${options.limit ?? 200}
  `);

  return (result.rows ?? []).map(toCaseSummary);
}

export async function getCase(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<CaseDetail | null> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT c.*, cust.name AS customer_name,
           lead.full_name AS lead_name,
           (SELECT count(*) FROM estate.case_requirement r
             WHERE r.case_id = c.id AND r.status IN ('outstanding', 'in_progress')) AS outstanding_requirements,
           (SELECT count(*) FROM estate.case_requirement r
             WHERE r.case_id = c.id AND cardinality(r.undecided_facts) > 0
               AND r.status IN ('outstanding', 'in_progress')) AS undecided_requirements,
           (SELECT count(*) FROM estate.case_task t
             WHERE t.case_id = c.id AND t.status IN ('open', 'in_progress', 'blocked')) AS open_tasks,
           (SELECT count(*) FROM estate.case_task t
             WHERE t.case_id = c.id AND t.status IN ('open', 'in_progress', 'blocked')
               AND t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE) AS overdue_tasks
      FROM estate.case c
      LEFT JOIN accounting.customer cust ON cust.id = c.customer_id
      LEFT JOIN LATERAL (
        SELECT e.full_name
          FROM estate.case_assignment a
          JOIN hr.employee e ON e.id = a.employee_id
         WHERE a.case_id = c.id AND a.removed_at IS NULL AND a.role = 'lead'
         ORDER BY a.assigned_at
         LIMIT 1
      ) lead ON true
     WHERE c.id = ${caseId} AND ${caseAccessClause(principal)}
  `);
  const row = result.rows?.[0];
  if (!row) return null;

  const assignments = await db.execute<Record<string, unknown>>(sql`
    SELECT a.id, a.employee_id, a.role, a.assigned_at, e.full_name, e.employee_no
      FROM estate.case_assignment a
      JOIN hr.employee e ON e.id = a.employee_id
     WHERE a.case_id = ${caseId} AND a.removed_at IS NULL
     ORDER BY CASE a.role WHEN 'lead' THEN 0 WHEN 'reviewer' THEN 1 ELSE 2 END, e.full_name
  `);

  return {
    ...toCaseSummary(row),
    instructedBy: (row.instructed_by as string) ?? null,
    placeOfDeath: (row.place_of_death as string) ?? null,
    domicileState: (row.domicile_state as string) ?? null,
    registry: (row.registry as string) ?? null,
    closeReason: (row.close_reason as string) ?? null,
    engagementRef: (row.engagement_ref as string) ?? null,
    notes: (row.notes as string) ?? null,
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString(),
    assignments: (assignments.rows ?? []).map((entry) => ({
      id: String(entry.id),
      employeeId: String(entry.employee_id),
      employeeName: String(entry.full_name),
      employeeNo: String(entry.employee_no),
      role: entry.role as CaseAssignmentView["role"],
      assignedAt: new Date(String(entry.assigned_at)).toISOString(),
    })),
  };
}

function toCaseSummary(row: Record<string, unknown>): CaseSummary {
  return {
    id: String(row.id),
    caseNo: String(row.case_no),
    matterType: row.matter_type as MatterType,
    title: String(row.title),
    status: row.status as CaseStatus,
    deceasedName: String(row.deceased_name),
    deceasedIdLast4: (row.deceased_id_last4 as string) ?? null,
    dateOfDeath: row.date_of_death ? String(row.date_of_death).slice(0, 10) : null,
    customerId: (row.customer_id as string) ?? null,
    customerName: (row.customer_name as string) ?? null,
    openedOn: String(row.opened_on).slice(0, 10),
    targetOn: row.target_on ? String(row.target_on).slice(0, 10) : null,
    closedOn: row.closed_on ? String(row.closed_on).slice(0, 10) : null,
    courtReference: (row.court_reference as string) ?? null,
    leadName: (row.lead_name as string) ?? null,
    outstandingRequirements: Number(row.outstanding_requirements ?? 0),
    undecidedRequirements: Number(row.undecided_requirements ?? 0),
    openTasks: Number(row.open_tasks ?? 0),
    overdueTasks: Number(row.overdue_tasks ?? 0),
  };
}

/**
 * The deceased's identification, in full.
 *
 * Separate call, capability-gated, and it writes `EXPORT_SENSITIVE` with a reason —
 * the same treatment as an employee's NRIC, because it is the same kind of data about
 * a person who cannot object.
 */
export async function getDeceasedIdentification(
  db: Executor,
  principal: Principal,
  caseId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<string | null> {
  requireCapability(principal, "case.document.view");
  const record = await requireCaseAccess(db, principal, caseId);

  const result = await db.execute<{ deceased_id_enc: string | null }>(
    sql`SELECT deceased_id_enc FROM estate.case WHERE id = ${caseId}`,
  );
  const cipher = result.rows?.[0]?.deceased_id_enc ?? null;

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.EXPORT_SENSITIVE,
    entityType: "estate.case",
    entityId: caseId,
    newValues: { caseNo: record.caseNo, fields: ["deceased_identification"] },
    reason: options.reason ?? null,
  });

  return cipher ? decryptSecret(cipher) : null;
}

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

export interface CaseEventView {
  id: string;
  occurredAt: string;
  origin: "system" | "recorded";
  kind: string;
  summary: string;
  detail: Record<string, unknown>;
  actorLabel: string | null;
  recordedAt: string;
}

export interface RecordCaseEventInput {
  caseId: string;
  kind: string;
  summary: string;
  occurredAt?: string;
  origin?: "system" | "recorded";
  detail?: Record<string, unknown>;
  actorUserId?: string | null;
  actorLabel?: string | null;
}

/**
 * Appends to the timeline.
 *
 * Internal, and called from the write paths in this module and its neighbours rather
 * than from a screen — the timeline is a consequence of work, not a thing somebody
 * maintains. `recordCaseMilestone` is the public door for the entries somebody does
 * type in, because they happened outside the platform.
 *
 * `detail` goes through `redact()` on the way in. A timeline is read by more people
 * than a case file is.
 */
/**
 * Adds an entry to a matter's timeline.
 *
 * **Takes no principal, and checks nothing.** It is called from inside functions that have already
 * established access to the case and are recording what they just did — so a check here would be a
 * second, weaker copy of one that has already happened. That makes the contract worth stating: the
 * caller is responsible for having scoped the case, and a screen must never call this directly with
 * a case id out of a request.
 */
export async function recordCaseEvent(db: Executor, input: RecordCaseEventInput): Promise<void> {
  const summary = input.summary.trim();
  if (!summary) throw new ValidationError("An entry needs a summary.", "summary");

  const detail = JSON.stringify(redact(input.detail ?? {}));

  await db.execute(sql`
    INSERT INTO estate.case_event
      (case_id, occurred_at, origin, kind, summary, detail, actor_user_id, actor_label)
    VALUES
      (${input.caseId},
       COALESCE(${input.occurredAt ?? null}::timestamptz, now()),
       ${input.origin ?? "system"}, ${input.kind}, ${summary}, ${detail}::jsonb,
       ${input.actorUserId ?? null}, ${input.actorLabel ?? null})
  `);
}

/** Something that happened in the matter, outside this platform. */
export async function recordCaseMilestone(
  db: Executor,
  principal: Principal,
  params: { caseId: string; kind: string; summary: string; occurredAt: string },
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.edit");
  const record = await requireWritableCase(db, principal, params.caseId);

  const summary = params.summary.trim();
  if (!summary) throw new ValidationError("Say what happened.", "summary");
  const kind = params.kind.trim() || "note";

  const occurredAt = params.occurredAt.trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(occurredAt)) {
    throw new ValidationError("Write the date as YYYY-MM-DD.", "occurredAt");
  }
  const date = occurredAt.slice(0, 10);
  parseIsoDate(date);
  if (date > toIsoDate(today())) {
    throw new ValidationError("That date is in the future.", "occurredAt");
  }
  // Malaysia is +08:00 all year; no DST to reason about.
  const instant = occurredAt.length > 10 ? `${occurredAt}:00+08:00` : `${date}T00:00:00+08:00`;

  await recordCaseEvent(db, {
    caseId: params.caseId,
    kind,
    summary,
    occurredAt: instant,
    origin: "recorded",
    actorUserId: principal.userId,
    actorLabel: principal.fullName,
  });

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_EVENT_RECORDED,
    entityType: "estate.case",
    entityId: params.caseId,
    newValues: { caseNo: record.caseNo, kind, occurredAt: instant },
  });
}

export async function listCaseEvents(
  db: Executor,
  principal: Principal,
  caseId: string,
  limit = 200,
): Promise<CaseEventView[]> {
  await requireCaseAccess(db, principal, caseId);

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT id, occurred_at, origin, kind, summary, detail, actor_label, recorded_at
      FROM estate.case_event
     WHERE case_id = ${caseId}
     ORDER BY occurred_at DESC, recorded_at DESC
     LIMIT ${limit}
  `);

  return (result.rows ?? []).map((row) => ({
    id: String(row.id),
    occurredAt: new Date(String(row.occurred_at)).toISOString(),
    origin: row.origin as "system" | "recorded",
    kind: String(row.kind),
    summary: String(row.summary),
    detail: readJsonObject(row.detail),
    actorLabel: (row.actor_label as string) ?? null,
    recordedAt: new Date(String(row.recorded_at)).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// The estate's position
// ---------------------------------------------------------------------------

export interface EstatePosition {
  assetTotal: Amount;
  liabilityTotal: Amount;
  /** Assets less liabilities. Arithmetic on the figures recorded, nothing more. */
  net: Amount;
  assetsValued: number;
  assetsUnvalued: number;
  liabilitiesValued: number;
  liabilitiesUnvalued: number;
  /** True while any figure is missing, so no total is presented as complete. */
  incomplete: boolean;
}

/**
 * Adds up the inventory.
 *
 * Deliberately arithmetic and nothing else: it sums what has been recorded and counts
 * what has not. It does not estimate a missing valuation, and `incomplete` is how the
 * screen knows to say so rather than showing a total that looks final. An estate
 * summary that reads as complete when three assets have no figure is how a family is
 * given a number that turns out to be wrong.
 */
export async function estatePosition(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<EstatePosition> {
  await requireCaseAccess(db, principal, caseId);

  const assets = await db.execute<{ valuation_amount: string | null }>(sql`
    SELECT valuation_amount FROM estate.case_asset
     WHERE case_id = ${caseId} AND status <> 'excluded'
  `);
  const liabilities = await db.execute<{ amount: string | null }>(sql`
    SELECT amount FROM estate.case_liability
     WHERE case_id = ${caseId} AND status <> 'excluded'
  `);

  const assetAmounts: Amount[] = [];
  let assetsUnvalued = 0;
  for (const row of assets.rows ?? []) {
    if (row.valuation_amount === null) assetsUnvalued += 1;
    else assetAmounts.push(parseAmount(row.valuation_amount));
  }

  const liabilityAmounts: Amount[] = [];
  let liabilitiesUnvalued = 0;
  for (const row of liabilities.rows ?? []) {
    if (row.amount === null) liabilitiesUnvalued += 1;
    else liabilityAmounts.push(parseAmount(row.amount));
  }

  const assetTotal = sumAmounts(assetAmounts);
  const liabilityTotal = sumAmounts(liabilityAmounts);

  return {
    assetTotal,
    liabilityTotal,
    net: (assetTotal - liabilityTotal) as Amount,
    assetsValued: assetAmounts.length,
    assetsUnvalued,
    liabilitiesValued: liabilityAmounts.length,
    liabilitiesUnvalued,
    incomplete: assetsUnvalued > 0 || liabilitiesUnvalued > 0,
  };
}

/** The position in words, for a screen that must not overstate it. */
export function describePosition(position: EstatePosition): string {
  const net = `RM ${formatAmount(position.net)}`;
  if (!position.incomplete) return `Net ${net}, from every asset and liability recorded.`;
  const missing = [
    position.assetsUnvalued > 0 ? `${position.assetsUnvalued} asset(s)` : null,
    position.liabilitiesUnvalued > 0 ? `${position.liabilitiesUnvalued} liability(ies)` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  return `Net ${net} so far — ${missing} have no figure yet, so this is not the estate's total.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ciphertext and last four, or a pair of nulls. Mirrors the employee treatment. */
export function encryptOptional(value: string | null | undefined): {
  cipher: string | null;
  last4: string | null;
} {
  const trimmed = value?.trim();
  if (!trimmed) return { cipher: null, last4: null };
  const digits = trimmed.replace(/\D/g, "");
  const tail = (digits || trimmed).slice(-4);
  return { cipher: encryptSecret(trimmed), last4: tail };
}

/**
 * `undefined` leaves the column as it is; anything else writes.
 *
 * The same three helpers as `people.ts`, and for the same reason: a partial update
 * that silently clears what it did not mention is a data-loss bug that looks like a
 * form bug.
 */
export function keep<T>(value: T | undefined, column: string) {
  return value === undefined ? sql.raw(column) : sql`${value}`;
}

export function text(value: string | undefined, column: string) {
  return value === undefined ? sql.raw(column) : sql`${value.trim()}`;
}

export function optionalText(value: string | null | undefined, column: string) {
  return value === undefined ? sql.raw(column) : sql`${value?.trim() || null}`;
}

export function readJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}
