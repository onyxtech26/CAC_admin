import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { SYSTEM_ACCOUNTS } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, requireDifferentApprover, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, today, toIsoDate } from "./dates.js";
import { amountToSql, formatAmount, parseAmount, type Amount } from "./money.js";
import {
  computeDocumentLines,
  readPurchaseLines,
  writePurchaseLines,
  type DocumentLineInput,
  type PurchaseLine,
} from "./documents.js";
import { postSourceJournal, reverseJournal } from "./posting.js";
import { allocateDocumentNumber } from "./sequence.js";
import { taxFor } from "./tax.js";

/**
 * Petty cash, and what staff spend from their own pockets.
 *
 * Both are small amounts, both are where controls are usually thinnest, and both
 * are where money quietly goes missing. So both go through the ledger like
 * everything else, and both have a second person in the loop.
 *
 * The petty cash **count** is the control that matters. Counting the tin and
 * recording what was in it against what the ledger says is the only way a float
 * is ever reconciled; a difference posts as an expense — small, visible and
 * attributable — rather than the balance being quietly adjusted to fit.
 */

export type PettyCashKind = "top_up" | "expense" | "adjustment";
export type ClaimStatus = "draft" | "submitted" | "approved" | "posted" | "reimbursed" | "rejected";

// ---------------------------------------------------------------------------
// Petty cash
// ---------------------------------------------------------------------------

export interface PettyCashInput {
  kind: PettyCashKind;
  txnDate?: string;
  description: string;
  amount: string;
  /** Top-up: the bank account it came from. Expense: what it was spent on. */
  counterpartAccountId?: string | null;
  counterpartAccountCode?: string | null;
  /** Which float. Defaults to the seeded petty cash account. */
  floatAccountId?: string | null;
  taxCodeId?: string | null;
  receiptRef?: string | null;
  costCentreId?: string | null;
  caseId?: string | null;
}

export async function recordPettyCash(
  db: Executor,
  principal: Principal,
  input: PettyCashInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.pettycash.create");

  const date = toIsoDate(input.txnDate ? parseIsoDate(input.txnDate, "txnDate") : today());
  const amount = parseAmount(input.amount, "amount");
  if (amount <= 0n) throw new ValidationError("Enter the amount.", "amount");

  const description = input.description?.trim();
  if (!description) throw new ValidationError("Say what this was for.", "description");

  const float = await resolveAccount(
    db,
    input.floatAccountId ?? null,
    SYSTEM_ACCOUNTS.pettyCash,
    "floatAccountId",
  );
  const counterpart = await resolveAccount(
    db,
    input.counterpartAccountId ?? null,
    input.counterpartAccountCode ?? null,
    "counterpartAccountId",
  );

  if (input.kind === "top_up" && counterpart.subtype !== "bank" && counterpart.subtype !== "cash") {
    throw new ValidationError(
      `A top-up comes from a bank or cash account; ${counterpart.code} is neither.`,
      "counterpartAccountId",
    );
  }

  // Tax on a petty cash expense is input tax and only claimable while registered;
  // taxFor already knows that and returns nil with a reason when not.
  const tax = input.kind === "expense" ? await taxFor(db, amount, input.taxCodeId, date) : {
    taxRateId: null,
    amount: 0n,
    note: null,
  };

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.petty_cash_txn
      (txn_date, kind, description, amount, counterpart_account_id, float_account_id,
       tax_code_id, tax_rate_id, tax_amount, receipt_ref, cost_centre_id, case_id, created_by)
    VALUES (${date}, ${input.kind}, ${description}, ${amountToSql(amount)}, ${counterpart.id},
            ${float.id}, ${input.taxCodeId ?? null}, ${tax.taxRateId}, ${amountToSql(tax.amount)},
            ${input.receiptRef?.trim() || null}, ${input.costCentreId ?? null},
            ${input.caseId ?? null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PETTY_CASH_RECORDED,
    entityType: "petty_cash_txn",
    entityId: id,
    newValues: {
      kind: input.kind,
      date,
      amount: amountToSql(amount),
      description,
      account: counterpart.code,
    },
  });

  return { id };
}

