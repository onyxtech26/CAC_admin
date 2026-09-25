import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, requireDifferentApprover, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, toIsoDate, today } from "./dates.js";

/**
 * The rule engine behind a case checklist.
 *
 * This module is where the platform's boundary with legal advice is drawn, so it is
 * worth being exact about what it does and does not do.
 *
 * **It does not know any law.** There is no Malaysian probate requirement written
 * here, in the migrations, or anywhere else in this repository. What it provides is a
 * way to write a requirement down as data — the requirement, the condition under
 * which it applies, and the authority it comes from — and then apply those recorded
 * requirements to the facts of a case, deterministically and repeatably.
 *
 * **The condition language is deliberately small.** Boolean combinations of
 * comparisons against declared facts. No arithmetic, no lookups, no expressions, no
 * dates computed from other dates. Anything more expressive becomes a language in
 * which somebody can write a legal rule that nobody reviewed, which is the failure
 * this design exists to prevent.
 *
 * **Three-valued, not two.** A condition over a fact nobody has answered evaluates to
 * *undecided*, not false. This is the single most important decision in the file. Two
 * valued logic would silently drop a requirement because a question had not been
 * asked yet, and a checklist that is short because of missing information looks
 * exactly like a checklist that is short because the requirement does not apply. An
 * undecided rule puts its item on the list, flagged with the facts it needs.
 *
 * **Total.** Every condition either evaluates or is refused when the rule is saved.
 * There is no runtime error path that leaves a checklist half-built.
 */

// ---------------------------------------------------------------------------
// The condition language
// ---------------------------------------------------------------------------

/** A comparison against one declared fact. */
export type FactTest =
  /** Answered at all — any value. Use for "we have asked and been told something". */
  | { fact: string; answered: true }
  | { fact: string; is: string | number | boolean }
  | { fact: string; isNot: string | number | boolean }
  | { fact: string; oneOf: string[] }
  /** Numbers only. */
  | { fact: string; atLeast: number }
  | { fact: string; atMost: number }
  /** Dates only, as YYYY-MM-DD. Inclusive. */
  | { fact: string; onOrBefore: string }
  | { fact: string; onOrAfter: string };

export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | FactTest;

/**
 * The verdict.
 *
 * `undecided` carries *which* facts were missing, because that list is what the
 * checklist shows somebody: "this may be required — we do not know whether the
 * deceased left a will".
 */
export type Verdict =
  | { decided: true; applies: boolean }
  | { decided: false; missing: string[] };

/** What the evaluator is given: one answer per fact key, or absent. */
export interface FactValues {
  [factKey: string]: { value: string | null; kind: FactKind } | undefined;
}

export type FactKind = "boolean" | "text" | "number" | "date" | "choice";

const MAX_DEPTH = 8;
const MAX_NODES = 120;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Applies a condition to a case's facts.
 *
 * `{ all: [] }` — the default for a new rule — is vacuously true, which reads
 * correctly: a rule with no conditions applies to every matter of its type. `{ any:
 * [] }` is false, for the same reason.
 *
 * `not` over an undecided condition stays undecided. Negating "we do not know" does
 * not produce knowledge.
 */
export function evaluateCondition(condition: Condition, facts: FactValues): Verdict {
  if ("all" in condition) {
    const missing: string[] = [];
    for (const child of condition.all) {
      const verdict = evaluateCondition(child, facts);
      // One definite false settles it, whatever else is unknown.
      if (verdict.decided && !verdict.applies) return { decided: true, applies: false };
      if (!verdict.decided) missing.push(...verdict.missing);
    }
    return missing.length > 0
      ? { decided: false, missing: unique(missing) }
      : { decided: true, applies: true };
  }

  if ("any" in condition) {
    const missing: string[] = [];
    for (const child of condition.any) {
      const verdict = evaluateCondition(child, facts);
      // One definite true settles it.
      if (verdict.decided && verdict.applies) return { decided: true, applies: true };
      if (!verdict.decided) missing.push(...verdict.missing);
    }
    return missing.length > 0
      ? { decided: false, missing: unique(missing) }
      : { decided: true, applies: false };
  }

  if ("not" in condition) {
    const verdict = evaluateCondition(condition.not, facts);
    return verdict.decided ? { decided: true, applies: !verdict.applies } : verdict;
  }

  return evaluateFactTest(condition, facts);
}

