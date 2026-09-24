import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, requireDifferentApprover, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, toIsoDate } from "./dates.js";
import { amountToSql, parseAmount, type Amount } from "./money.js";

/**
 * The statutory contribution rules — EPF, SOCSO, EIS, PCB, HRD levy.
 *
 * This module is short on arithmetic and long on refusals, and that is deliberate.
 *
 * **None of these is a percentage.** EPF rates differ by age and by wage band.
 * SOCSO and EIS are contribution *tables*: you find the wage band and read the two
 * figures out of it, and the figures are not the band multiplied by anything. PCB is
 * a schedule with reliefs and categories. Writing `wages * 0.11` would be inventing
 * Malaysian law, and the brief is explicit that nothing of the sort happens here.
 *
 * So the rules are **data**: a band table per kind, effective-dated, carrying the
 * citation it came from, approved by a named person, and immutable once approved.
 * Nothing is seeded. Until CAC supplies them — Q-HR-1 — `requireRulesFor` refuses,
 * and payroll refuses with it.
 *
 * **Immutability is what makes payroll reproducible.** A payslip records the rule
 * *version* used for each figure. When rates change in April, a new version is
 * created effective from April; March's payslip still points at March's version, and
 * recomputing March reads that one. A mutable rule table would make every past
 * payslip a function of today's rates.
 */

export type StatutoryKind =
  | "epf_employee"
  | "epf_employer"
  | "socso"
  | "eis"
  | "pcb"
  | "hrd_levy";

export const STATUTORY_KINDS: StatutoryKind[] = [
  "epf_employee",
  "epf_employer",
  "socso",
  "eis",
  "pcb",
  "hrd_levy",
];

export const STATUTORY_LABELS: Record<StatutoryKind, string> = {
  epf_employee: "EPF — employee's share",
  epf_employer: "EPF — employer's share",
  socso: "SOCSO",
  eis: "EIS",
  pcb: "PCB (monthly tax deduction)",
  hrd_levy: "HRD levy",
};

/**
 * A rate band: a wage range, optionally an age range, and a percentage.
 *
 * Used by EPF, where the rate genuinely is a percentage of wages but *which*
 * percentage depends on the band and the age.
 */
export interface RateBand {
  wageFrom: string;
  wageTo: string | null;
  ratePercent: string;
  ageFrom?: number;
  ageTo?: number;
}

/**
 * A contribution band: a wage range and the two amounts, in ringgit.
 *
 * Used by SOCSO and EIS. The amounts are read from the table; they are not the wage
 * multiplied by anything, which is the single most important thing about them.
 */
export interface ContributionBand {
  wageFrom: string;
  wageTo: string | null;
  employee: string;
  employer: string;
}

export interface RateTable {
  bands: RateBand[];
  /** Rounding applied to the result, e.g. "1.00" for the nearest ringgit. */
  roundTo?: string;
}

export interface ContributionTable {
  bands: ContributionBand[];
}

export interface LevyTable {
  ratePercent: string;
  minimumEmployees?: number;
}

export type StatutoryTable = RateTable | ContributionTable | LevyTable;

export interface RuleVersion {
  id: string;
  kind: StatutoryKind;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceRef: string;
  sourceUrl: string | null;
  table: StatutoryTable;
  status: "draft" | "approved" | "superseded";
  notes: string | null;
  approvedByName: string | null;
  approvedAt: Date | string | null;
  createdByName: string | null;
}

/**
 * Checks a table's shape for its kind.
 *
 * The *content* is CAC's to supply and this makes no judgement about whether a rate
 * is correct — it cannot. What it does check is that the table can be read
 * unambiguously: bands in order, no gaps at the bottom, no overlaps, and the right
 * fields present for the kind. An overlapping band means "which rate applies to
 * 3,000" has two answers.
 */
