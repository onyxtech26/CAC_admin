import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { addMonths, endOfMonth, monthName, parseIsoDate, toIsoDate } from "./dates.js";

/**
 * The fiscal calendar.
 *
 * Every journal belongs to exactly one period, and a period has a status that
 * decides whether it will accept anything more. That is the mechanism behind
 * "the month is closed": not a convention people follow, but a state the
 * database checks on every posting.
 *
 * Periods are created up front for a whole fiscal year rather than on demand.
 * Creating them lazily at posting time sounds convenient and is how entries end
 * up in a period nobody intended, dated outside the year they were meant for.
 */

export interface FiscalYearRow {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  status: "open" | "closed";
}

export interface PeriodRow {
  id: string;
  fiscalYearId: string;
  code: string;
  name: string;
  startsOn: string;
  endsOn: string;
  status: "open" | "locked" | "closed";
}

type RawPeriod = {
  id: string;
  fiscal_year_id: string;
  code: string;
  name: string;
  starts_on: string;
  ends_on: string;
  status: PeriodRow["status"];
};

const toPeriod = (row: RawPeriod): PeriodRow => ({
  id: row.id,
  fiscalYearId: row.fiscal_year_id,
  code: row.code,
  name: row.name,
  startsOn: String(row.starts_on).slice(0, 10),
  endsOn: String(row.ends_on).slice(0, 10),
  status: row.status,
});

export interface CreateFiscalYearInput {
  /** First day. Usually 1 January, but CAC's year-end is a setting. */
  startsOn: string;
  /** Number of periods. 12 monthly by default; 4 gives quarters. */
  periods?: 12 | 4 | 1;
  /** Defaults to the calendar year, or "FY2026/27" when it straddles one. */
  name?: string;
}

/**
 * Creates a fiscal year and its periods in one transaction.
 *
 * Period boundaries are computed, not typed: month lengths, leap years and the
 * final period's end date all follow from the start date. Hand-entered
 * boundaries are where off-by-one-day gaps come from, and a one-day gap is an
 * entry date that belongs to no period at all.
 */