/**
 * Posts a petty cash movement.
 *
 *   top_up      Dr petty cash        Cr bank
 *   expense     Dr expense (+ tax)   Cr petty cash
 *   adjustment  Dr expense           Cr petty cash   (a counted shortfall)
 *
 * Approving is a separate capability from recording, so the person who spends the
 * money is not the person who confirms it went into the ledger.
 */
export async function postPettyCash(
  db: Executor,
  principal: Principal,
  txnId: string,
  context?: AuditContext,
): Promise<{ txnNo: string; journalNo: string }> {
  requireCapability(principal, "accounting.pettycash.approve");

  const txn = await lockPettyCash(db, txnId);
  if (txn.status !== "draft") throw new ConflictError(`This entry is already ${txn.status}.`);

  const date = String(txn.txn_date).slice(0, 10);
  const amount = parseAmount(txn.amount);
  const tax = parseAmount(txn.tax_amount);
  const txnNo = await allocateDocumentNumber(db, "petty_cash", { on: date });

  const lines =
    txn.kind === "top_up"
      ? [
          { accountId: txn.float_account_id, debit: amountToSql(amount), description: txn.description },
          {
            accountId: txn.counterpart_account_id,
            credit: amountToSql(amount),
            description: `Petty cash float top-up`,
          },
        ]
      : [
          {
            accountId: txn.counterpart_account_id,
            debit: amountToSql(amount - tax),
            description: txn.description,
            costCentreId: txn.cost_centre_id,
            caseId: txn.case_id,
          },
          ...(tax > 0n
            ? [
                {
                  accountCode: SYSTEM_ACCOUNTS.sstInput,
                  debit: amountToSql(tax),
                  description: "Service tax paid",
                },
              ]
            : []),
          {
            accountId: txn.float_account_id,
            credit: amountToSql(amount),
            description: txn.receipt_ref ? `Receipt ${txn.receipt_ref}` : "Paid from petty cash",
          },
        ];

  const journal = await postSourceJournal(
    db,
    principal,
    {
      entryDate: date,
      memo: `Petty cash ${txnNo} — ${txn.description}`,
      sourceType: "petty_cash",
      sourceId: txnId,
      authorisedBy: "accounting.pettycash.approve",
      lines,
    },
    context,
  );

  await db.execute(sql`
    UPDATE accounting.petty_cash_txn
       SET status = 'posted', txn_no = ${txnNo}, journal_id = ${journal.id},
           posted_at = now(), posted_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${txnId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PETTY_CASH_POSTED,
    entityType: "petty_cash_txn",
    entityId: txnId,
    newValues: { txnNo, journalNo: journal.journalNo, amount: txn.amount, kind: txn.kind },
  });

  return { txnNo, journalNo: journal.journalNo };
}

export async function voidPettyCash(
  db: Executor,
  principal: Principal,
  txnId: string,
  options: { reason: string; context?: AuditContext },
): Promise<{ journalNo: string }> {
  requireCapability(principal, "accounting.pettycash.approve");

  const reason = options.reason?.trim();
  if (!reason) throw new ValidationError("A void needs a reason.", "reason");

  const txn = await lockPettyCash(db, txnId);
  if (txn.status !== "posted") throw new ConflictError(`This entry is ${txn.status}.`);
  if (!txn.journal_id) throw new ConflictError("This entry has no ledger entry to reverse.");

  const reversal = await reverseJournal(db, principal, txn.journal_id, {
    reason: `Petty cash ${txn.txn_no} voided: ${reason}`,
    context: options.context,
  });

  await db.execute(sql`
    UPDATE accounting.petty_cash_txn
       SET status = 'void', void_journal_id = ${reversal.journalId}, void_reason = ${reason},
           voided_at = now(), voided_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${txnId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PETTY_CASH_VOIDED,
    entityType: "petty_cash_txn",
    entityId: txnId,
    oldValues: { txnNo: txn.txn_no, amount: txn.amount },
    reason,
  });

  return { journalNo: reversal.journalNo };
}

export interface PettyCashPosition {
  floatAccountId: string;
  floatAccountCode: string;
  floatAccountName: string;
  /** What the ledger says is in the tin. */
  bookBalance: Amount;
  lastCountedOn: string | null;
  lastCountedAmount: Amount | null;
  lastDifference: Amount | null;
  unpostedCount: number;
}