export function validateStatutoryTable(kind: StatutoryKind, table: unknown): void {
  if (typeof table !== "object" || table === null) {
    throw new ValidationError("The rule table is not an object.", "table");
  }

  if (kind === "hrd_levy") {
    const levy = table as LevyTable;
    const rate = Number(levy.ratePercent);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      throw new ValidationError("The levy needs a rate as a percentage.", "table.ratePercent");
    }
    return;
  }

  const bands = (table as { bands?: unknown }).bands;
  if (!Array.isArray(bands) || bands.length === 0) {
    throw new ValidationError(
      "The rule needs at least one wage band. These are tables, not single rates.",
      "table.bands",
    );
  }

  const isContribution = kind === "socso" || kind === "eis";
  let previousTo: Amount | null = null;

  bands.forEach((raw, index) => {
    const band = raw as Record<string, unknown>;
    const where = `table.bands[${index}]`;

    const from = parseAmount(String(band.wageFrom ?? ""), `${where}.wageFrom`);
    const to =
      band.wageTo === null || band.wageTo === undefined || band.wageTo === ""
        ? null
        : parseAmount(String(band.wageTo), `${where}.wageTo`);

    if (to !== null && to < from) {
      throw new ValidationError(`Band ${index + 1} ends below where it starts.`, `${where}.wageTo`);
    }

    // The first band has to start at nil, or wages below it fall through with no
    // rule and the engine would have to invent one.
    if (index === 0 && from !== 0n) {
      throw new ValidationError(
        "The first band has to start at 0, or wages below it would have no rule at all.",
        `${where}.wageFrom`,
      );
    }

    if (previousTo !== null && from !== previousTo + 1n && from !== previousTo) {
      throw new ValidationError(
        `Band ${index + 1} starts at ${band.wageFrom} but the previous band ended at a different ` +
          "figure. Bands have to be contiguous, or some wage falls between two of them.",
        `${where}.wageFrom`,
      );
    }

    if (isContribution) {
      parseAmount(String(band.employee ?? ""), `${where}.employee`);
      parseAmount(String(band.employer ?? ""), `${where}.employer`);
    } else {
      const rate = Number((band as { ratePercent?: unknown }).ratePercent);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        throw new ValidationError(
          `Band ${index + 1} needs a rate as a percentage.`,
          `${where}.ratePercent`,
        );
      }
    }

    previousTo = to;
  });

  // The last band has to be open-ended, or the highest earner has no rule.
  const last = bands[bands.length - 1] as Record<string, unknown>;
  if (last.wageTo !== null && last.wageTo !== undefined && last.wageTo !== "") {
    throw new ValidationError(
      "The last band has to be open-ended (no upper wage), or somebody earning above it would " +
        "have no rule.",
      "table.bands",
    );
  }
}

export async function saveRuleVersion(
  db: Executor,
  principal: Principal,
  input: {
    ruleId?: string;
    kind: StatutoryKind;
    effectiveFrom: string;
    effectiveTo?: string | null;
    sourceRef: string;
    sourceUrl?: string | null;
    table: unknown;
    notes?: string | null;
  },
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "hr.statutory.manage");

  const effectiveFrom = toIsoDate(parseIsoDate(input.effectiveFrom, "effectiveFrom"));
  const effectiveTo = input.effectiveTo
    ? toIsoDate(parseIsoDate(input.effectiveTo, "effectiveTo"))
    : null;

  if (!input.sourceRef?.trim()) {
    throw new ValidationError(
      "Say where this comes from — the gazette, the KWSP schedule, the PERKESO contribution " +
        "table. A statutory figure without a citation is somebody's recollection, and this one " +
        "decides what people are paid.",
      "sourceRef",
    );
  }

  validateStatutoryTable(input.kind, input.table);

  if (input.ruleId) {
    const before = await db.execute<{ status: string }>(
      sql`SELECT status FROM hr.statutory_rule_version WHERE id = ${input.ruleId}`,
    );
    const current = before.rows?.[0];
    if (!current) throw new NotFoundError("That rule version no longer exists.");
    if (current.status !== "draft") {
      throw new ConflictError(
        "An approved rule cannot be edited. Create a new version effective from the date the " +
          "rate changed — that is what keeps past payslips reproducible.",
      );
    }

    await db.execute(sql`
      UPDATE hr.statutory_rule_version SET
        effective_from = ${effectiveFrom}, effective_to = ${effectiveTo},
        source_ref = ${input.sourceRef.trim()}, source_url = ${input.sourceUrl?.trim() || null},
        table_data = ${JSON.stringify(input.table)}::jsonb,
        notes = ${input.notes?.trim() || null}, updated_by = ${principal.userId}
      WHERE id = ${input.ruleId}
    `);

    await writeAudit(db, {
      ...context,
      actorUserId: principal.userId,
      actorLabel: principal.email,
      action: AUDIT.STATUTORY_RULE_SAVED,
      entityType: "statutory_rule_version",
      entityId: input.ruleId,
      newValues: { kind: input.kind, effectiveFrom, sourceRef: input.sourceRef.trim() },
    });

    return { id: input.ruleId };
  }

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.statutory_rule_version
      (kind, effective_from, effective_to, source_ref, source_url, table_data, notes, created_by)
    VALUES (${input.kind}, ${effectiveFrom}, ${effectiveTo}, ${input.sourceRef.trim()},
            ${input.sourceUrl?.trim() || null}, ${JSON.stringify(input.table)}::jsonb,
            ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.STATUTORY_RULE_SAVED,
    entityType: "statutory_rule_version",
    entityId: id,
    newValues: {
      kind: input.kind,
      effectiveFrom,
      effectiveTo,
      sourceRef: input.sourceRef.trim(),
      bands: Array.isArray((input.table as { bands?: unknown[] }).bands)
        ? (input.table as { bands: unknown[] }).bands.length
        : undefined,
    },
  });

  return { id };
}

