import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import { hashPassword } from "./password.js";
import { resolveCapabilities, type Principal } from "./authz.js";
import { ConflictError, ValidationError } from "./errors.js";
import { amountToSql, formatAmount, parseAmount } from "./money.js";
import {
  closeFiscalYear,
  createFiscalYear,
  findPeriodForDate,
  listPeriods,
  transitionPeriod,
} from "./periods.js";
import {
  createDraftJournal,
  deleteDraftJournal,
  getJournal,
  listJournals,
  postJournal,
  postSourceJournal,
  reverseJournal,
  updateDraftJournal,
  validateLines,
} from "./posting.js";
import { accountLedger, ledgerTotals, trialBalance } from "./ledger.js";
import { allocateDocumentNumber, peekDocumentNumber } from "./sequence.js";

/**
 * The Phase 2 exit criteria, as tests.
 *
 * The brief for this phase was specific: a manual journal can be drafted,
 * balanced, posted and reversed; an unbalanced journal cannot post; a closed
 * period rejects posting; the trial balance totals to zero. Each of those has a
 * test below with that name.
 *
 * Every test runs against real PostgreSQL (PGlite), through real migrations, so
 * the database constraints and triggers are exercised alongside the application
 * checks rather than mocked away.
 */

let db: Database;
let close: () => Promise<void>;

/** Two people, because maker/checker needs two. */
let maker: Principal;
let checker: Principal;
let director: Principal;
let clerk: Principal;

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
  };
}

/** A balanced journal: a fee invoiced, the receivable raised. */
const feeJournal = (entryDate = "2026-03-10", amount = "5000.00") => ({
  entryDate,
  memo: "Forensic investigation fee",
  lines: [
    { accountCode: "1210", debit: amount, description: "Client receivable" },
    { accountCode: "4110", credit: amount, description: "Investigation fee" },
  ],
});

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  await runMigrations(db);
  await seed(db);

  maker = await makePrincipal("maker@cac.test", ["ACCOUNTANT"]);
  checker = await makePrincipal("checker@cac.test", ["ACCOUNTANT"]);
  director = await makePrincipal("director@cac.test", ["DIRECTOR"]);
  clerk = await makePrincipal("clerk@cac.test", ["ACCOUNTS_EXECUTIVE"]);

  await createFiscalYear(db, director, { startsOn: "2026-01-01" });
}, 120_000);

afterAll(async () => {
  await close();
});

