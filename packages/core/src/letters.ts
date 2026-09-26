import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, requireDifferentApprover, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, today, toIsoDate } from "./dates.js";
import { formatAmount, parseAmount } from "./money.js";
import { allocateDocumentNumber } from "./sequence.js";
import {
  analyseTemplate,
  parseBoolean,
  renderTemplate,
  validateTemplateBody,
  type TemplateVariable,
} from "./templates.js";

/**
 * Employment letters.
 *
 * One idea carries the whole module: **a letter keeps its own copy of the template.**
 * The wording, the declared variables, the values and the rendered text are all
 * snapshotted onto the letter when it is generated.
 *
 * That is not redundancy. These documents are produced in employment disputes, and a
 * letter that re-renders itself from the current template is a letter whose contents
 * depend on when you read it. Someone revising the appointment letter next year must
 * not change what a person was told this year.
 *
 * The rest follows: an approved template version is immutable and a revision is a new
 * version; an issued letter is immutable and a correction is a new letter that says
 * what it supersedes.
 */

export type LetterKind =
  | "appointment"
  | "confirmation"
  | "increment"
  | "promotion"
  | "warning"
  | "reference"
  | "termination"
  | "custom";

export type TemplateStatus = "draft" | "approved" | "retired";
export type LetterStatus = "draft" | "approved" | "issued" | "cancelled";

export const LETTER_KINDS: Array<{ kind: LetterKind; label: string; note?: string }> = [
  { kind: "appointment", label: "Appointment", note: "Written before somebody joins." },
  { kind: "confirmation", label: "Confirmation after probation" },
  { kind: "increment", label: "Salary increment" },
  { kind: "promotion", label: "Promotion" },
  { kind: "warning", label: "Warning" },
  { kind: "reference", label: "Reference / certificate of employment" },
  { kind: "termination", label: "Termination" },
  { kind: "custom", label: "Something else" },
];

export interface TemplateView {
  id: string;
  code: string;
  version: number;
  name: string;
  kind: LetterKind;
  subject: string;
  body: string;
  variables: TemplateVariable[];
  sourceRef: string | null;
  notes: string | null;
  status: TemplateStatus;
  approvedByName: string | null;
  createdByName: string | null;
  lettersGenerated: number;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function saveTemplate(
  db: Executor,
  principal: Principal,
  input: {
    templateId?: string;
    code: string;
    name: string;
    kind: LetterKind;
    subject: string;
    body: string;
    variables: TemplateVariable[];
    sourceRef?: string | null;
    notes?: string | null;
  },
  context?: AuditContext,
): Promise<{ id: string; version: number }> {
  requireCapability(principal, "hr.letter.generate");

  const code = requireText(input.code, "Give the template a short code.", "code").toUpperCase();
  const name = requireText(input.name, "Name the template.", "name");
  const subject = requireText(input.subject, "The letter needs a subject line.", "subject");
  const body = requireText(input.body, "The letter needs a body.", "body");

  validateTemplateBody(body);
  validateVariables(input.variables);

  // A placeholder the template never declared would reach a real letter as literal
  // braces. Caught here, while somebody is editing, rather than there.
  const analysis = analyseTemplate(body, input.variables);
  if (analysis.undeclared.length > 0) {
    throw new ValidationError(
      `The body uses ${analysis.undeclared.map((key) => `{{${key}}}`).join(", ")}, which ` +
        "is not declared above. Declare each one, or remove it — a letter that reaches somebody " +
        "with a placeholder still in it is worse than no letter.",
      "body",
    );
  }

  if (input.templateId) {
    const before = await db.execute<{ status: TemplateStatus; version: number }>(
      sql`SELECT status, version FROM hr.letter_template WHERE id = ${input.templateId}`,
    );
    const current = before.rows?.[0];
    if (!current) throw new NotFoundError("That template no longer exists.");
    if (current.status !== "draft") {
      throw new ConflictError(
        "An approved template's wording is fixed. Create a new version instead — that is what " +
          "makes it possible to say which wording somebody was actually sent.",
      );
    }

    await db.execute(sql`
      UPDATE hr.letter_template SET
        name = ${name}, kind = ${input.kind}, subject = ${subject}, body = ${body},
        variables = ${JSON.stringify(input.variables)}::jsonb,
        source_ref = ${input.sourceRef?.trim() || null},
        notes = ${input.notes?.trim() || null}, updated_by = ${principal.userId}
      WHERE id = ${input.templateId}
    `);

    await writeAudit(db, {
      ...context,
      actorUserId: principal.userId,
      actorLabel: principal.email,
      action: AUDIT.LETTER_TEMPLATE_SAVED,
      entityType: "letter_template",
      entityId: input.templateId,
      newValues: { code, name, version: current.version },
    });

    return { id: input.templateId, version: current.version };
  }

  // A new version of an existing code, or a new code entirely.
  const highest = await db.execute<{ version: number }>(
    sql`SELECT COALESCE(MAX(version), 0) AS version FROM hr.letter_template WHERE code = ${code}`,
  );
  const version = Number(highest.rows?.[0]?.version ?? 0) + 1;

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.letter_template
      (code, version, name, kind, subject, body, variables, source_ref, notes, created_by)
    VALUES (${code}, ${version}, ${name}, ${input.kind}, ${subject}, ${body},
            ${JSON.stringify(input.variables)}::jsonb, ${input.sourceRef?.trim() || null},
            ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.LETTER_TEMPLATE_SAVED,
    entityType: "letter_template",
    entityId: id,
    newValues: { code, version, name, kind: input.kind, variables: input.variables.length },
  });

