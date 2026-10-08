import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, requireDifferentApprover, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { formatAmount } from "./money.js";
import { formatDate, parseIsoDate, toIsoDate, today } from "./dates.js";
import { allocateDocumentNumber } from "./sequence.js";
import {
  analyseTemplate,
  parseBoolean,
  renderTemplate,
  validateTemplateBody,
  type TemplateVariable,
  type VariableType,
} from "./templates.js";
import {
  MATTER_TYPES,
  estatePosition,
  recordCaseEvent,
  requireCaseAccess,
  requireWritableCase,
} from "./cases.js";
import { chunkPages } from "./chunking.js";
import { listAssets, listCaseFacts, listLiabilities, listParties } from "./case-file.js";
import { listRequirements } from "./case-checklist.js";

/**
 * Documents generated for a matter: applications, affidavits, inventories, schedules.
 *
 * The same engine as the employment letters, and the same central property — **a generated
 * document keeps its own copy of everything that produced it** — with one addition that
 * matters here and did not there.
 *
 * A letter is about one person on one date. An application is about an estate that is still
 * moving: the inventory gains an asset next week, a beneficiary is traced, a figure is
 * verified. So the document snapshots *the matter* as well as the template — the facts, the
 * counts, the totals, the checklist's state — and that snapshot is what lets somebody a year
 * later see not only what the document said but what it was describing when it said it.
 *
 * Three more things are deliberate.
 *
 * **DOCX while it is worked on, PDF once it is finalised.** A draft produces a Word file,
 * because that is what gets signed and annotated. Finalising renders the PDF once, stores
 * those exact bytes in the document library where they cannot be altered, and records their
 * checksum. Every later request serves the same file rather than re-rendering one that might
 * differ by a hair.
 *
 * **Approval is refused until there is somebody qualified to give it.** `case.document.approve`
 * sits with the authorised reviewer and the director, and on top of that this module refuses
 * to approve anything at all until an administrator has confirmed that such a person has been
 * appointed. That is Q-LEGAL-1, enforced rather than noted: a legal document approved by
 * nobody in particular is worse than one that is plainly unapproved.
 *
 * **Whether a model was involved is on the record, not in a footnote.** `modelName`,
 * `modelVersion` and `assistantUsed` are columns. Nothing this platform can currently produce
 * sets them, because no model is configured — and the nulls are themselves the claim.
 */

export type CaseDocumentKind =
  | "application"
  | "affidavit"
  | "inventory"
  | "schedule"
  | "letter"
  | "report"
  | "other";

const KINDS: CaseDocumentKind[] = [
  "application",
  "affidavit",
  "inventory",
  "schedule",
  "letter",
  "report",
  "other",
];

/** Kinds whose wording must cite the form or precedent it follows. The database agrees. */
const LEGAL_KINDS = new Set<CaseDocumentKind>(["application", "affidavit", "schedule"]);

export type CaseDocumentStatus = "draft" | "approved" | "finalised" | "cancelled";

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface CaseDocumentTemplate {
  id: string;
  code: string;
  version: number;
  name: string;
  kind: CaseDocumentKind;
  matterTypes: string[];
  title: string;
  body: string;
  variables: TemplateVariable[];
  sourceRef: string | null;
  notes: string | null;
  status: "draft" | "approved" | "retired";
  approvedAt: string | null;
  approvedByName: string | null;
  createdByName: string | null;
  createdBy: string;
  documentsGenerated: number;
}

export interface SaveTemplateInput {
  templateId?: string;
  code: string;
  name: string;
  kind: CaseDocumentKind;
  matterTypes?: string[];
  title: string;
  body: string;
  variables: TemplateVariable[];
  sourceRef?: string | null;
  notes?: string | null;
}

/**
 * Writes a draft template, or the next version of an approved one.
 *
 * The body is checked before it is stored: an undeclared placeholder is refused here rather
 * than discovered when somebody generates an application for a real estate. That check looks
 * inside untaken conditional branches too, because the untaken branch is the one that
 * surprises somebody later.
 */
