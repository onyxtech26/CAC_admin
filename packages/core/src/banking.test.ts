import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import { hashPassword } from "./password.js";
import { AuthorizationError, resolveCapabilities, type Principal } from "./authz.js";
import { ConflictError, ValidationError } from "./errors.js";
import { amountToSql, formatAmount, parseAmount } from "./money.js";
import { createFiscalYear } from "./periods.js";
import { createDraftJournal, postJournal } from "./posting.js";
import { setSetting } from "./settings.js";
import { readDelimited, findColumn } from "./delimited.js";
import {
  abandonReconciliation,
  completeReconciliation,
  createBankAccount,
  deleteStatement,
  getReconciliation,
  guessMapping,
  ignoreStatementLine,
  importStatement,
  listBankAccounts,
  listStatementLines,
  listStatements,
  listUnexplainedLedgerLines,
  matchStatementLine,
  openReconciliation,
  parseStatement,
  postStatementLine,
  reconciliationPosition,
  restoreStatementLine,
  suggestMatches,
  unmatchStatementLine,
} from "./banking.js";

/**
 * Phase 4: the bank.
 *
 * Four things are worth proving beyond the mechanics, and they are the four ways
 * a bank reconciliation is normally got wrong:
 *
 *   - direction. Money in is a ledger debit. A match in the wrong direction is
 *     refused by the database, not only by the application.
 *   - double counting. One ledger entry cannot explain two statement lines, and
 *     one statement line cannot be explained twice. Without both, any
 *     reconciliation can be made to balance.
 *   - completeness. An import whose rows do not account for the movement between
 *     the stated balances is refused, and the same file cannot be imported twice.
 *   - permanence. A completed reconciliation is a signed statement about a date.
 *     It cannot afterwards be edited, unmatched, or made to balance.
 */

let db: Database;
let close: () => Promise<void>;

let clerk: Principal; // ACCOUNTS_EXECUTIVE — imports and matches, cannot sign off
let accountant: Principal; // ACCOUNTANT — reconciles
let director: Principal; // DIRECTOR — read-only over the bank
let employee: Principal; // EMPLOYEE — nothing

let bankAccountId: string;
let bankLedgerAccountId: string;

