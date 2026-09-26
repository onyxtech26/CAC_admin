import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { SYSTEM_ACCOUNTS } from "@cac/db";
import { parseIsoDate, today, toIsoDate } from "./dates.js";
import { parseAmount, sumAmounts, type Amount } from "./money.js";
import { getSettingState } from "./settings.js";
import type { AccountType } from "./accounts.js";

/**
 * Financial reports.
 *
 * Every figure here is derived from posted journal lines or from the documents
 * themselves. Nothing is stored as a "report total" and nothing is cached: a
 * report that can disagree with the ledger is worse than no report, because it is
 * believed.
 *
 * The same rule as the trial balance applies throughout: a journal counts when
 * its status is 'posted' or 'reversed', because a reversed journal and its
 * reversal both sit in the ledger and cancel.
 */
const IN_LEDGER = sql`j.status IN ('posted', 'reversed')`;

// ---------------------------------------------------------------------------
// Receivables
// ---------------------------------------------------------------------------

export interface AgingBucket {
  label: string;
  /** Inclusive lower bound in days past due. */
  from: number;
  /** Exclusive upper bound, or null for "and older". */
  to: number | null;
  amount: Amount;
}

export interface AgingRow {
  customerId: string;
  customerCode: string;
  customerName: string;
  current: Amount;
  buckets: AgingBucket[];
  total: Amount;
  /** Posted receipts not yet matched to an invoice. Reduces what is really owed. */
  unallocatedReceipts: Amount;
  netOwing: Amount;
  oldestDueDate: string | null;
}

export interface AgingReport {
  asOf: string;
  boundaries: number[];
  /**
   * Whether the boundaries are CAC's policy or the platform's suggestion.
   *
   * 30/60/90 is a convention, and this report is what a collections conversation starts from — which
   * invoice somebody rings about first. The figures either side of a boundary do not change, but who
   * appears in which column does, and the screen should not present a suggestion as the firm's rule.
   */
  boundariesConfirmed: boolean;
  rows: AgingRow[];
  totals: {
    current: Amount;
    buckets: Amount[];
    total: Amount;
    unallocatedReceipts: Amount;
    netOwing: Amount;
  };
  /**
   * The AR control account balance, which the whole report must agree with.
   *
   * Null when the report is scoped to one customer: the control account holds
   * every customer's balance, so there is nothing meaningful to compare a single
   * customer's figures against. Reporting a difference there would flag a fault
   * on every filtered run.
   */
  controlAccountBalance: Amount | null;
  /** Zero when receivables reconcile; null when the report is scoped. */
  difference: Amount | null;
}

/**
 * Accounts receivable, aged.
 *
 * Bucket boundaries come from `accounting.aging_buckets` rather than being fixed
 * at 30/60/90, because how a firm ages its debt is a policy, not a law.
 *
 * The last three fields are the part that matters. An aging report is only worth
 * reading if it agrees with the ledger, so this computes the trade receivables
 * control balance independently and reports the difference. If the difference is
 * not nil, something has reached account 1210 without going through an invoice or
 * a receipt, and the report says so rather than quietly disagreeing with the
 * balance sheet.
 */