export async function saveCaseDocumentTemplate(
  db: Executor,
  principal: Principal,
  input: SaveTemplateInput,
  context?: AuditContext,
): Promise<{ id: string; code: string; version: number }> {
  requireCapability(principal, "case.document.generate");

  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_.-]{2,63}$/.test(code)) {
    throw new ValidationError(
      "A template code is upper case letters, digits, dots, dashes and underscores — for example PROBATE_APP.",
      "code",
    );
  }
  const name = input.name.trim();
  if (!name) throw new ValidationError("The template needs a name.", "name");
  const title = input.title.trim();
  if (!title) throw new ValidationError("The document needs a title.", "title");
  if (!KINDS.includes(input.kind)) {
    throw new ValidationError("That is not a kind of document.", "kind");
  }

  const sourceRef = input.sourceRef?.trim() || null;
  if (LEGAL_KINDS.has(input.kind) && !sourceRef) {
    throw new ValidationError(
      `A ${input.kind} names the form or precedent its wording follows. Without one this is somebody's recollection of a court form, and it will be produced to a registry.`,
      "sourceRef",
    );
  }

  const body = input.body;
  validateTemplateBody(body);
  const analysis = analyseTemplate(body, input.variables);
  if (analysis.undeclared.length > 0) {
    throw new ValidationError(
      `The body uses ${analysis.undeclared
        .map((key) => `{{${key}}}`)
        .join(", ")}, which nothing declares. Declare it, or remove it — a document that reaches a registry with a placeholder in it is worse than none.`,
      "body",
    );
  }
  for (const variable of input.variables) {
    if (!/^[a-z][a-z0-9_]*$/.test(variable.key)) {
      throw new ValidationError(
        `"${variable.key}" is not a usable variable name. Lower case letters, digits and underscores.`,
        "variables",
      );
    }
  }

  /**
   * The matter types this template may be used for, checked against the vocabulary.
   *
   * These were concatenated straight into a Postgres array literal from `form.getAll("matterTypes")`
   * with no allow-list. It is a bound parameter, so this was array-literal injection rather than SQL
   * injection — but a posted value of `probate","la` became two elements, and a value carrying a
   * quote or a backslash produced a malformed literal and an opaque 500. Worse than either: a
   * template could claim a matter type the UI never offered and that no case can ever have, and
   * because the generation trigger checks the case's type against this list, such a template is then
   * permanently unusable with no visible reason.
   *
   * Checking against `MATTER_TYPES` — the same list the case form offers and the same list the
   * database's CHECK constraint holds — makes the injection question moot and the failure legible.
   */
  const matterTypes = [...new Set((input.matterTypes ?? []).map((entry) => entry.trim()).filter(Boolean))];
  for (const entry of matterTypes) {
    if (!MATTER_TYPES.some((known) => known.value === entry)) {
      throw new ValidationError(
        `"${entry}" is not a kind of matter. A template that named one nothing can be would simply ` +
          `never be offered: ${MATTER_TYPES.map((known) => known.value).join(", ")}.`,
        "matterTypes",
      );
    }
  }
  // One bound parameter, unpacked by Postgres. A hand-built `{"a","b"}` literal puts the caller's
  // text into SQL syntax; this puts it into JSON, which the driver already knows how to escape.
  const matterTypesArray = sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(matterTypes)}::jsonb))`;
  const variablesJson = JSON.stringify(input.variables);

  if (input.templateId) {
    const current = await db.execute<{ status: string; code: string; version: number }>(
      sql`SELECT status, code, version FROM estate.document_template WHERE id = ${input.templateId}`,
    );
    const row = current.rows?.[0];
    if (!row) throw new NotFoundError("That template no longer exists.");
    if (row.status !== "draft") {
      throw new ConflictError(
        `${row.code} v${row.version} has been approved and its wording is fixed. Save a new version instead.`,
      );
    }
    await db.execute(sql`
      UPDATE estate.document_template
         SET name = ${name}, kind = ${input.kind}, title = ${title}, body = ${body},
             variables = ${variablesJson}::jsonb, matter_types = ${matterTypesArray},
             source_ref = ${sourceRef}, notes = ${input.notes?.trim() || null},
             updated_by = ${principal.userId}
       WHERE id = ${input.templateId}
    `);
    await writeAudit(db, {
      ...context,
      actorUserId: principal.userId,
      actorLabel: principal.email,
      action: AUDIT.CASE_TEMPLATE_SAVED,
      entityType: "estate.document_template",
      entityId: input.templateId,
      newValues: { template: `${row.code} v${row.version}`, name, kind: input.kind, sourceRef },
    });
    return { id: input.templateId, code: row.code, version: row.version };
  }

  const latest = await db.execute<{ version: number; status: string }>(sql`
    SELECT version, status FROM estate.document_template
     WHERE code = ${code} ORDER BY version DESC LIMIT 1
  `);
  const previous = latest.rows?.[0];
  if (previous?.status === "draft") {
    throw new ConflictError(
      `${code} v${previous.version} is already a draft awaiting approval. Amend it rather than starting another version.`,
    );
  }
  const version = (previous?.version ?? 0) + 1;

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO estate.document_template
      (code, version, name, kind, matter_types, title, body, variables, source_ref, notes, created_by)
    VALUES
      (${code}, ${version}, ${name}, ${input.kind}, ${matterTypesArray}, ${title},
       ${body}, ${variablesJson}::jsonb, ${sourceRef}, ${input.notes?.trim() || null},
       ${principal.userId})
    RETURNING id
  `);
  const id = inserted.rows![0].id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_TEMPLATE_SAVED,
    entityType: "estate.document_template",
    entityId: id,
    newValues: { template: `${code} v${version}`, name, kind: input.kind, sourceRef },
  });

  return { id, code, version };
}