/**
 * Approves a rule version, which is what makes it usable.
 *
 * Maker/checker applies: the person who entered a statutory table is not the person
 * who confirms it. A wrong EPF table entered and used unchecked is the most expensive
 * single mistake available in this system, and it is wrong for twelve months before
 * anybody notices.
 */
export async function approveRuleVersion(
  db: Executor,
  principal: Principal,
  ruleId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.statutory.manage");

  const found = await db.execute<{
    status: string;
    kind: string;
    created_by: string;
    effective_from: string;
    source_ref: string;
  }>(sql`
    SELECT status, kind, created_by, effective_from, source_ref
      FROM hr.statutory_rule_version WHERE id = ${ruleId} FOR UPDATE
  `);
  const rule = found.rows?.[0];
  if (!rule) throw new NotFoundError("That rule version no longer exists.");
  if (rule.status !== "draft") throw new ConflictError(`That version is already ${rule.status}.`);

  requireDifferentApprover({
    principal,
    createdByUserId: rule.created_by,
    action: "approve a statutory rule",
  });

  // An earlier open-ended version has to be closed off, or two approved versions
  // would cover the same day and "which rate applied" would have two answers.
  await db.execute(sql`
    UPDATE hr.statutory_rule_version
       SET effective_to = (${rule.effective_from}::date - 1), status = 'approved',
           updated_by = ${principal.userId}
     WHERE kind = ${rule.kind} AND status = 'approved' AND effective_to IS NULL
       AND effective_from < ${rule.effective_from}::date
  `);

  await db.execute(sql`
    UPDATE hr.statutory_rule_version
       SET status = 'approved', approved_at = now(), approved_by = ${principal.userId},
           updated_by = ${principal.userId}
     WHERE id = ${ruleId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.STATUTORY_RULE_APPROVED,
    entityType: "statutory_rule_version",
    entityId: ruleId,
    newValues: {
      kind: rule.kind,
      effectiveFrom: String(rule.effective_from).slice(0, 10),
      sourceRef: rule.source_ref,
    },
  });
}

export async function listRuleVersions(
  db: Executor,
  filters: { kind?: StatutoryKind; includeDrafts?: boolean } = {},
): Promise<RuleVersion[]> {
  const result = await db.execute<{
    id: string;
    kind: StatutoryKind;
    effective_from: string;
    effective_to: string | null;
    source_ref: string;
    source_url: string | null;
    table_data: unknown;
    status: "draft" | "approved" | "superseded";
    notes: string | null;
    approved_by_name: string | null;
    approved_at: Date | string | null;
    created_by_name: string | null;
  }>(sql`
    SELECT r.id, r.kind, r.effective_from, r.effective_to, r.source_ref, r.source_url,
           r.table_data, r.status, r.notes, a.full_name AS approved_by_name, r.approved_at,
           c.full_name AS created_by_name
      FROM hr.statutory_rule_version r
      LEFT JOIN auth."user" a ON a.id = r.approved_by
      LEFT JOIN auth."user" c ON c.id = r.created_by
     WHERE ${filters.kind ? sql`r.kind = ${filters.kind}` : sql`true`}
       AND ${filters.includeDrafts === false ? sql`r.status <> 'draft'` : sql`true`}
     ORDER BY r.kind, r.effective_from DESC
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    effectiveFrom: String(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? String(row.effective_to).slice(0, 10) : null,
    sourceRef: row.source_ref,
    sourceUrl: row.source_url,
    table: row.table_data as StatutoryTable,
    status: row.status,
    notes: row.notes,
    approvedByName: row.approved_by_name,
    approvedAt: row.approved_at,
    createdByName: row.created_by_name,
  }));
}