  return { id, version };
}

function validateVariables(variables: TemplateVariable[]): void {
  if (!Array.isArray(variables)) {
    throw new ValidationError("The variables have to be a list.", "variables");
  }

  const seen = new Set<string>();
  for (const variable of variables) {
    if (!variable.key?.trim()) {
      throw new ValidationError("Every variable needs a key.", "variables");
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(variable.key)) {
      throw new ValidationError(
        `"${variable.key}" is not a usable key. Letters, digits and underscores, starting with a letter.`,
        "variables",
      );
    }
    if (seen.has(variable.key)) {
      throw new ValidationError(
        `"${variable.key}" is declared twice, so one would overwrite the other.`,
        "variables",
      );
    }
    seen.add(variable.key);

    if (!variable.label?.trim()) {
      throw new ValidationError(
        `"${variable.key}" needs a label — it is what whoever fills the letter in will read.`,
        "variables",
      );
    }
  }
}

/**
 * Approves a template version.
 *
 * Maker/checker, and for a reason beyond form: an appointment letter states somebody's
 * terms of employment. The wording is a commitment by the firm, and one person should
 * not be able to change what the firm commits to.
 */
export async function approveTemplate(
  db: Executor,
  principal: Principal,
  templateId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.letter.approve");

  const found = await db.execute<{
    status: TemplateStatus;
    code: string;
    version: number;
    created_by: string;
    name: string;
  }>(sql`
    SELECT status, code, version, created_by, name FROM hr.letter_template
     WHERE id = ${templateId} FOR UPDATE
  `);
  const template = found.rows?.[0];
  if (!template) throw new NotFoundError("That template no longer exists.");
  if (template.status !== "draft") {
    throw new ConflictError(`That version is already ${template.status}.`);
  }

  requireDifferentApprover({
    principal,
    createdByUserId: template.created_by,
    action: "approve a letter template",
  });

  // Retire the previous approved version of the same code: "the appointment letter"
  // has to mean one thing when somebody generates one.
  await db.execute(sql`
    UPDATE hr.letter_template
       SET status = 'retired', retired_at = now(), updated_by = ${principal.userId}
     WHERE code = ${template.code} AND status = 'approved' AND id <> ${templateId}
  `);

  await db.execute(sql`
    UPDATE hr.letter_template
       SET status = 'approved', approved_at = now(), approved_by = ${principal.userId},
           updated_by = ${principal.userId}
     WHERE id = ${templateId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.LETTER_TEMPLATE_APPROVED,
    entityType: "letter_template",
    entityId: templateId,
    newValues: { code: template.code, version: template.version, name: template.name },
  });
}

export async function listTemplates(
  db: Executor,
  filters: { includeRetired?: boolean } = {},
): Promise<TemplateView[]> {
  const result = await db.execute<{
    id: string;
    code: string;
    version: number;
    name: string;
    kind: LetterKind;
    subject: string;
    body: string;
    variables: unknown;
    source_ref: string | null;
    notes: string | null;
    status: TemplateStatus;
    approved_by_name: string | null;
    created_by_name: string | null;
    letters_generated: number;
  }>(sql`
    SELECT t.id, t.code, t.version, t.name, t.kind, t.subject, t.body, t.variables,
           t.source_ref, t.notes, t.status,
           a.full_name AS approved_by_name, c.full_name AS created_by_name,
           COALESCE(l.count, 0)::int AS letters_generated
      FROM hr.letter_template t
      LEFT JOIN auth."user" a ON a.id = t.approved_by
      LEFT JOIN auth."user" c ON c.id = t.created_by
      LEFT JOIN (
        SELECT template_id, count(*) AS count FROM hr.letter GROUP BY template_id
      ) l ON l.template_id = t.id
     WHERE ${filters.includeRetired === false ? sql`t.status <> 'retired'` : sql`true`}
     ORDER BY t.code, t.version DESC
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    code: row.code,
    version: row.version,
    name: row.name,
    kind: row.kind,
    subject: row.subject,
    body: row.body,
    variables: (row.variables as TemplateVariable[]) ?? [],
    sourceRef: row.source_ref,
    notes: row.notes,
    status: row.status,
    approvedByName: row.approved_by_name,
    createdByName: row.created_by_name,
    lettersGenerated: row.letters_generated,
  }));
}

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------

