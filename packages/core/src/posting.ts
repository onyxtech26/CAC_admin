import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, requireDifferentApprover, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { amountToSql, formatAmount, parseAmount, sumAmounts, type Amount } from "./money.js";
import { parseIsoDate, today, toIsoDate } from "./dates.js";
import { requirePeriodForDate } from "./periods.js";
import { allocateDocumentNumber } from "./sequence.js";
import { getSetting } from "./settings.js";

/**
 * The posting engine.
 *
 * This is the only code in the platform that writes to the general ledger.
 * Invoices, receipts, payment vouchers, petty cash and payroll all call in here;
 * none of them keeps a balance of its own. One engine means one place where the
 * rules of double entry are enforced, and one place to read to know they are.
 *
 * The rules, in the order they are checked:
 *
 *  1. every line has a value on exactly one side;
 *  2. debits equal credits, to the cent;
 *  3. the total is not zero;
 *  4. at least two lines — a single-line journal is not an entry;
 *  5. every account exists, is active and is postable;
 *  6. the entry date falls inside an accounting period;
 *  7. the period is open;
 *  8. for manual journals, the poster is not the person who drafted it.
 *
 * Each has a matching constraint or trigger in migrations 0002/0003, so a caller
 * that skips this module still cannot corrupt the ledger. The checks here exist
 * to produce an error a human can act on rather than a constraint name.
 */

export interface JournalLineInput {
  /** Either an id or a code. Code is friendlier for fixtures and imports. */
  accountId?: string;
  accountCode?: string;
  debit?: string | number | bigint | null;
  credit?: string | number | bigint | null;
  description?: string | null;
  costCentreId?: string | null;
  caseId?: string | null;
  taxCodeId?: string | null;
  taxRateId?: string | null;
}

export interface DraftJournalInput {
  entryDate: string;
  memo?: string | null;
  lines: JournalLineInput[];
}

export interface JournalLineView {
  id: string;
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: Amount;
  credit: Amount;
  description: string | null;
  costCentreId: string | null;
  costCentreCode: string | null;
  caseId: string | null;
}

export interface JournalView {
  id: string;
  journalNo: string | null;
  status: "draft" | "posted" | "reversed";
  entryDate: string;
  memo: string | null;
  sourceType: string;
  sourceId: string | null;
  periodId: string;
  periodCode: string;
  periodStatus: "open" | "locked" | "closed";
  totalDebit: Amount;
  totalCredit: Amount;
  postedAt: Date | string | null;
  postedByName: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: Date | string;
  reversesId: string | null;
  reversesNo: string | null;
  reversedById: string | null;
  reversedByNo: string | null;
  reversalReason: string | null;
  lines: JournalLineView[];
}

/** A line after validation: one side only, both sides present as amounts. */
interface NormalisedLine {
  accountId: string;
  accountCode: string;
  debit: Amount;
  credit: Amount;
  description: string | null;
  costCentreId: string | null;
  caseId: string | null;
  taxCodeId: string | null;
  taxRateId: string | null;
}

/**
 * Checks the shape and arithmetic of a set of lines.
 *
 * Pure: no database, no clock. That is what makes the balance rules cheap to
 * test exhaustively, and it means the same function can validate a form before
 * anything is written.
 */