export async function pettyCashPosition(
  db: Executor,
  floatAccountCode: string = SYSTEM_ACCOUNTS.pettyCash,
): Promise<PettyCashPosition | null> {
  const account = await db.execute<{ id: string; code: string; name: string }>(
    sql`SELECT id, code, name FROM accounting.account WHERE code = ${floatAccountCode}`,
  );
  const found = account.rows?.[0];
  if (!found) return null;

  const balance = await db.execute<{ debit: string; credit: string }>(sql`
    SELECT COALESCE(SUM(l.debit) FILTER (WHERE j.id IS NOT NULL), 0)::text AS debit,
           COALESCE(SUM(l.credit) FILTER (WHERE j.id IS NOT NULL), 0)::text AS credit
      FROM accounting.account a
      LEFT JOIN accounting.journal_line l ON l.account_id = a.id
      LEFT JOIN accounting.journal j ON j.id = l.journal_id
        AND j.status IN ('posted', 'reversed')
     WHERE a.id = ${found.id}
  `);

  const lastCount = await db.execute<{
    counted_on: string;
    counted_amount: string;
    difference: string;
  }>(sql`
    SELECT counted_on, counted_amount, difference FROM accounting.petty_cash_count
     WHERE float_account_id = ${found.id} ORDER BY counted_on DESC, created_at DESC LIMIT 1
  `);

  const unposted = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM accounting.petty_cash_txn
     WHERE float_account_id = ${found.id} AND status = 'draft'
  `);

  const row = balance.rows?.[0];
  const count = lastCount.rows?.[0];

  return {
    floatAccountId: found.id,
    floatAccountCode: found.code,
    floatAccountName: found.name,
    bookBalance: parseAmount(row?.debit ?? "0") - parseAmount(row?.credit ?? "0"),
    lastCountedOn: count ? String(count.counted_on).slice(0, 10) : null,
    lastCountedAmount: count ? parseAmount(count.counted_amount) : null,
    lastDifference: count ? parseAmount(count.difference) : null,
    unpostedCount: unposted.rows?.[0]?.count ?? 0,
  };
}

/**
 * Records a physical count of the float.
 *
 * A difference is written off immediately as an expense rather than left as a
 * note: an unexplained shortfall that sits in the balance is one nobody
 * investigates, and one that is posted has a date, an amount and a name against
 * it. Unposted entries block the count, because counting against a book balance
 * that does not yet include what was spent proves nothing.
 */
export async function countPettyCash(
  db: Executor,
  principal: Principal,
  input: {
    countedAmount: string;
    countedOn?: string;
    floatAccountCode?: string;
    notes?: string | null;
  },
  context?: AuditContext,
): Promise<{ difference: Amount; adjustmentTxnId: string | null }> {
  requireCapability(principal, "accounting.pettycash.reconcile");

  const position = await pettyCashPosition(db, input.floatAccountCode ?? SYSTEM_ACCOUNTS.pettyCash);
  if (!position) throw new NotFoundError("That petty cash account does not exist.");

  if (position.unpostedCount > 0) {
    throw new ConflictError(
      `There ${position.unpostedCount === 1 ? "is" : "are"} ${position.unpostedCount} unposted petty cash ` +
        `${position.unpostedCount === 1 ? "entry" : "entries"}. Post them first, or the count is being ` +
        "compared against a balance that does not yet include what was spent.",
    );
  }

  const countedOn = toIsoDate(input.countedOn ? parseIsoDate(input.countedOn, "countedOn") : today());
  const counted = parseAmount(input.countedAmount, "countedAmount");
  if (counted < 0n) throw new ValidationError("A count cannot be negative.", "countedAmount");

  const difference = counted - position.bookBalance;
  let adjustmentTxnId: string | null = null;

  if (difference !== 0n) {
    // A shortfall is an expense; an overage is a negative expense against the
    // same account, so both are visible in the same place at year end.
    const shortfall = difference < 0n;
    const created = await recordPettyCash(
      db,
      principal,
      {
        kind: "adjustment",
        txnDate: countedOn,
        description: shortfall
          ? `Shortfall found on counting the float on ${countedOn}`
          : `Surplus found on counting the float on ${countedOn}`,
        amount: amountToSql(difference < 0n ? -difference : difference),
        counterpartAccountCode: SYSTEM_ACCOUNTS.rounding,
      },
      context,
    );
    adjustmentTxnId = created.id;

    if (shortfall) {
      await postPettyCash(db, principal, adjustmentTxnId, context);
    } else {
      // An overage is the mirror entry: the tin holds more than the books say.
      // Recorded and posted the same way, with the sides swapped at posting time
      // by kind, so it is never silently absorbed.
      await db.execute(sql`
        UPDATE accounting.petty_cash_txn SET kind = 'top_up' WHERE id = ${adjustmentTxnId}
      `);
      await postPettyCash(db, principal, adjustmentTxnId, context);
    }
  }

  await db.execute(sql`
    INSERT INTO accounting.petty_cash_count
      (float_account_id, counted_on, counted_amount, book_amount, difference, notes,
       adjustment_txn_id, counted_by)
    VALUES (${position.floatAccountId}, ${countedOn}, ${amountToSql(counted)},
            ${amountToSql(position.bookBalance)}, ${amountToSql(difference)},
            ${input.notes?.trim() || null}, ${adjustmentTxnId}, ${principal.userId})
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PETTY_CASH_COUNTED,
    entityType: "account",
    entityId: position.floatAccountId,
    newValues: {
      countedOn,
      counted: amountToSql(counted),
      book: amountToSql(position.bookBalance),
      difference: amountToSql(difference),
    },
    reason: input.notes ?? null,
  });

  return { difference, adjustmentTxnId };
}

