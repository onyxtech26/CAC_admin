import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { parseAmount, sumAmounts, type Amount } from "./money.js";
import { parseIsoDate, toIsoDate } from "./dates.js";
import type { AccountType } from "./accounts.js";

/**
 * Reading the ledger.
 *
 * One rule governs every query here: a journal counts when its status is
 * 'posted' or 'reversed'.
 *
 * The 'reversed' part surprises people. A reversed journal is not removed from
 * the ledger — its reversing entry is *also* in the ledger, and the two net to
 * zero. Excluding the original would leave the reversal unmatched and put the
 * trial balance out by twice the amount. Drafts, by contrast, are excluded
 * everywhere: they are not part of the record until they are posted.
 */
const IN_LEDGER = sql`j.status IN ('posted', 'reversed')`;

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  normalSide: "debit" | "credit";
  /** Sum of debits and of credits over the window. */
  debit: Amount;
  credit: Amount;
  /** Net, presented on the side the balance actually falls. */
  balanceDebit: Amount;
  balanceCredit: Amount;
}

export interface TrialBalance {
  from: string | null;
  to: string;
  rows: TrialBalanceRow[];
  totalDebit: Amount;
  totalCredit: Amount;
  /** Zero in a sound ledger. Non-zero is a bug, and the screen says so loudly. */
  difference: Amount;
}

export interface TrialBalanceOptions {
  /** Inclusive. Omitted means from the beginning: a cumulative balance. */
  from?: string | null;
  /** Inclusive. Defaults to today. */
  to?: string;
  /** Include accounts whose movement and balance are both nil. */
  includeZero?: boolean;
}

/**
 * The trial balance.
 *
 * Every posted line, grouped by account. `difference` must be zero: it is the
 * single number that says whether double entry has held, and it is computed and
 * shown rather than assumed. If it is ever non-zero, something has written to
 * the ledger without going through the posting engine.
 */
export async function trialBalance(
  db: Executor,
  options: TrialBalanceOptions = {},
): Promise<TrialBalance> {
  const to = toIsoDate(options.to ? parseIsoDate(options.to, "to") : new Date());
  const from = options.from ? toIsoDate(parseIsoDate(options.from, "from")) : null;

  const window = from
    ? sql`j.entry_date BETWEEN ${from}::date AND ${to}::date`
    : sql`j.entry_date <= ${to}::date`;

  const result = await db.execute<{
    account_id: string;
    code: string;
    name: string;
    type: AccountType;
    normal_side: "debit" | "credit";
    debit: string | null;
    credit: string | null;
  }>(sql`
    SELECT a.id AS account_id, a.code, a.name, a.type, a.normal_side,
           -- FILTER, not a WHERE clause: the join is outer so that accounts with
           -- no movement can still be listed, and a plain SUM would then add up
           -- the lines of draft journals whose join row survived as NULL.
           COALESCE(SUM(l.debit) FILTER (WHERE j.id IS NOT NULL), 0)::text AS debit,
           COALESCE(SUM(l.credit) FILTER (WHERE j.id IS NOT NULL), 0)::text AS credit
      FROM accounting.account a
      LEFT JOIN accounting.journal_line l ON l.account_id = a.id
      LEFT JOIN accounting.journal j ON j.id = l.journal_id AND ${IN_LEDGER} AND ${window}
     WHERE a.is_postable
     GROUP BY a.id, a.code, a.name, a.type, a.normal_side
    HAVING ${options.includeZero ? sql`true` : sql`count(j.id) > 0`}
     ORDER BY a.code
  `);

  const rows: TrialBalanceRow[] = (result.rows ?? []).map((row) => {
    const debit = parseAmount(row.debit ?? "0");
    const credit = parseAmount(row.credit ?? "0");
    const net = debit - credit;
    return {
      accountId: row.account_id,
      code: row.code,
      name: row.name,
      type: row.type,
      normalSide: row.normal_side,
      debit,
      credit,
      // A net debit shows in the debit column and vice versa. Presenting a
      // credit balance as a negative debit is technically the same number and
      // is not how a trial balance is read.
      balanceDebit: net > 0n ? net : 0n,
      balanceCredit: net < 0n ? -net : 0n,
    };
  });

  const visible = options.includeZero
    ? rows
    : rows.filter((row) => row.debit !== 0n || row.credit !== 0n);

  const totalDebit = sumAmounts(visible.map((row) => row.balanceDebit));
  const totalCredit = sumAmounts(visible.map((row) => row.balanceCredit));

  return {
    from,
    to,
    rows: visible,
    totalDebit,
    totalCredit,
    difference: totalDebit - totalCredit,
  };
}

export interface LedgerEntry {
  journalId: string;
  journalNo: string | null;
  entryDate: string;
  status: "posted" | "reversed";
  memo: string | null;
  description: string | null;
  sourceType: string;
  debit: Amount;
  credit: Amount;
  /** Running balance in the account's own normal direction. */
  balance: Amount;
}