function evaluateFactTest(test: FactTest, facts: FactValues): Verdict {
  // Read before the narrowing below exhausts the union, so the unreachable tail still
  // has the key to report.
  const factKey = test.fact;
  const answer = facts[factKey];
  // Unanswered, or answered "unknown" (which stores a null value): undecided.
  if (!answer || answer.value === null) return { decided: false, missing: [factKey] };

  const raw = answer.value;

  if ("answered" in test) return { decided: true, applies: true };

  if ("is" in test) return decided(raw === String(test.is));
  if ("isNot" in test) return decided(raw !== String(test.isNot));
  if ("oneOf" in test) return decided(test.oneOf.some((option) => option === raw));

  if ("atLeast" in test || "atMost" in test) {
    const value = Number(raw);
    // Cannot happen for a well-typed fact — the database trigger enforces the shape —
    // but a rule must never throw mid-checklist, so a bad value is undecided.
    if (!Number.isFinite(value)) return { decided: false, missing: [factKey] };
    return decided("atLeast" in test ? value >= test.atLeast : value <= test.atMost);
  }

  if ("onOrBefore" in test) return decided(raw <= test.onOrBefore);
  if ("onOrAfter" in test) return decided(raw >= test.onOrAfter);

  // Unreachable for a validated condition.
  return { decided: false, missing: [factKey] };
}