export async function receivablesAging(
  db: Executor,
  options: { asOf?: string; customerId?: string } = {},
): Promise<AgingReport> {
  const asOf = toIsoDate(options.asOf ? parseIsoDate(options.asOf, "asOf") : today());
  const buckets = await getSettingState<number[]>(db, "accounting.aging_buckets", [30, 60, 90]);
  const boundaries = buckets.value;
  const sorted = [...boundaries].sort((a, b) => a - b);

  // `amount_allocated` on the invoice is what has been settled *today*. For an
  // "as at" report that is the wrong number: a receipt taken last week does not
  // reduce what was owed a month ago. So the allocated figure is rebuilt from the
  // allocations whose source document is itself dated on or before the date —
  // which is the same basis the control account is measured on, and the reason
  // the two reconcile.
  const invoices = await db.execute<{
    customer_id: string;
    customer_code: string;
    customer_name: string;
    due_date: string;
    outstanding: string;
    days_overdue: number;
  }>(sql`
    WITH settled AS (
      SELECT al.invoice_id, SUM(al.amount) AS amount
        FROM accounting.allocation al
        LEFT JOIN accounting.receipt r ON r.id = al.receipt_id
        LEFT JOIN accounting.invoice cn ON cn.id = al.credit_note_id
       WHERE COALESCE(r.receipt_date, cn.invoice_date) <= ${asOf}::date
         AND (r.id IS NULL OR r.status = 'posted')
         AND (cn.id IS NULL OR cn.status IN ('issued', 'paid'))
       GROUP BY al.invoice_id
    )
    SELECT i.customer_id, c.code AS customer_code, c.name AS customer_name, i.due_date,
           (i.total - COALESCE(s.amount, 0))::text AS outstanding,
           (${asOf}::date - i.due_date) AS days_overdue
      FROM accounting.invoice i
      JOIN accounting.customer c ON c.id = i.customer_id
      LEFT JOIN settled s ON s.invoice_id = i.id
     WHERE i.kind = 'invoice'
       AND i.status IN ('issued', 'paid')
       AND i.total > COALESCE(s.amount, 0)
       AND i.invoice_date <= ${asOf}::date
       AND ${options.customerId ? sql`i.customer_id = ${options.customerId}` : sql`true`}
  `);

  // Same reasoning: how much of each receipt was unmatched *at that date*, which
  // counts only allocations whose target invoice existed by then.
  const unallocated = await db.execute<{ customer_id: string; amount: string }>(sql`
    WITH applied AS (
      SELECT al.receipt_id, SUM(al.amount) AS amount
        FROM accounting.allocation al
        JOIN accounting.invoice i ON i.id = al.invoice_id
       WHERE al.receipt_id IS NOT NULL AND i.invoice_date <= ${asOf}::date
       GROUP BY al.receipt_id
    )
    SELECT r.customer_id, SUM(r.amount - COALESCE(a.amount, 0))::text AS amount
      FROM accounting.receipt r
      LEFT JOIN applied a ON a.receipt_id = r.id
     WHERE r.status = 'posted'
       AND r.amount > COALESCE(a.amount, 0)
       AND r.receipt_date <= ${asOf}::date
       AND ${options.customerId ? sql`r.customer_id = ${options.customerId}` : sql`true`}
     GROUP BY r.customer_id
  `);
  const unallocatedByCustomer = new Map(
    (unallocated.rows ?? []).map((row) => [row.customer_id, parseAmount(row.amount)]),
  );

  const byCustomer = new Map<string, AgingRow>();

  const emptyBuckets = (): AgingBucket[] =>
    sorted.map((from, index) => ({
      label:
        index === sorted.length - 1 ? `${from}+ days` : `${from}-${sorted[index + 1]! - 1} days`,
      from,
      to: index === sorted.length - 1 ? null : sorted[index + 1]!,
      amount: 0n,
    }));

  for (const row of invoices.rows ?? []) {
    const outstanding = parseAmount(row.outstanding);
    const overdue = Number(row.days_overdue);

    let entry = byCustomer.get(row.customer_id);
    if (!entry) {
      entry = {
        customerId: row.customer_id,
        customerCode: row.customer_code,
        customerName: row.customer_name,
        current: 0n,
        buckets: emptyBuckets(),
        total: 0n,
        unallocatedReceipts: unallocatedByCustomer.get(row.customer_id) ?? 0n,
        netOwing: 0n,
        oldestDueDate: null,
      };
      byCustomer.set(row.customer_id, entry);
    }

    if (overdue < sorted[0]!) {
      entry.current += outstanding;
    } else {
      // The last bucket that this invoice is at least as old as.
      const index = sorted.reduce((best, from, i) => (overdue >= from ? i : best), 0);
      entry.buckets[index]!.amount += outstanding;
    }

    entry.total += outstanding;
    const dueDate = String(row.due_date).slice(0, 10);
    if (!entry.oldestDueDate || dueDate < entry.oldestDueDate) entry.oldestDueDate = dueDate;
  }

  // Customers with money on account and nothing outstanding still belong here:
  // the firm owes them work, and their balance is part of the reconciliation.
  for (const [customerId, amount] of unallocatedByCustomer) {
    if (byCustomer.has(customerId)) continue;
    const named = await db.execute<{ code: string; name: string }>(
      sql`SELECT code, name FROM accounting.customer WHERE id = ${customerId}`,
    );
    byCustomer.set(customerId, {
      customerId,
      customerCode: named.rows?.[0]?.code ?? "",
      customerName: named.rows?.[0]?.name ?? "",
      current: 0n,
      buckets: emptyBuckets(),
      total: 0n,
      unallocatedReceipts: amount,
      netOwing: 0n,
      oldestDueDate: null,
    });
  }

  const rows = [...byCustomer.values()].map((row) => ({
    ...row,
    netOwing: row.total - row.unallocatedReceipts,
  }));
  rows.sort((a, b) => a.customerName.localeCompare(b.customerName));

  const bucketTotals = sorted.map((_, index) =>
    sumAmounts(rows.map((row) => row.buckets[index]!.amount)),
  );
  const total = sumAmounts(rows.map((row) => row.total));
  const unallocatedTotal = sumAmounts(rows.map((row) => row.unallocatedReceipts));

  // Only for the whole ledger. See the note on the field.
  const controlAccountBalance = options.customerId
    ? null
    : await accountBalanceAt(db, SYSTEM_ACCOUNTS.receivableControl, asOf);

  return {
    asOf,
    boundaries: sorted,
    boundariesConfirmed: buckets.confirmed,
    rows,
    totals: {
      current: sumAmounts(rows.map((row) => row.current)),
      buckets: bucketTotals,
      total,
      unallocatedReceipts: unallocatedTotal,
      netOwing: total - unallocatedTotal,
    },
    controlAccountBalance,
    // Outstanding invoices, less money received and not yet matched, is what the
    // control account should hold.
    difference:
      controlAccountBalance === null ? null : total - unallocatedTotal - controlAccountBalance,
  };
}