export interface LetterView {
  id: string;
  letterNo: string | null;
  employeeId: string;
  employeeName: string;
  employeeNo: string;
  templateId: string | null;
  templateCode: string;
  templateVersion: number;
  kind: LetterKind;
  subject: string;
  bodyRendered: string;
  variables: TemplateVariable[];
  valuesUsed: Record<string, unknown>;
  letterDate: string;
  status: LetterStatus;
  approvedByName: string | null;
  issuedByName: string | null;
  deliveryNote: string | null;
  cancelReason: string | null;
  supersedesLetterId: string | null;
  supersedesLetterNo: string | null;
  supersededByNo: string | null;
  notes: string | null;
  /** So a screen can tell whether the person looking at it generated it. */
  createdBy: string;
}

/**
 * The values a letter about somebody starts with.
 *
 * Filled from the employee record so nobody retypes a name or a joining date — and so
 * a letter cannot disagree with the record it is about. Anything the template asks for
 * that is not here is asked of the person.
 */
export async function letterDefaults(
  db: Executor,
  employeeId: string,
): Promise<Record<string, string>> {
  const result = await db.execute<{
    full_name: string;
    employee_no: string;
    joined_on: string;
    confirmed_on: string | null;
    position_title: string | null;
    department_name: string | null;
    employment_type: string;
    probation_months: number;
    basic_salary: string;
    nric_last4: string | null;
    address: string | null;
  }>(sql`
    SELECT e.full_name, e.employee_no, e.joined_on, e.confirmed_on,
           p.title AS position_title, d.name AS department_name,
           e.employment_type, e.probation_months, e.basic_salary, e.nric_last4, e.address
      FROM hr.employee e
      LEFT JOIN hr.position p ON p.id = e.position_id
      LEFT JOIN hr.department d ON d.id = e.department_id
     WHERE e.id = ${employeeId}
  `);

  const row = result.rows?.[0];
  if (!row) throw new NotFoundError("That employee no longer exists.");

  return {
    employee_name: row.full_name,
    employee_no: row.employee_no,
    joined_on: String(row.joined_on).slice(0, 10),
    confirmed_on: row.confirmed_on ? String(row.confirmed_on).slice(0, 10) : "",
    position: row.position_title ?? "",
    department: row.department_name ?? "",
    employment_type: row.employment_type.replace(/_/g, " "),
    probation_months: String(row.probation_months),
    // The salary is offered because an appointment or increment letter states it. It
    // needs `hr.employee.view_sensitive` to read elsewhere, and generating a letter
    // that states somebody's pay is the same disclosure — so the caller has to hold it.
    basic_salary: row.basic_salary,
    address: row.address ?? "",
    letter_date: toIsoDate(today()),
    today: toIsoDate(today()),
  };
}

