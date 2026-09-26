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
import { trialBalance } from "./ledger.js";
import { getJournal } from "./posting.js";
import { createSupplier } from "./parties.js";
import { setSetting } from "./settings.js";
import { balanceSheet, profitAndLoss } from "./reports.js";
import {
  approvePurchaseOrder,
  approveVoucher,
  closePurchaseOrder,
  createPurchaseOrder,
  createVoucher,
  getPurchaseOrder,
  getVoucher,
  issuePurchaseOrder,
  listPurchaseOrders,
  listVouchers,
  postVoucher,
  receivePurchaseOrder,
  submitPurchaseOrder,
  submitVoucher,
  updatePurchaseOrder,
  voidVoucher,
} from "./purchasing.js";
import {
  countPettyCash,
  createClaim,
  decideClaim,
  getClaim,
  listPettyCash,
  markClaimReimbursed,
  pettyCashPosition,
  postClaim,
  postPettyCash,
  recordPettyCash,
  submitClaim,
  voidPettyCash,
} from "./expenses.js";

/**
 * Phase 3b: money out.
 *
 * The three things worth proving, beyond the mechanics:
 *
 *   - a purchase order reaches no ledger account, whatever happens to it;
 *   - every payment has a second person in the loop, on every path;
 *   - the petty cash float reconciles to a physical count, and a difference is
 *     posted rather than absorbed.
 */

let db: Database;
let close: () => Promise<void>;

let clerk: Principal; // ACCOUNTS_EXECUTIVE — prepares
let accountant: Principal; // ACCOUNTANT — pays, posts, reconciles
let director: Principal; // DIRECTOR — approves
let employee: Principal; // EMPLOYEE — claims, and nothing else
let hrAdmin: Principal; // HR_ADMIN — approves claims

let supplierId: string;

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