export async function createFiscalYear(
  db: Executor,
  principal: Principal,
  input: CreateFiscalYearInput,
  context?: AuditContext,
): Promise<{ fiscalYearId: string; periods: PeriodRow[] }> {
  requireCapability(principal, "accounting.period.manage");

  const start = parseIsoDate(input.startsOn, "startsOn");
  const count = input.periods ?? 12;
  const monthsPerPeriod = 12 / count;

  if (start.getUTCDate() !== 1) {
    throw new ValidationError("A fiscal year must start on the first of a month.", "startsOn");
  }

  const end = endOfMonth(addMonths(start, 11));
  const name = input.name?.trim() || defaultYearName(start, end);

  const overlapping = await db.execute<{ name: string }>(sql`
    SELECT name FROM accounting.fiscal_year
     WHERE daterange(starts_on, ends_on, '[]') && daterange(${toIsoDate(start)}::date, ${toIsoDate(end)}::date, '[]')
  `);
  if (overlapping.rows?.[0]) {
    throw new ConflictError(
      `That overlaps fiscal year "${overlapping.rows[0].name}", which already covers part of those dates.`,
    );
  }

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.fiscal_year (name, starts_on, ends_on, created_by)
    VALUES (${name}, ${toIsoDate(start)}, ${toIsoDate(end)}, ${principal.userId})
    RETURNING id
  `);
  const fiscalYearId = created.rows![0]!.id;

  const periods: PeriodRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const periodStart = addMonths(start, index * monthsPerPeriod);
    const periodEnd = endOfMonth(addMonths(periodStart, monthsPerPeriod - 1));
    const code = periodCode(periodStart, count, index);
    const label = periodLabel(periodStart, periodEnd, count, index);

    const row = await db.execute<RawPeriod>(sql`
      INSERT INTO accounting.period (fiscal_year_id, code, name, starts_on, ends_on)
      VALUES (${fiscalYearId}, ${code}, ${label}, ${toIsoDate(periodStart)}, ${toIsoDate(periodEnd)})
      RETURNING id, fiscal_year_id, code, name, starts_on, ends_on, status
    `);
    periods.push(toPeriod(row.rows![0]!));
  }

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.FISCAL_YEAR_CREATED,
    entityType: "fiscal_year",
    entityId: fiscalYearId,
    newValues: { name, startsOn: toIsoDate(start), endsOn: toIsoDate(end), periods: periods.length },
  });

  return { fiscalYearId, periods };
}

/**
 * Finds the period an entry date falls in.
 *
 * Returns null rather than creating one. The caller turns that into "no
 * accounting period covers 15 March 2027 — set up the fiscal year first", which
 * is a problem an accountant can act on.
 */
export async function findPeriodForDate(db: Executor, date: string | Date): Promise<PeriodRow | null> {
  const iso = toIsoDate(parseIsoDate(date, "entryDate"));
  const result = await db.execute<RawPeriod>(sql`
    SELECT id, fiscal_year_id, code, name, starts_on, ends_on, status
      FROM accounting.period
     WHERE ${iso}::date BETWEEN starts_on AND ends_on
  `);
  const row = result.rows?.[0];
  return row ? toPeriod(row) : null;
}

/** The period for a date, or a message explaining why there is not one. */
export async function requirePeriodForDate(db: Executor, date: string | Date): Promise<PeriodRow> {
  const period = await findPeriodForDate(db, date);
  if (!period) {
    throw new ValidationError(
      `No accounting period covers ${toIsoDate(parseIsoDate(date))}. Set up the fiscal year that contains it first.`,
      "entryDate",
    );
  }
  return period;
}

export async function listFiscalYears(db: Executor): Promise<FiscalYearRow[]> {
  const result = await db.execute<{
    id: string;
    name: string;
    starts_on: string;
    ends_on: string;
    status: "open" | "closed";
  }>(sql`
    SELECT id, name, starts_on, ends_on, status
      FROM accounting.fiscal_year ORDER BY starts_on DESC
  `);
  return (result.rows ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    startsOn: String(row.starts_on).slice(0, 10),
    endsOn: String(row.ends_on).slice(0, 10),
    status: row.status,
  }));
}

export async function listPeriods(db: Executor, fiscalYearId?: string): Promise<PeriodRow[]> {
  const result = await db.execute<RawPeriod>(
    fiscalYearId
      ? sql`SELECT id, fiscal_year_id, code, name, starts_on, ends_on, status
              FROM accounting.period WHERE fiscal_year_id = ${fiscalYearId} ORDER BY starts_on`
      : sql`SELECT id, fiscal_year_id, code, name, starts_on, ends_on, status
              FROM accounting.period ORDER BY starts_on DESC`,
  );
  return (result.rows ?? []).map(toPeriod);
}

export type PeriodTransition = "lock" | "unlock" | "close" | "reopen";

const TRANSITION: Record<
  PeriodTransition,
  { from: PeriodRow["status"][]; to: PeriodRow["status"]; capability: string; action: string }
> = {
  lock: { from: ["open"], to: "locked", capability: "accounting.period.lock", action: AUDIT.PERIOD_LOCKED },
  unlock: { from: ["locked"], to: "open", capability: "accounting.period.lock", action: AUDIT.PERIOD_UNLOCKED },
  close: { from: ["open", "locked"], to: "closed", capability: "accounting.period.close", action: AUDIT.PERIOD_CLOSED },
  reopen: { from: ["closed"], to: "open", capability: "accounting.period.close", action: AUDIT.PERIOD_REOPENED },
};

/**
 * Moves a period between states.
 *
 * Locking is the reversible one: it stops postings while a month is reviewed and
 * an accountant can lift it. Closing is the statement that the figures are
 * final; reopening one is possible, but it is a deliberate, audited act that
 * needs a reason, because anything already reported from that month is now
 * suspect.
 *
 * The database refuses to lock or close a period with draft journals still in it,
 * and refuses to reopen one whose fiscal year has been closed. Those checks are
 * repeated here only to produce a better message.
 */
export async function transitionPeriod(
  db: Executor,
  principal: Principal,
  periodId: string,
  transition: PeriodTransition,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<PeriodRow> {
  const rule = TRANSITION[transition];
  requireCapability(principal, rule.capability);

  if (transition === "reopen" && !options.reason?.trim()) {
    throw new ValidationError(
      "Reopening a closed period needs a reason. It will be recorded against your name.",
      "reason",
    );
  }

  const current = await db.execute<RawPeriod>(sql`
    SELECT id, fiscal_year_id, code, name, starts_on, ends_on, status
      FROM accounting.period WHERE id = ${periodId} FOR UPDATE
  `);
  const period = current.rows?.[0];
  if (!period) throw new NotFoundError("That accounting period no longer exists.");

  if (!rule.from.includes(period.status)) {
    throw new ConflictError(
      `Period ${period.code} is ${period.status}; it cannot be ${transition === "reopen" ? "reopened" : `${transition}ed`}.`,
    );
  }

  if (transition === "lock" || transition === "close") {
    const drafts = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM accounting.journal
       WHERE period_id = ${periodId} AND status = 'draft'
    `);
    const count = drafts.rows?.[0]?.count ?? 0;
    if (count > 0) {
      throw new ConflictError(
        `Period ${period.code} still has ${count} unposted draft journal${count === 1 ? "" : "s"}. Post or delete them first.`,
      );
    }
  }

  const stamps =
    rule.to === "locked"
      ? sql`, locked_at = now(), locked_by = ${principal.userId}`
      : rule.to === "closed"
        ? sql`, closed_at = now(), closed_by = ${principal.userId}`
        : // Reopening clears the stamps of the state being left, so the columns
          // always describe the current state rather than a stale one.
          sql`, locked_at = NULL, locked_by = NULL, closed_at = NULL, closed_by = NULL`;

  const updated = await db.execute<RawPeriod>(sql`
    UPDATE accounting.period SET status = ${rule.to}${stamps}
     WHERE id = ${periodId}
    RETURNING id, fiscal_year_id, code, name, starts_on, ends_on, status
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: rule.action,
    entityType: "accounting_period",
    entityId: periodId,
    oldValues: { code: period.code, status: period.status },
    newValues: { code: period.code, status: rule.to },
    reason: options.reason ?? null,
  });

  return toPeriod(updated.rows![0]!);
}

/**
 * Closes a fiscal year.
 *
 * Every period must already be closed — the database enforces that. Note what
 * this does *not* do: it does not roll the profit and loss into retained
 * earnings. That closing entry is a posted journal like any other, produced with
 * the year-end reports in phase 3, so it is visible and reversible rather than
 * hidden inside a status change.
 */
export async function closeFiscalYear(
  db: Executor,
  principal: Principal,
  fiscalYearId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "accounting.period.close");

  const found = await db.execute<{ name: string; status: string }>(sql`
    SELECT name, status FROM accounting.fiscal_year WHERE id = ${fiscalYearId} FOR UPDATE
  `);
  const year = found.rows?.[0];
  if (!year) throw new NotFoundError("That fiscal year no longer exists.");
  if (year.status === "closed") throw new ConflictError(`${year.name} is already closed.`);

  const open = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM accounting.period
     WHERE fiscal_year_id = ${fiscalYearId} AND status <> 'closed'
  `);
  const count = open.rows?.[0]?.count ?? 0;
  if (count > 0) {
    throw new ConflictError(
      `${year.name} still has ${count} period${count === 1 ? "" : "s"} that ${count === 1 ? "is" : "are"} not closed.`,
    );
  }

  await db.execute(sql`
    UPDATE accounting.fiscal_year
       SET status = 'closed', closed_at = now(), closed_by = ${principal.userId}
     WHERE id = ${fiscalYearId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.FISCAL_YEAR_CLOSED,
    entityType: "fiscal_year",
    entityId: fiscalYearId,
    oldValues: { name: year.name, status: year.status },
    newValues: { name: year.name, status: "closed" },
    reason: options.reason ?? null,
  });
}

function defaultYearName(start: Date, end: Date): string {
  return start.getUTCFullYear() === end.getUTCFullYear()
    ? `FY${start.getUTCFullYear()}`
    : `FY${start.getUTCFullYear()}/${end.getUTCFullYear().toString().slice(-2)}`;
}

/**
 * Quarters are numbered by their position in the fiscal year, not the calendar
 * one. For a year starting in April, April is Q1 - which is what the accountant
 * means by "first quarter".
 */
function periodCode(start: Date, count: number, index: number): string {
  const year = start.getUTCFullYear();
  if (count === 12) return `${year}-${(start.getUTCMonth() + 1).toString().padStart(2, "0")}`;
  if (count === 4) return `${year}-Q${index + 1}`;
  return `${year}-FULL`;
}

function periodLabel(start: Date, end: Date, count: number, index: number): string {
  if (count === 12) return `${monthName(start.getUTCMonth())} ${start.getUTCFullYear()}`;
  if (count === 4) {
    return `Q${index + 1} ${start.getUTCFullYear()} (${monthName(start.getUTCMonth()).slice(0, 3)}-${monthName(
      end.getUTCMonth(),
    ).slice(0, 3)})`;
  }
  return `${monthName(start.getUTCMonth())} ${start.getUTCFullYear()} to ${monthName(end.getUTCMonth())} ${end.getUTCFullYear()}`;
}