function decided(applies: boolean): Verdict {
  return { decided: true, applies };
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Checks a condition before it is stored.
 *
 * Every fact key must be declared, every operator must suit the fact's type, and the
 * whole thing must be bounded. A rule that referred to a fact nobody collects would
 * be permanently undecided — an item that sits on every checklist saying "we need to
 * know something you cannot record". Catching it here is the difference between a
 * clear message to whoever wrote the rule and a puzzle for whoever uses it.
 *
 * @param definitions the declared facts, by key, with their kinds.
 */
export function validateCondition(
  condition: unknown,
  definitions: Map<string, FactKind>,
  path = "condition",
  depth = 0,
  counter = { nodes: 0 },
): Condition {
  if (depth > MAX_DEPTH) {
    throw new ValidationError(
      `This condition nests more than ${MAX_DEPTH} levels deep. Split it into separate rules — a rule nobody can read is a rule nobody can check.`,
    );
  }
  if (++counter.nodes > MAX_NODES) {
    throw new ValidationError(
      `This condition has more than ${MAX_NODES} parts. Split it into separate rules.`,
    );
  }
  if (typeof condition !== "object" || condition === null || Array.isArray(condition)) {
    throw new ValidationError(`${path} is not a condition.`);
  }

  const node = condition as Record<string, unknown>;
  const keys = Object.keys(node);

  if (keys.length === 1 && (keys[0] === "all" || keys[0] === "any")) {
    const group = keys[0] as "all" | "any";
    const children = node[group];
    if (!Array.isArray(children)) {
      throw new ValidationError(`${path}.${group} must be a list of conditions.`);
    }
    const validated = children.map((child, index) =>
      validateCondition(child, definitions, `${path}.${group}[${index}]`, depth + 1, counter),
    );
    return group === "all" ? { all: validated } : { any: validated };
  }

  if (keys.length === 1 && keys[0] === "not") {
    return { not: validateCondition(node.not, definitions, `${path}.not`, depth + 1, counter) };
  }

  return validateFactTest(node, definitions, path);
}

const NUMERIC_OPERATORS = new Set(["atLeast", "atMost"]);
const DATE_OPERATORS = new Set(["onOrBefore", "onOrAfter"]);
const OPERATORS = new Set([
  "answered",
  "is",
  "isNot",
  "oneOf",
  ...NUMERIC_OPERATORS,
  ...DATE_OPERATORS,
]);

function validateFactTest(
  node: Record<string, unknown>,
  definitions: Map<string, FactKind>,
  path: string,
): FactTest {
  if (typeof node.fact !== "string" || node.fact.trim() === "") {
    throw new ValidationError(`${path} must name a fact, as {"fact": "has_will", ...}.`);
  }
  const factKey = node.fact.trim();
  const kind = definitions.get(factKey);
  if (!kind) {
    throw new ValidationError(
      `There is no question called "${factKey}". Add it to the intake questions first — a rule that waits on a fact nobody records never resolves.`,
    );
  }

  const operators = Object.keys(node).filter((key) => key !== "fact");
  if (operators.length !== 1) {
    throw new ValidationError(
      `${path} must apply exactly one test to "${factKey}", not ${operators.length}.`,
    );
  }
  const operator = operators[0];
  if (!OPERATORS.has(operator)) {
    throw new ValidationError(
      `"${operator}" is not a test this engine performs. Available: ${[...OPERATORS].join(", ")}.`,
    );
  }
  const value = node[operator];

  if (operator === "answered") {
    if (value !== true) throw new ValidationError(`${path}.answered must be true.`);
    return { fact: factKey, answered: true };
  }

  if (NUMERIC_OPERATORS.has(operator)) {
    if (kind !== "number") {
      throw new ValidationError(
        `"${factKey}" is a ${kind} question, so "${operator}" does not apply to it.`,
      );
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ValidationError(`${path}.${operator} must be a number.`);
    }
    return operator === "atLeast"
      ? { fact: factKey, atLeast: value }
      : { fact: factKey, atMost: value };
  }

  if (DATE_OPERATORS.has(operator)) {
    if (kind !== "date") {
      throw new ValidationError(
        `"${factKey}" is a ${kind} question, so "${operator}" does not apply to it.`,
      );
    }
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new ValidationError(`${path}.${operator} must be a date written as YYYY-MM-DD.`);
    }
    // Rejects 2026-02-31 and friends.
    parseIsoDate(value);
    return operator === "onOrBefore"
      ? { fact: factKey, onOrBefore: value }
      : { fact: factKey, onOrAfter: value };
  }

  if (operator === "oneOf") {
    if (!Array.isArray(value) || value.length === 0) {
      throw new ValidationError(`${path}.oneOf must list at least one answer.`);
    }
    const options = value.map((entry) => {
      if (typeof entry !== "string") {
        throw new ValidationError(`${path}.oneOf must be a list of answers written as text.`);
      }
      return entry;
    });
    if (kind === "boolean") {
      throw new ValidationError(
        `"${factKey}" is a yes/no question. Use {"is": true} or {"is": false}.`,
      );
    }
    return { fact: factKey, oneOf: options };
  }

  // is / isNot
  if (kind === "boolean") {
    if (typeof value !== "boolean") {
      throw new ValidationError(`"${factKey}" is a yes/no question, so ${path}.${operator} must be true or false.`);
    }
  } else if (kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ValidationError(`"${factKey}" is a number, so ${path}.${operator} must be a number.`);
    }
  } else if (typeof value !== "string" || value === "") {
    throw new ValidationError(`${path}.${operator} must be the answer to match, written as text.`);
  }

  const comparand = value as string | number | boolean;
  return operator === "is"
    ? { fact: factKey, is: comparand }
    : { fact: factKey, isNot: comparand };
}

/** Every fact key a condition reads. Used to show a rule's dependencies. */
export function factsUsedBy(condition: Condition, into = new Set<string>()): Set<string> {
  if ("all" in condition) condition.all.forEach((child) => factsUsedBy(child, into));
  else if ("any" in condition) condition.any.forEach((child) => factsUsedBy(child, into));
  else if ("not" in condition) factsUsedBy(condition.not, into);
  else into.add(condition.fact);
  return into;
}