export function validateLines(lines: JournalLineInput[]): {
  totalDebit: Amount;
  totalCredit: Amount;
} {
  const usable = lines.filter((line) => !isBlankLine(line));

  if (usable.length < 2) {
    throw new ValidationError(
      "A journal needs at least two lines: something debited and something credited.",
      "lines",
    );
  }

  const debits: Amount[] = [];
  const credits: Amount[] = [];

  for (const [index, line] of usable.entries()) {
    const position = index + 1;
    const debit = line.debit === null || line.debit === undefined || line.debit === "" ? 0n : parseAmount(line.debit, `lines.${index}.debit`);
    const credit = line.credit === null || line.credit === undefined || line.credit === "" ? 0n : parseAmount(line.credit, `lines.${index}.credit`);

    if (debit < 0n || credit < 0n) {
      throw new ValidationError(
        `Line ${position}: amounts cannot be negative. Put the value on the other side instead.`,
        `lines.${index}`,
      );
    }
    if (debit > 0n && credit > 0n) {
      throw new ValidationError(
        `Line ${position}: enter a debit or a credit, not both.`,
        `lines.${index}`,
      );
    }
    if (debit === 0n && credit === 0n) {
      throw new ValidationError(`Line ${position}: enter an amount.`, `lines.${index}`);
    }
    if (!line.accountId && !line.accountCode) {
      throw new ValidationError(`Line ${position}: choose an account.`, `lines.${index}.account`);
    }

    debits.push(debit);
    credits.push(credit);
  }

  const totalDebit = sumAmounts(debits);
  const totalCredit = sumAmounts(credits);

  if (totalDebit !== totalCredit) {
    const difference = totalDebit - totalCredit;
    throw new ValidationError(
      `The journal is out of balance by ${formatAmount(difference < 0n ? -difference : difference)}. ` +
        `Debits total ${formatAmount(totalDebit)} and credits total ${formatAmount(totalCredit)}.`,
      "lines",
    );
  }
  if (totalDebit === 0n) {
    throw new ValidationError("A journal for nothing has no effect. Enter the amounts.", "lines");
  }

  return { totalDebit, totalCredit };
}

/**
 * A line the user has started and not filled in.
 *
 * The entry form always shows a couple of spare rows. Treating an untouched row
 * as an error would make the form unusable; treating a half-filled one as blank
 * would silently drop data. So: blank only when nothing at all is set.
 */
function isBlankLine(line: JournalLineInput): boolean {
  const empty = (value: unknown) => value === null || value === undefined || value === "";
  return (
    empty(line.accountId) &&
    empty(line.accountCode) &&
    empty(line.debit) &&
    empty(line.credit) &&
    empty(line.description)
  );
}

async function resolveLines(db: Executor, lines: JournalLineInput[]): Promise<NormalisedLine[]> {
  const usable = lines.filter((line) => !isBlankLine(line));
  const resolved: NormalisedLine[] = [];

  for (const [index, line] of usable.entries()) {
    const account = await db.execute<{
      id: string;
      code: string;
      name: string;
      is_postable: boolean;
      is_active: boolean;
    }>(
      line.accountId
        ? sql`SELECT id, code, name, is_postable, is_active FROM accounting.account WHERE id = ${line.accountId}`
        : sql`SELECT id, code, name, is_postable, is_active FROM accounting.account WHERE code = ${line.accountCode}`,
    );
    const found = account.rows?.[0];
    const label = line.accountCode ?? line.accountId;

    if (!found) {
      throw new ValidationError(
        `Line ${index + 1}: there is no account "${label}".`,
        `lines.${index}.account`,
      );
    }
    if (!found.is_postable) {
      throw new ValidationError(
        `Line ${index + 1}: ${found.code} ${found.name} is a heading. Choose one of the accounts under it.`,
        `lines.${index}.account`,
      );
    }
    if (!found.is_active) {
      throw new ValidationError(
        `Line ${index + 1}: ${found.code} ${found.name} is no longer in use.`,
        `lines.${index}.account`,
      );
    }

    resolved.push({
      accountId: found.id,
      accountCode: found.code,
      debit: line.debit ? parseAmount(line.debit) : 0n,
      credit: line.credit ? parseAmount(line.credit) : 0n,
      description: line.description?.trim() || null,
      costCentreId: line.costCentreId || null,
      caseId: line.caseId || null,
      taxCodeId: line.taxCodeId || null,
      taxRateId: line.taxRateId || null,
    });
  }

  return resolved;
}

async function insertLines(db: Executor, journalId: string, lines: NormalisedLine[]): Promise<void> {
  for (const [index, line] of lines.entries()) {
    await db.execute(sql`
      INSERT INTO accounting.journal_line
        (journal_id, line_no, account_id, debit, credit, description, cost_centre_id, case_id, tax_code_id, tax_rate_id)
      VALUES (
        ${journalId}, ${index + 1}, ${line.accountId},
        ${amountToSql(line.debit)}, ${amountToSql(line.credit)},
        ${line.description}, ${line.costCentreId}, ${line.caseId},
        ${line.taxCodeId}, ${line.taxRateId}
      )
    `);
  }
}