/**
 * Net balance of one account at a date, in its normal direction.
 *
 * The outer joins are there so an account with no postings at all still returns a
 * row rather than nothing. That makes the FILTER clauses essential: a plain
 * `SUM(l.debit)` would add up every line on the account, including those whose
 * journal is a draft or falls after the date, because the failed join leaves the
 * line row in place with `j` null. The symptom is a control account that ignores
 * the "as at" date entirely and quietly agrees with a report it should not.
 */
export async function accountBalanceAt(
  db: Executor,
  accountCode: string,
  asOf: string,
): Promise<Amount> {
  const result = await db.execute<{ debit: string; credit: string; normal_side: string }>(sql`
    SELECT COALESCE(SUM(l.debit) FILTER (WHERE j.id IS NOT NULL), 0)::text AS debit,
           COALESCE(SUM(l.credit) FILTER (WHERE j.id IS NOT NULL), 0)::text AS credit,
           MAX(a.normal_side) AS normal_side
      FROM accounting.account a
      LEFT JOIN accounting.journal_line l ON l.account_id = a.id
      LEFT JOIN accounting.journal j ON j.id = l.journal_id AND ${IN_LEDGER}
        AND j.entry_date <= ${asOf}::date
     WHERE a.code = ${accountCode}
  `);
  const row = result.rows?.[0];
  if (!row) return 0n;
  const net = parseAmount(row.debit) - parseAmount(row.credit);
  return row.normal_side === "credit" ? -net : net;
}

// ---------------------------------------------------------------------------
// Profit and loss
// ---------------------------------------------------------------------------

export interface ReportLine {
  accountId: string;
  code: string;
  name: string;
  amount: Amount;
}