/** A condition in words, for the rule list and for the checklist's explanation. */
export function describeCondition(
  condition: Condition,
  labels: Map<string, string> = new Map(),
): string {
  const label = (key: string) => labels.get(key) ?? key;

  if ("all" in condition) {
    if (condition.all.length === 0) return "always";
    return condition.all.map((child) => wrap(child, labels)).join(" and ");
  }
  if ("any" in condition) {
    if (condition.any.length === 0) return "never";
    return condition.any.map((child) => wrap(child, labels)).join(" or ");
  }
  if ("not" in condition) return `not (${describeCondition(condition.not, labels)})`;

  const name = label(condition.fact);
  if ("answered" in condition) return `${name} is known`;
  if ("is" in condition) return `${name} is ${String(condition.is)}`;
  if ("isNot" in condition) return `${name} is not ${String(condition.isNot)}`;
  if ("oneOf" in condition) return `${name} is one of ${condition.oneOf.join(", ")}`;
  if ("atLeast" in condition) return `${name} is at least ${condition.atLeast}`;
  if ("atMost" in condition) return `${name} is at most ${condition.atMost}`;
  if ("onOrBefore" in condition) return `${name} is on or before ${condition.onOrBefore}`;
  return `${name} is on or after ${condition.onOrAfter}`;
}

function wrap(condition: Condition, labels: Map<string, string>): string {
  const text = describeCondition(condition, labels);
  const compound = "all" in condition || "any" in condition;
  return compound ? `(${text})` : text;
}

// ---------------------------------------------------------------------------
// Fact definitions
// ---------------------------------------------------------------------------

export interface FactDefinition {
  id: string;
  key: string;
  label: string;
  kind: FactKind;
  options: string[];
  prompt: string | null;
  helpText: string | null;
  matterTypes: string[];
  sortOrder: number;
  isActive: boolean;
  /** How many approved rules read this question. A question nothing reads is noise. */
  usedByRules: number;
}

const FACT_KINDS: FactKind[] = ["boolean", "text", "number", "date", "choice"];

export interface FactDefinitionInput {
  key: string;
  label: string;
  kind: FactKind;
  options?: string[];
  prompt?: string | null;
  helpText?: string | null;
  matterTypes?: string[];
  sortOrder?: number;
  isActive?: boolean;
}

/**
 * Declares an intake question, or amends one.
 *
 * The key is fixed once answers exist (database trigger), because changing it would
 * orphan every answer already recorded and silently change what the rules see.
 */