/**
 * The approved rule in force on a date, or null.
 *
 * Null is a real answer and callers have to handle it: it means CAC has not supplied
 * that rule for that period, and the honest consequence is that payroll cannot run.
 */
export async function ruleInForce(
  db: Executor,
  kind: StatutoryKind,
  onDate: string,
): Promise<RuleVersion | null> {
  const date = toIsoDate(parseIsoDate(onDate, "onDate"));

  const result = await db.execute<{
    id: string;
    kind: StatutoryKind;
    effective_from: string;
    effective_to: string | null;
    source_ref: string;
    source_url: string | null;
    table_data: unknown;
    status: "draft" | "approved" | "superseded";
    notes: string | null;
  }>(sql`
    SELECT id, kind, effective_from, effective_to, source_ref, source_url, table_data, status, notes
      FROM hr.statutory_rule_version
     WHERE kind = ${kind} AND status = 'approved'
       AND effective_from <= ${date}::date
       AND (effective_to IS NULL OR effective_to >= ${date}::date)
     ORDER BY effective_from DESC
     LIMIT 1
  `);

  const row = result.rows?.[0];
  if (!row) return null;

  return {
    id: row.id,
    kind: row.kind,
    effectiveFrom: String(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? String(row.effective_to).slice(0, 10) : null,
    sourceRef: row.source_ref,
    sourceUrl: row.source_url,
    table: row.table_data as StatutoryTable,
    status: row.status,
    notes: row.notes,
    approvedByName: null,
    approvedAt: null,
    createdByName: null,
  };
}

export interface RuleAvailability {
  kind: StatutoryKind;
  label: string;
  rule: RuleVersion | null;
}

/** What is and is not available for a date, for the screen that explains the block. */
export async function rulesAvailableFor(
  db: Executor,
  onDate: string,
): Promise<RuleAvailability[]> {
  return Promise.all(
    STATUTORY_KINDS.map(async (kind) => ({
      kind,
      label: STATUTORY_LABELS[kind],
      rule: await ruleInForce(db, kind, onDate),
    })),
  );
}

/**
 * Raised when payroll is asked to run without the rules it needs.
 *
 * A distinct error type, because the caller has to be able to tell "CAC has not
 * supplied the EPF table" from "this employee's record is incomplete". One is a
 * question for the client; the other is a data-entry job.
 */
export class StatutoryRulesMissingError extends Error {
  readonly missing: StatutoryKind[];

  constructor(missing: StatutoryKind[], onDate: string) {
    super(
      `Payroll cannot be computed for ${onDate}: no approved rule is in force for ` +
        `${missing.map((kind) => STATUTORY_LABELS[kind]).join(", ")}. These are contribution ` +
        "schedules rather than percentages, and they are not guessed at — CAC supplies them with " +
        "their source. See Q-HR-1 in docs/OPEN_QUESTIONS.md.",
    );
    this.name = "StatutoryRulesMissingError";
    this.missing = missing;
  }
}

/**
 * Fetches the rules a payroll run needs, or refuses.
 *
 * `required` is worked out from which contributions actually apply to the people in
 * the run — a firm whose staff are all exempt from SOCSO does not need the SOCSO
 * table to run payroll, and demanding it would be a refusal with no purpose.
 */
export async function requireRulesFor(
  db: Executor,
  onDate: string,
  required: StatutoryKind[],
): Promise<Map<StatutoryKind, RuleVersion>> {
  const found = new Map<StatutoryKind, RuleVersion>();
  const missing: StatutoryKind[] = [];

  for (const kind of required) {
    const rule = await ruleInForce(db, kind, onDate);
    if (rule) found.set(kind, rule);
    else missing.push(kind);
  }

  if (missing.length > 0) throw new StatutoryRulesMissingError(missing, onDate);
  return found;
}

// ---------------------------------------------------------------------------
// Reading a table
// ---------------------------------------------------------------------------

/**
 * Finds the band a wage falls in.
 *
 * Exported and pure so the band-finding can be tested directly against the awkward
 * cases: exactly on a boundary, below the first band, above the last.
 */
export function bandFor<T extends { wageFrom: string; wageTo: string | null }>(
  bands: T[],
  wages: Amount,
): T | null {
  for (const band of bands) {
    const from = parseAmount(band.wageFrom);
    const to = band.wageTo === null ? null : parseAmount(band.wageTo);
    if (wages >= from && (to === null || wages <= to)) return band;
  }
  return null;
}

export interface StatutoryResult {
  employee: Amount;
  employer: Amount;
  /** In words, for the payslip: "band 3,000.01–3,100.00" or "11% of 4,500.00". */
  basis: string;
  ruleId: string;
}

/**
 * Applies a rule to a wage.
 *
 * Contribution tables are **read**, not computed: the amount is what the band says.
 * Rate tables are a percentage of wages, rounded as the table specifies. The
 * distinction is the whole reason both shapes exist.
 */
export function applyRule(
  rule: RuleVersion,
  wages: Amount,
  options: { age?: number | null } = {},
): StatutoryResult {
  if (rule.kind === "hrd_levy") {
    const levy = rule.table as LevyTable;
    const rate = Number(levy.ratePercent);
    const amount = roundTo(multiplyPercent(wages, rate), "1.00");
    return {
      employee: 0n,
      employer: amount,
      basis: `${levy.ratePercent}% of ${formatPlain(wages)}`,
      ruleId: rule.id,
    };
  }

  if (rule.kind === "socso" || rule.kind === "eis") {
    const table = rule.table as ContributionTable;
    const band = bandFor(table.bands, wages);
    if (!band) {
      throw new ValidationError(
        `No ${STATUTORY_LABELS[rule.kind]} band covers wages of ${formatPlain(wages)}. The table ` +
          "supplied does not reach that far.",
        "wages",
      );
    }

    return {
      employee: parseAmount(band.employee),
      employer: parseAmount(band.employer),
      // Naming the band, not a calculation, because there is no calculation: the
      // figures are read out of the table.
      basis:
        `contribution table band ${band.wageFrom}–${band.wageTo ?? "above"}` +
        ` (${rule.sourceRef})`,
      ruleId: rule.id,
    };
  }

  const table = rule.table as RateTable;
  const applicable = table.bands.filter((band) => {
    if (options.age === null || options.age === undefined) return true;
    const from = band.ageFrom ?? 0;
    const to = band.ageTo ?? 200;
    return options.age >= from && options.age <= to;
  });

  const band = bandFor(applicable, wages);
  if (!band) {
    throw new ValidationError(
      `No ${STATUTORY_LABELS[rule.kind]} band covers wages of ${formatPlain(wages)}` +
        (options.age !== null && options.age !== undefined ? ` at age ${options.age}` : "") +
        ". The table supplied does not reach that far.",
      "wages",
    );
  }

  const amount = roundTo(multiplyPercent(wages, Number(band.ratePercent)), table.roundTo ?? "0.01");

  // Whose side the figure falls on. EPF has an employee half and an employer half
  // as separate rules; PCB is withheld from the employee's pay and paid over on
  // their behalf, so it is a deduction; the levy is the employer's alone. Getting
  // this wrong does not fail loudly — it silently moves money from one side of the
  // payslip to the other.
  const isEmployeeShare = rule.kind === "epf_employee" || rule.kind === "pcb";

  return {
    employee: isEmployeeShare ? amount : 0n,
    employer: isEmployeeShare ? 0n : amount,
    basis: `${band.ratePercent}% of ${formatPlain(wages)}`,
    ruleId: rule.id,
  };
}

/** A percentage of an amount, at full precision before rounding. */
function multiplyPercent(amount: Amount, percent: number): Amount {
  // Percent arrives as a decimal number; scaling by 10^6 keeps four decimal places
  // of a percentage meaningful before the division.
  const scaled = BigInt(Math.round(percent * 1_000_000));
  return (amount * scaled) / 100_000_000n;
}

/**
 * Rounds up to the nearest step.
 *
 * EPF contributions are rounded **up** to the next ringgit, which is a rule of the
 * scheme rather than ordinary rounding — so this is deliberately not
 * half-away-from-zero. The step comes from the table so a rule that rounds
 * differently can say so.
 */
function roundTo(amount: Amount, step: string): Amount {
  const unit = parseAmount(step);
  if (unit <= 0n) return amount;
  const remainder = amount % unit;
  return remainder === 0n ? amount : amount + (unit - remainder);
}

function formatPlain(amount: Amount): string {
  return amountToSql(amount).replace(/(\.\d{2})\d*$/, "$1");
}