/**
 * Creates a draft journal.
 *
 * A draft changes nothing: it does not appear in the trial balance, carries no
 * number, and can be edited or thrown away. That separation is what makes the
 * maker/checker step meaningful — there is something to review before it becomes
 * part of the record.
 */
export async function createDraftJournal(
  db: Executor,
  principal: Principal,
  input: DraftJournalInput,
  context?: AuditContext,
): Promise<{ id: string; periodCode: string }> {
  requireCapability(principal, "accounting.journal.create");

  validateLines(input.lines);
  const entryDate = toIsoDate(parseIsoDate(input.entryDate, "entryDate"));
  const period = await requirePeriodForDate(db, entryDate);

  if (period.status !== "open") {
    throw new ConflictError(
      `Period ${period.code} is ${period.status}. A journal dated ${entryDate} cannot be prepared for it.`,
    );
  }

  const lines = await resolveLines(db, input.lines);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.journal (period_id, entry_date, memo, source_type, status, created_by)
    VALUES (${period.id}, ${entryDate}, ${input.memo?.trim() || null}, 'manual', 'draft', ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await insertLines(db, id, lines);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.JOURNAL_DRAFTED,
    entityType: "journal",
    entityId: id,
    newValues: {
      entryDate,
      period: period.code,
      memo: input.memo ?? null,
      lines: lines.map((line) => ({
        account: line.accountCode,
        debit: amountToSql(line.debit),
        credit: amountToSql(line.credit),
        description: line.description,
      })),
    },
  });

  return { id, periodCode: period.code };
}

/**
 * Replaces a draft's contents.
 *
 * Lines are replaced wholesale rather than patched line by line. A partial
 * update has to reason about which lines moved and which were deleted, and
 * getting that wrong leaves a journal that no longer balances. Replacing is
 * always consistent, and a draft is small.
 */
export async function updateDraftJournal(
  db: Executor,
  principal: Principal,
  journalId: string,
  input: DraftJournalInput,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.journal.create");
  validateLines(input.lines);

  const existing = await db.execute<{
    status: string;
    created_by: string;
    entry_date: string;
    memo: string | null;
  }>(sql`
    SELECT status, created_by, entry_date, memo
      FROM accounting.journal WHERE id = ${journalId} FOR UPDATE
  `);
  const journal = existing.rows?.[0];
  if (!journal) throw new NotFoundError("That journal no longer exists.");
  if (journal.status !== "draft") {
    throw new ConflictError(
      `This journal is ${journal.status} and cannot be edited. Post a reversal instead.`,
    );
  }
  // Someone who can post is reviewing the draft and may correct it; otherwise
  // only its author may.
  if (journal.created_by !== principal.userId && !principal.capabilities.has("accounting.journal.post")) {
    throw new ConflictError("Only the person who prepared this draft can change it.");
  }

  const entryDate = toIsoDate(parseIsoDate(input.entryDate, "entryDate"));
  const period = await requirePeriodForDate(db, entryDate);
  if (period.status !== "open") {
    throw new ConflictError(`Period ${period.code} is ${period.status} and will not accept this date.`);
  }

  const lines = await resolveLines(db, input.lines);

  await db.execute(sql`DELETE FROM accounting.journal_line WHERE journal_id = ${journalId}`);
  await db.execute(sql`
    UPDATE accounting.journal
       SET period_id = ${period.id}, entry_date = ${entryDate},
           memo = ${input.memo?.trim() || null}, updated_by = ${principal.userId}
     WHERE id = ${journalId}
  `);
  await insertLines(db, journalId, lines);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.JOURNAL_UPDATED,
    entityType: "journal",
    entityId: journalId,
    oldValues: { entryDate: String(journal.entry_date).slice(0, 10), memo: journal.memo },
    newValues: {
      entryDate,
      memo: input.memo ?? null,
      lines: lines.map((line) => ({
        account: line.accountCode,
        debit: amountToSql(line.debit),
        credit: amountToSql(line.credit),
      })),
    },
  });
}