/**
 * Generates a letter from an approved template.
 *
 * The template is snapshotted onto the letter — wording, variables and values — so the
 * letter is complete in itself. Rendering happens once, here, and the result is stored:
 * re-rendering on read would mean the letter's text depended on the engine's current
 * behaviour as well as on the template's.
 */
export async function generateLetter(
  db: Executor,
  principal: Principal,
  input: {
    employeeId: string;
    templateCode: string;
    letterDate?: string;
    values: Record<string, unknown>;
    supersedesLetterId?: string | null;
    notes?: string | null;
  },
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "hr.letter.generate");

  const template = await db.execute<{
    id: string;
    code: string;
    version: number;
    kind: LetterKind;
    subject: string;
    body: string;
    variables: unknown;
  }>(sql`
    SELECT id, code, version, kind, subject, body, variables
      FROM hr.letter_template
     WHERE code = ${input.templateCode.toUpperCase()} AND status = 'approved'
  `);
  const found = template.rows?.[0];
  if (!found) {
    throw new ConflictError(
      `There is no approved template with the code ${input.templateCode.toUpperCase()}. A draft ` +
        "cannot be used to write to somebody — it has not been agreed as what the firm says.",
    );
  }

  const variables = (found.variables as TemplateVariable[]) ?? [];
  const letterDate = toIsoDate(
    input.letterDate ? parseIsoDate(input.letterDate, "letterDate") : today(),
  );

  // Coerce and check each value against its declared type before rendering, so a date
  // typed as "next Tuesday" fails here rather than appearing in a letter.
  const values = coerceValues(variables, { ...input.values, letter_date: letterDate });

  // Renders once. The stored text is the letter; nothing re-derives it on read.
  const bodyRendered = renderTemplate(found.body, variables, values, {
    formatMoney: (raw) => formatAmount(parseAmount(raw)),
  });

  const subject = renderTemplate(found.subject, variables, values, {
    formatMoney: (raw) => formatAmount(parseAmount(raw)),
  });

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.letter
      (employee_id, template_id, template_code, template_version, kind, subject,
       body_template, variables, values_used, body_rendered, letter_date,
       supersedes_letter_id, notes, created_by)
    VALUES (${input.employeeId}, ${found.id}, ${found.code}, ${found.version}, ${found.kind},
            ${subject}, ${found.body}, ${JSON.stringify(variables)}::jsonb,
            ${JSON.stringify(values)}::jsonb, ${bodyRendered}, ${letterDate},
            ${input.supersedesLetterId ?? null}, ${input.notes?.trim() || null},
            ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.LETTER_GENERATED,
    entityType: "letter",
    entityId: id,
    newValues: {
      employeeId: input.employeeId,
      template: `${found.code} v${found.version}`,
      kind: found.kind,
      letterDate,
      supersedes: input.supersedesLetterId ?? undefined,
    },
  });

  return { id };
}