export interface PettyCashRow {
  id: string;
  txnNo: string | null;
  status: "draft" | "posted" | "void";
  kind: PettyCashKind;
  txnDate: string;
  description: string;
  amount: Amount;
  counterpartCode: string;
  counterpartName: string;
  receiptRef: string | null;
  journalId: string | null;
  journalNo: string | null;
  createdByName: string | null;
}

export async function listPettyCash(
  db: Executor,
  filters: { status?: "draft" | "posted" | "void"; limit?: number } = {},
): Promise<PettyCashRow[]> {
  const result = await db.execute<{
    id: string;
    txn_no: string | null;
    status: PettyCashRow["status"];
    kind: PettyCashKind;
    txn_date: string;
    description: string;
    amount: string;
    counterpart_code: string;
    counterpart_name: string;
    receipt_ref: string | null;
    journal_id: string | null;
    journal_no: string | null;
    created_by_name: string | null;
  }>(sql`
    SELECT t.id, t.txn_no, t.status, t.kind, t.txn_date, t.description, t.amount,
           a.code AS counterpart_code, a.name AS counterpart_name, t.receipt_ref,
           t.journal_id, j.journal_no, u.full_name AS created_by_name
      FROM accounting.petty_cash_txn t
      JOIN accounting.account a ON a.id = t.counterpart_account_id
      LEFT JOIN accounting.journal j ON j.id = t.journal_id
      LEFT JOIN auth."user" u ON u.id = t.created_by
     WHERE ${filters.status ? sql`t.status = ${filters.status}` : sql`true`}
     ORDER BY t.txn_date DESC, t.created_at DESC
     LIMIT ${Math.min(Math.max(filters.limit ?? 100, 1), 500)}
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    txnNo: row.txn_no,
    status: row.status,
    kind: row.kind,
    txnDate: String(row.txn_date).slice(0, 10),
    description: row.description,
    amount: parseAmount(row.amount),
    counterpartCode: row.counterpart_code,
    counterpartName: row.counterpart_name,
    receiptRef: row.receipt_ref,
    journalId: row.journal_id,
    journalNo: row.journal_no,
    createdByName: row.created_by_name,
  }));
}

// ---------------------------------------------------------------------------
// Expense claims
// ---------------------------------------------------------------------------

export interface ClaimInput {
  claimDate?: string;
  periodFrom?: string | null;
  periodTo?: string | null;
  subject?: string | null;
  notes?: string | null;
  lines: DocumentLineInput[];
}

/**
 * A claim is always for the person making it.
 *
 * `claimant_id` comes from the session, never from the form. Letting somebody
 * file a claim on another person's behalf is how a reimbursement ends up in the
 * wrong bank account, and the capability to claim is held by everybody.
 */
export async function createClaim(
  db: Executor,
  principal: Principal,
  input: ClaimInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.claim.create");

  const date = toIsoDate(input.claimDate ? parseIsoDate(input.claimDate, "claimDate") : today());
  const computed = await computeDocumentLines(db, input.lines, date);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.expense_claim
      (claimant_id, claim_date, period_from, period_to, subject, notes, created_by)
    VALUES (${principal.userId}, ${date},
            ${input.periodFrom ? toIsoDate(parseIsoDate(input.periodFrom, "periodFrom")) : null},
            ${input.periodTo ? toIsoDate(parseIsoDate(input.periodTo, "periodTo")) : null},
            ${input.subject?.trim() || null}, ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;
  await writePurchaseLines(db, "expense_claim_line", "claim_id", id, computed.lines, date);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CLAIM_CREATED,
    entityType: "expense_claim",
    entityId: id,
    newValues: { claimDate: date, total: amountToSql(computed.totals.total), lines: computed.lines.length },
  });

  return { id };
}

export async function updateClaim(
  db: Executor,
  principal: Principal,
  claimId: string,
  input: ClaimInput,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.claim.create");

  const claim = await lockClaim(db, claimId);
  if (claim.claimant_id !== principal.userId) {
    throw new ConflictError("A claim can only be changed by the person who made it.");
  }
  if (claim.status !== "draft") {
    throw new ConflictError(`This claim is ${claim.status} and cannot be changed.`);
  }

  const date = toIsoDate(input.claimDate ? parseIsoDate(input.claimDate) : today());
  const computed = await computeDocumentLines(db, input.lines, date);

  await db.execute(sql`DELETE FROM accounting.expense_claim_line WHERE claim_id = ${claimId}`);
  await db.execute(sql`
    UPDATE accounting.expense_claim
       SET claim_date = ${date},
           period_from = ${input.periodFrom ? toIsoDate(parseIsoDate(input.periodFrom)) : null},
           period_to = ${input.periodTo ? toIsoDate(parseIsoDate(input.periodTo)) : null},
           subject = ${input.subject?.trim() || null}, notes = ${input.notes?.trim() || null},
           updated_by = ${principal.userId}
     WHERE id = ${claimId}
  `);
  await writePurchaseLines(db, "expense_claim_line", "claim_id", claimId, computed.lines, date);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CLAIM_UPDATED,
    entityType: "expense_claim",
    entityId: claimId,
    oldValues: { total: claim.total },
    newValues: { total: amountToSql(computed.totals.total) },
  });
}

export async function submitClaim(
  db: Executor,
  principal: Principal,
  claimId: string,
  context?: AuditContext,
): Promise<{ claimNo: string }> {
  requireCapability(principal, "accounting.claim.create");

  const claim = await lockClaim(db, claimId);
  if (claim.claimant_id !== principal.userId) {
    throw new ConflictError("Only the person who made a claim can submit it.");
  }
  if (claim.status !== "draft") throw new ConflictError(`This claim is already ${claim.status}.`);
  if (parseAmount(claim.total) <= 0n) {
    throw new ValidationError("A claim for nothing cannot be submitted.", "lines");
  }

  const claimNo =
    claim.claim_no ??
    (await allocateDocumentNumber(db, "claim", { on: String(claim.claim_date).slice(0, 10) }));

  await db.execute(sql`
    UPDATE accounting.expense_claim
       SET status = 'submitted', claim_no = ${claimNo}, submitted_at = now(),
           updated_by = ${principal.userId}
     WHERE id = ${claimId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CLAIM_SUBMITTED,
    entityType: "expense_claim",
    entityId: claimId,
    newValues: { claimNo, total: claim.total },
  });

  return { claimNo };
}