/** Discards a draft. Posted journals cannot be deleted; the database refuses. */
export async function deleteDraftJournal(
  db: Executor,
  principal: Principal,
  journalId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "accounting.journal.create");

  const existing = await db.execute<{ status: string; created_by: string; memo: string | null; entry_date: string }>(
    sql`SELECT status, created_by, memo, entry_date FROM accounting.journal WHERE id = ${journalId} FOR UPDATE`,
  );
  const journal = existing.rows?.[0];
  if (!journal) throw new NotFoundError("That journal no longer exists.");
  if (journal.status !== "draft") {
    throw new ConflictError(`This journal is ${journal.status} and cannot be deleted.`);
  }
  if (journal.created_by !== principal.userId && !principal.capabilities.has("accounting.journal.post")) {
    throw new ConflictError("Only the person who prepared this draft can delete it.");
  }

  // Audited before the row goes, so the trail records what was discarded.
  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.JOURNAL_DELETED,
    entityType: "journal",
    entityId: journalId,
    oldValues: { entryDate: String(journal.entry_date).slice(0, 10), memo: journal.memo, status: journal.status },
    reason: options.reason ?? null,
  });

  await db.execute(sql`DELETE FROM accounting.journal WHERE id = ${journalId}`);
}

/**
 * Whether a manual journal must be posted by someone other than its author.
 *
 * Default: yes. It is the standard control, and it is what the RBAC matrix
 * pairs `accounting.journal.create` with `accounting.journal.post` for.
 *
 * It can be switched off, because in a firm where one person holds
 * `accounting.journal.post` the control does not add review — it stops manual
 * journals being posted at all. Turning it off is a decision CAC records against
 * their name in the settings screen, and every self-posted journal is then
 * flagged as such in the audit trail. A compensating control that is visible
 * beats a control that quietly forces someone to share a login.
 */
async function secondPersonRequired(db: Executor): Promise<boolean> {
  return getSetting(db, "accounting.journal_requires_second_person", true);
}

/**
 * Posts a draft to the ledger.
 *
 * From here the entry is part of the record: numbered, dated, attributable, and
 * changeable only by reversal.
 */