function coerceValues(
  variables: TemplateVariable[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const variable of variables) {
    const raw = values[variable.key];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      if (variable.type === "boolean") out[variable.key] = false;
      continue;
    }

    const text = String(raw).trim();

    switch (variable.type) {
      case "number": {
        const number = Number(text);
        if (!Number.isFinite(number)) {
          throw new ValidationError(`${variable.label} is not a number.`, variable.key);
        }
        out[variable.key] = number;
        break;
      }
      case "money":
        // Parsed as money so "4,500" and "4500.00" are the same figure, and anything
        // that is not a figure fails here rather than being printed as typed.
        parseAmount(text, variable.key);
        out[variable.key] = text.replace(/,/g, "");
        break;
      case "date":
        try {
          out[variable.key] = toIsoDate(parseIsoDate(text, variable.key));
        } catch {
          // The parser's own message names the format but not the box. On a letter
          // form with six dates on it, which box matters more than the format does.
          throw new ValidationError(
            `${variable.label} is not a date. Write it as YYYY-MM-DD.`,
            variable.key,
          );
        }
        break;
      case "boolean":
        out[variable.key] = parseBoolean(text, variable.key);
        break;
      default:
        out[variable.key] = text;
    }
  }

  // Values the template did not declare are dropped rather than stored: keeping them
  // would suggest they had some effect on the letter.
  return out;
}