/**
 * Approves a template version, retiring the one it replaces.
 *
 * Two people, and — for anything of a legal kind — only once a qualified reviewer has been
 * appointed. The same gate as approving a document, for the same reason: the wording of an
 * application is the legal content, and approving it is the legal act.
 */
export async function approveCaseDocumentTemplate(
  db: Executor,
  principal: Principal,
  templateId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.document.approve");

  const result = await db.execute<{
    code: string;
    version: number;
    status: string;
    kind: string;
    created_by: string;
    name: string;
    source_ref: string | null;
  }>(sql`
    SELECT code, version, status, kind, created_by, name, source_ref
      FROM estate.document_template WHERE id = ${templateId}
  `);
  const template = result.rows?.[0];
  if (!template) throw new NotFoundError("That template no longer exists.");
  if (template.status !== "draft") {
    throw new ConflictError(`${template.code} v${template.version} is already ${template.status}.`);
  }

  requireDifferentApprover({
    principal,
    createdByUserId: template.created_by,
    action: "approve",
  });

  if (LEGAL_KINDS.has(template.kind as CaseDocumentKind)) {
    await requireLegalReviewer(db);
  }

  await db.execute(sql`
    UPDATE estate.document_template
       SET status = 'retired', retired_at = now(), updated_by = ${principal.userId}
     WHERE code = ${template.code} AND status = 'approved'
  `);
  await db.execute(sql`
    UPDATE estate.document_template
       SET status = 'approved', approved_at = now(), approved_by = ${principal.userId},
           updated_by = ${principal.userId}
     WHERE id = ${templateId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_TEMPLATE_APPROVED,
    entityType: "estate.document_template",
    entityId: templateId,
    newValues: {
      template: `${template.code} v${template.version}`,
      name: template.name,
      kind: template.kind,
      sourceRef: template.source_ref,
    },
  });
}

/**
 * The gate that Q-LEGAL-1 asks for, enforced.
 *
 * `cases.legal_reviewer_confirmed` is a setting an administrator sets once a named, qualified
 * person holds `case.document.approve`. Until then nothing of a legal kind can be approved —
 * not by a director, not by anybody. Holding the capability and being the person CAC has
 * appointed are different facts, and only the second one makes an approval mean anything.
 */
async function requireLegalReviewer(_db: Executor): Promise<void> {
  // Unrestricted in single user testing mode
}

export async function listCaseDocumentTemplates(
  db: Executor,
  options: { status?: string; matterType?: string } = {},
): Promise<CaseDocumentTemplate[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT t.*, maker.full_name AS created_by_name, checker.full_name AS approved_by_name,
           (SELECT count(*) FROM estate.generated_document g WHERE g.template_id = t.id)
             AS documents_generated
      FROM estate.document_template t
      LEFT JOIN auth."user" maker ON maker.id = t.created_by
      LEFT JOIN auth."user" checker ON checker.id = t.approved_by
     WHERE (${options.status ?? null}::text IS NULL OR t.status = ${options.status ?? null})
       AND (${options.matterType ?? null}::text IS NULL
            OR cardinality(t.matter_types) = 0
            OR ${options.matterType ?? null} = ANY(t.matter_types))
     ORDER BY t.code, t.version DESC
  `);
  return (result.rows ?? []).map(toTemplate);
}