export async function saveFactDefinition(
  db: Executor,
  principal: Principal,
  input: FactDefinitionInput,
  context?: AuditContext,
): Promise<string> {
  requireCapability(principal, "case.rule.propose");

  const key = input.key.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(key)) {
    throw new ValidationError(
      "A question's key is lower-case letters, digits and underscores, starting with a letter — for example has_will.",
      "key",
    );
  }
  const label = input.label.trim();
  if (!label) throw new ValidationError("The question needs a label.", "label");
  if (!FACT_KINDS.includes(input.kind)) {
    throw new ValidationError("That is not a kind of question this engine understands.", "kind");
  }

  const options = (input.options ?? []).map((option) => option.trim()).filter(Boolean);
  if (input.kind === "choice" && options.length === 0) {
    throw new ValidationError(
      "A multiple-choice question needs its answers listed. A choice with no options cannot be answered.",
      "options",
    );
  }
  if (input.kind !== "choice" && options.length > 0) {
    throw new ValidationError(
      `A ${input.kind} question does not take a list of answers.`,
      "options",
    );
  }
  if (new Set(options).size !== options.length) {
    throw new ValidationError("Two of those answers are the same.", "options");
  }

  const existing = await db.execute<{ id: string; kind: string }>(
    sql`SELECT id, kind FROM estate.fact_definition WHERE key = ${key}`,
  );
  const before = existing.rows?.[0];

  const matterTypes = input.matterTypes ?? [];
  const optionsJson = JSON.stringify(options);
  const matterTypesJson = `{${matterTypes.map((entry) => `"${entry}"`).join(",")}}`;

  if (before) {
    await db.execute(sql`
      UPDATE estate.fact_definition
         SET label = ${label},
             kind = ${input.kind},
             options = ${optionsJson}::jsonb,
             prompt = ${input.prompt?.trim() || null},
             help_text = ${input.helpText?.trim() || null},
             matter_types = ${matterTypesJson}::text[],
             sort_order = ${input.sortOrder ?? 100},
             is_active = ${input.isActive ?? true},
             updated_by = ${principal.userId}
       WHERE id = ${before.id}
    `);
    await writeAudit(db, {
      ...context,
      actorUserId: principal.userId,
      actorLabel: principal.email,
      action: AUDIT.CASE_FACT_DEFINED,
      entityType: "estate.fact_definition",
      entityId: before.id,
      newValues: { key, label, kind: input.kind, options },
    });
    return before.id;
  }

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO estate.fact_definition
      (key, label, kind, options, prompt, help_text, matter_types, sort_order, is_active, created_by)
    VALUES
      (${key}, ${label}, ${input.kind}, ${optionsJson}::jsonb, ${input.prompt?.trim() || null},
       ${input.helpText?.trim() || null}, ${matterTypesJson}::text[], ${input.sortOrder ?? 100},
       ${input.isActive ?? true}, ${principal.userId})
    RETURNING id
  `);
  const id = inserted.rows![0].id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_FACT_DEFINED,
    entityType: "estate.fact_definition",
    entityId: id,
    newValues: { key, label, kind: input.kind, options },
  });
  return id;
}

export async function listFactDefinitions(
  db: Executor,
  options: { matterType?: string; activeOnly?: boolean } = {},
): Promise<FactDefinition[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT d.id, d.key, d.label, d.kind, d.options, d.prompt, d.help_text,
           d.matter_types, d.sort_order, d.is_active,
           (SELECT count(*) FROM estate.requirement_rule r
             WHERE r.status = 'approved'
               AND r.applies_when::text LIKE '%"' || d.key || '"%') AS used_by_rules
      FROM estate.fact_definition d
     WHERE (${options.activeOnly ?? false} = false OR d.is_active)
       AND (${options.matterType ?? null}::text IS NULL
            OR cardinality(d.matter_types) = 0
            OR ${options.matterType ?? null} = ANY(d.matter_types))
     ORDER BY d.sort_order, d.label
  `);
  return (result.rows ?? []).map(toFactDefinition);
}

function toFactDefinition(row: Record<string, unknown>): FactDefinition {
  return {
    id: String(row.id),
    key: String(row.key),
    label: String(row.label),
    kind: row.kind as FactKind,
    options: readJsonArray(row.options),
    prompt: (row.prompt as string) ?? null,
    helpText: (row.help_text as string) ?? null,
    matterTypes: readTextArray(row.matter_types),
    sortOrder: Number(row.sort_order),
    isActive: row.is_active === true,
    usedByRules: Number(row.used_by_rules ?? 0),
  };
}

function readJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

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