export async function approveLetter(
  db: Executor,
  principal: Principal,
  letterId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.letter.approve");

  const letter = await lockLetter(db, letterId);
  if (letter.status !== "draft") {
    throw new ConflictError(`That letter is already ${letter.status}.`);
  }

  requireDifferentApprover({
    principal,
    createdByUserId: letter.created_by,
    action: "approve a letter",
  });

  await db.execute(sql`
    UPDATE hr.letter
       SET status = 'approved', approved_at = now(), approved_by = ${principal.userId},
           updated_by = ${principal.userId}
     WHERE id = ${letterId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.LETTER_APPROVED,
    entityType: "letter",
    entityId: letterId,
    newValues: { template: `${letter.template_code} v${letter.template_version}` },
  });
}

/**
 * Issues the letter.
 *
 * This is the point at which it becomes a document somebody has. It gets its number,
 * and from then on nothing about it changes. `deliveryNote` records how it reached
 * them, because "was it actually given to them" is the question asked afterwards.
 */
export async function issueLetter(
  db: Executor,
  principal: Principal,
  letterId: string,
  options: { deliveryNote?: string | null; context?: AuditContext } = {},
): Promise<{ letterNo: string }> {
  requireCapability(principal, "hr.letter.generate");

  const letter = await lockLetter(db, letterId);
  if (letter.status !== "approved") {
    throw new ConflictError(
      letter.status === "draft"
        ? "This letter has not been approved yet. An appointment letter states somebody's terms; " +
          "one person should not be able to send it alone."
        : `This letter is already ${letter.status}.`,
    );
  }

  const letterNo = await allocateDocumentNumber(db, "letter", { on: letter.letter_date });

  await db.execute(sql`
    UPDATE hr.letter
       SET status = 'issued', letter_no = ${letterNo}, issued_at = now(),
           issued_by = ${principal.userId},
           delivery_note = ${options.deliveryNote?.trim() || null},
           updated_by = ${principal.userId}
     WHERE id = ${letterId}
  `);

  await writeAudit(db, {
    ...context(options),
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.LETTER_ISSUED,
    entityType: "letter",
    entityId: letterId,
    newValues: { letterNo, delivery: options.deliveryNote ?? null },
  });

  return { letterNo };
}

function context(options: { context?: AuditContext }): AuditContext {
  return options.context ?? {};
}

export async function cancelLetter(
  db: Executor,
  principal: Principal,
  letterId: string,
  reason: string,
  auditContext?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.letter.generate");

  if (!reason?.trim()) throw new ValidationError("Say why it is being cancelled.", "reason");

  const letter = await lockLetter(db, letterId);
  if (letter.status === "issued") {
    throw new ConflictError(
      "This letter has been given to somebody. Supersede it with a corrected letter rather than " +
        "cancelling what they are holding.",
    );
  }
  if (letter.status === "cancelled") throw new ConflictError("That letter is already cancelled.");

  await db.execute(sql`
    UPDATE hr.letter
       SET status = 'cancelled', cancelled_at = now(), cancel_reason = ${reason.trim()},
           updated_by = ${principal.userId}
     WHERE id = ${letterId}
  `);

  await writeAudit(db, {
    ...auditContext,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.LETTER_CANCELLED,
    entityType: "letter",
    entityId: letterId,
    reason: reason.trim(),
  });
}

export async function listLetters(
  db: Executor,
  filters: { employeeId?: string; status?: LetterStatus; kind?: LetterKind; limit?: number } = {},
): Promise<LetterView[]> {
  const where = [sql`true`];
  if (filters.employeeId) where.push(sql`l.employee_id = ${filters.employeeId}`);
  if (filters.status) where.push(sql`l.status = ${filters.status}`);
  if (filters.kind) where.push(sql`l.kind = ${filters.kind}`);

  const result = await db.execute<Record<string, never>>(sql`
    SELECT l.id, l.letter_no, l.employee_id, e.full_name AS employee_name, e.employee_no,
           l.template_id, l.template_code, l.template_version, l.kind, l.subject,
           l.body_rendered, l.variables, l.values_used, l.letter_date, l.status,
           a.full_name AS approved_by_name, i.full_name AS issued_by_name,
           l.delivery_note, l.cancel_reason, l.supersedes_letter_id,
           prev.letter_no AS supersedes_letter_no, next.letter_no AS superseded_by_no, l.notes,
           l.created_by
      FROM hr.letter l
      JOIN hr.employee e ON e.id = l.employee_id
      LEFT JOIN auth."user" a ON a.id = l.approved_by
      LEFT JOIN auth."user" i ON i.id = l.issued_by
      LEFT JOIN hr.letter prev ON prev.id = l.supersedes_letter_id
      LEFT JOIN hr.letter next ON next.supersedes_letter_id = l.id AND next.status = 'issued'
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY l.letter_date DESC, l.created_at DESC
     LIMIT ${Math.min(Math.max(filters.limit ?? 200, 1), 1000)}
  `);

  return (result.rows ?? []).map((raw) => readLetter(raw as Record<string, unknown>));
}

export async function getLetter(db: Executor, letterId: string): Promise<LetterView | null> {
  const letters = await listLetters(db, { limit: 1000 });
  return letters.find((row) => row.id === letterId) ?? null;
}

function readLetter(row: Record<string, unknown>): LetterView {
  return {
    id: String(row.id),
    letterNo: (row.letter_no as string) ?? null,
    employeeId: String(row.employee_id),
    employeeName: String(row.employee_name),
    employeeNo: String(row.employee_no),
    templateId: (row.template_id as string) ?? null,
    templateCode: String(row.template_code),
    templateVersion: Number(row.template_version),
    kind: row.kind as LetterKind,
    subject: String(row.subject),
    bodyRendered: String(row.body_rendered),
    variables: (row.variables as TemplateVariable[]) ?? [],
    valuesUsed: (row.values_used as Record<string, unknown>) ?? {},
    letterDate: String(row.letter_date).slice(0, 10),
    status: row.status as LetterStatus,
    approvedByName: (row.approved_by_name as string) ?? null,
    issuedByName: (row.issued_by_name as string) ?? null,
    deliveryNote: (row.delivery_note as string) ?? null,
    cancelReason: (row.cancel_reason as string) ?? null,
    supersedesLetterId: (row.supersedes_letter_id as string) ?? null,
    supersedesLetterNo: (row.supersedes_letter_no as string) ?? null,
    supersededByNo: (row.superseded_by_no as string) ?? null,
    notes: (row.notes as string) ?? null,
    createdBy: String(row.created_by),
  };
}

interface LockedLetter extends Record<string, unknown> {
  id: string;
  status: LetterStatus;
  created_by: string;
  letter_date: string;
  template_code: string;
  template_version: number;
}

async function lockLetter(db: Executor, letterId: string): Promise<LockedLetter> {
  const result = await db.execute<LockedLetter>(sql`
    SELECT id, status, created_by, letter_date, template_code, template_version
      FROM hr.letter WHERE id = ${letterId} FOR UPDATE
  `);
  const row = result.rows?.[0];
  if (!row) throw new NotFoundError("That letter no longer exists.");
  return row;
}

function requireText(value: string | null | undefined, message: string, field: string): string {
  const text = (value ?? "").trim();
  if (text === "") throw new ValidationError(message, field);
  return text;
}