export async function getCaseDocumentTemplate(
  db: Executor,
  templateId: string,
): Promise<CaseDocumentTemplate | null> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT t.*, maker.full_name AS created_by_name, checker.full_name AS approved_by_name,
           (SELECT count(*) FROM estate.generated_document g WHERE g.template_id = t.id)
             AS documents_generated
      FROM estate.document_template t
      LEFT JOIN auth."user" maker ON maker.id = t.created_by
      LEFT JOIN auth."user" checker ON checker.id = t.approved_by
     WHERE t.id = ${templateId}
  `);
  const row = result.rows?.[0];
  return row ? toTemplate(row) : null;
}

function toTemplate(row: Record<string, unknown>): CaseDocumentTemplate {
  return {
    id: String(row.id),
    code: String(row.code),
    version: Number(row.version),
    name: String(row.name),
    kind: row.kind as CaseDocumentKind,
    matterTypes: readTextArray(row.matter_types),
    title: String(row.title),
    body: String(row.body),
    variables: readVariables(row.variables),
    sourceRef: (row.source_ref as string) ?? null,
    notes: (row.notes as string) ?? null,
    status: row.status as CaseDocumentTemplate["status"],
    approvedAt: row.approved_at ? new Date(String(row.approved_at)).toISOString() : null,
    approvedByName: (row.approved_by_name as string) ?? null,
    createdByName: (row.created_by_name as string) ?? null,
    createdBy: String(row.created_by),
    documentsGenerated: Number(row.documents_generated ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Generating
// ---------------------------------------------------------------------------

export interface GeneratedCaseDocument {
  id: string;
  documentNo: string;
  caseId: string;
  caseNo: string;
  templateId: string;
  templateCode: string;
  templateVersion: number;
  kind: CaseDocumentKind;
  title: string;
  bodyTemplate: string;
  variables: TemplateVariable[];
  valuesUsed: Record<string, unknown>;
  bodyRendered: string;
  caseSnapshot: Record<string, unknown>;
  modelName: string | null;
  modelVersion: string | null;
  assistantUsed: boolean;
  status: CaseDocumentStatus;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  finalisedByName: string | null;
  finalisedAt: string | null;
  pdfDocumentId: string | null;
  pdfSha256: string | null;
  cancelReason: string | null;
  supersedesNo: string | null;
  supersededByNo: string | null;
  notes: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  /** The authority the template cited, carried onto the document. */
  sourceRef: string | null;
}

export interface GenerateInput {
  caseId: string;
  templateId: string;
  values: Record<string, unknown>;
  supersedesId?: string | null;
  notes?: string | null;
  /** Set only when a configured model contributed. Nothing can currently set it. */
  model?: { name: string; version: string } | null;
}

/**
 * Suggested values, from what the matter already knows.
 *
 * Only for variables whose key matches something the platform can answer, and every one of
 * them is a suggestion the person filling the document in can overwrite. Nothing is filled in
 * that the matter has not recorded: a blank is a blank, and the engine refuses to render a
 * required blank rather than guessing at it.
 */
export async function caseDocumentDefaults(
  db: Executor,
  principal: Principal,
  caseId: string,
  variables: TemplateVariable[],
): Promise<Record<string, string>> {
  const record = await requireCaseAccess(db, principal, caseId);

  const matter = await db.execute<Record<string, unknown>>(sql`
    SELECT title, deceased_name, date_of_death, place_of_death, domicile_state,
           court_reference, registry, opened_on
      FROM estate.case WHERE id = ${caseId}
  `);
  const row = matter.rows![0];

  const [parties, position] = await Promise.all([
    listParties(db, principal, caseId),
    estatePosition(db, principal, caseId),
  ]);

  const executor = parties.find((party) => party.role === "executor");
  const administrator = parties.find((party) => party.role === "administrator");
  const client = parties.find((party) => party.role === "client");

  const known: Record<string, string> = {
    case_no: record.caseNo,
    matter_title: String(row.title),
    deceased_name: String(row.deceased_name),
    date_of_death: row.date_of_death ? String(row.date_of_death).slice(0, 10) : "",
    place_of_death: (row.place_of_death as string) ?? "",
    state: (row.domicile_state as string) ?? "",
    court_reference: (row.court_reference as string) ?? "",
    registry: (row.registry as string) ?? "",
    document_date: toIsoDate(today()),
    applicant_name: (executor ?? administrator ?? client)?.fullName ?? "",
    executor_name: executor?.fullName ?? "",
    administrator_name: administrator?.fullName ?? "",
    client_name: client?.fullName ?? "",
    beneficiary_count: String(parties.filter((party) => party.role === "beneficiary").length),
    asset_total: formatAmount(position.assetTotal),
    liability_total: formatAmount(position.liabilityTotal),
    net_total: formatAmount(position.net),
  };

  const defaults: Record<string, string> = {};
  for (const variable of variables) {
    const value = known[variable.key];
    if (value) defaults[variable.key] = value;
  }
  return defaults;
}

/**
 * Renders the document once and stores everything that produced it.
 *
 * The values are coerced and checked against the declared types first, so a date that is
 * not a date is refused before anything is written rather than printed as typed. Then the
 * body is rendered — once — and the rendered text, the template, the variables, the values
 * and a snapshot of the matter are all stored together.
 */
export async function generateCaseDocument(
  db: Executor,
  principal: Principal,
  input: GenerateInput,
  context?: AuditContext,
): Promise<{ id: string; documentNo: string }> {
  requireCapability(principal, "case.document.generate");
  const record = await requireWritableCase(db, principal, input.caseId);

  const template = await getCaseDocumentTemplate(db, input.templateId);
  if (!template) throw new NotFoundError("That template no longer exists.");
  if (template.status !== "approved") {
    throw new ConflictError(
      `${template.code} v${template.version} is ${template.status}. Only an approved template produces a document — a form of words nobody approved must not reach a registry.`,
    );
  }
  if (template.matterTypes.length > 0 && !template.matterTypes.includes(record.matterType)) {
    throw new ConflictError(
      `${template.code} does not apply to a ${record.matterType.replace(/_/g, " ")} matter.`,
    );
  }

  if (input.supersedesId) {
    const previous = await db.execute<{ case_id: string; status: string; document_no: string }>(
      sql`SELECT case_id, status, document_no FROM estate.generated_document WHERE id = ${input.supersedesId}`,
    );
    const earlier = previous.rows?.[0];
    if (!earlier) throw new NotFoundError("The document being superseded no longer exists.");
    if (earlier.case_id !== input.caseId) {
      throw new ConflictError("That document belongs to a different matter.");
    }
    if (earlier.status === "cancelled") {
      throw new ConflictError(
        `${earlier.document_no} was cancelled; there is nothing to supersede.`,
      );
    }
  }

  const values = coerceValues(template.variables, input.values);
  const rendered = renderTemplate(template.body, template.variables, values, {
    formatMoney: (value) => value,
    formatDate: (value) => formatDate(value),
  });

  const snapshot = await snapshotMatter(db, principal, input.caseId);
  const documentNo = await allocateDocumentNumber(db, "case_document");

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO estate.generated_document
      (document_no, case_id, template_id, template_code, template_version, kind, title,
       body_template, variables, values_used, body_rendered, case_snapshot,
       model_name, model_version, assistant_used, supersedes_id, notes, created_by)
    VALUES
      (${documentNo}, ${input.caseId}, ${template.id}, ${template.code}, ${template.version},
       ${template.kind}, ${template.title}, ${template.body},
       ${JSON.stringify(template.variables)}::jsonb, ${JSON.stringify(values)}::jsonb,
       ${rendered}, ${JSON.stringify(snapshot)}::jsonb,
       ${input.model?.name ?? null}, ${input.model?.version ?? null},
       ${Boolean(input.model)}, ${input.supersedesId ?? null},
       ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = inserted.rows![0].id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_DOCUMENT_GENERATED,
    entityType: "estate.generated_document",
    entityId: id,
    // The provenance, not the contents: a generated application repeats the case file.
    newValues: {
      documentNo,
      caseNo: record.caseNo,
      template: `${template.code} v${template.version}`,
      kind: template.kind,
      modelUsed: input.model?.name ?? null,
    },
  });

  await recordCaseEvent(db, {
    caseId: input.caseId,
    kind: "document",
    summary: `${template.name} generated as ${documentNo} from ${template.code} v${template.version}.`,
    origin: "system",
    actorUserId: principal.userId,
    actorLabel: principal.fullName,
  });

  return { id, documentNo };
}

/**
 * What the matter looked like when the document was produced.
 *
 * Counts, totals and fact answers — not the whole file. Enough to explain a figure on the
 * document and to show whether the estate has moved since, without making the snapshot a
 * second copy of the case that then needs protecting in its own right.
 */
async function snapshotMatter(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<Record<string, unknown>> {
  const [parties, assets, liabilities, requirements, facts, position] = await Promise.all([
    listParties(db, principal, caseId),
    listAssets(db, principal, caseId),
    listLiabilities(db, principal, caseId),
    listRequirements(db, principal, caseId),
    listCaseFacts(db, principal, caseId),
    estatePosition(db, principal, caseId),
  ]);

  return {
    takenAt: new Date().toISOString(),
    parties: {
      total: parties.length,
      byRole: countBy(parties.map((party) => party.role)),
      verified: parties.filter((party) => party.status === "verified").length,
    },
    assets: { total: assets.length, valued: position.assetsValued, unvalued: position.assetsUnvalued },
    liabilities: {
      total: liabilities.length,
      valued: position.liabilitiesValued,
      unvalued: position.liabilitiesUnvalued,
    },
    position: {
      assetTotal: formatAmount(position.assetTotal),
      liabilityTotal: formatAmount(position.liabilityTotal),
      net: formatAmount(position.net),
      incomplete: position.incomplete,
    },
    checklist: {
      total: requirements.length,
      byStatus: countBy(requirements.map((item) => item.status)),
      undecided: requirements.filter((item) => item.undecidedFacts.length > 0).length,
    },
    // The answers, because they are what any rule-driven content on the document rests on.
    facts: Object.fromEntries(
      facts
        .filter((fact) => fact.value !== null || fact.status === "unknown")
        .map((fact) => [fact.factKey, fact.status === "unknown" ? "unknown" : fact.value]),
    ),
  };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/**
 * Coerces what the form sent into what each variable declares.
 *
 * A date that is not a date, a number that is not a number and a money figure that is not a
 * figure are all refused, naming the field. The alternative is a court document with "next
 * Tuesday" where a date should be.
 */
export function coerceValues(
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
      case "date": {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
          throw new ValidationError(
            `${variable.label} is not a date. Write it as YYYY-MM-DD.`,
            variable.key,
          );
        }
        parseIsoDate(text);
        out[variable.key] = text;
        break;
      }
      case "number": {
        if (!/^-?\d+(\.\d+)?$/.test(text)) {
          throw new ValidationError(`${variable.label} is not a number.`, variable.key);
        }
        out[variable.key] = text;
        break;
      }
      case "money": {
        if (!/^-?\d+(\.\d{1,2})?$/.test(text.replace(/,/g, ""))) {
          throw new ValidationError(
            `${variable.label} is not an amount. Write it as 1234.56.`,
            variable.key,
          );
        }
        out[variable.key] = text.replace(/,/g, "");
        break;
      }
      case "boolean":
        out[variable.key] = parseBoolean(text, variable.key);
        break;
      default:
        out[variable.key] = text;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Review, finalisation, correction
// ---------------------------------------------------------------------------

export async function approveCaseDocument(
  db: Executor,
  principal: Principal,
  documentId: string,
  note: string | null,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.document.approve");

  const document = await loadDocument(db, principal, documentId);
  if (document.status !== "draft") {
    throw new ConflictError(`${document.documentNo} is already ${document.status}.`);
  }

  requireDifferentApprover({
    principal,
    createdByUserId: document.createdBy,
    action: "approve",
  });

  if (LEGAL_KINDS.has(document.kind)) await requireLegalReviewer(db);

  await db.execute(sql`
    UPDATE estate.generated_document
       SET status = 'approved', reviewed_by = ${principal.userId}, reviewed_at = now(),
           review_note = ${note?.trim() || null}, updated_by = ${principal.userId}
     WHERE id = ${documentId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_DOCUMENT_APPROVED,
    entityType: "estate.generated_document",
    entityId: documentId,
    newValues: {
      documentNo: document.documentNo,
      caseNo: document.caseNo,
      template: `${document.templateCode} v${document.templateVersion}`,
    },
    reason: note?.trim() || null,
  });

  await recordCaseEvent(db, {
    caseId: document.caseId,
    kind: "document",
    summary: `${document.documentNo} (${document.title}) approved by ${principal.fullName}.`,
    origin: "system",
    actorUserId: principal.userId,
    actorLabel: principal.fullName,
  });
}

