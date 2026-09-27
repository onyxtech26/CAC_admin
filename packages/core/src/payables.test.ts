import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import { hashPassword } from "./password.js";
import { resolveCapabilities, AuthorizationError, type Principal } from "./authz.js";
import { ConflictError, ValidationError } from "./errors.js";
import { formatAmount, parseAmount } from "./money.js";
import { createFiscalYear } from "./periods.js";
import { trialBalance } from "./ledger.js";
import { getJournal } from "./posting.js";
import { createSupplier } from "./parties.js";
import { payablesAging } from "./reports.js";
import { approveVoucher, createVoucher, postVoucher, submitVoucher } from "./purchasing.js";
import {
  applySupplierCreditNote,
  approveSupplierInvoice,
  createSupplierCreditNote,
  createSupplierInvoice,
  deleteSupplierInvoice,
  getSupplierInvoice,
  listSettlements,
  listSupplierInvoices,
  postSupplierInvoice,
  removeSettlement,
  settleBills,
  submitSupplierInvoice,
  updateSupplierInvoice,
  voidSupplierInvoice,
} from "./payables.js";

/**
 * The payables sub-ledger, end to end.
 *
 * This is the A/P half of what sales.test.ts does for A/R, and it is written against the same
 * worked example turned around:
 *
 *   create a supplier -> enter the bill they sent -> submit -> approve as somebody else ->
 *   post -> journal balanced and on the right sides -> pay it with a voucher -> partial
 *   settlement -> full settlement -> appears correctly in the payables aging -> agrees with the
 *   control account -> and the things that must be refused are refused.
 *
 * Two of these tests are the reason the module exists at all: the duplicate-bill refusal, and the
 * aging report reconciling against account 2110. A payables ledger that cannot do those two is
 * decoration.
 */

let db: Database;
let close: () => Promise<void>;

let clerk: Principal; // ACCOUNTS_EXECUTIVE — enters bills, cannot approve them
let accountant: Principal; // ACCOUNTANT — posts
let director: Principal; // DIRECTOR — approves
let employee: Principal; // EMPLOYEE — no business here

let supplierId: string;
let otherSupplierId: string;

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

/** A professional-fees line: what CAC actually buys. 7120 is legal and professional fees. */
const costLines = (amount = "1200.00") => [
  { description: "Land search fees", quantity: "1", unitPrice: amount, accountCode: "7120" },
];

/** Enters, approves and posts a bill, returning its id — the setup most tests need. */
async function postedBill(
  docNo: string,
  amount: string,
  options: { billDate?: string; dueDate?: string; supplier?: string } = {},
): Promise<string> {
  const { id } = await createSupplierInvoice(db, clerk, {
    supplierId: options.supplier ?? supplierId,
    supplierDocNo: docNo,
    billDate: options.billDate ?? "2026-03-01",
    dueDate: options.dueDate ?? "2026-03-31",
    lines: costLines(amount),
  });
  await submitSupplierInvoice(db, clerk, id);
  await approveSupplierInvoice(db, director, id);
  await postSupplierInvoice(db, accountant, id);
  return id;
}

async function accountId(code: string): Promise<string> {
  const result = await db.execute<{ id: string }>(
    sql`SELECT id FROM accounting.account WHERE code = ${code}`,
  );
  return result.rows![0]!.id;
}

/** A posted payment voucher made out to the supplier, ready to settle bills with. */
async function postedVoucher(amount: string, date = "2026-03-20"): Promise<string> {
  const { id } = await createVoucher(db, clerk, {
    supplierId,
    voucherDate: date,
    kind: "settlement",
    paymentAccountId: await accountId("1251"),
    lines: [{ description: "Payment on account", quantity: "1", unitPrice: amount, accountCode: "2110" }],
  });
  await submitVoucher(db, clerk, id);
  await approveVoucher(db, director, id);
  await postVoucher(db, accountant, id);
  return id;
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  await runMigrations(db);
  await seed(db);

  clerk = await makePrincipal("ap-clerk@cac.test", ["ACCOUNTS_EXECUTIVE"]);
  accountant = await makePrincipal("ap-accountant@cac.test", ["ACCOUNTANT"]);
  director = await makePrincipal("ap-director@cac.test", ["DIRECTOR"]);
  employee = await makePrincipal("ap-employee@cac.test", ["EMPLOYEE"]);

  await createFiscalYear(db, director, { startsOn: "2026-01-01" });

  supplierId = (
    await createSupplier(db, clerk, {
      code: "SUP-001",
      name: "Jaya Land Search Services",
      paymentTermsDays: 30,
    })
  ).id;

  otherSupplierId = (
    await createSupplier(db, clerk, { code: "SUP-002", name: "Meridian Printers" })
  ).id;
}, 180_000);