const searchLines = (amount = "450.00") => [
  { description: "Land office search fees", quantity: "1", unitPrice: amount, accountCode: "5110" },
];

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  await runMigrations(db);
  await seed(db);

  clerk = await makePrincipal("clerk@cac.test", ["ACCOUNTS_EXECUTIVE"]);
  accountant = await makePrincipal("accountant@cac.test", ["ACCOUNTANT"]);
  director = await makePrincipal("director@cac.test", ["DIRECTOR"]);
  employee = await makePrincipal("employee@cac.test", ["EMPLOYEE"]);
  hrAdmin = await makePrincipal("hr@cac.test", ["HR_ADMIN"]);

  await createFiscalYear(db, director, { startsOn: "2026-01-01" });

  supplierId = (
    await createSupplier(db, clerk, {
      code: "SUP-001",
      name: "Jaya Land Search Services",
      paymentTermsDays: 14,
      bankName: "Maybank",
      bankAccountNo: "5621 3388 9901",
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await close();
});

// ---------------------------------------------------------------------------
describe("purchase orders", () => {
  let orderId: string;

  it("commits to a purchase without touching the ledger", async () => {
    const before = await trialBalance(db, { to: "2026-12-31" });

    const created = await createPurchaseOrder(db, clerk, {
      supplierId,
      orderDate: "2026-04-01",
      requiredBy: "2026-04-15",
      subject: "Searches for the Skudai file",
      lines: [
        { description: "Land office search", quantity: "6", unitPrice: "120.00", accountCode: "5110" },
        { description: "Courier", quantity: "1", unitPrice: "35.00", accountCode: "5190" },
      ],
    });
    orderId = created.id;

    const order = await getPurchaseOrder(db, orderId);
    expect(order!.status).toBe("draft");
    expect(order!.total).toBe(parseAmount("755.00"));

    await submitPurchaseOrder(db, clerk, orderId);
    await approvePurchaseOrder(db, director, orderId);
    const { orderNo } = await issuePurchaseOrder(db, clerk, orderId);
    expect(orderNo).toMatch(/^PO-2026-\d{5}$/);

    // The whole point: a commitment is not a cost.
    const after = await trialBalance(db, { to: "2026-12-31" });
    expect(after.totalDebit).toBe(before.totalDebit);
    expect(after.difference).toBe(0n);
  });

  it("refuses a date required before the order date", async () => {
    await expect(
      createPurchaseOrder(db, clerk, {
        supplierId,
        orderDate: "2026-04-10",
        requiredBy: "2026-04-01",
        lines: searchLines(),
      }),
    ).rejects.toThrow(/cannot be before the order date/);
  });

  it("will not let the person who raised it approve it", async () => {
    // An accountant can do both, which is exactly when the rule has to bite.
    const created = await createPurchaseOrder(db, accountant, { supplierId, lines: searchLines() });
    await submitPurchaseOrder(db, accountant, created.id);
    await expect(approvePurchaseOrder(db, accountant, created.id)).rejects.toThrow(
      /Someone else must review/,
    );
    await expect(approvePurchaseOrder(db, director, created.id)).resolves.toBeUndefined();
  });

  it("records partial delivery and completes when everything arrives", async () => {
    const order = await getPurchaseOrder(db, orderId);
    const [searches, courier] = order!.lines;

    const partial = await receivePurchaseOrder(db, accountant, orderId, [
      { lineId: searches!.id, quantity: "4" },
    ]);
    expect(partial.complete).toBe(false);
    expect((await getPurchaseOrder(db, orderId))!.status).toBe("issued");

    const complete = await receivePurchaseOrder(db, accountant, orderId, [
      { lineId: searches!.id, quantity: "6" },
      { lineId: courier!.id, quantity: "1" },
    ]);
    expect(complete.complete).toBe(true);
    expect((await getPurchaseOrder(db, orderId))!.status).toBe("received");
  });

  it("refuses to receive more than was ordered", async () => {
    const order = await getPurchaseOrder(db, orderId);
    await expect(
      receivePurchaseOrder(db, accountant, orderId, [
        { lineId: order!.lines[0]!.id, quantity: "99" },
      ]),
    ).rejects.toThrow(/more of .* has been received than was ordered/i);
  });

  it("cannot be edited once it has gone to the supplier", async () => {
    await expect(
      updatePurchaseOrder(db, clerk, orderId, { supplierId, lines: searchLines() }),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      db.execute(sql`UPDATE accounting.purchase_order SET total = '1.0000' WHERE id = ${orderId}`),
    ).rejects.toThrow(/issued to the supplier/);
  });

  it("closes once the work is done", async () => {
    await closePurchaseOrder(db, accountant, orderId);
    expect((await getPurchaseOrder(db, orderId))!.status).toBe("closed");
  });

  it("cancels with a reason instead of being deleted", async () => {
    const created = await createPurchaseOrder(db, clerk, { supplierId, lines: searchLines() });
    await submitPurchaseOrder(db, clerk, created.id);
    await approvePurchaseOrder(db, director, created.id);
    await issuePurchaseOrder(db, clerk, created.id);

    await expect(closePurchaseOrder(db, director, created.id, { cancel: true })).rejects.toThrow(
      /Say why/,
    );
    await closePurchaseOrder(db, director, created.id, {
      cancel: true,
      reason: "Supplier could not meet the date",
    });
    expect((await getPurchaseOrder(db, created.id))!.status).toBe("cancelled");
  });

  it("lists what is still outstanding", async () => {
    const orders = await listPurchaseOrders(db, { limit: 100 });
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((order) => typeof order.outstandingLines === "number")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("payment vouchers", () => {
  it("pays a supplier and posts the expense", async () => {
    const created = await createVoucher(db, clerk, {
      supplierId,
      voucherDate: "2026-05-02",
      subject: "Searches, April",
      method: "transfer",
      paymentAccountId: await accountId(db, "1251"),
      lines: [
        { description: "Land office searches", quantity: "6", unitPrice: "120.00", accountCode: "5110" },
      ],
    });

    await submitVoucher(db, clerk, created.id);
    await approveVoucher(db, director, created.id);
    const posted = await postVoucher(db, accountant, created.id);
    expect(posted.voucherNo).toMatch(/^PV-2026-\d{5}$/);

    const voucher = await getVoucher(db, created.id);
    expect(voucher!.status).toBe("posted");
    expect(voucher!.total).toBe(parseAmount("720.00"));

    const journal = await getJournal(db, voucher!.journalId!);
    expect(journal!.lines.find((line) => line.accountCode === "5110")!.debit).toBe(
      parseAmount("720.00"),
    );
    expect(journal!.lines.find((line) => line.accountCode === "1251")!.credit).toBe(
      parseAmount("720.00"),
    );
    expect((await trialBalance(db, { to: "2026-12-31" })).difference).toBe(0n);
  });

  it("puts an unpaid supplier invoice into trade payables, and settles it later", async () => {
    const onAccount = await createVoucher(db, clerk, {
      supplierId,
      voucherDate: "2026-05-10",
      subject: "Searches on 14-day terms",
      settlement: "payable",
      lines: searchLines("300.00"),
    });
    await submitVoucher(db, clerk, onAccount.id);
    await approveVoucher(db, director, onAccount.id);
    await postVoucher(db, accountant, onAccount.id);

    const journal = await getJournal(db, (await getVoucher(db, onAccount.id))!.journalId!);
    // Nothing has left the bank yet.
    expect(journal!.lines.find((line) => line.accountCode === "1251")).toBeUndefined();
    expect(journal!.lines.find((line) => line.accountCode === "2110")!.credit).toBe(
      parseAmount("300.00"),
    );

    // Paying it off debits payables instead of an expense: the cost was already
    // recognised when the invoice arrived.
    const settle = await createVoucher(db, clerk, {
      supplierId,
      voucherDate: "2026-05-24",
      subject: "Settling the April account",
      kind: "settlement",
      paymentAccountId: await accountId(db, "1251"),
      lines: searchLines("300.00"),
    });
    await submitVoucher(db, clerk, settle.id);
    await approveVoucher(db, director, settle.id);
    await postVoucher(db, accountant, settle.id);

    const settlement = await getJournal(db, (await getVoucher(db, settle.id))!.journalId!);
    expect(settlement!.lines.find((line) => line.accountCode === "2110")!.debit).toBe(
      parseAmount("300.00"),
    );
    expect(settlement!.lines.find((line) => line.accountCode === "1251")!.credit).toBe(
      parseAmount("300.00"),
    );

    // Payables is back to nil and the ledger still balances.
    const tb = await trialBalance(db, { to: "2026-12-31" });
    const payables = tb.rows.find((row) => row.code === "2110");
    expect((payables?.balanceCredit ?? 0n) - (payables?.balanceDebit ?? 0n)).toBe(0n);
    expect(tb.difference).toBe(0n);
  });

  it("pays a one-off payee with no supplier record", async () => {
    const created = await createVoucher(db, clerk, {
      payeeName: "Pejabat Tanah dan Galian Johor",
      voucherDate: "2026-05-12",
      method: "cash",
      paymentAccountId: await accountId(db, "1251"),
      lines: [{ description: "Statutory search fee", unitPrice: "80.00", accountCode: "5120" }],
    });
    const voucher = await getVoucher(db, created.id);
    expect(voucher!.payee).toBe("Pejabat Tanah dan Galian Johor");
  });

  it("insists on somebody to pay", async () => {
    await expect(
      createVoucher(db, clerk, {
        paymentAccountId: await accountId(db, "1251"),
        lines: searchLines(),
      }),
    ).rejects.toThrow(/Say who is being paid/);
  });

  it("will not pay from a revenue account", async () => {
    await expect(
      createVoucher(db, clerk, {
        supplierId,
        paymentAccountId: await accountId(db, "4110"),
        lines: searchLines(),
      }),
    ).rejects.toThrow(/not a bank or cash account/);
  });

  it("needs director authority while the approval limit is unset", async () => {
    const created = await createVoucher(db, clerk, {
      supplierId,
      paymentAccountId: await accountId(db, "1251"),
      lines: searchLines("25.00"),
    });
    await submitVoucher(db, clerk, created.id);
    await expect(approveVoucher(db, accountant, created.id)).rejects.toThrow(/limit is unset/);
    await expect(approveVoucher(db, director, created.id)).resolves.toBeUndefined();
  });

  it("routes by amount once a limit is set", async () => {
    await setSetting(db, director, "accounting.approval_threshold_myr", 5000, {
      reason: "Test fixture: exercising threshold routing on payments",
    });

    const small = await createVoucher(db, clerk, {
      supplierId,
      paymentAccountId: await accountId(db, "1251"),
      lines: searchLines("400.00"),
    });
    await submitVoucher(db, clerk, small.id);
    await expect(approveVoucher(db, accountant, small.id)).resolves.toBeUndefined();

    const large = await createVoucher(db, clerk, {
      supplierId,
      paymentAccountId: await accountId(db, "1251"),
      lines: searchLines("9000.00"),
    });
    await submitVoucher(db, clerk, large.id);
    await expect(approveVoucher(db, accountant, large.id)).rejects.toThrow(/above the approval limit/);
    await expect(approveVoucher(db, director, large.id)).resolves.toBeUndefined();

    await setSetting(db, director, "accounting.approval_threshold_myr", null, {
      reason: "Test fixture: back to the unconfirmed default",
    });
  });

  it("stops the preparer approving their own payment", async () => {
    await setSetting(db, director, "accounting.approval_threshold_myr", 100000, {
      reason: "Test fixture: isolating maker/checker on payments",
    });
    const created = await createVoucher(db, accountant, {
      supplierId,
      paymentAccountId: await accountId(db, "1251"),
      lines: searchLines("120.00"),
    });
    await submitVoucher(db, accountant, created.id);
    await expect(approveVoucher(db, accountant, created.id)).rejects.toThrow(
      /Someone else must review/,
    );
    await setSetting(db, director, "accounting.approval_threshold_myr", null, {
      reason: "Test fixture: back to the unconfirmed default",
    });
  });

  it("cannot be posted without approval", async () => {
    const created = await createVoucher(db, clerk, {
      supplierId,
      paymentAccountId: await accountId(db, "1251"),
      lines: searchLines("15.00"),
    });
    await expect(postVoucher(db, accountant, created.id)).rejects.toThrow(ConflictError);
    await submitVoucher(db, clerk, created.id);
    await expect(postVoucher(db, accountant, created.id)).rejects.toThrow(/not been approved/);
  });

  it("voids by reversal, keeping both entries", async () => {
    const created = await createVoucher(db, clerk, {
      supplierId,
      voucherDate: "2026-06-01",
      paymentAccountId: await accountId(db, "1251"),
      lines: searchLines("640.00"),
    });
    await submitVoucher(db, clerk, created.id);
    await approveVoucher(db, director, created.id);
    await postVoucher(db, accountant, created.id);

    await expect(voidVoucher(db, director, created.id, { reason: " " })).rejects.toThrow(
      /needs a reason/,
    );
    await voidVoucher(db, director, created.id, { reason: "Paid the wrong supplier" });

    const voucher = await getVoucher(db, created.id);
    expect(voucher!.status).toBe("void");
    expect(voucher!.voidJournalId).toBeTruthy();
    // The number is kept.
    expect(voucher!.voucherNo).toBeTruthy();
    expect((await trialBalance(db, { to: "2026-12-31" })).difference).toBe(0n);
  });

  it("refuses an employee entirely", async () => {
    await expect(
      createVoucher(db, employee, { supplierId, lines: searchLines() }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("lists by status", async () => {
    const posted = await listVouchers(db, { status: "posted", limit: 100 });
    expect(posted.every((voucher) => voucher.status === "posted")).toBe(true);
    expect(posted.every((voucher) => voucher.voucherNo !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("petty cash", () => {
  it("tops up the float from the bank", async () => {
    const created = await recordPettyCash(db, clerk, {
      kind: "top_up",
      txnDate: "2026-07-01",
      description: "Opening the July float",
      amount: "500.00",
      counterpartAccountCode: "1251",
    });
    const posted = await postPettyCash(db, accountant, created.id);
    expect(posted.txnNo).toMatch(/^PC-2026-\d{5}$/);

    const journal = await getJournal(db, (await listPettyCash(db))[0]!.journalId!);
    expect(journal!.lines.find((line) => line.accountCode === "1255")!.debit).toBe(
      parseAmount("500.00"),
    );
    expect(journal!.lines.find((line) => line.accountCode === "1251")!.credit).toBe(
      parseAmount("500.00"),
    );

    const position = await pettyCashPosition(db);
    expect(position!.bookBalance).toBe(parseAmount("500.00"));
  });

  it("refuses a top-up from something that is not a bank or cash account", async () => {
    await expect(
      recordPettyCash(db, clerk, {
        kind: "top_up",
        description: "From revenue, somehow",
        amount: "10.00",
        counterpartAccountCode: "4110",
      }),
    ).rejects.toThrow(/bank or cash account/);
  });

  it("spends from the float", async () => {
    for (const [description, amount, account] of [
      ["Courier to the land office", "18.50", "5190"],
      ["Parking and tolls", "24.00", "7180"],
      ["Printing for the Skudai file", "62.30", "7125"],
    ] as const) {
      const created = await recordPettyCash(db, clerk, {
        kind: "expense",
        txnDate: "2026-07-10",
        description,
        amount,
        counterpartAccountCode: account,
        receiptRef: "July envelope",
      });
      await postPettyCash(db, accountant, created.id);
    }

    const position = await pettyCashPosition(db);
    // 500 - 18.50 - 24.00 - 62.30
    expect(position!.bookBalance).toBe(parseAmount("395.20"));
    expect((await trialBalance(db, { to: "2026-12-31" })).difference).toBe(0n);
  });

  it("will not let the person who spent it post it", async () => {
    const created = await recordPettyCash(db, clerk, {
      kind: "expense",
      description: "Stamps",
      amount: "5.00",
      counterpartAccountCode: "7130",
    });
    // Recording and approving are different capabilities; a clerk holds only one.
    await expect(postPettyCash(db, clerk, created.id)).rejects.toThrow(AuthorizationError);
    await postPettyCash(db, accountant, created.id);
  });

  it("refuses a count while entries are unposted", async () => {
    const pending = await recordPettyCash(db, clerk, {
      kind: "expense",
      description: "Not yet posted",
      amount: "3.00",
      counterpartAccountCode: "7135",
    });

    await expect(
      countPettyCash(db, accountant, { countedAmount: "390.20", countedOn: "2026-07-31" }),
    ).rejects.toThrow(/unposted petty cash/);

    await postPettyCash(db, accountant, pending.id);
  });

  it("posts a shortfall found on counting rather than absorbing it", async () => {
    const before = await pettyCashPosition(db);
    const short = before!.bookBalance - parseAmount("7.40");

    const result = await countPettyCash(db, accountant, {
      countedAmount: amountToSql(short),
      countedOn: "2026-07-31",
      notes: "Counted with Faizal present",
    });

    expect(result.difference).toBe(parseAmount("-7.40"));
    expect(result.adjustmentTxnId).toBeTruthy();

    // The float now agrees with the tin, and the shortfall is an expense with a
    // date and a name against it.
    const after = await pettyCashPosition(db);
    expect(after!.bookBalance).toBe(short);
    expect(after!.lastDifference).toBe(parseAmount("-7.40"));
    expect((await trialBalance(db, { to: "2026-12-31" })).difference).toBe(0n);
  });

  it("records a clean count with no adjustment", async () => {
    const position = await pettyCashPosition(db);
    const result = await countPettyCash(db, accountant, {
      countedAmount: amountToSql(position!.bookBalance),
      countedOn: "2026-08-31",
    });
    expect(result.difference).toBe(0n);
    expect(result.adjustmentTxnId).toBeNull();
  });

  it("voids a posted entry by reversal", async () => {
    const created = await recordPettyCash(db, clerk, {
      kind: "expense",
      txnDate: "2026-09-01",
      description: "Entered twice",
      amount: "12.00",
      counterpartAccountCode: "7135",
    });
    await postPettyCash(db, accountant, created.id);
    await voidPettyCash(db, accountant, created.id, { reason: "Duplicate of the earlier entry" });

    const rows = await listPettyCash(db, { status: "void" });
    expect(rows.length).toBeGreaterThan(0);
    expect((await trialBalance(db, { to: "2026-12-31" })).difference).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
describe("expense claims", () => {
  let claimId: string;

  it("an employee claims what they spent", async () => {
    const created = await createClaim(db, employee, {
      claimDate: "2026-08-05",
      periodFrom: "2026-07-01",
      periodTo: "2026-07-31",
      subject: "July travel and subsistence",
      lines: [
        {
          description: "Mileage to Kluang land office",
          quantity: "180",
          unitPrice: "0.60",
          accountCode: "7180",
          spentOn: "2026-07-14",
          receiptRef: "Log sheet 14/07",
        },
        {
          description: "Parking",
          unitPrice: "9.00",
          accountCode: "7180",
          spentOn: "2026-07-14",
        },
      ],
    });
    claimId = created.id;

    const claim = await getClaim(db, claimId);
    expect(claim!.status).toBe("draft");
    expect(claim!.total).toBe(parseAmount("117.00"));
    expect(claim!.claimantName).toBe("employee@cac.test");
    // The spend date is per line, not the claim date.
    expect(claim!.lines[0]!.spentOn).toBe("2026-07-14");
  });

  it("is filed for the person making it, never for somebody else", async () => {
    // There is no parameter to claim on another person's behalf; the claimant is
    // taken from the session. Somebody else cannot even edit it.
    await expect(
      (await import("./expenses.js")).updateClaim(db, clerk, claimId, {
        lines: [{ description: "x", unitPrice: "1.00", accountCode: "7180" }],
      }),
    ).rejects.toThrow(/only be changed by the person who made it/);
  });

  it("nobody approves their own", async () => {
    await submitClaim(db, employee, claimId);
    await expect(decideClaim(db, employee, claimId, "approved")).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("is approved, posted to staff claims payable, then reimbursed", async () => {
    await decideClaim(db, hrAdmin, claimId, "approved");
    await postClaim(db, hrAdmin, claimId);

    const claim = await getClaim(db, claimId);
    expect(claim!.status).toBe("posted");

    const journal = await getJournal(db, claim!.journalId!);
    // Both claim lines hit travel, and the engine keeps them separate on purpose:
    // one journal line per claim line, so each keeps its own narrative.
    const travel = journal!.lines.filter((line) => line.accountCode === "7180");
    expect(travel).toHaveLength(2);
    expect(travel.reduce((sum, line) => sum + line.debit, 0n)).toBe(parseAmount("117.00"));
    // Owed to the person, not paid yet.
    expect(journal!.lines.find((line) => line.accountCode === "2155")!.credit).toBe(
      parseAmount("117.00"),
    );

    // Paying them goes through an ordinary voucher, so the money leaving the bank
    // has the same approval as any other payment.
    const voucher = await createVoucher(db, clerk, {
      payeeName: "employee@cac.test",
      voucherDate: "2026-08-20",
      subject: `Reimbursing ${claim!.claimNo}`,
      paymentAccountId: await accountId(db, "1251"),
      lines: [{ description: "Expense claim reimbursement", unitPrice: "117.00", accountCode: "2155" }],
    });
    await submitVoucher(db, clerk, voucher.id);
    await approveVoucher(db, director, voucher.id);
    await postVoucher(db, accountant, voucher.id);

    await markClaimReimbursed(db, accountant, claimId, voucher.id);
    expect((await getClaim(db, claimId))!.status).toBe("reimbursed");

    // Staff claims payable is back to nil.
    const tb = await trialBalance(db, { to: "2026-12-31" });
    const payable = tb.rows.find((row) => row.code === "2155");
    expect((payable?.balanceCredit ?? 0n) - (payable?.balanceDebit ?? 0n)).toBe(0n);
    expect(tb.difference).toBe(0n);
  });

  it("rejects with a reason the claimant can read", async () => {
    const created = await createClaim(db, employee, {
      lines: [{ description: "Dinner", unitPrice: "300.00", accountCode: "7185" }],
    });
    await submitClaim(db, employee, created.id);

    await expect(decideClaim(db, hrAdmin, created.id, "rejected")).rejects.toThrow(/Say why/);
    await decideClaim(db, hrAdmin, created.id, "rejected", {
      reason: "Entertainment needs the client named and prior approval",
    });

    const claim = await getClaim(db, created.id);
    expect(claim!.status).toBe("rejected");
    expect(claim!.rejectReason).toMatch(/prior approval/);
  });

  it("will not reimburse against a voucher that is too small", async () => {
    const created = await createClaim(db, employee, {
      lines: [{ description: "Taxi", unitPrice: "40.00", accountCode: "7180" }],
    });
    await submitClaim(db, employee, created.id);
    await decideClaim(db, hrAdmin, created.id, "approved");
    await postClaim(db, hrAdmin, created.id);

    const short = await createVoucher(db, clerk, {
      payeeName: "employee@cac.test",
      paymentAccountId: await accountId(db, "1251"),
      lines: [{ description: "Part payment", unitPrice: "10.00", accountCode: "2155" }],
    });
    await submitVoucher(db, clerk, short.id);
    await approveVoucher(db, director, short.id);
    await postVoucher(db, accountant, short.id);

    await expect(markClaimReimbursed(db, accountant, created.id, short.id)).rejects.toThrow(
      /less than the/,
    );
  });

  it("cannot be posted before it is approved", async () => {
    const created = await createClaim(db, employee, {
      lines: [{ description: "Stationery", unitPrice: "22.00", accountCode: "7135" }],
    });
    await expect(postClaim(db, hrAdmin, created.id)).rejects.toThrow(/Only an approved claim/);
  });

  it("refuses a claim for nothing", async () => {
    await expect(createClaim(db, employee, { lines: [] })).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
describe("the reports take it all in", () => {
  it("shows the costs in profit and loss and the cash movement on the balance sheet", async () => {
    const pl = await profitAndLoss(db, { from: "2026-01-01", to: "2026-12-31" });
    expect(pl.directCosts.total).toBeGreaterThan(0n);
    expect(pl.totalExpenses).toBeGreaterThan(0n);
    expect(pl.netProfit).toBe(pl.grossProfit - pl.totalExpenses);

    const sheet = await balanceSheet(db, { asOf: "2026-12-31" });
    expect(formatAmount(sheet.difference)).toBe("0.00");

    // The float shows as an asset in its own right.
    const petty = sheet.assets
      .flatMap((group) => group.lines)
      .find((line) => line.code === "1255");
    expect(petty?.amount ?? 0n).toBeGreaterThan(0n);
  });

  it("leaves the ledger balanced after everything above", async () => {
    expect((await trialBalance(db, { to: "2026-12-31" })).difference).toBe(0n);
  });
});

/** A small helper: the id of an account by its code. */
async function accountId(database: Database, code: string): Promise<string> {
  const result = await database.execute<{ id: string }>(
    sql`SELECT id FROM accounting.account WHERE code = ${code}`,
  );
  return result.rows![0]!.id;
}