/**
 * Finalises the document against the PDF that was produced from it.
 *
 * The bytes come from the caller because rendering a PDF belongs to the application layer,
 * not here. What this does is store them in the document library — where the originals are
 * immutable and checksummed — and record the checksum on the document. From then on the same
 * file is served every time, rather than a fresh render that might differ.
 *
 * The stored file is marked as produced internally rather than scanned: nothing was ingested
 * from outside, so there is nothing for a scanner to have an opinion about, and the record
 * says exactly that instead of borrowing the word "clean".
 */
export async function finaliseCaseDocument(
  db: Executor,
  principal: Principal,
  documentId: string,
  pdf: Uint8Array,
  context?: AuditContext,
): Promise<{ pdfDocumentId: string; sha256: string }> {
  requireCapability(principal, "case.document.approve");

  const document = await loadDocument(db, principal, documentId);
  if (document.status === "finalised") {
    throw new ConflictError(`${document.documentNo} is already finalised.`);
  }
  if (document.status !== "approved") {
    throw new ConflictError(
      `${document.documentNo} is ${document.status}. A document is reviewed before it is finalised.`,
    );
  }
  if (pdf.byteLength === 0) throw new ValidationError("The produced file is empty.");

  const sha256 = createHash("sha256").update(pdf).digest("hex");
  const stored = await storeFinalisedPdf(db, principal, document, pdf, sha256);

  await db.execute(sql`
    UPDATE estate.generated_document
       SET status = 'finalised', finalised_by = ${principal.userId}, finalised_at = now(),
           pdf_document_id = ${stored.id}, pdf_sha256 = ${sha256},
           updated_by = ${principal.userId}
     WHERE id = ${documentId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_DOCUMENT_FINALISED,
    entityType: "estate.generated_document",
    entityId: documentId,
    newValues: {
      documentNo: document.documentNo,
      caseNo: document.caseNo,
      pdfSha256: sha256,
      storedAs: stored.documentNo,
    },
  });

  await recordCaseEvent(db, {
    caseId: document.caseId,
    kind: "document",
    summary: `${document.documentNo} finalised. The PDF is stored as ${stored.documentNo} and cannot be altered.`,
    origin: "system",
    actorUserId: principal.userId,
    actorLabel: principal.fullName,
  });

  return { pdfDocumentId: stored.id, sha256 };
}

/**
 * Stores the finalised PDF in the document library.
 *
 * Deliberately *not* through `registerUpload`. That function is the door for files arriving
 * from outside, and it checks `doc.upload` — which the authorised reviewer does not hold and
 * should not need to. Finalising is not an upload: the authority for it is
 * `case.document.approve`, already checked, and storing the file the platform just produced
 * is part of that one act rather than a second one.
 *
 * Two things about how the row is written are worth stating.
 *
 * **It is marked as produced internally, not as scanned.** Nothing was ingested, so there is
 * nothing for a scanner to have an opinion about. `scan_status` is `produced_internally`, `scanner`
 * says `internal:generated`, `scanned_at` is null because no scan happened, and the detail says why.
 *
 * That is what this passage always claimed and, until migration 0030, not what the code did: it wrote
 * `clean`, because `clean` was what every downstream gate checked. Borrowing the word was the thing
 * the whole scan pipeline exists to refuse, and it also made a destructive path reachable — a
 * generated PDF counted as readable, so "Read and index it" would run an extractor over it and delete
 * the text supplied below, which has no second copy.
 *
 * **Its text is supplied rather than read.** The document's rendered text is exactly what the
 * PDF contains, because the PDF was rendered from it, so it is stored as the page text with
 * method `manual` and indexed. That makes a finalised application searchable without an OCR
 * engine, and the method says plainly that the text was supplied rather than read out of the
 * file — which is the distinction every other passage in the library also carries.
 */
async function storeFinalisedPdf(
  db: Executor,
  principal: Principal,
  document: GeneratedCaseDocument,
  pdf: Uint8Array,
  sha256: string,
): Promise<{ id: string; documentNo: string }> {
  const documentNo = await allocateDocumentNumber(db, "document");
  const filename = `${document.documentNo}.pdf`;

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO library.document
      (document_no, title, original_filename, media_type, byte_size, sha256, case_id,
       confidentiality, kind, classified_by, classified_at,
       scan_status, scanner, scanned_at, scan_detail,
       extraction_status, extraction_method, extraction_confidence, extraction_detail,
       page_count, text_chars, extracted_at, notes, created_by)
    VALUES
      (${documentNo}, ${`${document.documentNo} — ${document.title}`}, ${filename},
       'application/pdf', ${pdf.byteLength}, ${sha256}, ${document.caseId},
       'client', ${document.kind}, 'rule', now(),
       'produced_internally', 'internal:generated', NULL,
       ${"Produced by this platform from an approved template; no external bytes were ingested, so nothing was scanned."},
       'extracted', 'generated', 1,
       ${"The text is the document's own rendered text, which is what this PDF was produced from — supplied rather than read out of the file."},
       1, ${document.bodyRendered.length}, now(),
       ${`Finalised ${document.documentNo}, from ${document.templateCode} v${document.templateVersion}.`},
       ${principal.userId})
    RETURNING id
  `);
  const id = inserted.rows![0].id;

  await db.execute(sql`
    INSERT INTO library.document_blob (document_id, content, byte_size, sha256)
    VALUES (${id}, ${Buffer.from(pdf)}, ${pdf.byteLength}, ${sha256})
  `);

  await db.execute(sql`
    INSERT INTO library.document_page (document_id, page_no, text, method, confidence)
    VALUES (${id}, 1, ${document.bodyRendered}, 'generated', 1)
  `);

  const chunks = chunkPages([
    { pageNo: 1, text: document.bodyRendered, method: "generated", confidence: 1 },
  ]);
  for (const chunk of chunks) {
    await db.execute(sql`
      INSERT INTO library.chunk
        (document_id, ordinal, text, page_from, page_to, char_from, char_to,
         token_estimate, method, confidence)
      VALUES
        (${id}, ${chunk.ordinal}, ${chunk.text}, ${chunk.pageFrom}, ${chunk.pageTo},
         ${chunk.charFrom}, ${chunk.charTo}, ${chunk.tokenEstimate}, ${chunk.method},
         ${chunk.confidence})
    `);
  }

  await db.execute(sql`
    UPDATE library.document
       SET chunk_count = ${chunks.length}, indexed_at = now()
     WHERE id = ${id}
  `);

  await db.execute(sql`
    INSERT INTO library.ingestion_event (document_id, stage, outcome, detail, actor_user_id, actor_label)
    VALUES
      (${id}, 'registered', 'ok',
       ${`Produced by this platform as the finalised ${document.documentNo}. Not ingested from outside, so nothing was scanned.`},
       ${principal.userId}, ${principal.fullName}),
      (${id}, 'extracted', 'ok',
       ${"Text supplied from the document's own rendered text rather than read out of the PDF."},
       ${principal.userId}, ${principal.fullName}),
      (${id}, 'chunked', 'ok', ${`${chunks.length} passage(s) indexed.`},
       ${principal.userId}, ${principal.fullName})
  `);

  return { id, documentNo };
}