export async function postJournal(
  db: Executor,
  principal: Principal,
  journalId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<{ journalNo: string }> {
  requireCapability(principal, "accounting.journal.post");

  const existing = await db.execute<{
    status: string;
    created_by: string;
    source_type: string;
    entry_date: string;
    period_id: string;
    total_debit: string;
    total_credit: string;
  }>(sql`
    SELECT status, created_by, source_type, entry_date, period_id, total_debit, total_credit
      FROM accounting.journal WHERE id = ${journalId} FOR UPDATE
  `);
  const journal = existing.rows?.[0];
  if (!journal) throw new NotFoundError("That journal no longer exists.");
  if (journal.status !== "draft") {
    throw new ConflictError(`This journal is already ${journal.status}.`);
  }

  const selfPosting = journal.created_by === principal.userId;
  if (journal.source_type === "manual" && selfPosting && (await secondPersonRequired(db))) {
    requireDifferentApprover({
      principal,
      createdByUserId: journal.created_by,
      action: "post",
    });
  }

  await assertPostable(db, journalId, journal.period_id);

  const entryDate = String(journal.entry_date).slice(0, 10);
  const journalNo = await allocateDocumentNumber(db, "journal", { on: entryDate });

  await db.execute(sql`
    UPDATE accounting.journal
       SET status = 'posted', journal_no = ${journalNo},
           posted_at = now(), posted_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${journalId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.JOURNAL_POSTED,
    entityType: "journal",
    entityId: journalId,
    oldValues: { status: "draft" },
    newValues: {
      status: "posted",
      journalNo,
      entryDate,
      totalDebit: journal.total_debit,
      // Recorded explicitly rather than inferred later: if the second-person
      // rule was off, the trail says so on the journal it applied to.
      selfPosted: selfPosting,
    },
    reason: options.reason ?? null,
  });

  return { journalNo };
}

/**
 * The checks that must hold at the moment of posting.
 *
 * Re-read from the database rather than trusted from the draft: the period may
 * have been closed, or an account deactivated, since the draft was prepared.
 */
async function assertPostable(db: Executor, journalId: string, periodId: string): Promise<void> {
  const totals = await db.execute<{ debit: string | null; credit: string | null; lines: number }>(sql`
    SELECT SUM(debit)::text AS debit, SUM(credit)::text AS credit, count(*)::int AS lines
      FROM accounting.journal_line WHERE journal_id = ${journalId}
  `);
  const row = totals.rows?.[0];
  const debit = parseAmount(row?.debit ?? "0");
  const credit = parseAmount(row?.credit ?? "0");

  if ((row?.lines ?? 0) < 2) {
    throw new ValidationError("A journal needs at least two lines before it can be posted.", "lines");
  }
  if (debit !== credit) {
    const difference = debit - credit;
    throw new ValidationError(
      `This journal is out of balance by ${formatAmount(difference < 0n ? -difference : difference)} and cannot be posted.`,
      "lines",
    );
  }
  if (debit === 0n) {
    throw new ValidationError("A journal for nothing cannot be posted.", "lines");
  }

  const period = await db.execute<{ code: string; status: string }>(sql`
    SELECT code, status FROM accounting.period WHERE id = ${periodId} FOR SHARE
  `);
  const found = period.rows?.[0];
  if (!found) throw new ConflictError("This journal's accounting period no longer exists.");
  if (found.status !== "open") {
    throw new ConflictError(
      `Period ${found.code} is ${found.status} and will not accept postings. Reopen it, or date the entry in an open period.`,
    );
  }

  const blocked = await db.execute<{ code: string; name: string; reason: string }>(sql`
    SELECT a.code, a.name,
           CASE WHEN a.is_postable THEN 'inactive' ELSE 'heading' END AS reason
      FROM accounting.journal_line l
      JOIN accounting.account a ON a.id = l.account_id
     WHERE l.journal_id = ${journalId}
       AND (a.is_active = false OR a.is_postable = false)
     LIMIT 1
  `);
  const bad = blocked.rows?.[0];
  if (bad) {
    throw new ValidationError(
      bad.reason === "heading"
        ? `${bad.code} ${bad.name} is a heading and cannot be posted to.`
        : `${bad.code} ${bad.name} is no longer in use. Change the line to an active account.`,
      "lines",
    );
  }
}

/**
 * Reverses a posted journal.
 *
 * The only way to undo a posting. A new journal is created with every debit and
 * credit swapped, posted immediately, and linked to the original in both
 * directions. Both entries stay in the ledger and net to zero, so the history
 * shows what was entered, that it was wrong, and what corrected it — which is
 * exactly what an auditor asks for and what deleting the row would destroy.
 *
 * `entryDate` defaults to the original's date when that period is still open,
 * and to today otherwise: a reversal must not be forced into a closed month.
 */
export async function reverseJournal(
  db: Executor,
  principal: Principal,
  journalId: string,
  options: { reason: string; entryDate?: string; context?: AuditContext },
): Promise<{ journalId: string; journalNo: string }> {
  requireCapability(principal, "accounting.journal.reverse");

  const reason = options.reason?.trim();
  if (!reason) {
    throw new ValidationError("A reversal needs a reason. It becomes part of the record.", "reason");
  }

  const existing = await db.execute<{
    id: string;
    journal_no: string;
    status: string;
    entry_date: string;
    memo: string | null;
    source_type: string;
    source_id: string | null;
    reversed_by_id: string | null;
  }>(sql`
    SELECT id, journal_no, status, entry_date, memo, source_type, source_id, reversed_by_id
      FROM accounting.journal WHERE id = ${journalId} FOR UPDATE
  `);
  const original = existing.rows?.[0];
  if (!original) throw new NotFoundError("That journal no longer exists.");
  if (original.status === "draft") {
    throw new ConflictError("This journal has not been posted. Edit or delete the draft instead.");
  }
  if (original.reversed_by_id) {
    throw new ConflictError(`${original.journal_no} has already been reversed.`);
  }

  const originalDate = String(original.entry_date).slice(0, 10);
  const entryDate = options.entryDate
    ? toIsoDate(parseIsoDate(options.entryDate, "entryDate"))
    : await defaultReversalDate(db, originalDate);
  const period = await requirePeriodForDate(db, entryDate);

  if (period.status !== "open") {
    throw new ConflictError(
      `Period ${period.code} is ${period.status}. Choose a date in an open period for the reversal.`,
    );
  }

  const lines = await db.execute<{
    account_id: string;
    debit: string;
    credit: string;
    description: string | null;
    cost_centre_id: string | null;
    case_id: string | null;
    tax_code_id: string | null;
    tax_rate_id: string | null;
  }>(sql`
    SELECT account_id, debit, credit, description, cost_centre_id, case_id, tax_code_id, tax_rate_id
      FROM accounting.journal_line WHERE journal_id = ${journalId} ORDER BY line_no
  `);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.journal
      (period_id, entry_date, memo, source_type, source_id, status, created_by, reverses_id, reversal_reason)
    VALUES (
      ${period.id}, ${entryDate},
      ${`Reversal of ${original.journal_no}${original.memo ? ` - ${original.memo}` : ""}`},
      ${original.source_type}, ${original.source_id}, 'draft', ${principal.userId},
      ${journalId}, ${reason}
    )
    RETURNING id
  `);
  const reversalId = created.rows![0]!.id;

  // Debits become credits. Posting to a deactivated account is deliberately
  // still allowed here: an account can be retired after it was used, and the
  // ability to correct history must not depend on it still being in service.
  for (const [index, line] of (lines.rows ?? []).entries()) {
    await db.execute(sql`
      INSERT INTO accounting.journal_line
        (journal_id, line_no, account_id, debit, credit, description, cost_centre_id, case_id, tax_code_id, tax_rate_id)
      VALUES (
        ${reversalId}, ${index + 1}, ${line.account_id},
        ${line.credit}, ${line.debit},
        ${line.description}, ${line.cost_centre_id}, ${line.case_id},
        ${line.tax_code_id}, ${line.tax_rate_id}
      )
    `);
  }

  const journalNo = await allocateDocumentNumber(db, "journal", { on: entryDate });

  await db.execute(sql`
    UPDATE accounting.journal
       SET status = 'posted', journal_no = ${journalNo},
           posted_at = now(), posted_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${reversalId}
  `);

  await db.execute(sql`
    UPDATE accounting.journal
       SET status = 'reversed', reversed_by_id = ${reversalId}, updated_by = ${principal.userId}
     WHERE id = ${journalId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.JOURNAL_REVERSED,
    entityType: "journal",
    entityId: journalId,
    oldValues: { journalNo: original.journal_no, status: original.status },
    newValues: { status: "reversed", reversedBy: journalNo, reversalDate: entryDate },
    reason,
  });

  return { journalId: reversalId, journalNo };
}

/**
 * Where to date a reversal when the caller has not said.
 *
 * The original's own date when its period is still open — that keeps the
 * correction in the month it belongs to. Otherwise today, because forcing an
 * entry into a closed month is the thing period closing exists to prevent.
 */
async function defaultReversalDate(db: Executor, originalDate: string): Promise<string> {
  const period = await requirePeriodForDate(db, originalDate);
  if (period.status === "open") return originalDate;
  return toIsoDate(today());
}

/**
 * Creates and posts a journal in one step, for a source document.
 *
 * Invoices, receipts and payroll runs use this: the review happened on the
 * document, and its ledger entry is a consequence of approving it rather than a
 * separate thing to approve. There is no maker/checker step here for that
 * reason.
 *
 * `authorisedBy` is the capability that authorises the *document*, and it is
 * checked. Without it this function would be a way to post to the ledger while
 * holding no posting capability at all, which is precisely the hole the engine
 * exists to close.
 */
export async function postSourceJournal(
  db: Executor,
  principal: Principal,
  input: DraftJournalInput & {
    sourceType:
      | "invoice"
      // A bill CAC received. Distinct from "voucher", which is money going out: the two are
      // different events and a payables ledger that cannot tell them apart cannot be aged.
      | "supplier_invoice"
      | "receipt"
      | "voucher"
      | "petty_cash"
      | "claim"
      | "payroll"
      | "opening"
      // A charge or credit the bank applied that the ledger had not recorded. The
      // source is the statement line, so the entry can always be traced back to
      // the bank's own assertion rather than to somebody's recollection.
      | "bank";
    sourceId?: string | null;
    authorisedBy: string;
  },
  context?: AuditContext,
): Promise<{ id: string; journalNo: string }> {
  requireCapability(principal, input.authorisedBy);

  validateLines(input.lines);
  const entryDate = toIsoDate(parseIsoDate(input.entryDate, "entryDate"));
  const period = await requirePeriodForDate(db, entryDate);
  if (period.status !== "open") {
    throw new ConflictError(
      `Period ${period.code} is ${period.status}. This document cannot be posted with that date.`,
    );
  }

  const lines = await resolveLines(db, input.lines);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.journal (period_id, entry_date, memo, source_type, source_id, status, created_by)
    VALUES (${period.id}, ${entryDate}, ${input.memo?.trim() || null}, ${input.sourceType}, ${input.sourceId ?? null}, 'draft', ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await insertLines(db, id, lines);
  await assertPostable(db, id, period.id);

  const journalNo = await allocateDocumentNumber(db, "journal", { on: entryDate });
  await db.execute(sql`
    UPDATE accounting.journal
       SET status = 'posted', journal_no = ${journalNo},
           posted_at = now(), posted_by = ${principal.userId}
     WHERE id = ${id}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.JOURNAL_POSTED,
    entityType: "journal",
    entityId: id,
    newValues: {
      status: "posted",
      journalNo,
      entryDate,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      lines: lines.map((line) => ({
        account: line.accountCode,
        debit: amountToSql(line.debit),
        credit: amountToSql(line.credit),
      })),
    },
  });

  return { id, journalNo };
}