export async function decideClaim(
  db: Executor,
  principal: Principal,
  claimId: string,
  decision: "approved" | "rejected",
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "accounting.claim.approve");

  const claim = await lockClaim(db, claimId);
  if (claim.status !== "submitted") {
    throw new ConflictError(`Only a submitted claim can be decided; this one is ${claim.status}.`);
  }

  // Nobody approves their own expenses. This is the whole control.
  requireDifferentApprover({ principal, createdByUserId: claim.claimant_id, action: "approve" });

  if (decision === "rejected" && !options.reason?.trim()) {
    throw new ValidationError("Say why the claim is being rejected. The claimant sees it.", "reason");
  }

  await db.execute(sql`
    UPDATE accounting.expense_claim
       SET status = ${decision},
           approved_at = ${decision === "approved" ? sql`now()` : sql`NULL`},
           approved_by = ${decision === "approved" ? principal.userId : null},
           rejected_at = ${decision === "rejected" ? sql`now()` : sql`NULL`},
           rejected_by = ${decision === "rejected" ? principal.userId : null},
           reject_reason = ${decision === "rejected" ? options.reason!.trim() : null},
           updated_by = ${principal.userId}
     WHERE id = ${claimId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: decision === "approved" ? AUDIT.CLAIM_APPROVED : AUDIT.CLAIM_REJECTED,
    entityType: "expense_claim",
    entityId: claimId,
    newValues: { claimNo: claim.claim_no, total: claim.total, decision },
    reason: options.reason ?? null,
  });
}

/**
 * Posts an approved claim.
 *
 *   Dr each expense line (+ input tax)
 *     Cr staff claims payable
 *
 * The money is owed to the person from this moment; paying them is a separate
 * act, and a separate entry, because approving a claim and having the cash to
 * settle it are different things.
 */
export async function postClaim(
  db: Executor,
  principal: Principal,
  claimId: string,
  context?: AuditContext,
): Promise<{ journalNo: string }> {
  requireCapability(principal, "accounting.claim.approve");

  const claim = await lockClaim(db, claimId);
  if (claim.status !== "approved") {
    throw new ConflictError(`Only an approved claim can be posted; this one is ${claim.status}.`);
  }

  const lines = await readPurchaseLines(db, "expense_claim_line", "claim_id", claimId);
  const date = String(claim.claim_date).slice(0, 10);
  const total = parseAmount(claim.total);
  const tax = parseAmount(claim.tax_total);
  const claimant = await db.execute<{ full_name: string }>(
    sql`SELECT full_name FROM auth."user" WHERE id = ${claim.claimant_id}`,
  );
  const who = claimant.rows?.[0]?.full_name ?? "staff";

  const journal = await postSourceJournal(
    db,
    principal,
    {
      entryDate: date,
      memo: `Expense claim ${claim.claim_no} — ${who}`,
      sourceType: "claim",
      sourceId: claimId,
      authorisedBy: "accounting.claim.approve",
      lines: [
        ...lines.map((line) => ({
          accountId: line.accountId,
          debit: amountToSql(line.lineSubtotal),
          description: line.description,
          costCentreId: line.costCentreId,
          caseId: line.caseId,
        })),
        ...(tax > 0n
          ? [
              {
                accountCode: SYSTEM_ACCOUNTS.sstInput,
                debit: amountToSql(tax),
                description: "Service tax paid",
              },
            ]
          : []),
        {
          accountCode: SYSTEM_ACCOUNTS.staffClaimsPayable,
          credit: amountToSql(total),
          description: `Owed to ${who}`,
        },
      ],
    },
    context,
  );

  await db.execute(sql`
    UPDATE accounting.expense_claim
       SET status = 'posted', journal_id = ${journal.id}, posted_at = now(),
           posted_by = ${principal.userId}, updated_by = ${principal.userId}
     WHERE id = ${claimId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CLAIM_POSTED,
    entityType: "expense_claim",
    entityId: claimId,
    newValues: { claimNo: claim.claim_no, journalNo: journal.journalNo, total: claim.total, claimant: who },
  });

  return { journalNo: journal.journalNo };
}