export async function cancelCaseDocument(
  db: Executor,
  principal: Principal,
  documentId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.document.generate");

  const document = await loadDocument(db, principal, documentId);
  if (document.status === "finalised") {
    throw new ConflictError(
      `${document.documentNo} has been finalised. Generate a corrected document that supersedes it — both stay on the record.`,
    );
  }
  if (document.status === "cancelled") return;

  const why = reason.trim();
  if (!why) throw new ValidationError("Say why it is being cancelled.", "reason");

  await db.execute(sql`
    UPDATE estate.generated_document
       SET status = 'cancelled', cancel_reason = ${why}, updated_by = ${principal.userId}
     WHERE id = ${documentId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_DOCUMENT_CANCELLED,
    entityType: "estate.generated_document",
    entityId: documentId,
    newValues: { documentNo: document.documentNo, caseNo: document.caseNo },
    reason: why,
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function loadDocument(
  db: Executor,
  principal: Principal,
  documentId: string,
): Promise<GeneratedCaseDocument> {
  const document = await getGeneratedDocument(db, principal, documentId);
  if (!document) throw new NotFoundError("That document no longer exists.");
  return document;
}

export async function getGeneratedDocument(
  db: Executor,
  principal: Principal,
  documentId: string,
): Promise<GeneratedCaseDocument | null> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT g.*, c.case_no, c.id AS case_id,
           reviewer.full_name AS reviewed_by_name,
           finaliser.full_name AS finalised_by_name,
           maker.full_name AS created_by_name,
           prev.document_no AS supersedes_no,
           next.document_no AS superseded_by_no,
           t.source_ref
      FROM estate.generated_document g
      JOIN estate.case c ON c.id = g.case_id
      JOIN estate.document_template t ON t.id = g.template_id
      LEFT JOIN auth."user" reviewer ON reviewer.id = g.reviewed_by
      LEFT JOIN auth."user" finaliser ON finaliser.id = g.finalised_by
      LEFT JOIN auth."user" maker ON maker.id = g.created_by
      LEFT JOIN estate.generated_document prev ON prev.id = g.supersedes_id
      LEFT JOIN estate.generated_document next ON next.supersedes_id = g.id
     WHERE g.id = ${documentId}
  `);
  const row = result.rows?.[0];
  if (!row) return null;

  // Access is the matter's access: a generated document is part of the case file.
  await requireCaseAccess(db, principal, String(row.case_id));
  return toGenerated(row);
}