/** One journal with its lines, for the detail screen. */
export async function getJournal(db: Executor, journalId: string): Promise<JournalView | null> {
  const header = await db.execute<{
    id: string;
    journal_no: string | null;
    status: JournalView["status"];
    entry_date: string;
    memo: string | null;
    source_type: string;
    source_id: string | null;
    period_id: string;
    period_code: string;
    period_status: JournalView["periodStatus"];
    total_debit: string;
    total_credit: string;
    posted_at: Date | string | null;
    posted_by_name: string | null;
    created_by: string;
    created_by_name: string | null;
    created_at: Date | string;
    reverses_id: string | null;
    reverses_no: string | null;
    reversed_by_id: string | null;
    reversed_by_no: string | null;
    reversal_reason: string | null;
  }>(sql`
    SELECT j.id, j.journal_no, j.status, j.entry_date, j.memo, j.source_type, j.source_id,
           j.period_id, p.code AS period_code, p.status AS period_status,
           j.total_debit, j.total_credit, j.posted_at,
           pb.full_name AS posted_by_name, j.created_by, cb.full_name AS created_by_name,
           j.created_at, j.reverses_id, orig.journal_no AS reverses_no,
           j.reversed_by_id, rev.journal_no AS reversed_by_no, j.reversal_reason
      FROM accounting.journal j
      JOIN accounting.period p ON p.id = j.period_id
      LEFT JOIN auth."user" pb ON pb.id = j.posted_by
      LEFT JOIN auth."user" cb ON cb.id = j.created_by
      LEFT JOIN accounting.journal orig ON orig.id = j.reverses_id
      LEFT JOIN accounting.journal rev ON rev.id = j.reversed_by_id
     WHERE j.id = ${journalId}
  `);
  const row = header.rows?.[0];
  if (!row) return null;

  const lines = await db.execute<{
    id: string;
    line_no: number;
    account_id: string;
    account_code: string;
    account_name: string;
    debit: string;
    credit: string;
    description: string | null;
    cost_centre_id: string | null;
    cost_centre_code: string | null;
    case_id: string | null;
  }>(sql`
    SELECT l.id, l.line_no, l.account_id, a.code AS account_code, a.name AS account_name,
           l.debit, l.credit, l.description, l.cost_centre_id, c.code AS cost_centre_code, l.case_id
      FROM accounting.journal_line l
      JOIN accounting.account a ON a.id = l.account_id
      LEFT JOIN org.cost_centre c ON c.id = l.cost_centre_id
     WHERE l.journal_id = ${journalId}
     ORDER BY l.line_no
  `);

  return {
    id: row.id,
    journalNo: row.journal_no,
    status: row.status,
    entryDate: String(row.entry_date).slice(0, 10),
    memo: row.memo,
    sourceType: row.source_type,
    sourceId: row.source_id,
    periodId: row.period_id,
    periodCode: row.period_code,
    periodStatus: row.period_status,
    totalDebit: parseAmount(row.total_debit),
    totalCredit: parseAmount(row.total_credit),
    postedAt: row.posted_at,
    postedByName: row.posted_by_name,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    reversesId: row.reverses_id,
    reversesNo: row.reverses_no,
    reversedById: row.reversed_by_id,
    reversedByNo: row.reversed_by_no,
    reversalReason: row.reversal_reason,
    lines: (lines.rows ?? []).map((line) => ({
      id: line.id,
      lineNo: line.line_no,
      accountId: line.account_id,
      accountCode: line.account_code,
      accountName: line.account_name,
      debit: parseAmount(line.debit),
      credit: parseAmount(line.credit),
      description: line.description,
      costCentreId: line.cost_centre_id,
      costCentreCode: line.cost_centre_code,
      caseId: line.case_id,
    })),
  };
}