/**
 * Marks a posted claim as paid, against the voucher that paid it.
 *
 * The payment itself is an ordinary payment voucher debiting staff claims
 * payable, so the money leaving the bank goes through the same approval and the
 * same ledger path as every other payment.
 */
export async function markClaimReimbursed(
  db: Executor,
  principal: Principal,
  claimId: string,
  voucherId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.claim.reimburse");

  const claim = await lockClaim(db, claimId);
  if (claim.status !== "posted") {
    throw new ConflictError(`Only a posted claim can be marked reimbursed; this one is ${claim.status}.`);
  }

  const voucher = await db.execute<{ status: string; voucher_no: string | null; total: string }>(
    sql`SELECT status, voucher_no, total FROM accounting.payment_voucher WHERE id = ${voucherId}`,
  );
  const found = voucher.rows?.[0];
  if (!found) throw new NotFoundError("That payment voucher no longer exists.");
  if (found.status !== "posted") {
    throw new ConflictError("The voucher that pays a claim has to be posted first.");
  }
  if (parseAmount(found.total) < parseAmount(claim.total)) {
    throw new ValidationError(
      `Voucher ${found.voucher_no} is for ${formatAmount(parseAmount(found.total))}, less than the ` +
        `${formatAmount(parseAmount(claim.total))} claimed.`,
      "voucherId",
    );
  }

  await db.execute(sql`
    UPDATE accounting.expense_claim
       SET status = 'reimbursed', reimbursement_voucher_id = ${voucherId}, reimbursed_at = now(),
           updated_by = ${principal.userId}
     WHERE id = ${claimId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CLAIM_REIMBURSED,
    entityType: "expense_claim",
    entityId: claimId,
    newValues: { claimNo: claim.claim_no, voucherNo: found.voucher_no },
  });
}

export async function deleteClaim(
  db: Executor,
  principal: Principal,
  claimId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "accounting.claim.create");

  const claim = await lockClaim(db, claimId);
  if (claim.claimant_id !== principal.userId) {
    throw new ConflictError("A claim can only be deleted by the person who made it.");
  }
  if (claim.status !== "draft") {
    throw new ConflictError(`This claim is ${claim.status} and cannot be deleted.`);
  }

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CLAIM_DELETED,
    entityType: "expense_claim",
    entityId: claimId,
    oldValues: { total: claim.total },
    reason: options.reason ?? null,
  });

  await db.execute(sql`DELETE FROM accounting.expense_claim WHERE id = ${claimId}`);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type LockedPettyCash = {
  status: "draft" | "posted" | "void";
  txn_no: string | null;
  kind: PettyCashKind;
  txn_date: string;
  description: string;
  amount: string;
  tax_amount: string;
  counterpart_account_id: string;
  float_account_id: string;
  cost_centre_id: string | null;
  case_id: string | null;
  receipt_ref: string | null;
  journal_id: string | null;
};

async function lockPettyCash(db: Executor, txnId: string): Promise<LockedPettyCash> {
  const result = await db.execute<LockedPettyCash>(sql`
    SELECT status, txn_no, kind, txn_date, description, amount, tax_amount,
           counterpart_account_id, float_account_id, cost_centre_id, case_id, receipt_ref, journal_id
      FROM accounting.petty_cash_txn WHERE id = ${txnId} FOR UPDATE
  `);
  const txn = result.rows?.[0];
  if (!txn) throw new NotFoundError("That petty cash entry no longer exists.");
  return txn;
}

type LockedClaim = {
  status: ClaimStatus;
  claim_no: string | null;
  claimant_id: string;
  claim_date: string;
  total: string;
  tax_total: string;
  journal_id: string | null;
};

async function lockClaim(db: Executor, claimId: string): Promise<LockedClaim> {
  const result = await db.execute<LockedClaim>(sql`
    SELECT status, claim_no, claimant_id, claim_date, total, tax_total, journal_id
      FROM accounting.expense_claim WHERE id = ${claimId} FOR UPDATE
  `);
  const claim = result.rows?.[0];
  if (!claim) throw new NotFoundError("That claim no longer exists.");
  return claim;
}

async function resolveAccount(
  db: Executor,
  id: string | null,
  code: string | null,
  field: string,
): Promise<{ id: string; code: string; subtype: string | null }> {
  if (!id && !code) throw new ValidationError("Choose an account.", field);
  const result = await db.execute<{ id: string; code: string; subtype: string | null; is_active: boolean; is_postable: boolean }>(
    id
      ? sql`SELECT id, code, subtype, is_active, is_postable FROM accounting.account WHERE id = ${id}`
      : sql`SELECT id, code, subtype, is_active, is_postable FROM accounting.account WHERE code = ${code}`,
  );
  const account = result.rows?.[0];
  if (!account) throw new ValidationError("That account does not exist.", field);
  if (!account.is_postable) throw new ValidationError(`${account.code} is a heading.`, field);
  if (!account.is_active) throw new ValidationError(`${account.code} is no longer in use.`, field);
  return { id: account.id, code: account.code, subtype: account.subtype };
}

export interface ClaimView {
  id: string;
  claimNo: string | null;
  status: ClaimStatus;
  claimantId: string;
  claimantName: string;
  claimDate: string;
  periodFrom: string | null;
  periodTo: string | null;
  subject: string | null;
  notes: string | null;
  subtotal: Amount;
  taxTotal: Amount;
  total: Amount;
  journalId: string | null;
  journalNo: string | null;
  reimbursementVoucherId: string | null;
  reimbursementVoucherNo: string | null;
  rejectReason: string | null;
  approvedByName: string | null;
  postedByName: string | null;
  createdAt: Date | string;
  lines: PurchaseLine[];
}

export async function getClaim(db: Executor, claimId: string): Promise<ClaimView | null> {
  const result = await db.execute<Record<string, never>>(sql`
    SELECT c.*, u.full_name AS claimant_name, j.journal_no,
           v.voucher_no AS reimbursement_voucher_no,
           ab.full_name AS approved_by_name, pb.full_name AS posted_by_name
      FROM accounting.expense_claim c
      JOIN auth."user" u ON u.id = c.claimant_id
      LEFT JOIN accounting.journal j ON j.id = c.journal_id
      LEFT JOIN accounting.payment_voucher v ON v.id = c.reimbursement_voucher_id
      LEFT JOIN auth."user" ab ON ab.id = c.approved_by
      LEFT JOIN auth."user" pb ON pb.id = c.posted_by
     WHERE c.id = ${claimId}
  `);
  const raw = result.rows?.[0] as Record<string, unknown> | undefined;
  if (!raw) return null;

  return {
    id: String(raw.id),
    claimNo: (raw.claim_no as string) ?? null,
    status: raw.status as ClaimStatus,
    claimantId: String(raw.claimant_id),
    claimantName: String(raw.claimant_name),
    claimDate: String(raw.claim_date).slice(0, 10),
    periodFrom: raw.period_from ? String(raw.period_from).slice(0, 10) : null,
    periodTo: raw.period_to ? String(raw.period_to).slice(0, 10) : null,
    subject: (raw.subject as string) ?? null,
    notes: (raw.notes as string) ?? null,
    subtotal: parseAmount(String(raw.subtotal)),
    taxTotal: parseAmount(String(raw.tax_total)),
    total: parseAmount(String(raw.total)),
    journalId: (raw.journal_id as string) ?? null,
    journalNo: (raw.journal_no as string) ?? null,
    reimbursementVoucherId: (raw.reimbursement_voucher_id as string) ?? null,
    reimbursementVoucherNo: (raw.reimbursement_voucher_no as string) ?? null,
    rejectReason: (raw.reject_reason as string) ?? null,
    approvedByName: (raw.approved_by_name as string) ?? null,
    postedByName: (raw.posted_by_name as string) ?? null,
    createdAt: raw.created_at as Date | string,
    lines: await readPurchaseLines(db, "expense_claim_line", "claim_id", claimId),
  };
}

export interface ClaimSummary {
  id: string;
  claimNo: string | null;
  status: ClaimStatus;
  claimantId: string;
  claimantName: string;
  claimDate: string;
  subject: string | null;
  total: Amount;
}

export async function listClaims(
  db: Executor,
  filters: { status?: ClaimStatus; claimantId?: string; limit?: number } = {},
): Promise<ClaimSummary[]> {
  const result = await db.execute<{
    id: string;
    claim_no: string | null;
    status: ClaimStatus;
    claimant_id: string;
    claimant_name: string;
    claim_date: string;
    subject: string | null;
    total: string;
  }>(sql`
    SELECT c.id, c.claim_no, c.status, c.claimant_id, u.full_name AS claimant_name,
           c.claim_date, c.subject, c.total
      FROM accounting.expense_claim c
      JOIN auth."user" u ON u.id = c.claimant_id
     WHERE ${filters.status ? sql`c.status = ${filters.status}` : sql`true`}
       AND ${filters.claimantId ? sql`c.claimant_id = ${filters.claimantId}` : sql`true`}
     ORDER BY c.claim_date DESC, c.created_at DESC
     LIMIT ${Math.min(Math.max(filters.limit ?? 100, 1), 500)}
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    claimNo: row.claim_no,
    status: row.status,
    claimantId: row.claimant_id,
    claimantName: row.claimant_name,
    claimDate: String(row.claim_date).slice(0, 10),
    subject: row.subject,
    total: parseAmount(row.total),
  }));
}