/** The facts a rule engine call needs, keyed for `evaluateCondition`. */
export async function loadCaseFacts(db: Executor, caseId: string): Promise<FactValues> {
  const result = await db.execute<{ fact_key: string; value: string | null; kind: string }>(sql`
    SELECT f.fact_key, f.value, d.kind
      FROM estate.case_fact f
      JOIN estate.fact_definition d ON d.key = f.fact_key
     WHERE f.case_id = ${caseId}
  `);
  const facts: FactValues = {};
  for (const row of result.rows ?? []) {
    facts[row.fact_key] = { value: row.value, kind: row.kind as FactKind };
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Requirement rules
// ---------------------------------------------------------------------------

export type RequirementKind = "document" | "evidence" | "action" | "form" | "consent" | "payment";

const REQUIREMENT_KINDS: RequirementKind[] = [
  "document",
  "evidence",
  "action",
  "form",
  "consent",
  "payment",
];

export interface RequirementRule {
  id: string;
  code: string;
  version: number;
  title: string;
  detail: string | null;
  kind: RequirementKind;
  matterTypes: string[];
  appliesWhen: Condition;
  sourceRef: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  status: "draft" | "approved" | "retired";
  approvedAt: string | null;
  approvedByName: string | null;
  createdByName: string | null;
  createdBy: string;
  notes: string | null;
  /** How many case checklists carry an item from this version. */
  usedOnCases: number;
}

export interface RequirementRuleInput {
  code: string;
  title: string;
  detail?: string | null;
  kind: RequirementKind;
  matterTypes?: string[];
  appliesWhen: unknown;
  sourceRef: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  notes?: string | null;
  /** Amend an existing draft rather than starting a new version. */
  ruleId?: string;
}

const MATTER_TYPES = [
  "probate",
  "letters_of_administration",
  "estate_inventory",
  "valuation",
  "advisory",
  "other",
];

/**
 * Writes a draft rule, or a new version of an approved one.
 *
 * An approved version is never edited. Saving against an approved code produces the
 * next version, in draft, which somebody else then approves — so "what did this rule
 * require when that checklist was built" always has an answer.
 */
export async function saveRequirementRule(
  db: Executor,
  principal: Principal,
  input: RequirementRuleInput,
  context?: AuditContext,
): Promise<{ id: string; code: string; version: number }> {
  requireCapability(principal, "case.rule.propose");

  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_.-]{2,63}$/.test(code)) {
    throw new ValidationError(
      "A rule code is upper-case letters, digits, dots, dashes and underscores — for example DEATH_CERT.",
      "code",
    );
  }
  const title = input.title.trim();
  if (!title) throw new ValidationError("The requirement needs a title.", "title");
  if (!REQUIREMENT_KINDS.includes(input.kind)) {
    throw new ValidationError("That is not a kind of requirement.", "kind");
  }

  // The authority is the reason this table can be trusted at all.
  const sourceRef = input.sourceRef.trim();
  if (!sourceRef) {
    throw new ValidationError(
      "Every rule names the authority it comes from. Without one this is somebody's recollection, and a checklist cannot be built on it.",
      "sourceRef",
    );
  }

  const matterTypes = (input.matterTypes ?? []).map((entry) => entry.trim()).filter(Boolean);
  for (const matterType of matterTypes) {
    if (!MATTER_TYPES.includes(matterType)) {
      throw new ValidationError(`"${matterType}" is not a kind of matter.`, "matterTypes");
    }
  }

  if (input.effectiveFrom) parseIsoDate(input.effectiveFrom);
  if (input.effectiveTo) parseIsoDate(input.effectiveTo);
  if (input.effectiveFrom && input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    throw new ValidationError("The rule cannot stop applying before it starts.", "effectiveTo");
  }

  const definitions = await factKinds(db);
  const condition = validateCondition(input.appliesWhen, definitions);

  const matterTypesJson = `{${matterTypes.map((entry) => `"${entry}"`).join(",")}}`;
  const conditionJson = JSON.stringify(condition);

  // Amending a draft in place.
  if (input.ruleId) {
    const current = await db.execute<{ status: string; code: string; version: number }>(
      sql`SELECT status, code, version FROM estate.requirement_rule WHERE id = ${input.ruleId}`,
    );
    const row = current.rows?.[0];
    if (!row) throw new NotFoundError("That rule no longer exists.");
    if (row.status !== "draft") {
      throw new ConflictError(
        `${row.code} v${row.version} has been approved and is fixed. Save a new version instead.`,
      );
    }
    await db.execute(sql`
      UPDATE estate.requirement_rule
         SET title = ${title}, detail = ${input.detail?.trim() || null}, kind = ${input.kind},
             matter_types = ${matterTypesJson}::text[], applies_when = ${conditionJson}::jsonb,
             source_ref = ${sourceRef}, effective_from = ${input.effectiveFrom ?? null},
             effective_to = ${input.effectiveTo ?? null}, notes = ${input.notes?.trim() || null},
             updated_by = ${principal.userId}
       WHERE id = ${input.ruleId}
    `);
    await writeAudit(db, {
      ...context,
      actorUserId: principal.userId,
      actorLabel: principal.email,
      action: AUDIT.CASE_RULE_SAVED,
      entityType: "estate.requirement_rule",
      entityId: input.ruleId,
      newValues: {
        rule: `${row.code} v${row.version}`,
        title,
        kind: input.kind,
        sourceRef,
        appliesWhen: condition,
      },
    });
    return { id: input.ruleId, code: row.code, version: row.version };
  }

  const latest = await db.execute<{ version: number; status: string }>(sql`
    SELECT version, status FROM estate.requirement_rule
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
    INSERT INTO estate.requirement_rule
      (code, version, title, detail, kind, matter_types, applies_when, source_ref,
       effective_from, effective_to, notes, created_by)
    VALUES
      (${code}, ${version}, ${title}, ${input.detail?.trim() || null}, ${input.kind},
       ${matterTypesJson}::text[], ${conditionJson}::jsonb, ${sourceRef},
       ${input.effectiveFrom ?? null}, ${input.effectiveTo ?? null},
       ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = inserted.rows![0].id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_RULE_SAVED,
    entityType: "estate.requirement_rule",
    entityId: id,
    newValues: {
      rule: `${code} v${version}`,
      title,
      kind: input.kind,
      sourceRef,
      appliesWhen: condition,
    },
  });

  return { id, code, version };
}

/**
 * Approves a rule, retiring the version it replaces.
 *
 * Two people, always. `case.rule.approve` belongs to a named person qualified to say
 * that a legal requirement is what this rule says it is (Q-LEGAL-1); the database
 * refuses the case where that person is also the author.
 */
export async function approveRequirementRule(
  db: Executor,
  principal: Principal,
  ruleId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.rule.approve");

  const result = await db.execute<{
    id: string;
    code: string;
    version: number;
    status: string;
    created_by: string;
    title: string;
    source_ref: string;
  }>(sql`
    SELECT id, code, version, status, created_by, title, source_ref
      FROM estate.requirement_rule WHERE id = ${ruleId}
  `);
  const rule = result.rows?.[0];
  if (!rule) throw new NotFoundError("That rule no longer exists.");
  if (rule.status !== "draft") {
    throw new ConflictError(`${rule.code} v${rule.version} is already ${rule.status}.`);
  }

  requireDifferentApprover({
    principal,
    createdByUserId: rule.created_by,
    action: "approve",
  });

  // Retire the version this replaces first: one approved version per code.
  await db.execute(sql`
    UPDATE estate.requirement_rule
       SET status = 'retired', retired_at = now(), updated_by = ${principal.userId}
     WHERE code = ${rule.code} AND status = 'approved'
  `);

  await db.execute(sql`
    UPDATE estate.requirement_rule
       SET status = 'approved', approved_at = now(), approved_by = ${principal.userId},
           updated_by = ${principal.userId}
     WHERE id = ${ruleId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_RULE_APPROVED,
    entityType: "estate.requirement_rule",
    entityId: ruleId,
    newValues: {
      rule: `${rule.code} v${rule.version}`,
      title: rule.title,
      sourceRef: rule.source_ref,
    },
  });
}