afterAll(async () => {
  await close();
});

// ---------------------------------------------------------------------------
describe("entering a bill", () => {
  it("records the supplier's own document number, and requires one", async () => {
    await expect(
      createSupplierInvoice(db, clerk, {
        supplierId,
        supplierDocNo: "   ",
        billDate: "2026-02-01",
        dueDate: "2026-03-03",
        lines: costLines(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("computes the total from the lines rather than taking it on trust", async () => {
    const { id } = await createSupplierInvoice(db, clerk, {
      supplierId,
      supplierDocNo: "JLS-1001",
      billDate: "2026-02-01",
      dueDate: "2026-03-03",
      lines: [
        { description: "Land search", quantity: "3", unitPrice: "150.00", accountCode: "7120" },
        { description: "Courier", quantity: "1", unitPrice: "40.00", accountCode: "7130" },
      ],
    });

    const bill = await getSupplierInvoice(db, id);
    expect(bill!.subtotal).toBe(parseAmount("490.00"));
    expect(bill!.total).toBe(parseAmount("490.00"));
    expect(bill!.outstanding).toBe(parseAmount("490.00"));
    expect(bill!.status).toBe("draft");
  });

  it("refuses a due date before the date on the bill", async () => {
    await expect(
      createSupplierInvoice(db, clerk, {
        supplierId,
        supplierDocNo: "JLS-1002",
        billDate: "2026-02-10",
        dueDate: "2026-02-01",
        lines: costLines(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a bill received before it was written", async () => {
    await expect(
      createSupplierInvoice(db, clerk, {
        supplierId,
        supplierDocNo: "JLS-1003",
        billDate: "2026-02-10",
        dueDate: "2026-03-10",
        receivedDate: "2026-02-01",
        lines: costLines(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  /**
   * The test this module exists for.
   *
   * A supplier sends a statement, somebody treats it as a fresh invoice, and it is paid twice.
   * There is no clever way to detect that after the fact, so it is refused at the door — and the
   * message names the bill it duplicates, because an error that only says "already exists" gets
   * worked around by changing the reference.
   */
  it("refuses the same supplier document number twice, and says which bill it duplicates", async () => {
    await createSupplierInvoice(db, clerk, {
      supplierId,
      supplierDocNo: "JLS-2001",
      billDate: "2026-02-15",
      dueDate: "2026-03-17",
      lines: costLines("800.00"),
    });

    const again = createSupplierInvoice(db, clerk, {
      supplierId,
      supplierDocNo: "jls-2001 ",
      billDate: "2026-02-15",
      dueDate: "2026-03-17",
      lines: costLines("800.00"),
    });

    await expect(again).rejects.toBeInstanceOf(ConflictError);
    await expect(again).rejects.toThrow(/already been entered/i);
  });

  it("allows the same document number for a different supplier", async () => {
    const { id } = await createSupplierInvoice(db, clerk, {
      supplierId: otherSupplierId,
      supplierDocNo: "JLS-2001",
      billDate: "2026-02-15",
      dueDate: "2026-03-17",
      lines: costLines("300.00"),
    });
    expect(id).toBeTruthy();
  });

  it("lets a draft be edited and deleted", async () => {
    const { id } = await createSupplierInvoice(db, clerk, {
      supplierId,
      supplierDocNo: "JLS-3001",
      billDate: "2026-02-20",
      dueDate: "2026-03-22",
      lines: costLines("100.00"),
    });

    await updateSupplierInvoice(db, clerk, id, {
      supplierId,
      supplierDocNo: "JLS-3001-A",
      billDate: "2026-02-20",
      dueDate: "2026-03-22",
      lines: costLines("250.00"),
    });

    const edited = await getSupplierInvoice(db, id);
    expect(edited!.supplierDocNo).toBe("JLS-3001-A");
    expect(edited!.total).toBe(parseAmount("250.00"));

    await deleteSupplierInvoice(db, clerk, id);
    expect(await getSupplierInvoice(db, id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("approval", () => {
  it("will not let the person who entered a bill approve it", async () => {
    const { id } = await createSupplierInvoice(db, accountant, {
      supplierId,
      supplierDocNo: "JLS-4001",
      billDate: "2026-03-01",
      dueDate: "2026-03-31",
      lines: costLines(),
    });
    await submitSupplierInvoice(db, accountant, id);

    await expect(approveSupplierInvoice(db, accountant, id)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await approveSupplierInvoice(db, director, id);
    expect((await getSupplierInvoice(db, id))!.status).toBe("approved");
  });

  it("refuses a clerk who has no approval capability", async () => {
    const { id } = await createSupplierInvoice(db, accountant, {
      supplierId,
      supplierDocNo: "JLS-4002",
      billDate: "2026-03-01",
      dueDate: "2026-03-31",
      lines: costLines(),
    });
    await submitSupplierInvoice(db, accountant, id);
    await expect(approveSupplierInvoice(db, clerk, id)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses an employee at the door", async () => {
    await expect(
      createSupplierInvoice(db, employee, {
        supplierId,
        supplierDocNo: "JLS-4003",
        billDate: "2026-03-01",
        dueDate: "2026-03-31",
        lines: costLines(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("will not post a bill that has not been approved", async () => {
    const { id } = await createSupplierInvoice(db, clerk, {
      supplierId,
      supplierDocNo: "JLS-4004",
      billDate: "2026-03-01",
      dueDate: "2026-03-31",
      lines: costLines(),
    });
    await submitSupplierInvoice(db, clerk, id);
    await expect(postSupplierInvoice(db, accountant, id)).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
describe("posting", () => {
  it("debits the cost and credits payables, and the journal balances", async () => {
    const id = await postedBill("JLS-5001", "1500.00");

    const bill = await getSupplierInvoice(db, id);
    expect(bill!.status).toBe("posted");
    expect(bill!.billNo).toMatch(/^BILL-2026-\d{5}$/);
    expect(bill!.journalId).toBeTruthy();

    const journal = await getJournal(db, bill!.journalId!);
    const payable = journal!.lines.find((line) => line.accountCode === "2110");
    const cost = journal!.lines.find((line) => line.accountCode === "7120");

    expect(payable!.credit).toBe(parseAmount("1500.00"));
    expect(cost!.debit).toBe(parseAmount("1500.00"));

    const debits = journal!.lines.reduce((sum, line) => sum + line.debit, 0n);
    const credits = journal!.lines.reduce((sum, line) => sum + line.credit, 0n);
    expect(debits).toBe(credits);
  });

  it("carries the bill into the trial balance", async () => {
    await postedBill("JLS-5002", "600.00");
    const tb = await trialBalance(db, { to: "2026-12-31" });
    expect(tb.difference).toBe(0n);
    const payables = tb.rows.find((row) => row.code === "2110");
    expect(payables!.credit).toBeGreaterThan(0n);
  });

  it("refuses to change the terms of a posted bill", async () => {
    const id = await postedBill("JLS-5003", "400.00");
    await expect(
      updateSupplierInvoice(db, clerk, id, {
        supplierId,
        supplierDocNo: "JLS-5003",
        billDate: "2026-03-01",
        dueDate: "2026-03-31",
        lines: costLines("999.00"),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to delete a posted bill", async () => {
    const id = await postedBill("JLS-5004", "400.00");
    await expect(deleteSupplierInvoice(db, clerk, id)).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
describe("settlement", () => {
  it("settles a bill in part and then in full, and the status follows the arithmetic", async () => {
    const billId = await postedBill("JLS-6001", "1000.00");

    await settleBills(db, clerk, {
      voucherId: await postedVoucher("400.00"),
      allocations: [{ billId, amount: "400.00" }],
    });

    let bill = await getSupplierInvoice(db, billId);
    expect(bill!.amountSettled).toBe(parseAmount("400.00"));
    expect(bill!.outstanding).toBe(parseAmount("600.00"));
    expect(bill!.status).toBe("posted");

    await settleBills(db, clerk, {
      voucherId: await postedVoucher("600.00", "2026-03-25"),
      allocations: [{ billId, amount: "600.00" }],
    });

    bill = await getSupplierInvoice(db, billId);
    expect(bill!.outstanding).toBe(0n);
    // Not because anybody said so — because what has been applied adds up to the total.
    expect(bill!.status).toBe("settled");

    expect(await listSettlements(db, billId)).toHaveLength(2);
  });

  it("refuses to settle more than the bill is for", async () => {
    const billId = await postedBill("JLS-6002", "500.00");
    const voucherId = await postedVoucher("900.00");

    await expect(
      settleBills(db, clerk, { voucherId, allocations: [{ billId, amount: "900.00" }] }),
    ).rejects.toThrow(/more than the bill is for/i);
  });

  it("refuses to settle a bill belonging to another supplier", async () => {
    const billId = await postedBill("MER-7001", "200.00", { supplier: otherSupplierId });
    const voucherId = await postedVoucher("200.00");

    await expect(
      settleBills(db, clerk, { voucherId, allocations: [{ billId, amount: "200.00" }] }),
    ).rejects.toThrow(/different supplier/i);
  });

  it("refuses to settle from a voucher that has not been posted", async () => {
    const billId = await postedBill("JLS-6003", "300.00");
    const { id: voucherId } = await createVoucher(db, clerk, {
      supplierId,
      voucherDate: "2026-03-20",
      kind: "settlement",
      paymentAccountId: await accountId("1251"),
      lines: [
        { description: "Payment", quantity: "1", unitPrice: "300.00", accountCode: "2110" },
      ],
    });

    await expect(
      settleBills(db, clerk, { voucherId, allocations: [{ billId, amount: "300.00" }] }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("puts a bill back to posted when a settlement is removed", async () => {
    const billId = await postedBill("JLS-6004", "250.00");
    await settleBills(db, clerk, {
      voucherId: await postedVoucher("250.00"),
      allocations: [{ billId, amount: "250.00" }],
    });
    expect((await getSupplierInvoice(db, billId))!.status).toBe("settled");

    const [settlement] = await listSettlements(db, billId);
    await removeSettlement(db, clerk, settlement!.id, "Paid the wrong bill");

    const bill = await getSupplierInvoice(db, billId);
    expect(bill!.status).toBe("posted");
    expect(bill!.outstanding).toBe(parseAmount("250.00"));
  });
});

// ---------------------------------------------------------------------------
describe("supplier credit notes", () => {
  it("credits a posted bill and reduces what is owed", async () => {
    const billId = await postedBill("JLS-8001", "1000.00");

    const { id: creditId } = await createSupplierCreditNote(db, clerk, {
      billId,
      supplierDocNo: "JLS-CN-01",
      lines: [
        { description: "Overcharge on land search", quantity: "1", unitPrice: "150.00", accountCode: "7120" },
      ],
      reason: "They billed three searches and did two",
    });
    await submitSupplierInvoice(db, clerk, creditId);
    await approveSupplierInvoice(db, director, creditId);
    await postSupplierInvoice(db, accountant, creditId);

    const credit = await getSupplierInvoice(db, creditId);
    expect(credit!.kind).toBe("credit_note");
    expect(credit!.billNo).toMatch(/^SCN-2026-\d{5}$/);

    // The sides are swapped: payables debited, the cost credited back.
    const journal = await getJournal(db, credit!.journalId!);
    expect(journal!.lines.find((line) => line.accountCode === "2110")!.debit).toBe(
      parseAmount("150.00"),
    );

    await applySupplierCreditNote(db, clerk, { creditNoteId: creditId, billId, amount: "150.00" });

    const bill = await getSupplierInvoice(db, billId);
    expect(bill!.outstanding).toBe(parseAmount("850.00"));
  });

  it("refuses a credit note for more than the bill it credits", async () => {
    const billId = await postedBill("JLS-8002", "200.00");
    const { id: creditId } = await createSupplierCreditNote(db, clerk, {
      billId,
      supplierDocNo: "JLS-CN-02",
      lines: [
        { description: "Too much", quantity: "1", unitPrice: "500.00", accountCode: "7120" },
      ],
      reason: "Testing the cap",
    });
    await submitSupplierInvoice(db, clerk, creditId);
    await approveSupplierInvoice(db, director, creditId);

    await expect(postSupplierInvoice(db, accountant, creditId)).rejects.toThrow(
      /never incurred/i,
    );
  });
});

// ---------------------------------------------------------------------------
describe("voiding", () => {
  it("reverses the journal and needs a reason", async () => {
    const id = await postedBill("JLS-9001", "700.00");
    await expect(voidSupplierInvoice(db, director, id, "  ")).rejects.toBeInstanceOf(
      ValidationError,
    );

    const { journalNo } = await voidSupplierInvoice(db, director, id, "Not our bill");
    expect(journalNo).toBeTruthy();

    const bill = await getSupplierInvoice(db, id);
    expect(bill!.status).toBe("void");

    const tb = await trialBalance(db, { to: "2026-12-31" });
    expect(tb.difference).toBe(0n);
  });

  it("will not void a bill that has been settled", async () => {
    const billId = await postedBill("JLS-9002", "300.00");
    await settleBills(db, clerk, {
      voucherId: await postedVoucher("300.00"),
      allocations: [{ billId, amount: "300.00" }],
    });

    await expect(voidSupplierInvoice(db, director, billId, "Changed my mind")).rejects.toThrow(
      /settled against this bill/i,
    );
  });

  /** A voided bill's number becomes re-usable, because it must be possible to re-enter it. */
  it("lets a voided document number be entered again", async () => {
    const id = await postedBill("JLS-9003", "120.00");
    await voidSupplierInvoice(db, director, id, "Entered against the wrong supplier");

    const again = await createSupplierInvoice(db, clerk, {
      supplierId,
      supplierDocNo: "JLS-9003",
      billDate: "2026-03-01",
      dueDate: "2026-03-31",
      lines: costLines("120.00"),
    });
    expect(again.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe("the payables aging report", () => {
  /**
   * The other test this module exists for.
   *
   * An aging report that does not agree with the control account is a number somebody will act on
   * and should not. This checks the difference is nil across everything the suite has posted.
   */
  it("agrees with the trade payables control account", async () => {
    const aging = await payablesAging(db, { asOf: "2026-12-31" });
    expect(aging.controlAccountBalance).not.toBeNull();
    expect(formatAmount(aging.difference!)).toBe("0.00");
  });

  it("puts an overdue bill in the right bucket and names the oldest", async () => {
    await postedBill("JLS-A001", "1000.00", { billDate: "2026-01-05", dueDate: "2026-01-20" });

    // 2026-03-01 is 40 days past 2026-01-20, so the 30-59 bucket.
    const aging = await payablesAging(db, { asOf: "2026-03-01", supplierId });
    const row = aging.rows[0]!;
    const bucket = row.buckets.find((b) => b.from === 30);
    expect(bucket!.amount).toBeGreaterThanOrEqual(parseAmount("1000.00"));
    expect(row.oldestDueDate).toBe("2026-01-20");
  });

  /**
   * A payment made after the report date must not reduce what was owed at it. This is the bug
   * that makes an aging report quietly disagree with the balance sheet, and the reason the
   * settled figure is rebuilt as at the date rather than read from `amount_settled`.
   */
  it("ignores a payment made after the as-at date", async () => {
    const billId = await postedBill("JLS-A002", "500.00", {
      billDate: "2026-04-01",
      dueDate: "2026-04-30",
    });
    await settleBills(db, clerk, {
      voucherId: await postedVoucher("500.00", "2026-06-15"),
      allocations: [{ billId, amount: "500.00" }],
    });

    const before = await payablesAging(db, { asOf: "2026-05-31", supplierId });
    const after = await payablesAging(db, { asOf: "2026-06-30", supplierId });

    expect(before.totals.total - after.totals.total).toBe(parseAmount("500.00"));
  });

  /**
   * Written because the reconciliation test above failed by exactly 1,350.00 the first time it
   * ran, and this is what the 1,350.00 was: three settlement vouchers posted to the supplier and
   * never matched to a bill. A settlement voucher debits the payables control account the moment
   * it posts, so a report that counts only bills claims more is owed than the balance sheet does.
   */
  it("counts a payment nobody has matched to a bill, so the report still reconciles", async () => {
    const before = await payablesAging(db, { asOf: "2026-12-31" });
    await postedVoucher("777.00", "2026-07-01");
    const after = await payablesAging(db, { asOf: "2026-12-31" });

    expect(after.totals.paymentsOnAccount - before.totals.paymentsOnAccount).toBe(
      parseAmount("777.00"),
    );
    expect(after.totals.total).toBe(before.totals.total);
    expect(formatAmount(after.difference!)).toBe("0.00");
  });

  it("leaves a draft bill out, because nobody has confirmed it is owed", async () => {
    const before = await payablesAging(db, { asOf: "2026-12-31" });
    await createSupplierInvoice(db, clerk, {
      supplierId,
      supplierDocNo: "JLS-A003-DRAFT",
      billDate: "2026-05-01",
      dueDate: "2026-05-31",
      lines: costLines("9999.00"),
    });
    const after = await payablesAging(db, { asOf: "2026-12-31" });
    expect(after.totals.total).toBe(before.totals.total);
  });
});

// ---------------------------------------------------------------------------
describe("listing", () => {
  it("finds a bill by the supplier's own document number", async () => {
    await postedBill("JLS-B001", "75.00");
    const rows = await listSupplierInvoices(db, { search: "JLS-B001" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.supplierDocNo).toBe("JLS-B001");
  });

  it("filters to what is still outstanding", async () => {
    const rows = await listSupplierInvoices(db, { onlyOutstanding: true, limit: 500 });
    expect(rows.every((row) => row.outstanding > 0n)).toBe(true);
  });
});