export interface JournalListFilters {
  status?: "draft" | "posted" | "reversed";
  periodId?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
}

export interface JournalSummary {
  id: string;
  journalNo: string | null;
  status: JournalView["status"];
  entryDate: string;
  memo: string | null;
  sourceType: string;
  periodCode: string;
  total: Amount;
  createdByName: string | null;
  postedByName: string | null;
}

export async function listJournals(
  db: Executor,
  filters: JournalListFilters = {},
): Promise<JournalSummary[]> {
  const where = [sql`true`];
  if (filters.status) where.push(sql`j.status = ${filters.status}`);
  if (filters.periodId) where.push(sql`j.period_id = ${filters.periodId}`);
  if (filters.from) where.push(sql`j.entry_date >= ${toIsoDate(parseIsoDate(filters.from))}::date`);
  if (filters.to) where.push(sql`j.entry_date <= ${toIsoDate(parseIsoDate(filters.to))}::date`);
  if (filters.search?.trim()) {
    const term = `%${filters.search.trim().toLowerCase()}%`;
    where.push(sql`(lower(coalesce(j.journal_no, '')) LIKE ${term} OR lower(coalesce(j.memo, '')) LIKE ${term})`);
  }

  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);

  const result = await db.execute<{
    id: string;
    journal_no: string | null;
    status: JournalView["status"];
    entry_date: string;
    memo: string | null;
    source_type: string;
    period_code: string;
    total_debit: string;
    created_by_name: string | null;
    posted_by_name: string | null;
  }>(sql`
    SELECT j.id, j.journal_no, j.status, j.entry_date, j.memo, j.source_type,
           p.code AS period_code, j.total_debit,
           cb.full_name AS created_by_name, pb.full_name AS posted_by_name
      FROM accounting.journal j
      JOIN accounting.period p ON p.id = j.period_id
      LEFT JOIN auth."user" cb ON cb.id = j.created_by
      LEFT JOIN auth."user" pb ON pb.id = j.posted_by
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY j.entry_date DESC, j.journal_no DESC NULLS FIRST, j.created_at DESC
     LIMIT ${limit}
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    journalNo: row.journal_no,
    status: row.status,
    entryDate: String(row.entry_date).slice(0, 10),
    memo: row.memo,
    sourceType: row.source_type,
    periodCode: row.period_code,
    total: parseAmount(row.total_debit),
    createdByName: row.created_by_name,
    postedByName: row.posted_by_name,
  }));
}