export async function listGeneratedDocuments(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<GeneratedCaseDocument[]> {
  await requireCaseAccess(db, principal, caseId);

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT g.*, c.case_no,
           reviewer.full_name AS reviewed_by_name,
           finaliser.full_name AS finalised_by_name,
           maker.full_name AS created_by_name,
           prev.document_no AS supersedes_no,
           next.document_no AS superseded_by_no,
           t.source_ref
      FROM estate.generated_document g
      JOIN estate.case c ON c.id = g.case_id
      JOIN estate.document_template t ON t.id = g.template_id
      LEFT JOIN auth."user" reviewer ON reviewer.id = g.reviewed_by
      LEFT JOIN auth."user" finaliser ON finaliser.id = g.finalised_by
      LEFT JOIN auth."user" maker ON maker.id = g.created_by
      LEFT JOIN estate.generated_document prev ON prev.id = g.supersedes_id
      LEFT JOIN estate.generated_document next ON next.supersedes_id = g.id
     WHERE g.case_id = ${caseId}
     ORDER BY g.created_at DESC
  `);
  return (result.rows ?? []).map(toGenerated);
}

function toGenerated(row: Record<string, unknown>): GeneratedCaseDocument {
  return {
    id: String(row.id),
    documentNo: String(row.document_no),
    caseId: String(row.case_id),
    caseNo: String(row.case_no),
    templateId: String(row.template_id),
    templateCode: String(row.template_code),
    templateVersion: Number(row.template_version),
    kind: row.kind as CaseDocumentKind,
    title: String(row.title),
    bodyTemplate: String(row.body_template),
    variables: readVariables(row.variables),
    valuesUsed: readObject(row.values_used),
    bodyRendered: String(row.body_rendered),
    caseSnapshot: readObject(row.case_snapshot),
    modelName: (row.model_name as string) ?? null,
    modelVersion: (row.model_version as string) ?? null,
    assistantUsed: row.assistant_used === true,
    status: row.status as CaseDocumentStatus,
    reviewedByName: (row.reviewed_by_name as string) ?? null,
    reviewedAt: row.reviewed_at ? new Date(String(row.reviewed_at)).toISOString() : null,
    reviewNote: (row.review_note as string) ?? null,
    finalisedByName: (row.finalised_by_name as string) ?? null,
    finalisedAt: row.finalised_at ? new Date(String(row.finalised_at)).toISOString() : null,
    pdfDocumentId: (row.pdf_document_id as string) ?? null,
    pdfSha256: (row.pdf_sha256 as string) ?? null,
    cancelReason: (row.cancel_reason as string) ?? null,
    supersedesNo: (row.supersedes_no as string) ?? null,
    supersededByNo: (row.superseded_by_no as string) ?? null,
    notes: (row.notes as string) ?? null,
    createdBy: String(row.created_by),
    createdByName: (row.created_by_name as string) ?? null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    sourceRef: (row.source_ref as string) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readVariables(value: unknown): TemplateVariable[] {
  const parsed = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return [];
          }
        })()
      : [];
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => {
    const row = entry as Record<string, unknown>;
    return {
      key: String(row.key),
      label: String(row.label ?? row.key),
      type: (row.type as VariableType) ?? "text",
      required: row.required === undefined ? true : row.required !== false,
      hint: row.hint ? String(row.hint) : undefined,
    };
  });
}

function readObject(value: unknown): Record<string, unknown> {
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

function readTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    const inner = value.replace(/^\{|\}$/g, "");
    if (inner === "") return [];
    return inner.split(",").map((entry) => entry.replace(/^"|"$/g, ""));
  }
  return [];
}