// ---------------------------------------------------------------------------
describe("the seeded chart of accounts", () => {
  it("is a tree of headings and postable accounts", async () => {
    const counts = await db.execute<{ total: number; postable: number; system: number }>(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE is_postable)::int AS postable,
             count(*) FILTER (WHERE is_system)::int AS system
        FROM accounting.account
    `);
    const row = counts.rows![0]!;
    expect(row.total).toBeGreaterThan(80);
    expect(row.postable).toBeLessThan(row.total); // there are headings
    expect(row.system).toBeGreaterThan(10);
  });

  it("gives every account the normal side its type implies", async () => {
    const wrong = await db.execute<{ code: string }>(sql`
      SELECT code FROM accounting.account
       WHERE (type IN ('ASSET', 'EXPENSE') AND NOT is_contra AND normal_side <> 'debit')
          OR (type IN ('LIABILITY', 'EQUITY', 'REVENUE') AND NOT is_contra AND normal_side <> 'credit')
          OR (is_contra AND type IN ('ASSET', 'EXPENSE') AND normal_side <> 'credit')
    `);
    expect(wrong.rows ?? []).toEqual([]);
  });

  it("refuses to post to a heading, in the database as well as the engine", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-01-06", "5.00"));
    // 1000 "Assets" is a heading. The engine already refuses it; so does the
    // database, for anything that goes round the engine.
    await expect(
      db.execute(sql`
        INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit)
        SELECT ${id}, 99, a.id, 1 FROM accounting.account a WHERE a.code = '1000'
      `),
    ).rejects.toThrow(/is a heading/);
    await deleteDraftJournal(db, maker, id, { reason: "test cleanup" });
  });

  it("seeds tax codes but no rates, because a rate needs a citation", async () => {
    const codes = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM accounting.tax_code`,
    );
    const rates = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM accounting.tax_rate`,
    );
    expect(codes.rows![0]!.count).toBeGreaterThan(0);
    // Nothing asserts a percentage the company has not confirmed.
    expect(rates.rows![0]!.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("the fiscal calendar", () => {
  it("creates twelve contiguous periods with no gap and no overlap", async () => {
    const periods = await listPeriods(db);
    const year = periods
      .filter((p) => p.code.startsWith("2026-"))
      .sort((a, b) => a.startsOn.localeCompare(b.startsOn));
    expect(year).toHaveLength(12);
    expect(year[0]!.startsOn).toBe("2026-01-01");
    expect(year[0]!.endsOn).toBe("2026-01-31");
    expect(year[1]!.endsOn).toBe("2026-02-28");
    expect(year[11]!.endsOn).toBe("2026-12-31");

    // Each period starts the day after the previous one ends.
    for (let i = 1; i < year.length; i += 1) {
      const previousEnd = new Date(`${year[i - 1]!.endsOn}T00:00:00Z`);
      const thisStart = new Date(`${year[i]!.startsOn}T00:00:00Z`);
      expect(thisStart.getTime() - previousEnd.getTime()).toBe(86_400_000);
    }
  });

  it("will not create a year that overlaps an existing one", async () => {
    await expect(createFiscalYear(db, director, { startsOn: "2026-07-01" })).rejects.toThrow(
      ConflictError,
    );
  });

  it("finds the period an entry date falls in, and reports when there is none", async () => {
    const period = await findPeriodForDate(db, "2026-03-15");
    expect(period?.code).toBe("2026-03");
    expect(await findPeriodForDate(db, "2030-01-01")).toBeNull();
  });

  it("refuses a fiscal year that does not start on the first of a month", async () => {
    await expect(createFiscalYear(db, director, { startsOn: "2028-01-15" })).rejects.toThrow(
      /first of a month/,
    );
  });

  it("will not let someone without the capability set up a calendar", async () => {
    await expect(createFiscalYear(db, clerk, { startsOn: "2029-01-01" })).rejects.toThrow(
      /permission/,
    );
  });
});

// ---------------------------------------------------------------------------
describe("validateLines", () => {
  it("accepts a balanced entry", () => {
    const { totalDebit, totalCredit } = validateLines(feeJournal().lines);
    expect(totalDebit).toBe(parseAmount("5000.00"));
    expect(totalCredit).toBe(parseAmount("5000.00"));
  });

  it("rejects an unbalanced entry and says by how much", () => {
    expect(() =>
      validateLines([
        { accountCode: "1210", debit: "100.00" },
        { accountCode: "4110", credit: "90.00" },
      ]),
    ).toThrow(/out of balance by 10.00/);
  });

  it("rejects a single-sided line", () => {
    expect(() =>
      validateLines([
        { accountCode: "1210", debit: "100.00", credit: "100.00" },
        { accountCode: "4110", credit: "100.00" },
      ]),
    ).toThrow(/a debit or a credit, not both/);
  });

  it("rejects negatives, pointing at the other side instead", () => {
    expect(() =>
      validateLines([
        { accountCode: "1210", debit: "-100.00" },
        { accountCode: "4110", credit: "-100.00" },
      ]),
    ).toThrow(/cannot be negative/);
  });

  it("rejects a one-line journal", () => {
    expect(() => validateLines([{ accountCode: "1210", debit: "100.00" }])).toThrow(
      /at least two lines/,
    );
  });

  it("rejects an entry for nothing", () => {
    expect(() =>
      validateLines([
        { accountCode: "1210", debit: "0" },
        { accountCode: "4110", credit: "0" },
      ]),
    ).toThrow(ValidationError);
  });

  it("ignores blank rows the form leaves behind", () => {
    const { totalDebit } = validateLines([
      { accountCode: "1210", debit: "100.00" },
      { accountCode: "4110", credit: "100.00" },
      {},
      { accountCode: "", debit: "", credit: "", description: "" },
    ]);
    expect(totalDebit).toBe(parseAmount("100.00"));
  });

  it("insists on an account for a line that has an amount", () => {
    expect(() =>
      validateLines([
        { debit: "100.00" },
        { accountCode: "4110", credit: "100.00" },
      ]),
    ).toThrow(/choose an account/i);
  });
});

// ---------------------------------------------------------------------------
describe("drafting", () => {
  it("creates a draft with no number, invisible to the ledger", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-03-01", "1200.00"));
    const journal = await getJournal(db, id);

    expect(journal?.status).toBe("draft");
    expect(journal?.journalNo).toBeNull();
    expect(journal?.periodCode).toBe("2026-03");
    // Totals come from the database trigger, not from anything the caller sent.
    expect(journal?.totalDebit).toBe(parseAmount("1200.00"));
    expect(journal?.totalCredit).toBe(parseAmount("1200.00"));
    expect(journal?.lines).toHaveLength(2);

    const tb = await trialBalance(db, { to: "2026-12-31" });
    const receivable = tb.rows.find((row) => row.code === "1210");
    // Nothing from a draft reaches the trial balance.
    expect(receivable?.debit ?? 0n).not.toBe(parseAmount("1200.00"));

    await deleteDraftJournal(db, maker, id, { reason: "test cleanup" });
  });

  it("refuses a date that falls in no period", async () => {
    await expect(createDraftJournal(db, maker, feeJournal("2031-01-15"))).rejects.toThrow(
      /No accounting period covers/,
    );
  });

  it("refuses to draft for a heading account", async () => {
    await expect(
      createDraftJournal(db, maker, {
        entryDate: "2026-03-01",
        lines: [
          { accountCode: "1000", debit: "10.00" },
          { accountCode: "4110", credit: "10.00" },
        ],
      }),
    ).rejects.toThrow(/is a heading/);
  });

  it("refuses an account that does not exist", async () => {
    await expect(
      createDraftJournal(db, maker, {
        entryDate: "2026-03-01",
        lines: [
          { accountCode: "9999", debit: "10.00" },
          { accountCode: "4110", credit: "10.00" },
        ],
      }),
    ).rejects.toThrow(/there is no account "9999"/);
  });

  it("will not let an accounts executive draft a journal", async () => {
    // Preparing documents and touching the ledger are different jobs.
    await expect(createDraftJournal(db, clerk, feeJournal())).rejects.toThrow(/permission/);
  });

  it("replaces a draft's lines wholesale on edit", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-03-02", "800.00"));
    await updateDraftJournal(db, maker, id, {
      entryDate: "2026-03-03",
      memo: "Corrected",
      lines: [
        { accountCode: "1210", debit: "250.00" },
        { accountCode: "4120", credit: "150.00" },
        { accountCode: "4140", credit: "100.00" },
      ],
    });

    const journal = await getJournal(db, id);
    expect(journal?.entryDate).toBe("2026-03-03");
    expect(journal?.memo).toBe("Corrected");
    expect(journal?.lines).toHaveLength(3);
    expect(journal?.totalDebit).toBe(parseAmount("250.00"));
    expect(journal?.totalCredit).toBe(parseAmount("250.00"));

    await deleteDraftJournal(db, maker, id, { reason: "test cleanup" });
  });

  it("will not let one accountant edit another's draft unless they can post it", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-03-04", "100.00"));
    // checker holds accounting.journal.post, so may correct it during review.
    await updateDraftJournal(db, checker, id, feeJournal("2026-03-04", "110.00"));
    expect((await getJournal(db, id))?.totalDebit).toBe(parseAmount("110.00"));
    await deleteDraftJournal(db, checker, id, { reason: "test cleanup" });
  });
});

// ---------------------------------------------------------------------------
describe("posting", () => {
  it("posts a balanced journal, numbers it and stamps who and when", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-03-10", "5000.00"));
    const { journalNo } = await postJournal(db, checker, id);

    expect(journalNo).toMatch(/^JV-2026-\d{5}$/);

    const journal = await getJournal(db, id);
    expect(journal?.status).toBe("posted");
    expect(journal?.journalNo).toBe(journalNo);
    expect(journal?.postedAt).toBeTruthy();
    expect(journal?.postedByName).toBe("checker@cac.test");
    expect(journal?.createdByName).toBe("maker@cac.test");
  });

  it("stops the same person drafting and posting", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-03-11", "300.00"));
    await expect(postJournal(db, maker, id)).rejects.toThrow(/Someone else must review/);
    // Somebody else can.
    await expect(postJournal(db, checker, id)).resolves.toBeTruthy();
  });

  it("will not let a director post a journal they have no capability for", async () => {
    // A DIRECTOR approves and reverses; posting the ledger is the accountant's.
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-03-12", "50.00"));
    await expect(postJournal(db, director, id)).rejects.toThrow(/permission/);
    await deleteDraftJournal(db, maker, id, { reason: "test cleanup" });
  });

  it("an unbalanced journal cannot post", async () => {
    // Created balanced, then unbalanced behind the engine's back, exactly as a
    // bug elsewhere would do it.
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-03-13", "400.00"));
    await db.execute(sql`
      UPDATE accounting.journal_line SET credit = '399.0000'
       WHERE journal_id = ${id} AND credit > 0
    `);

    await expect(postJournal(db, checker, id)).rejects.toThrow(/out of balance by 1.00/);

    // And the database refuses even if the engine is bypassed entirely.
    await expect(
      db.execute(sql`
        UPDATE accounting.journal
           SET status = 'posted', journal_no = 'FORGED-1', posted_at = now(), posted_by = ${checker.userId}
         WHERE id = ${id}
      `),
    ).rejects.toThrow();

    await deleteDraftJournal(db, maker, id, { reason: "test cleanup" });
  });

  it("a single-line journal cannot post", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-03-14", "10.00"));
    await db.execute(sql`DELETE FROM accounting.journal_line WHERE journal_id = ${id} AND credit > 0`);
    await expect(postJournal(db, checker, id)).rejects.toThrow(/at least two lines/);
    await deleteDraftJournal(db, maker, id, { reason: "test cleanup" });
  });

  it("cannot be posted twice", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-03-15", "60.00"));
    await postJournal(db, checker, id);
    await expect(postJournal(db, checker, id)).rejects.toThrow(/already posted/);
  });

  it("numbers journals gaplessly and in order", async () => {
    const numbers: string[] = [];
    for (const amount of ["11.00", "12.00", "13.00"]) {
      const { id } = await createDraftJournal(db, maker, feeJournal("2026-04-01", amount));
      numbers.push((await postJournal(db, checker, id)).journalNo);
    }
    const sequence = numbers.map((n) => Number(n.split("-")[2]));
    expect(sequence[1]).toBe(sequence[0]! + 1);
    expect(sequence[2]).toBe(sequence[1]! + 1);
  });
});

// ---------------------------------------------------------------------------
describe("a posted journal is immutable", () => {
  let postedId: string;

  beforeEach(async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-05-05", "777.00"));
    await postJournal(db, checker, id);
    postedId = id;
  });

  it("cannot be edited through the engine", async () => {
    await expect(
      updateDraftJournal(db, checker, postedId, feeJournal("2026-05-05", "1.00")),
    ).rejects.toThrow(/cannot be edited/);
  });

  it("cannot be deleted through the engine or the database", async () => {
    await expect(deleteDraftJournal(db, checker, postedId)).rejects.toThrow(/cannot be deleted/);
    await expect(
      db.execute(sql`DELETE FROM accounting.journal WHERE id = ${postedId}`),
    ).rejects.toThrow();
  });

  it("cannot have its amounts or date changed in the database", async () => {
    await expect(
      db.execute(sql`UPDATE accounting.journal SET entry_date = '2026-06-01' WHERE id = ${postedId}`),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.execute(sql`UPDATE accounting.journal SET memo = 'rewritten' WHERE id = ${postedId}`),
    ).rejects.toThrow(/immutable/);
  });

  it("cannot have its lines changed in the database", async () => {
    await expect(
      db.execute(sql`UPDATE accounting.journal_line SET debit = '1.0000' WHERE journal_id = ${postedId}`),
    ).rejects.toThrow(/cannot be/);
    await expect(
      db.execute(sql`DELETE FROM accounting.journal_line WHERE journal_id = ${postedId}`),
    ).rejects.toThrow(/cannot be/);
  });

  it("cannot be pushed back to draft", async () => {
    await expect(
      db.execute(sql`UPDATE accounting.journal SET status = 'draft' WHERE id = ${postedId}`),
    ).rejects.toThrow(/cannot move from posted to draft/);
  });
});

// ---------------------------------------------------------------------------
describe("reversal", () => {
  it("posts an equal and opposite entry and links both ways", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-06-10", "2500.00"));
    await postJournal(db, checker, id);

    const { journalId: reversalId, journalNo } = await reverseJournal(db, director, id, {
      reason: "Fee was invoiced to the wrong client",
    });

    const original = await getJournal(db, id);
    const reversal = await getJournal(db, reversalId);

    expect(original?.status).toBe("reversed");
    expect(original?.reversedByNo).toBe(journalNo);
    expect(reversal?.status).toBe("posted");
    expect(reversal?.reversesNo).toBe(original?.journalNo);
    expect(reversal?.reversalReason).toBe("Fee was invoiced to the wrong client");
    expect(reversal?.entryDate).toBe("2026-06-10");

    // Every line is mirrored.
    const originalLine = original!.lines.find((l) => l.accountCode === "1210")!;
    const reversalLine = reversal!.lines.find((l) => l.accountCode === "1210")!;
    expect(reversalLine.credit).toBe(originalLine.debit);
    expect(reversalLine.debit).toBe(0n);

    // And the pair has no net effect on the ledger.
    const ledger = await accountLedger(db, "1210", { from: "2026-06-01", to: "2026-06-30" });
    const net = ledger!.entries
      .filter((e) => e.journalId === id || e.journalId === reversalId)
      .reduce((sum, e) => sum + e.debit - e.credit, 0n);
    expect(net).toBe(0n);
  });

  it("insists on a reason", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-06-11", "10.00"));
    await postJournal(db, checker, id);
    await expect(reverseJournal(db, director, id, { reason: "  " })).rejects.toThrow(
      /needs a reason/,
    );
  });

  it("reverses only once", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-06-12", "20.00"));
    await postJournal(db, checker, id);
    await reverseJournal(db, director, id, { reason: "Duplicate" });
    await expect(reverseJournal(db, director, id, { reason: "Again" })).rejects.toThrow(
      /already been reversed/,
    );
  });

  it("will not reverse a draft", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-06-13", "30.00"));
    await expect(reverseJournal(db, director, id, { reason: "No" })).rejects.toThrow(
      /has not been posted/,
    );
    await deleteDraftJournal(db, maker, id, { reason: "test cleanup" });
  });

  it("needs the reverse capability, which an accountant has and a clerk does not", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-06-14", "40.00"));
    await postJournal(db, checker, id);
    await expect(reverseJournal(db, clerk, id, { reason: "Nope" })).rejects.toThrow(/permission/);
  });
});

// ---------------------------------------------------------------------------
describe("period control", () => {
  it("a closed period rejects posting", async () => {
    // Draft first, while the period is open.
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-02-10", "150.00"));
    const { id: second } = await createDraftJournal(db, maker, feeJournal("2026-02-11", "160.00"));
    await postJournal(db, checker, second);

    const february = (await listPeriods(db)).find((p) => p.code === "2026-02")!;

    // Closing refuses while a draft is still sitting in the period.
    await expect(transitionPeriod(db, maker, february.id, "close")).rejects.toThrow(
      /unposted draft journal/,
    );

    await postJournal(db, checker, id);
    await transitionPeriod(db, maker, february.id, "close");

    // Now nothing more can be posted into it.
    const blocked = await createDraftJournal(db, maker, feeJournal("2026-03-20", "170.00"));
    await db.execute(sql`
      UPDATE accounting.journal SET period_id = ${february.id}, entry_date = '2026-02-15'
       WHERE id = ${blocked.id}
    `);
    await expect(postJournal(db, checker, blocked.id)).rejects.toThrow(/is closed/);

    // Even bypassing the engine.
    await expect(
      db.execute(sql`
        UPDATE accounting.journal
           SET status = 'posted', journal_no = 'FORGED-2', posted_at = now(), posted_by = ${checker.userId}
         WHERE id = ${blocked.id}
      `),
    ).rejects.toThrow(/will not accept postings/);

    // And a new draft cannot be prepared for a closed period either.
    await expect(createDraftJournal(db, maker, feeJournal("2026-02-20", "1.00"))).rejects.toThrow(
      /is closed/,
    );

    await db.execute(sql`DELETE FROM accounting.journal WHERE id = ${blocked.id}`);
  });

  it("locks and unlocks a period, which is the reversible freeze", async () => {
    const july = (await listPeriods(db)).find((p) => p.code === "2026-07")!;
    await transitionPeriod(db, maker, july.id, "lock");
    await expect(createDraftJournal(db, maker, feeJournal("2026-07-05", "1.00"))).rejects.toThrow(
      /is locked/,
    );
    await transitionPeriod(db, maker, july.id, "unlock");
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-07-05", "1.00"));
    await deleteDraftJournal(db, maker, id, { reason: "test cleanup" });
  });

  it("reopening a closed period needs a reason and is audited", async () => {
    const february = (await listPeriods(db)).find((p) => p.code === "2026-02")!;
    await expect(transitionPeriod(db, director, february.id, "reopen")).rejects.toThrow(
      /needs a reason/,
    );
    await transitionPeriod(db, director, february.id, "reopen", {
      reason: "Late supplier invoice received",
    });
    expect((await listPeriods(db)).find((p) => p.code === "2026-02")?.status).toBe("open");

    const audit = await db.execute<{ action: string; reason: string }>(sql`
      SELECT action, reason FROM audit.event
       WHERE entity_type = 'accounting_period' AND action = 'PERIOD_REOPENED'
       ORDER BY created_at DESC LIMIT 1
    `);
    expect(audit.rows![0]!.reason).toBe("Late supplier invoice received");
  });

  it("will not let a clerk lock or close anything", async () => {
    const august = (await listPeriods(db)).find((p) => p.code === "2026-08")!;
    await expect(transitionPeriod(db, clerk, august.id, "lock")).rejects.toThrow(/permission/);
    await expect(transitionPeriod(db, clerk, august.id, "close")).rejects.toThrow(/permission/);
  });

  it("will not close a fiscal year over periods that are still open", async () => {
    const years = await db.execute<{ id: string }>(
      sql`SELECT id FROM accounting.fiscal_year WHERE name = 'FY2026'`,
    );
    await expect(closeFiscalYear(db, director, years.rows![0]!.id)).rejects.toThrow(
      /not closed/,
    );
  });
});

// ---------------------------------------------------------------------------
describe("the trial balance", () => {
  it("totals to zero", async () => {
    const tb = await trialBalance(db, { to: "2026-12-31" });
    expect(tb.rows.length).toBeGreaterThan(0);
    expect(formatAmount(tb.difference)).toBe("0.00");
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it("still totals to zero after a reversal", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-09-09", "1234.56"));
    await postJournal(db, checker, id);
    expect((await trialBalance(db, { to: "2026-12-31" })).difference).toBe(0n);

    await reverseJournal(db, director, id, { reason: "Balance check" });
    const after = await trialBalance(db, { to: "2026-12-31" });
    expect(after.difference).toBe(0n);

    // The reversed original and its reversal both remain in the ledger and
    // cancel, which is why excluding 'reversed' would break this.
    const receivable = after.rows.find((row) => row.code === "1210")!;
    expect(receivable.debit).toBeGreaterThan(0n);
    expect(receivable.credit).toBeGreaterThan(0n);
  });

  it("presents each balance on the side it falls", async () => {
    const tb = await trialBalance(db, { to: "2026-12-31" });
    const receivable = tb.rows.find((row) => row.code === "1210")!;
    const revenue = tb.rows.find((row) => row.code === "4110")!;

    // An asset with money owed to us sits in the debit column.
    expect(receivable.balanceDebit).toBeGreaterThan(0n);
    expect(receivable.balanceCredit).toBe(0n);
    // Revenue sits in the credit column.
    expect(revenue.balanceCredit).toBeGreaterThan(0n);
    expect(revenue.balanceDebit).toBe(0n);
  });

  it("respects the date window", async () => {
    const wide = await trialBalance(db, { to: "2026-12-31" });
    const narrow = await trialBalance(db, { from: "2026-03-01", to: "2026-03-31" });
    expect(narrow.totalDebit).toBeLessThan(wide.totalDebit);
    expect(narrow.difference).toBe(0n);
  });

  it("agrees with the ledger health check", async () => {
    const totals = await ledgerTotals(db);
    expect(totals.outOfBalance).toBe(0n);
    expect(totals.postedJournals).toBeGreaterThan(0);
    expect(totals.reversedJournals).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("the account ledger", () => {
  it("runs a balance in the account's own direction", async () => {
    const receivable = await accountLedger(db, "1210", { to: "2026-12-31" });
    expect(receivable!.normalSide).toBe("debit");
    expect(receivable!.entries.length).toBeGreaterThan(0);
    // Debit-normal: money owed to us reads positive.
    expect(receivable!.closingBalance).toBeGreaterThan(0n);

    const revenue = await accountLedger(db, "4110", { to: "2026-12-31" });
    expect(revenue!.normalSide).toBe("credit");
    // Credit-normal: revenue earned also reads positive, not negative.
    expect(revenue!.closingBalance).toBeGreaterThan(0n);
  });

  it("carries an opening balance into a windowed view", async () => {
    const full = await accountLedger(db, "1210", { to: "2026-12-31" });
    const later = await accountLedger(db, "1210", { from: "2026-06-01", to: "2026-12-31" });
    const earlier = await accountLedger(db, "1210", { to: "2026-05-31" });

    expect(later!.openingBalance).toBe(earlier!.closingBalance);
    expect(later!.closingBalance).toBe(full!.closingBalance);
  });

  it("returns null for an account that does not exist", async () => {
    expect(await accountLedger(db, "0000")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("source documents post through the same engine", () => {
  it("creates and posts in one step, with the document's own authorisation", async () => {
    const { id, journalNo } = await postSourceJournal(db, clerk, {
      entryDate: "2026-10-01",
      memo: "Invoice INV-2026-00001",
      sourceType: "invoice",
      sourceId: "11111111-1111-1111-1111-111111111111",
      authorisedBy: "accounting.invoice.create",
      lines: [
        { accountCode: "1210", debit: "3000.00" },
        { accountCode: "4130", credit: "3000.00" },
      ],
    });

    const journal = await getJournal(db, id);
    expect(journal?.status).toBe("posted");
    expect(journal?.journalNo).toBe(journalNo);
    expect(journal?.sourceType).toBe("invoice");
    // No maker/checker step: the clerk created and posted it, because the
    // approval belongs to the invoice, not to its ledger entry.
    expect(journal?.createdByName).toBe("clerk@cac.test");
    expect((await trialBalance(db, { to: "2026-12-31" })).difference).toBe(0n);
  });

  it("refuses when the caller lacks the document's own capability", async () => {
    await expect(
      postSourceJournal(db, clerk, {
        entryDate: "2026-10-02",
        sourceType: "payroll",
        authorisedBy: "hr.payroll.post",
        lines: [
          { accountCode: "6110", debit: "10.00" },
          { accountCode: "2150", credit: "10.00" },
        ],
      }),
    ).rejects.toThrow(/permission/);
  });
});

// ---------------------------------------------------------------------------
describe("listing journals", () => {
  it("filters by status, period and text", async () => {
    const all = await listJournals(db, { limit: 500 });
    expect(all.length).toBeGreaterThan(5);

    const posted = await listJournals(db, { status: "posted", limit: 500 });
    expect(posted.every((j) => j.status === "posted")).toBe(true);
    expect(posted.every((j) => j.journalNo !== null)).toBe(true);

    const march = (await listPeriods(db)).find((p) => p.code === "2026-03")!;
    const inMarch = await listJournals(db, { periodId: march.id, limit: 500 });
    expect(inMarch.every((j) => j.periodCode === "2026-03")).toBe(true);

    const byMemo = await listJournals(db, { search: "forensic" });
    expect(byMemo.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("document numbering", () => {
  it("is gapless and restarts each year", async () => {
    await db.execute(sql`
      INSERT INTO org.document_sequence (key, prefix, format, padding)
      VALUES ('seqtest', 'TST', '{PREFIX}-{YYYY}-{SEQ}', '4')
    `);

    expect(await allocateDocumentNumber(db, "seqtest", { on: "2026-01-05" })).toBe("TST-2026-0001");
    expect(await allocateDocumentNumber(db, "seqtest", { on: "2026-06-05" })).toBe("TST-2026-0002");
    // A new year restarts the count, because the format carries the year.
    expect(await allocateDocumentNumber(db, "seqtest", { on: "2027-01-05" })).toBe("TST-2027-0001");
  });

  it("previews without consuming", async () => {
    await db.execute(sql`
      INSERT INTO org.document_sequence (key, prefix, format, padding)
      VALUES ('peektest', 'PK', '{PREFIX}-{YYYY}-{SEQ}', '3')
    `);
    expect(await peekDocumentNumber(db, "peektest", { on: "2026-01-01" })).toBe("PK-2026-001");
    expect(await peekDocumentNumber(db, "peektest", { on: "2026-01-01" })).toBe("PK-2026-001");
    expect(await allocateDocumentNumber(db, "peektest", { on: "2026-01-01" })).toBe("PK-2026-001");
    expect(await peekDocumentNumber(db, "peektest", { on: "2026-01-01" })).toBe("PK-2026-002");
  });

  it("returns the number to the pool when the transaction rolls back", async () => {
    await db.execute(sql`
      INSERT INTO org.document_sequence (key, prefix, format, padding)
      VALUES ('rollback', 'RB', '{PREFIX}-{YYYY}-{SEQ}', '3')
    `);

    // This is the reason for not using a PostgreSQL sequence: nextval would keep
    // the consumed value and leave a hole in the invoice book.
    await expect(
      db.transaction(async (tx) => {
        expect(await allocateDocumentNumber(tx, "rollback", { on: "2026-01-01" })).toBe("RB-2026-001");
        throw new Error("abandon");
      }),
    ).rejects.toThrow("abandon");

    expect(await allocateDocumentNumber(db, "rollback", { on: "2026-01-01" })).toBe("RB-2026-001");
  });

  it("reports a sequence nobody configured rather than inventing one", async () => {
    await expect(allocateDocumentNumber(db, "nonexistent")).rejects.toThrow(
      /No document sequence is configured/,
    );
  });
});

// ---------------------------------------------------------------------------
describe("the audit trail", () => {
  it("records the whole life of a journal", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-11-11", "999.00"));
    await postJournal(db, checker, id);
    await reverseJournal(db, director, id, { reason: "Recorded twice" });

    const events = await db.execute<{ action: string; actor_label: string }>(sql`
      SELECT action, actor_label FROM audit.event
       WHERE entity_id = ${id} ORDER BY created_at
    `);
    const actions = (events.rows ?? []).map((row) => row.action);
    expect(actions).toEqual(["JOURNAL_DRAFTED", "JOURNAL_POSTED", "JOURNAL_REVERSED"]);
    expect(events.rows!.map((r) => r.actor_label)).toEqual([
      "maker@cac.test",
      "checker@cac.test",
      "director@cac.test",
    ]);
  });

  it("records what a discarded draft contained", async () => {
    const { id } = await createDraftJournal(db, maker, feeJournal("2026-11-12", "1.00"));
    await deleteDraftJournal(db, maker, id, { reason: "Entered in error" });

    const event = await db.execute<{ reason: string; old_values: Record<string, unknown> }>(sql`
      SELECT reason, old_values FROM audit.event
       WHERE entity_id = ${id} AND action = 'JOURNAL_DELETED'
    `);
    expect(event.rows![0]!.reason).toBe("Entered in error");
    expect(event.rows![0]!.old_values.entryDate).toBe("2026-11-12");
  });

  it("notes when a journal was posted by its own author", async () => {
    // With the second-person rule switched off, self-posting is allowed but the
    // trail says so on the journal it happened to.
    await db.execute(sql`
      UPDATE org.setting SET value = 'false'::jsonb
       WHERE key = 'accounting.journal_requires_second_person'
    `);

    const { id } = await createDraftJournal(db, maker, feeJournal("2026-11-13", "2.00"));
    await postJournal(db, maker, id);

    const event = await db.execute<{ new_values: Record<string, unknown> }>(sql`
      SELECT new_values FROM audit.event WHERE entity_id = ${id} AND action = 'JOURNAL_POSTED'
    `);
    expect(event.rows![0]!.new_values.selfPosted).toBe(true);

    await db.execute(sql`
      UPDATE org.setting SET value = 'true'::jsonb
       WHERE key = 'accounting.journal_requires_second_person'
    `);
  });

  it("cannot be rewritten", async () => {
    await expect(
      db.execute(sql`UPDATE audit.event SET action = 'NOTHING_HAPPENED' WHERE action = 'JOURNAL_POSTED'`),
    ).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
describe("amounts survive the round trip to the database", () => {
  it("stores and returns four decimal places exactly", async () => {
    const { id } = await createDraftJournal(db, maker, {
      entryDate: "2026-12-01",
      memo: "Precision check",
      lines: [
        { accountCode: "1210", debit: "0.0001" },
        { accountCode: "4110", credit: "0.0001" },
      ],
    });
    const journal = await getJournal(db, id);
    expect(amountToSql(journal!.lines[0]!.debit)).toBe("0.0001");
    expect(journal!.totalDebit).toBe(parseAmount("0.0001"));
    await deleteDraftJournal(db, maker, id, { reason: "test cleanup" });
  });

  it("adds many awkward amounts without drifting a cent", async () => {
    const lines = Array.from({ length: 30 }, () => ({
      accountCode: "5110",
      debit: "0.07",
    }));
    const { id } = await createDraftJournal(db, maker, {
      entryDate: "2026-12-02",
      memo: "Thirty seven-cent lines",
      lines: [...lines, { accountCode: "1251", credit: "2.10" }],
    });
    const journal = await getJournal(db, id);
    expect(journal!.totalDebit).toBe(parseAmount("2.10"));
    expect(journal!.totalDebit).toBe(journal!.totalCredit);
    await deleteDraftJournal(db, maker, id, { reason: "test cleanup" });
  });
});