async function makePrincipal(email: string, roles: string[]): Promise<Principal> {
  const hash = await hashPassword("correct-horse-battery-staple");
  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO auth."user" (email, password_hash, full_name)
    VALUES (${email}, ${hash}, ${email}) RETURNING id
  `);
  const userId = created.rows![0]!.id;
  for (const role of roles) {
    await db.execute(sql`
      INSERT INTO auth.user_role (user_id, role_id)
      SELECT ${userId}, id FROM auth.role WHERE key = ${role}
    `);
  }
  return {
    userId,
    email,
    fullName: email,
    roles,
    capabilities: await resolveCapabilities(db, userId),
    employeeId: null,
    sessionId: "00000000-0000-0000-0000-000000000000",
    mfaSatisfied: true,
    mustChangePassword: false,
    mustEnrolMfa: false,
    mfaRequired: false,
    mfaEnrolmentDueAt: null,
  };
}

async function accountIdFor(code: string): Promise<string> {
  const found = await db.execute<{ id: string }>(
    sql`SELECT id FROM accounting.account WHERE code = ${code}`,
  );
  return found.rows![0]!.id;
}

/**
 * Posts a journal straight onto the bank account.
 *
 * Standing in for whichever document would really have produced it. What matters
 * to these tests is that a posted ledger line exists on the bank account with a
 * known date, amount and direction.
 */
async function postToBank(options: {
  date: string;
  memo: string;
  amount: string;
  direction: "in" | "out";
  otherCode?: string;
}): Promise<{ journalId: string; bankLineId: string }> {
  const other = await accountIdFor(options.otherCode ?? "4110");
  const draft = await createDraftJournal(db, accountant, {
    entryDate: options.date,
    memo: options.memo,
    lines:
      options.direction === "in"
        ? [
            { accountId: bankLedgerAccountId, debit: options.amount, description: options.memo },
            { accountId: other, credit: options.amount, description: options.memo },
          ]
        : [
            { accountId: other, debit: options.amount, description: options.memo },
            { accountId: bankLedgerAccountId, credit: options.amount, description: options.memo },
          ],
  });
  // Posted by the same person: maker/checker is switched off for this fixture.
  await postJournal(db, accountant, draft.id);

  const line = await db.execute<{ id: string }>(sql`
    SELECT id FROM accounting.journal_line
     WHERE journal_id = ${draft.id} AND account_id = ${bankLedgerAccountId}
  `);
  return { journalId: draft.id, bankLineId: line.rows![0]!.id };
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  await runMigrations(db);
  await seed(db);

  clerk = await makePrincipal("bank-clerk@cac.test", ["ACCOUNTS_EXECUTIVE"]);
  accountant = await makePrincipal("bank-accountant@cac.test", ["ACCOUNTANT"]);
  director = await makePrincipal("bank-director@cac.test", ["DIRECTOR"]);
  employee = await makePrincipal("bank-employee@cac.test", ["EMPLOYEE"]);

  await createFiscalYear(db, director, { startsOn: "2026-01-01" });

  // Manual journals are the only practical way to put known entries on the bank
  // account in this file, and maker/checker would otherwise need a third user for
  // every one of them. The control itself is proven in posting.test.ts.
  await setSetting(db, director, "accounting.journal_requires_second_person", false, {
    reason: "test fixture: the control itself is proven in posting.test.ts",
  });

  bankLedgerAccountId = await accountIdFor("1251");
  bankAccountId = (
    await createBankAccount(db, accountant, {
      accountId: bankLedgerAccountId,
      bankName: "Maybank",
      accountNo: "5142 9931 0077",
      accountLabel: "Operating current account",
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await close();
});

// ---------------------------------------------------------------------------
describe("reading a bank export", () => {
  it("parses RFC 4180 quoting, embedded newlines and doubled quotes", () => {
    const table = readDelimited(
      'Date,Description,Amount\r\n' +
        '01/07/2026,"Payment to ""Jaya"", with comma",-100.00\r\n' +
        '02/07/2026,"Two\nlines",250.00\r\n',
    );

    expect(table.header).toEqual(["Date", "Description", "Amount"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]![1]).toBe('Payment to "Jaya", with comma');
    expect(table.rows[1]![1]).toBe("Two\nlines");
  });

  it("detects a semicolon-separated file rather than assuming commas", () => {
    const table = readDelimited('Date;Description;Amount\n01/07/2026;"Fee, annual";-50.00\n');
    expect(table.delimiter).toBe(";");
    expect(table.rows[0]![1]).toBe("Fee, annual");
  });

  it("strips a UTF-8 BOM, which would otherwise corrupt the first heading", () => {
    const table = readDelimited("﻿Date,Description,Amount\n01/07/2026,Fee,-50.00\n");
    expect(table.header[0]).toBe("Date");
    expect(findColumn(table.header, ["date"])).toBe(0);
  });

  it("skips preamble rows when told how many there are", () => {
    const table = readDelimited(
      "MAYBANK BERHAD\nStatement for 5142993100077\n\nDate,Description,Amount\n01/07/2026,Fee,-50.00\n",
      { skipRows: 3 },
    );
    expect(table.header).toEqual(["Date", "Description", "Amount"]);
    expect(table.rows).toHaveLength(1);
  });

  it("matches column headings regardless of case and punctuation", () => {
    const mapping = guessMapping(["TXN_DATE", "Transaction Description", "Debit", "Credit", "Balance"]);
    expect(mapping.date).toBe(0);
    expect(mapping.description).toBe(1);
    expect(mapping.paidOut).toBe(2);
    expect(mapping.paidIn).toBe(3);
    expect(mapping.balance).toBe(4);
  });

  it("refuses a date that could be read two ways rather than guessing", () => {
    const parsed = parseStatement("Date,Description,Amount\n03/04/2026,Fee,-50.00\n");
    expect(parsed.lines).toHaveLength(0);
    expect(parsed.rejected[0]!.reason).toContain("day-first or month-first");
  });

  it("accepts an ambiguous date once the file's format is stated", () => {
    const parsed = parseStatement("Date,Description,Amount\n03/04/2026,Fee,-50.00\n", {
      mapping: { dateFormat: "dmy" },
    });
    expect(parsed.lines[0]!.txnDate).toBe("2026-04-03");
  });

  it("reads thousands separators, brackets and trailing minus signs", () => {
    const parsed = parseStatement(
      "Date,Description,Amount\n" +
        "13/07/2026,Big receipt,\"12,345.67\"\n" +
        "14/07/2026,Bracketed,(250.00)\n" +
        "15/07/2026,Trailing minus,99.50-\n",
      { mapping: { dateFormat: "dmy" } },
    );

    expect(parsed.rejected).toHaveLength(0);
    expect(formatAmount(parsed.lines[0]!.paidIn)).toBe("12,345.67");
    expect(formatAmount(parsed.lines[1]!.paidOut)).toBe("250.00");
    expect(formatAmount(parsed.lines[2]!.paidOut)).toBe("99.50");
  });

  it("rejects an unreadable amount rather than importing it as nil", () => {
    const parsed = parseStatement("Date,Description,Amount\n13/07/2026,Odd,about fifty\n", {
      mapping: { dateFormat: "dmy" },
    });
    expect(parsed.lines).toHaveLength(0);
    expect(parsed.rejected[0]!.reason).toContain("not an amount");
  });

  it("rejects a row that moves money both ways, which means the columns are swapped", () => {
    const parsed = parseStatement(
      "Date,Description,Debit,Credit\n13/07/2026,Confused,100.00,250.00\n",
      { mapping: { dateFormat: "dmy" } },
    );
    expect(parsed.rejected[0]!.reason).toContain("money in and money out at once");
  });

  it("keeps a rejected row's reason and number so it can be looked at", () => {
    const parsed = parseStatement(
      "Date,Description,Amount\n" +
        "13/07/2026,Good,100.00\n" +
        "not a date,Bad,50.00\n" +
        "15/07/2026,Also good,-20.00\n",
      { mapping: { dateFormat: "dmy" } },
    );
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0]!.rowNo).toBe(2);
    expect(parsed.rejected[0]!.raw[1]).toBe("Bad");
  });
});

// ---------------------------------------------------------------------------
describe("bank accounts", () => {
  it("attaches to a ledger account and reports its balance", async () => {
    const accounts = await listBankAccounts(db);
    const account = accounts.find((row) => row.id === bankAccountId);

    expect(account?.accountCode).toBe("1251");
    expect(account?.bankName).toBe("Maybank");
    expect(account?.lastReconciledOn).toBeNull();
  });

  it("refuses a second bank account on the same ledger account", async () => {
    await expect(
      createBankAccount(db, accountant, { accountId: bankLedgerAccountId, bankName: "CIMB" }),
    ).rejects.toThrow(ConflictError);
  });

  it("refuses a ledger account that cannot hold money", async () => {
    const revenue = await accountIdFor("4110");
    await expect(
      createBankAccount(db, accountant, { accountId: revenue, bankName: "Maybank" }),
    ).rejects.toThrow();
  });

  it("is not something an accounts executive may set up", async () => {
    const other = await accountIdFor("1252").catch(() => null);
    if (!other) return;
    await expect(
      createBankAccount(db, clerk, { accountId: other, bankName: "CIMB" }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("masks the account number in the audit trail", async () => {
    const events = await db.execute<{ new_values: unknown }>(sql`
      SELECT new_values FROM audit.event
       WHERE action = 'BANK_ACCOUNT_CREATED' AND entity_id = ${bankAccountId}
    `);
    const payload = events.rows![0]!.new_values as { accountNo: string };
    expect(payload.accountNo).toBe("****0077");
    expect(JSON.stringify(payload)).not.toContain("5142");
  });
});

// ---------------------------------------------------------------------------
describe("importing a statement", () => {
  const july =
    "Date,Description,Debit,Credit,Balance\n" +
    "01/07/2026,Opening,,,10000.00\n" +
    "03/07/2026,CHEQUE 100123 JAYA LAND,450.00,,9550.00\n" +
    "10/07/2026,FPX RECEIPT TAN SRI HOLDINGS,,3990.00,13540.00\n" +
    "31/07/2026,MONTHLY SERVICE CHARGE,12.00,,13528.00\n";

  it("refuses an import whose rows do not account for the balance movement", async () => {
    const parsed = parseStatement(july, { mapping: { dateFormat: "dmy" } });
    // Row one moves nothing and is rejected, so the readable rows move
    // 3,990 − 450 − 12 = 3,528.
    await expect(
      importStatement(db, accountant, parsed, {
        bankAccountId,
        periodFrom: "2026-07-01",
        periodTo: "2026-07-31",
        openingBalance: "10000.00",
        closingBalance: "99999.00",
      }),
    ).rejects.toThrow(/difference/);
  });

  it("imports when the rows and the balances agree", async () => {
    const parsed = parseStatement(july, { mapping: { dateFormat: "dmy" } });
    const result = await importStatement(db, accountant, parsed, {
      bankAccountId,
      statementRef: "JUL-2026",
      periodFrom: "2026-07-01",
      periodTo: "2026-07-31",
      openingBalance: "10000.00",
      closingBalance: "13528.00",
      sourceFilename: "maybank-july.csv",
    });

    expect(result.lineCount).toBe(3);
    expect(result.balanceDiscrepancy).toBe(0n);
    // The opening row moved no money, so it was reported rather than imported.
    expect(result.rejected).toHaveLength(1);

    const statements = await listStatements(db, { bankAccountId });
    expect(statements[0]!.lineCount).toBe(3);
    expect(statements[0]!.unmatchedCount).toBe(3);
  });

  it("refuses the same file twice, which would duplicate every transaction", async () => {
    const parsed = parseStatement(july, { mapping: { dateFormat: "dmy" } });
    await expect(
      importStatement(db, accountant, parsed, {
        bankAccountId,
        periodFrom: "2026-07-01",
        periodTo: "2026-07-31",
        openingBalance: "10000.00",
        closingBalance: "13528.00",
      }),
    ).rejects.toThrow(/already been imported/);
  });

  it("refuses rows dated outside the stated period", async () => {
    const parsed = parseStatement(
      "Date,Description,Amount\n05/08/2026,Later payment,-100.00\n",
      { mapping: { dateFormat: "dmy" } },
    );
    await expect(
      importStatement(db, accountant, parsed, {
        bankAccountId,
        periodFrom: "2026-07-01",
        periodTo: "2026-07-31",
        openingBalance: "0",
        closingBalance: "-100.00",
      }),
    ).rejects.toThrow(/outside/);
  });

  it("is not something an employee may do", async () => {
    const parsed = parseStatement("Date,Description,Amount\n01/07/2026,Fee,-1.00\n", {
      mapping: { dateFormat: "dmy" },
    });
    await expect(
      importStatement(db, employee, parsed, {
        bankAccountId,
        openingBalance: "0",
        closingBalance: "-1.00",
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("records the direction the firm sees, not the bank's", async () => {
    const lines = await listStatementLines(db, { bankAccountId });
    const receipt = lines.find((line) => line.description.includes("FPX"))!;
    const charge = lines.find((line) => line.description.includes("SERVICE"))!;

    // Money in increases the firm's asset: a debit when it reaches the ledger.
    expect(formatAmount(receipt.paidIn)).toBe("3,990.00");
    expect(receipt.paidOut).toBe(0n);
    expect(formatAmount(charge.paidOut)).toBe("12.00");
    expect(charge.paidIn).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
describe("matching", () => {
  let chequeLineId: string;
  let receiptLineId: string;
  let chargeLineId: string;
  let chequeJournalLineId: string;
  let receiptJournalLineId: string;

  beforeAll(async () => {
    const lines = await listStatementLines(db, { bankAccountId });
    chequeLineId = lines.find((line) => line.description.includes("CHEQUE"))!.id;
    receiptLineId = lines.find((line) => line.description.includes("FPX"))!.id;
    chargeLineId = lines.find((line) => line.description.includes("SERVICE"))!.id;

    // The ledger's own record of the same two events.
    chequeJournalLineId = (
      await postToBank({
        date: "2026-07-02",
        memo: "Jaya Land search fees, cheque 100123",
        amount: "450.00",
        direction: "out",
        otherCode: "5110",
      })
    ).bankLineId;

    receiptJournalLineId = (
      await postToBank({
        date: "2026-07-10",
        memo: "Tan Sri Holdings, investigation fee",
        amount: "3990.00",
        direction: "in",
      })
    ).bankLineId;
  });

  it("suggests the ledger entry with the same amount, and says why", async () => {
    const candidates = await suggestMatches(db, chequeLineId);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.journalLineId).toBe(chequeJournalLineId);
    expect(formatAmount(candidates[0]!.credit)).toBe("450.00");
    expect(candidates[0]!.reasons.join(" ")).toContain("amount agrees exactly");
    expect(candidates[0]!.reasons.join(" ")).toContain("1 day apart");
  });

  it("suggests nothing for a charge the ledger has never heard of", async () => {
    expect(await suggestMatches(db, chargeLineId)).toHaveLength(0);
  });

  it("refuses a match in the wrong direction", async () => {
    // The cheque left the bank; the receipt's ledger line is a debit. Same account,
    // both posted, but they are not the same movement of money.
    await expect(
      matchStatementLine(db, clerk, {
        statementLineId: chequeLineId,
        journalLineId: receiptJournalLineId,
      }),
    ).rejects.toThrow();
  });

  it("matches, and the line says so afterwards", async () => {
    await matchStatementLine(db, clerk, {
      statementLineId: chequeLineId,
      journalLineId: chequeJournalLineId,
      method: "suggested",
    });

    const lines = await listStatementLines(db, { bankAccountId });
    const cheque = lines.find((line) => line.id === chequeLineId)!;
    expect(cheque.status).toBe("matched");
    expect(cheque.journalLineId).toBe(chequeJournalLineId);
    expect(cheque.matchMethod).toBe("suggested");
  });

  it("will not use one ledger entry to explain two statement lines", async () => {
    // A second statement line of the same amount, in the same direction.
    const parsed = parseStatement(
      "Date,Description,Amount\n04/07/2026,CHEQUE 100124 JAYA LAND,-450.00\n",
      { mapping: { dateFormat: "dmy" } },
    );
    const second = await importStatement(db, accountant, parsed, {
      bankAccountId,
      periodFrom: "2026-07-04",
      periodTo: "2026-07-04",
      openingBalance: "0",
      closingBalance: "-450.00",
      statementRef: "duplicate-amount probe",
    });

    const line = (await listStatementLines(db, { statementId: second.statementId }))[0]!;

    await expect(
      matchStatementLine(db, clerk, {
        statementLineId: line.id,
        journalLineId: chequeJournalLineId,
      }),
    ).rejects.toThrow(/already explains another/);

    // And it is no longer offered as a candidate either.
    const candidates = await suggestMatches(db, line.id);
    expect(candidates.map((c) => c.journalLineId)).not.toContain(chequeJournalLineId);

    await deleteStatement(db, accountant, second.statementId, { reason: "probe" });
  });

  it("will not match the same statement line twice", async () => {
    await expect(
      matchStatementLine(db, clerk, {
        statementLineId: chequeLineId,
        journalLineId: receiptJournalLineId,
      }),
    ).rejects.toThrow(/already matched/);
  });

  it("unmatches, and the ledger entry becomes available again", async () => {
    await unmatchStatementLine(db, clerk, chequeLineId, { reason: "wrong cheque" });

    const lines = await listStatementLines(db, { bankAccountId });
    expect(lines.find((line) => line.id === chequeLineId)!.status).toBe("unmatched");

    const candidates = await suggestMatches(db, chequeLineId);
    expect(candidates.map((c) => c.journalLineId)).toContain(chequeJournalLineId);

    // Put it back for the reconciliation below.
    await matchStatementLine(db, clerk, {
      statementLineId: chequeLineId,
      journalLineId: chequeJournalLineId,
    });
    await matchStatementLine(db, clerk, {
      statementLineId: receiptLineId,
      journalLineId: receiptJournalLineId,
    });
  });

  it("needs a reason to set a line aside, and the line can be brought back", async () => {
    await expect(ignoreStatementLine(db, clerk, chargeLineId, "  ")).rejects.toThrow(
      ValidationError,
    );

    await ignoreStatementLine(db, clerk, chargeLineId, "advice line, not a transaction");
    let lines = await listStatementLines(db, { bankAccountId });
    expect(lines.find((line) => line.id === chargeLineId)!.status).toBe("ignored");

    await restoreStatementLine(db, clerk, chargeLineId);
    lines = await listStatementLines(db, { bankAccountId });
    expect(lines.find((line) => line.id === chargeLineId)!.status).toBe("unmatched");
  });

  it("posts a charge the ledger never knew about, and matches it in one step", async () => {
    const bankCharges = await accountIdFor("7175");

    const posted = await postStatementLine(db, clerk, {
      statementLineId: chargeLineId,
      accountId: bankCharges,
    });
    expect(posted.journalNo).toMatch(/^JV-/);

    const lines = await listStatementLines(db, { bankAccountId });
    const charge = lines.find((line) => line.id === chargeLineId)!;
    expect(charge.status).toBe("matched");
    expect(charge.matchMethod).toBe("posted_from_statement");

    // Money out of the bank credits the bank and debits the expense.
    const journal = await db.execute<{ code: string; debit: string; credit: string }>(sql`
      SELECT a.code, l.debit, l.credit
        FROM accounting.journal_line l
        JOIN accounting.account a ON a.id = l.account_id
       WHERE l.journal_id = (SELECT journal_id FROM accounting.journal_line WHERE id = ${charge.journalLineId})
       ORDER BY a.code
    `);
    const rows = journal.rows!;
    expect(rows.find((r) => r.code === "1251")!.credit).toBe("12.0000");
    expect(rows.find((r) => r.code === "7175")!.debit).toBe("12.0000");
  });

  it("refuses to post a statement line against the bank account itself", async () => {
    const parsed = parseStatement("Date,Description,Amount\n20/07/2026,Odd,-5.00\n", {
      mapping: { dateFormat: "dmy" },
    });
    const probe = await importStatement(db, accountant, parsed, {
      bankAccountId,
      periodFrom: "2026-07-20",
      periodTo: "2026-07-20",
      openingBalance: "0",
      closingBalance: "-5.00",
    });
    const line = (await listStatementLines(db, { statementId: probe.statementId }))[0]!;

    await expect(
      postStatementLine(db, clerk, {
        statementLineId: line.id,
        accountId: bankLedgerAccountId,
      }),
    ).rejects.toThrow(ValidationError);

    await deleteStatement(db, accountant, probe.statementId, { reason: "probe" });
  });

  it("is not something an employee may do", async () => {
    await expect(
      matchStatementLine(db, employee, {
        statementLineId: chargeLineId,
        journalLineId: chequeJournalLineId,
      }),
    ).rejects.toThrow(AuthorizationError);
  });
});

// ---------------------------------------------------------------------------
describe("the reconciliation", () => {
  it("shows the two sides and what is in transit between them", async () => {
    const position = await reconciliationPosition(db, bankAccountId, "2026-07-31");

    expect(formatAmount(position.statementBalance)).toBe("13,528.00");
    // Ledger: −450 + 3,990 − 12 = 3,528 on the bank account.
    expect(formatAmount(position.ledgerBalance)).toBe("3,528.00");
    expect(position.unmatchedStatementCount).toBe(0);
    expect(formatAmount(position.difference)).toBe("10,000.00");
  });

  it("balances once the opening balance is on the ledger too", async () => {
    // The statement opens at 10,000 which the ledger has never been told about.
    // Recording it is what the difference was pointing at all along.
    await postToBank({
      date: "2026-06-30",
      memo: "Opening bank balance brought forward",
      amount: "10000.00",
      direction: "in",
      otherCode: "3900",
    });

    const position = await reconciliationPosition(db, bankAccountId, "2026-07-31");
    expect(formatAmount(position.ledgerBalance)).toBe("13,528.00");
    expect(position.difference).toBe(0n);

    // And it is NOT carried as an item in transit. It is dated before the first
    // statement CAC imported, so the bank had already accounted for it inside
    // that statement's opening balance. Treating it as outstanding would report a
    // difference equal to the opening balance that no statement line could ever
    // clear.
    expect(position.unmatchedLedger).toBe(0n);
  });

  it("reports a difference when a statement is missing between two others", async () => {
    // A statement that opens 1,500 below where the last one closed. Something
    // happened in between that neither record accounts for — which is the one
    // thing the difference figure genuinely catches, and the reason it is kept.
    const parsed = parseStatement(
      "Date,Description,Amount\n05/09/2026,IBG TRANSFER OUT,-200.00\n",
      { mapping: { dateFormat: "dmy" } },
    );
    const gap = await importStatement(db, accountant, parsed, {
      bankAccountId,
      statementRef: "gap probe",
      periodFrom: "2026-09-01",
      periodTo: "2026-09-30",
      openingBalance: "12028.00",
      closingBalance: "11828.00",
    });

    const position = await reconciliationPosition(db, bankAccountId, "2026-09-30");
    expect(position.difference).not.toBe(0n);

    await deleteStatement(db, accountant, gap.statementId, { reason: "probe" });
  });

  it("is not something an accounts executive may sign off", async () => {
    await expect(
      openReconciliation(db, clerk, { bankAccountId, asAt: "2026-07-31" }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("opens one, and only one, per account", async () => {
    const opened = await openReconciliation(db, accountant, {
      bankAccountId,
      asAt: "2026-07-31",
      notes: "July",
    });
    expect(opened.id).toBeTruthy();

    await expect(
      openReconciliation(db, accountant, { bankAccountId, asAt: "2026-08-31" }),
    ).rejects.toThrow(/already a reconciliation open/);
  });

  it("adopts the matches that were made before it was opened", async () => {
    const open = (await db.execute<{ id: string }>(
      sql`SELECT id FROM accounting.reconciliation WHERE status = 'draft'`,
    )).rows![0]!.id;

    const adopted = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM accounting.reconciliation_match
       WHERE reconciliation_id = ${open}
    `);
    expect(adopted.rows![0]!.count).toBe(3);
  });

  it("reports what is still unexplained on the ledger side", async () => {
    const unexplained = await listUnexplainedLedgerLines(db, bankAccountId, "2026-07-31");
    expect(unexplained).toHaveLength(1);
    expect(unexplained[0]!.memo).toContain("Opening bank balance");
    expect(formatAmount(unexplained[0]!.debit)).toBe("10,000.00");
  });

  it("completes, numbers itself, and keeps the figures it was signed off with", async () => {
    const open = (await db.execute<{ id: string }>(
      sql`SELECT id FROM accounting.reconciliation WHERE status = 'draft'`,
    )).rows![0]!.id;

    const completed = await completeReconciliation(db, accountant, open, {
      notes: "Opening balance is on the June statement, not yet imported.",
    });
    expect(completed.reconciliationNo).toMatch(/^BR-2026-/);

    const view = await getReconciliation(db, open);
    expect(view?.status).toBe("completed");
    expect(view?.difference).toBe(0n);
    expect(formatAmount(view!.statementBalance)).toBe("13,528.00");
    expect(view?.completedByName).toBe("bank-accountant@cac.test");
  });

  it("does not let a later back-dated journal rewrite a completed reconciliation", async () => {
    const completed = (await db.execute<{ id: string; difference: string }>(
      sql`SELECT id, difference FROM accounting.reconciliation WHERE status = 'completed'`,
    )).rows![0]!;

    // A journal dated inside the reconciled period, posted afterwards. Today's
    // arithmetic no longer agrees; what was signed off must not change.
    await postToBank({
      date: "2026-07-15",
      memo: "Late entry, dated inside a reconciled period",
      amount: "77.00",
      direction: "out",
      otherCode: "7180",
    });

    const view = await getReconciliation(db, completed.id);
    expect(view?.difference).toBe(0n);
    expect(formatAmount(view!.ledgerBalance)).toBe("13,528.00");

    // Drawn fresh, the account no longer agrees — which is the honest answer and
    // what the next reconciliation has to deal with.
    const now = await reconciliationPosition(db, bankAccountId, "2026-07-31");
    expect(now.difference).toBe(0n);
    expect(formatAmount(now.ledgerBalance)).toBe("13,451.00");
  });

  it("refuses to unmatch anything belonging to a completed reconciliation", async () => {
    const lines = await listStatementLines(db, { bankAccountId, status: "matched" });
    await expect(unmatchStatementLine(db, clerk, lines[0]!.id)).rejects.toThrow(
      /completed reconciliation/,
    );
  });

  it("refuses to delete a statement that a completed reconciliation stands on", async () => {
    const statements = await listStatements(db, { bankAccountId });
    const july = statements.find((statement) => statement.statementRef === "JUL-2026")!;
    await expect(deleteStatement(db, accountant, july.id)).rejects.toThrow(/completed/);
  });

  it("refuses a new reconciliation dated no later than the last one", async () => {
    await expect(
      openReconciliation(db, accountant, { bankAccountId, asAt: "2026-07-31" }),
    ).rejects.toThrow(/later date/);
  });

  it("refuses to complete while a statement line has not been looked at", async () => {
    const parsed = parseStatement(
      "Date,Description,Amount\n05/08/2026,IBG TRANSFER OUT,-500.00\n",
      { mapping: { dateFormat: "dmy" } },
    );
    await importStatement(db, accountant, parsed, {
      bankAccountId,
      statementRef: "AUG-2026",
      periodFrom: "2026-08-01",
      periodTo: "2026-08-31",
      openingBalance: "13528.00",
      closingBalance: "13028.00",
    });

    const opened = await openReconciliation(db, accountant, {
      bankAccountId,
      asAt: "2026-08-31",
    });

    // The arithmetic agrees — it is an identity once the two records start from
    // the same balance — but nobody has accounted for what the bank reported in
    // August. That is why the difference cannot be the only gate.
    const position = await reconciliationPosition(db, bankAccountId, "2026-08-31");
    expect(position.difference).toBe(0n);
    expect(position.unmatchedStatementCount).toBe(1);

    await expect(completeReconciliation(db, accountant, opened.id)).rejects.toThrow(
      /not been accounted for/,
    );

    await abandonReconciliation(db, accountant, opened.id, { reason: "left for next month" });
  });

  it("completes once every statement line has been accounted for", async () => {
    const august = (await listStatementLines(db, { bankAccountId, status: "unmatched" }))[0]!;
    await postStatementLine(db, clerk, {
      statementLineId: august.id,
      accountId: await accountIdFor("7175"),
      memo: "IBG transfer out, recorded from the statement",
    });

    const opened = await openReconciliation(db, accountant, {
      bankAccountId,
      asAt: "2026-08-31",
    });
    const completed = await completeReconciliation(db, accountant, opened.id);
    expect(completed.reconciliationNo).toMatch(/^BR-2026-/);

    // The 77.00 posted into July after that month was signed off is on no
    // statement. An unpresented item is the normal state of affairs and does not
    // stop the account being reconciled: it is carried as outstanding instead.
    const view = await getReconciliation(db, opened.id);
    expect(formatAmount(view!.unmatchedLedger)).toBe("-77.00");
  });

  it("keeps the matches when an attempt is abandoned", async () => {
    const lines = await listStatementLines(db, { bankAccountId, status: "matched" });
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses to abandon a completed one", async () => {
    const completed = (await db.execute<{ id: string }>(
      sql`SELECT id FROM accounting.reconciliation WHERE status = 'completed' LIMIT 1`,
    )).rows![0]!;
    await expect(abandonReconciliation(db, accountant, completed.id)).rejects.toThrow(
      ConflictError,
    );
  });

  it("refuses at the database level to hold a completed reconciliation that does not balance", async () => {
    const completed = (await db.execute<{ id: string }>(
      sql`SELECT id FROM accounting.reconciliation WHERE status = 'completed' LIMIT 1`,
    )).rows![0]!;

    await expect(
      db.execute(
        sql`UPDATE accounting.reconciliation SET difference = ${amountToSql(parseAmount("1.00"))} WHERE id = ${completed.id}`,
      ),
    ).rejects.toThrow();
  });
});