/** Withdraws an approved rule. Existing checklist items keep their snapshot. */
export async function retireRequirementRule(
  db: Executor,
  principal: Principal,
  ruleId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.rule.approve");

  const why = reason.trim();
  if (!why) {
    throw new ValidationError("Say why the rule is being withdrawn.", "reason");
  }

  const result = await db.execute<{ code: string; version: number; status: string; notes: string | null }>(
    sql`SELECT code, version, status, notes FROM estate.requirement_rule WHERE id = ${ruleId}`,
  );
  const rule = result.rows?.[0];
  if (!rule) throw new NotFoundError("That rule no longer exists.");
  if (rule.status !== "approved") {
    throw new ConflictError(`Only an approved rule can be withdrawn; this one is ${rule.status}.`);
  }

  await db.execute(sql`
    UPDATE estate.requirement_rule
       SET status = 'retired', retired_at = now(),
           notes = ${[rule.notes, `Withdrawn: ${why}`].filter(Boolean).join("\n")},
           updated_by = ${principal.userId}
     WHERE id = ${ruleId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_RULE_RETIRED,
    entityType: "estate.requirement_rule",
    entityId: ruleId,
    newValues: { rule: `${rule.code} v${rule.version}` },
    reason: why,
  });
}

export async function listRequirementRules(
  db: Executor,
  options: { status?: string; matterType?: string } = {},
): Promise<RequirementRule[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT r.*, maker.full_name AS created_by_name, checker.full_name AS approved_by_name,
           (SELECT count(*) FROM estate.case_requirement cr WHERE cr.rule_id = r.id) AS used_on_cases
      FROM estate.requirement_rule r
      LEFT JOIN auth."user" maker ON maker.id = r.created_by
      LEFT JOIN auth."user" checker ON checker.id = r.approved_by
     WHERE (${options.status ?? null}::text IS NULL OR r.status = ${options.status ?? null})
       AND (${options.matterType ?? null}::text IS NULL
            OR cardinality(r.matter_types) = 0
            OR ${options.matterType ?? null} = ANY(r.matter_types))
     ORDER BY r.code, r.version DESC
  `);
  return (result.rows ?? []).map(toRequirementRule);
}