export interface ReportSection {
  heading: string;
  lines: ReportLine[];
  total: Amount;
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  revenue: ReportSection;
  directCosts: ReportSection;
  grossProfit: Amount;
  /** Gross profit as a percentage of revenue, or null when revenue is nil. */
  grossMargin: number | null;
  expenses: ReportSection[];
  totalExpenses: Amount;
  netProfit: Amount;
}

/**
 * Profit and loss for a period.
 *
 * Revenue and expenses are shown in their natural direction — revenue positive
 * when earned, expenses positive when incurred — rather than as raw debits and
 * credits. Contra accounts (fee rebates, credit notes) net against their group,
 * which is where a reader expects to find them.
 *
 * Direct costs are separated from overheads so gross margin means something: for
 * a fee-based practice, what a job costs to deliver is the number that decides
 * whether the fee was right.
 */
export async function profitAndLoss(
  db: Executor,
  options: { from: string; to: string },
): Promise<ProfitAndLoss> {
  const from = toIsoDate(parseIsoDate(options.from, "from"));
  const to = toIsoDate(parseIsoDate(options.to, "to"));

  const rows = await db.execute<{
    account_id: string;
    code: string;
    name: string;
    type: AccountType;
    normal_side: string;
    net: string;
  }>(sql`
    SELECT a.id AS account_id, a.code, a.name, a.type, a.normal_side,
           (COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0))::text AS net
      FROM accounting.account a
      JOIN accounting.journal_line l ON l.account_id = a.id
      JOIN accounting.journal j ON j.id = l.journal_id
     WHERE a.type IN ('REVENUE', 'EXPENSE')
       AND ${IN_LEDGER}
       AND j.entry_date BETWEEN ${from}::date AND ${to}::date
     GROUP BY a.id, a.code, a.name, a.type, a.normal_side
    HAVING COALESCE(SUM(l.debit), 0) <> COALESCE(SUM(l.credit), 0)
     ORDER BY a.code
  `);

  const all = (rows.rows ?? []).map((row) => ({
    accountId: row.account_id,
    code: row.code,
    name: row.name,
    type: row.type,
    // Presented in the direction the reader expects: revenue as a positive
    // credit, expense as a positive debit.
    amount: row.type === "REVENUE" ? -parseAmount(row.net) : parseAmount(row.net),
  }));

  /**
   * Which section a line belongs to.
   *
   * Revenue or expense comes from the account's **type**, and only the subdivision of the expenses
   * comes from the code. That distinction is the fix for a defect worth spelling out: every section
   * used to be chosen by the leading digit alone, and nothing ties a code to a type. The chart
   * accepts `REVENUE` coded `3900`, or `REV-ADVISORY`; both are legal, and both used to land in no
   * section at all — vanishing from the statement and from `netProfit`, while the trial balance
   * still balanced, so the balance sheet reported a difference and pointed the reader at the one
   * report that looked correct.
   *
   * Nothing can now fall out. Anything whose code does not match a known prefix is an expense, since
   * its type says so, and it is shown under a heading that says it is unclassified rather than being
   * dropped.
   */
  const toSection = (
    heading: string,
    predicate: (line: (typeof all)[number]) => boolean,
  ): ReportSection => {
    const lines = all.filter(predicate);
    return { heading, lines, total: sumAmounts(lines.map((line) => line.amount)) };
  };

  const revenue = toSection("Revenue", (line) => line.type === "REVENUE");

  const isExpense = (line: (typeof all)[number]) => line.type === "EXPENSE";
  const directCosts = toSection(
    "Direct costs",
    (line) => isExpense(line) && line.code.startsWith("5"),
  );

  // 6 staff, 7 admin, 8 finance, 9 tax, which is how the seeded chart is organised. The prefixes
  // group the statement; they do not decide what is in it.
  const GROUPED = ["5", "6", "7", "8", "9"];
  const expenses = [
    toSection("Staff costs", (line) => isExpense(line) && line.code.startsWith("6")),
    toSection("Administrative expenses", (line) => isExpense(line) && line.code.startsWith("7")),
    toSection("Finance costs", (line) => isExpense(line) && line.code.startsWith("8")),
    toSection("Taxation", (line) => isExpense(line) && line.code.startsWith("9")),
    toSection(
      "Other expenses — code outside the numbering",
      (line) => isExpense(line) && !GROUPED.some((prefix) => line.code.startsWith(prefix)),
    ),
  ].filter((group) => group.lines.length > 0);

  const grossProfit = revenue.total - directCosts.total;
  const totalExpenses = sumAmounts(expenses.map((group) => group.total));

  return {
    from,
    to,
    revenue,
    directCosts,
    grossProfit,
    grossMargin:
      revenue.total === 0n ? null : Number((grossProfit * 10_000n) / revenue.total) / 100,
    expenses,
    totalExpenses,
    netProfit: grossProfit - totalExpenses,
  };
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------

export interface BalanceSheet {
  asOf: string;
  /** Start of the fiscal year the date falls in, for the profit figure. */
  fiscalYearStart: string | null;
  assets: ReportSection[];
  totalAssets: Amount;
  liabilities: ReportSection[];
  totalLiabilities: Amount;
  equity: ReportSection;
  /** Profit for the year to date, which has not yet been closed to reserves. */
  currentYearEarnings: Amount;
  totalEquity: Amount;
  /** Assets less liabilities and equity. Nil in a sound ledger. */
  difference: Amount;
}

/**
 * Balance sheet at a date.
 *
 * The subtlety is current-year earnings. Revenue and expense accounts are not
 * closed to retained earnings until the year end, so a balance sheet drawn
 * mid-year has to include the profit so far as a movement in equity — otherwise
 * it does not balance, and the reader concludes the software is broken.
 *
 * That figure is computed here from the profit and loss for the year to date; it
 * is deliberately *not* posted anywhere. The closing entry at year end is a real
 * journal, made once, visible and reversible, rather than something a report
 * invents every time it is run.
 */
export async function balanceSheet(db: Executor, options: { asOf?: string } = {}): Promise<BalanceSheet> {
  const asOf = toIsoDate(options.asOf ? parseIsoDate(options.asOf, "asOf") : today());

  const year = await db.execute<{ starts_on: string }>(sql`
    SELECT starts_on FROM accounting.fiscal_year
     WHERE ${asOf}::date BETWEEN starts_on AND ends_on
  `);
  const fiscalYearStart = year.rows?.[0] ? String(year.rows[0].starts_on).slice(0, 10) : null;

  const rows = await db.execute<{
    account_id: string;
    code: string;
    name: string;
    type: AccountType;
    net: string;
  }>(sql`
    SELECT a.id AS account_id, a.code, a.name, a.type,
           (COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0))::text AS net
      FROM accounting.account a
      JOIN accounting.journal_line l ON l.account_id = a.id
      JOIN accounting.journal j ON j.id = l.journal_id
     WHERE a.type IN ('ASSET', 'LIABILITY', 'EQUITY')
       AND ${IN_LEDGER}
       AND j.entry_date <= ${asOf}::date
     GROUP BY a.id, a.code, a.name, a.type
    HAVING COALESCE(SUM(l.debit), 0) <> COALESCE(SUM(l.credit), 0)
     ORDER BY a.code
  `);

  const all = (rows.rows ?? []).map((row) => ({
    accountId: row.account_id,
    code: row.code,
    name: row.name,
    type: row.type,
    // Assets positive when held; liabilities and equity positive when owed.
    amount: row.type === "ASSET" ? parseAmount(row.net) : -parseAmount(row.net),
  }));

  const section = (heading: string, predicate: (code: string, type: AccountType) => boolean): ReportSection => {
    const lines = all.filter((line) => predicate(line.code, line.type));
    return { heading, lines, total: sumAmounts(lines.map((line) => line.amount)) };
  };

  const assets = [
    section("Non-current assets", (code, type) => type === "ASSET" && code < "1200"),
    section("Current assets", (code, type) => type === "ASSET" && code >= "1200"),
  ].filter((group) => group.lines.length > 0);

  const liabilities = [
    section("Current liabilities", (code, type) => type === "LIABILITY" && code < "2200"),
    section("Non-current liabilities", (code, type) => type === "LIABILITY" && code >= "2200"),
  ].filter((group) => group.lines.length > 0);

  const equity = section("Equity", (_code, type) => type === "EQUITY");

  const currentYearEarnings = fiscalYearStart
    ? (await profitAndLoss(db, { from: fiscalYearStart, to: asOf })).netProfit
    : 0n;

  const totalAssets = sumAmounts(assets.map((group) => group.total));
  const totalLiabilities = sumAmounts(liabilities.map((group) => group.total));
  const totalEquity = equity.total + currentYearEarnings;

  return {
    asOf,
    fiscalYearStart,
    assets,
    totalAssets,
    liabilities,
    totalLiabilities,
    equity,
    currentYearEarnings,
    totalEquity,
    difference: totalAssets - totalLiabilities - totalEquity,
  };
}

// ---------------------------------------------------------------------------
// Customer statement
// ---------------------------------------------------------------------------

export interface StatementEntry {
  date: string;
  kind: "invoice" | "credit_note" | "receipt";
  reference: string;
  documentId: string;
  description: string | null;
  /** Increases what the customer owes. */
  charge: Amount;
  /** Reduces it. */
  payment: Amount;
  balance: Amount;
}

export interface CustomerStatement {
  customerId: string;
  customerName: string;
  customerCode: string;
  from: string | null;
  to: string;
  openingBalance: Amount;
  entries: StatementEntry[];
  closingBalance: Amount;
}

/**
 * What a customer owes, as a running account.
 *
 * Built from the documents rather than the ledger, because this is what gets sent
 * to the customer and they need to see their own invoice and receipt numbers, not
 * journal references.
 */
export async function customerStatement(
  db: Executor,
  customerId: string,
  options: { from?: string | null; to?: string } = {},
): Promise<CustomerStatement | null> {
  const to = toIsoDate(options.to ? parseIsoDate(options.to, "to") : today());
  const from = options.from ? toIsoDate(parseIsoDate(options.from, "from")) : null;

  const customer = await db.execute<{ id: string; name: string; code: string }>(
    sql`SELECT id, name, code FROM accounting.customer WHERE id = ${customerId}`,
  );
  if (!customer.rows?.[0]) return null;

  const documents = await db.execute<{
    date: string;
    kind: string;
    reference: string;
    document_id: string;
    description: string | null;
    charge: string;
    payment: string;
  }>(sql`
    SELECT i.invoice_date AS date,
           i.kind,
           COALESCE(i.invoice_no, '(draft)') AS reference,
           i.id AS document_id,
           i.subject AS description,
           CASE WHEN i.kind = 'invoice' THEN i.total ELSE 0 END::text AS charge,
           CASE WHEN i.kind = 'credit_note' THEN i.total ELSE 0 END::text AS payment
      FROM accounting.invoice i
     WHERE i.customer_id = ${customerId} AND i.status IN ('issued', 'paid')
       AND i.invoice_date <= ${to}::date
    UNION ALL
    SELECT r.receipt_date AS date,
           'receipt' AS kind,
           COALESCE(r.receipt_no, '(draft)') AS reference,
           r.id AS document_id,
           r.method || COALESCE(' ' || r.reference, '') AS description,
           0::text AS charge,
           r.amount::text AS payment
      FROM accounting.receipt r
     WHERE r.customer_id = ${customerId} AND r.status = 'posted'
       AND r.receipt_date <= ${to}::date
     ORDER BY date, reference
  `);

  // The running balance is computed over every document up to `to`, then the
  // window is applied. Computing it only over the window would start each page of
  // a statement from zero, which is exactly the number the customer disputes.
  let balance = 0n;
  let openingBalance = 0n;
  const all: StatementEntry[] = [];

  for (const row of documents.rows ?? []) {
    const date = String(row.date).slice(0, 10);
    const charge = parseAmount(row.charge);
    const payment = parseAmount(row.payment);
    balance += charge - payment;

    if (from && date < from) {
      openingBalance = balance;
      continue;
    }

    all.push({
      date,
      kind: row.kind as StatementEntry["kind"],
      reference: row.reference,
      documentId: row.document_id,
      description: row.description,
      charge,
      payment,
      balance,
    });
  }

  return {
    customerId,
    customerName: customer.rows[0].name,
    customerCode: customer.rows[0].code,
    from,
    to,
    openingBalance,
    entries: all,
    closingBalance: balance,
  };
}

// ---------------------------------------------------------------------------
// Revenue by matter
// ---------------------------------------------------------------------------

export interface MatterRevenueRow {
  caseId: string;
  caseNo: string;
  title: string;
  matterType: string;
  status: string;
  customerName: string | null;
  /** Issued invoices, net of credit notes. */
  billed: Amount;
  /** Of that, what is still owed — apportioned to this matter by its share of each invoice. */
  outstanding: Amount;
  /** Quoted and not yet invoiced: accepted quotations whose lines name this matter. */
  quoted: Amount;
  invoices: number;
}

export interface MatterRevenue {
  from: string;
  to: string;
  rows: MatterRevenueRow[];
  totals: { billed: Amount; outstanding: Amount; quoted: Amount };
  /** Issued revenue in the period that names no matter at all. */
  unattributed: Amount;
}

/**
 * What each matter has been billed.
 *
 * `invoice_line.case_id` and `quotation_line.case_id` have been accepted, computed, persisted and
 * carried through conversions and credit notes since Phase 3, and nothing read them: no form set one
 * and no report used one. For a firm that bills per matter that was the missing join between the two
 * halves of the platform — the case management on one side, the money on the other.
 *
 * Two things here are deliberate.
 *
 * **Credit notes net off.** A credit note's lines carry the matter through, so crediting an invoice
 * reduces what the matter was billed rather than leaving a figure nobody recognises.
 *
 * **What is outstanding is apportioned, not attributed.** A receipt pays an invoice, not a line, so
 * an invoice split across two matters that is half paid cannot say which half. Each matter is given
 * its share of the invoice's outstanding balance in the ratio of its lines, which is the only honest
 * answer — and it is why this column is described as the matter's share rather than its debt.
 */
export async function matterRevenue(
  db: Executor,
  options: { from?: string; to?: string } = {},
): Promise<MatterRevenue> {
  const from = toIsoDate(parseIsoDate(options.from ?? "2000-01-01", "from"));
  const to = toIsoDate(parseIsoDate(options.to ?? toIsoDate(today()), "to"));

  const rows = await db.execute<{
    case_id: string;
    case_no: string;
    title: string;
    matter_type: string;
    status: string;
    customer_name: string | null;
    billed: string;
    outstanding: string;
    invoices: number;
  }>(sql`
    WITH billed AS (
      SELECT l.case_id,
             i.id AS invoice_id,
             i.kind,
             SUM(l.line_total) AS matter_total,
             -- The invoice's own total, for the apportionment below.
             MAX(i.total) AS invoice_total,
             MAX(i.total - i.amount_allocated) AS invoice_outstanding
        FROM accounting.invoice_line l
        JOIN accounting.invoice i ON i.id = l.invoice_id
       WHERE l.case_id IS NOT NULL
         AND i.status IN ('issued', 'paid')
         AND i.invoice_date BETWEEN ${from}::date AND ${to}::date
       GROUP BY l.case_id, i.id, i.kind
    )
    SELECT c.id AS case_id, c.case_no, c.title, c.matter_type, c.status,
           cust.name AS customer_name,
           COALESCE(SUM(
             CASE WHEN b.kind = 'credit_note' THEN -b.matter_total ELSE b.matter_total END
           ), 0)::text AS billed,
           -- Rounded to the money scale. Each matter's share is rounded on its own, so the shares of
           -- a split invoice can differ from its outstanding balance by a fraction of a sen; that is
           -- inherent in apportioning one payment across several matters and is why the column is
           -- described as a share rather than a debt.
           ROUND(COALESCE(SUM(
             CASE
               WHEN b.kind = 'credit_note' OR b.invoice_total = 0 THEN 0
               ELSE b.invoice_outstanding * (b.matter_total / b.invoice_total)
             END
           ), 0), 4)::text AS outstanding,
           count(DISTINCT b.invoice_id) FILTER (WHERE b.kind = 'invoice')::int AS invoices
      FROM billed b
      JOIN estate.case c ON c.id = b.case_id
      LEFT JOIN accounting.customer cust ON cust.id = c.customer_id
     GROUP BY c.id, c.case_no, c.title, c.matter_type, c.status, cust.name
     ORDER BY c.case_no
  `);

  // Accepted quotations that have not become invoices: work promised and not yet billed.
  const quoted = await db.execute<{ case_id: string; quoted: string }>(sql`
    SELECT l.case_id, COALESCE(SUM(l.line_total), 0)::text AS quoted
      FROM accounting.quotation_line l
      JOIN accounting.quotation q ON q.id = l.quotation_id
     WHERE l.case_id IS NOT NULL
       AND q.status = 'accepted' AND q.converted_invoice_id IS NULL
       AND q.quotation_date BETWEEN ${from}::date AND ${to}::date
     GROUP BY l.case_id
  `);
  const quotedByCase = new Map(
    (quoted.rows ?? []).map((row) => [row.case_id, parseAmount(row.quoted)]),
  );

  const unattributed = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(
             CASE WHEN i.kind = 'credit_note' THEN -l.line_total ELSE l.line_total END
           ), 0)::text AS total
      FROM accounting.invoice_line l
      JOIN accounting.invoice i ON i.id = l.invoice_id
     WHERE l.case_id IS NULL
       AND i.status IN ('issued', 'paid')
       AND i.invoice_date BETWEEN ${from}::date AND ${to}::date
  `);

  const all: MatterRevenueRow[] = (rows.rows ?? []).map((row) => ({
    caseId: row.case_id,
    caseNo: row.case_no,
    title: row.title,
    matterType: row.matter_type,
    status: row.status,
    customerName: row.customer_name,
    billed: parseAmount(row.billed),
    outstanding: parseAmount(row.outstanding),
    quoted: quotedByCase.get(row.case_id) ?? 0n,
    invoices: row.invoices,
  }));

  // A matter with an accepted quotation and no invoice yet belongs in the list: "promised and not
  // billed" is exactly what somebody reads this report to find.
  for (const [caseId, amount] of quotedByCase) {
    if (all.some((row) => row.caseId === caseId)) continue;
    const found = await db.execute<{
      case_no: string;
      title: string;
      matter_type: string;
      status: string;
      customer_name: string | null;
    }>(sql`
      SELECT c.case_no, c.title, c.matter_type, c.status, cust.name AS customer_name
        FROM estate.case c
        LEFT JOIN accounting.customer cust ON cust.id = c.customer_id
       WHERE c.id = ${caseId}
    `);
    const matter = found.rows?.[0];
    if (!matter) continue;
    all.push({
      caseId,
      caseNo: matter.case_no,
      title: matter.title,
      matterType: matter.matter_type,
      status: matter.status,
      customerName: matter.customer_name,
      billed: 0n,
      outstanding: 0n,
      quoted: amount,
      invoices: 0,
    });
  }

  all.sort((left, right) => left.caseNo.localeCompare(right.caseNo));

  return {
    from,
    to,
    rows: all,
    totals: {
      billed: sumAmounts(all.map((row) => row.billed)),
      outstanding: sumAmounts(all.map((row) => row.outstanding)),
      quoted: sumAmounts(all.map((row) => row.quoted)),
    },
    unattributed: parseAmount(unattributed.rows?.[0]?.total ?? "0"),
  };
}