export interface AccountLedger {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  normalSide: "debit" | "credit";
  from: string | null;
  to: string;
  openingBalance: Amount;
  closingBalance: Amount;
  entries: LedgerEntry[];
}

/**
 * One account's movements, with an opening balance and a running total.
 *
 * The balance runs in the account's normal direction, so a bank account's
 * balance is positive when there is money in it and an expense account's is
 * positive when money has been spent. Signing everything as debit-minus-credit
 * is arithmetically simpler and makes every credit-normal account read as
 * negative, which is how people conclude the software is wrong.
 */
export async function accountLedger(
  db: Executor,
  accountIdOrCode: string,
  options: { from?: string | null; to?: string } = {},
): Promise<AccountLedger | null> {
  const to = toIsoDate(options.to ? parseIsoDate(options.to, "to") : new Date());
  const from = options.from ? toIsoDate(parseIsoDate(options.from, "from")) : null;

  const accountResult = await db.execute<{
    id: string;
    code: string;
    name: string;
    type: AccountType;
    normal_side: "debit" | "credit";
  }>(sql`
    SELECT id, code, name, type, normal_side FROM accounting.account
     WHERE id::text = ${accountIdOrCode} OR code = ${accountIdOrCode}
  `);
  const account = accountResult.rows?.[0];
  if (!account) return null;

  const sign = account.normal_side === "debit" ? 1n : -1n;

  let openingBalance = 0n;
  if (from) {
    const opening = await db.execute<{ debit: string | null; credit: string | null }>(sql`
      SELECT COALESCE(SUM(l.debit), 0)::text AS debit, COALESCE(SUM(l.credit), 0)::text AS credit
        FROM accounting.journal_line l
        JOIN accounting.journal j ON j.id = l.journal_id
       WHERE l.account_id = ${account.id} AND ${IN_LEDGER} AND j.entry_date < ${from}::date
    `);
    const row = opening.rows?.[0];
    openingBalance = (parseAmount(row?.debit ?? "0") - parseAmount(row?.credit ?? "0")) * sign;
  }

  const movements = await db.execute<{
    journal_id: string;
    journal_no: string | null;
    entry_date: string;
    status: "posted" | "reversed";
    memo: string | null;
    description: string | null;
    source_type: string;
    debit: string;
    credit: string;
  }>(sql`
    SELECT j.id AS journal_id, j.journal_no, j.entry_date, j.status, j.memo,
           l.description, j.source_type, l.debit, l.credit
      FROM accounting.journal_line l
      JOIN accounting.journal j ON j.id = l.journal_id
     WHERE l.account_id = ${account.id}
       AND ${IN_LEDGER}
       AND ${from ? sql`j.entry_date BETWEEN ${from}::date AND ${to}::date` : sql`j.entry_date <= ${to}::date`}
     ORDER BY j.entry_date, j.journal_no, l.line_no
  `);

  let balance = openingBalance;
  const entries: LedgerEntry[] = (movements.rows ?? []).map((row) => {
    const debit = parseAmount(row.debit);
    const credit = parseAmount(row.credit);
    balance += (debit - credit) * sign;
    return {
      journalId: row.journal_id,
      journalNo: row.journal_no,
      entryDate: String(row.entry_date).slice(0, 10),
      status: row.status,
      memo: row.memo,
      description: row.description,
      sourceType: row.source_type,
      debit,
      credit,
      balance,
    };
  });

  return {
    accountId: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    normalSide: account.normal_side,
    from,
    to,
    openingBalance,
    closingBalance: balance,
    entries,
  };
}

export interface LedgerTotals {
  postedJournals: number;
  draftJournals: number;
  reversedJournals: number;
  totalPosted: Amount;
  /** Zero unless the ledger has been corrupted. */
  outOfBalance: Amount;
}

/**
 * Headline figures for the accounting dashboard.
 *
 * `outOfBalance` sums every posted journal's debit minus credit. It is a health
 * check, not a report: any value other than zero means a journal reached the
 * ledger unbalanced, and the dashboard shows it in red rather than hiding it.
 */
export async function ledgerTotals(db: Executor): Promise<LedgerTotals> {
  const result = await db.execute<{
    posted: number;
    draft: number;
    reversed: number;
    total_posted: string | null;
    difference: string | null;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE status = 'posted')::int   AS posted,
      count(*) FILTER (WHERE status = 'draft')::int    AS draft,
      count(*) FILTER (WHERE status = 'reversed')::int AS reversed,
      COALESCE(SUM(total_debit) FILTER (WHERE status = 'posted'), 0)::text AS total_posted,
      COALESCE(SUM(total_debit - total_credit) FILTER (WHERE status <> 'draft'), 0)::text AS difference
    FROM accounting.journal
  `);
  const row = result.rows?.[0];
  return {
    postedJournals: row?.posted ?? 0,
    draftJournals: row?.draft ?? 0,
    reversedJournals: row?.reversed ?? 0,
    totalPosted: parseAmount(row?.total_posted ?? "0"),
    outOfBalance: parseAmount(row?.difference ?? "0"),
  };
}