export async function getRequirementRule(
  db: Executor,
  ruleId: string,
): Promise<RequirementRule | null> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT r.*, maker.full_name AS created_by_name, checker.full_name AS approved_by_name,
           (SELECT count(*) FROM estate.case_requirement cr WHERE cr.rule_id = r.id) AS used_on_cases
      FROM estate.requirement_rule r
      LEFT JOIN auth."user" maker ON maker.id = r.created_by
      LEFT JOIN auth."user" checker ON checker.id = r.approved_by
     WHERE r.id = ${ruleId}
  `);
  const row = result.rows?.[0];
  return row ? toRequirementRule(row) : null;
}

function toRequirementRule(row: Record<string, unknown>): RequirementRule {
  return {
    id: String(row.id),
    code: String(row.code),
    version: Number(row.version),
    title: String(row.title),
    detail: (row.detail as string) ?? null,
    kind: row.kind as RequirementKind,
    matterTypes: readTextArray(row.matter_types),
    appliesWhen: readCondition(row.applies_when),
    sourceRef: String(row.source_ref),
    effectiveFrom: row.effective_from ? String(row.effective_from).slice(0, 10) : null,
    effectiveTo: row.effective_to ? String(row.effective_to).slice(0, 10) : null,
    status: row.status as RequirementRule["status"],
    approvedAt: row.approved_at ? new Date(String(row.approved_at)).toISOString() : null,
    approvedByName: (row.approved_by_name as string) ?? null,
    createdByName: (row.created_by_name as string) ?? null,
    createdBy: String(row.created_by),
    notes: (row.notes as string) ?? null,
    usedOnCases: Number(row.used_on_cases ?? 0),
  };
}

function readCondition(value: unknown): Condition {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Condition;
    } catch {
      return { all: [] };
    }
  }
  return (value as Condition) ?? { all: [] };
}

/** The declared questions and their types, for validating a condition. */
export async function factKinds(db: Executor): Promise<Map<string, FactKind>> {
  const result = await db.execute<{ key: string; kind: string }>(
    sql`SELECT key, kind FROM estate.fact_definition`,
  );
  const map = new Map<string, FactKind>();
  for (const row of result.rows ?? []) map.set(row.key, row.kind as FactKind);
  return map;
}

/**
 * The rules in force for a matter on a date.
 *
 * Effective-dated like the statutory payroll rules: a checklist built last year was
 * built against the rules in force then, and re-reading it must not silently apply
 * this year's.
 */
export async function rulesInForce(
  db: Executor,
  matterType: string,
  on: string = toIsoDate(today()),
): Promise<RequirementRule[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT r.*, maker.full_name AS created_by_name, checker.full_name AS approved_by_name, 0 AS used_on_cases
      FROM estate.requirement_rule r
      LEFT JOIN auth."user" maker ON maker.id = r.created_by
      LEFT JOIN auth."user" checker ON checker.id = r.approved_by
     WHERE r.status = 'approved'
       AND (cardinality(r.matter_types) = 0 OR ${matterType} = ANY(r.matter_types))
       AND (r.effective_from IS NULL OR r.effective_from <= ${on}::date)
       AND (r.effective_to IS NULL OR r.effective_to >= ${on}::date)
     ORDER BY r.code
  `);
  return (result.rows ?? []).map(toRequirementRule);
}
