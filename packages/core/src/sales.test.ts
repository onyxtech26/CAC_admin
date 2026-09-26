import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import { hashPassword } from "./password.js";
import { resolveCapabilities, type Principal } from "./authz.js";
import { ConflictError, ValidationError } from "./errors.js";
import { AuthorizationError } from "./authz.js";
import { amountToSql, formatAmount, parseAmount } from "./money.js";
import { createFiscalYear } from "./periods.js";
import { trialBalance } from "./ledger.js";
import { getJournal } from "./posting.js";
import { createCustomer } from "./parties.js";
import { addTaxRate, listTaxCodes, taxFor } from "./tax.js";
import { setSetting } from "./settings.js";
import {
  approveInvoice,
  convertQuotationToInvoice,
  createCreditNote,
  createInvoice,
  createQuotation,
  decideQuotation,
  getInvoice,
  getQuotation,
  issueInvoice,
  listInvoices,
  returnInvoiceToDraft,
  sendQuotation,
  submitInvoice,
  updateInvoice,
  voidInvoice,
} from "./sales.js";
import {
  allocateCreditNote,
  allocateReceipt,
  createReceipt,
  getReceipt,
  postReceipt,
  removeAllocation,
  suggestAllocation,
  voidReceipt,
} from "./receipts.js";
import { balanceSheet, customerStatement, profitAndLoss, receivablesAging } from "./reports.js";

/**
 * Phase 3, against the worked example in docs/IMPLEMENTATION_PLAN.md:
 *
 *   create a customer -> create an invoice -> add lines -> totals computed
 *   server-side -> configured tax applied -> save draft -> submit -> approve as a
 *   different user -> issue -> journal posted and balanced -> receipt recorded ->
 *   partial settlement -> full settlement -> appears correctly in AR aging ->
 *   ledger entries visible -> reflected in trial balance, P&L and balance sheet ->
 *   complete audit history -> and a user without invoice.approve is refused by the
 *   server when the UI is bypassed.
 *
 * "The full worked example" below runs precisely that, in order.
 */

let db: Database;
let close: () => Promise<void>;

let clerk: Principal; // ACCOUNTS_EXECUTIVE — prepares, cannot approve
let accountant: Principal; // ACCOUNTANT — issues, posts, allocates
let director: Principal; // DIRECTOR — approves above the limit
let secondDirector: Principal; // a second one, because an approver may not be the preparer
let employee: Principal; // EMPLOYEE — has no business here at all

let customerId: string;
let secondCustomerId: string;

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

const feeLines = (amount = "5000.00") => [
  {
    description: "Property forensic investigation - Lot 4821",
    quantity: "1",
    unitPrice: amount,
    accountCode: "4110",
  },
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
  secondDirector = await makePrincipal("director2@cac.test", ["DIRECTOR"]);
  employee = await makePrincipal("employee@cac.test", ["EMPLOYEE"]);

  await createFiscalYear(db, director, { startsOn: "2026-01-01" });

  customerId = (
    await createCustomer(db, clerk, {
      code: "CUST-001",
      name: "Tan Holdings Sdn Bhd",
      email: "accounts@tanholdings.test",
      paymentTermsDays: 30,
    })
  ).id;

  secondCustomerId = (
    await createCustomer(db, clerk, { code: "CUST-002", name: "Lim Estate", paymentTermsDays: 14 })
  ).id;
}, 120_000);

afterAll(async () => {
  await close();
});

// ---------------------------------------------------------------------------
describe("line arithmetic is done on the server", () => {
  it("computes the subtotal from quantity and unit price", async () => {
    const { id } = await createInvoice(db, clerk, {
      customerId,
      documentDate: "2026-03-01",
      lines: [
        { description: "Site inspection", quantity: "3", unitPrice: "450.00", accountCode: "4110" },
        { description: "Report", quantity: "1", unitPrice: "1200.00", accountCode: "4110" },
      ],
    });

    const invoice = await getInvoice(db, id);
    expect(invoice!.lines[0]!.lineSubtotal).toBe(parseAmount("1350.00"));
    expect(invoice!.subtotal).toBe(parseAmount("2550.00"));
    expect(invoice!.total).toBe(parseAmount("2550.00"));
  });

  it("applies a percentage discount and stores both the percent and the amount", async () => {
    const { id } = await createInvoice(db, clerk, {
      customerId,
      documentDate: "2026-03-01",
      lines: [
        {
          description: "Advisory retainer",
          quantity: "1",
          unitPrice: "10000.00",
          discountPercent: "0.125",
          accountCode: "4150",
        },
      ],
    });

    const invoice = await getInvoice(db, id);
    expect(invoice!.lines[0]!.discountAmount).toBe(parseAmount("1250.00"));
    // Stored as numeric(9,6), so it reads back at full scale.
    expect(Number(invoice!.lines[0]!.discountPercent)).toBe(0.125);
    expect(invoice!.total).toBe(parseAmount("8750.00"));
  });

  it("refuses a discount larger than the line", async () => {
    await expect(
      createInvoice(db, clerk, {
        customerId,
        lines: [
          { description: "x", unitPrice: "100.00", discountAmount: "150.00", accountCode: "4110" },
        ],
      }),
    ).rejects.toThrow(/discount is more than the line is worth/);
  });

  it("refuses a negative price rather than treating it as a discount", async () => {
    await expect(
      createInvoice(db, clerk, {
        customerId,
        lines: [{ description: "x", unitPrice: "-100.00", accountCode: "4110" }],
      }),
    ).rejects.toThrow(/negative price is not a discount/);
  });

  it("refuses a heading account", async () => {
    await expect(
      createInvoice(db, clerk, {
        customerId,
        lines: [{ description: "x", unitPrice: "100.00", accountCode: "4000" }],
      }),
    ).rejects.toThrow(/is a heading/);
  });

  it("holds line arithmetic in the database as well", async () => {
    const { id } = await createInvoice(db, clerk, {
      customerId,
      lines: feeLines("100.00"),
    });
    // Tampering with one component without the others must not be storable.
    await expect(
      db.execute(sql`UPDATE accounting.invoice_line SET line_total = '999.0000' WHERE invoice_id = ${id}`),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("tax", () => {
  it("charges nothing while the company is not SST registered", async () => {
    const codes = await listTaxCodes(db);
    const sst = codes.find((code) => code.code === "SST-OUT")!;
    const result = await taxFor(db, parseAmount("1000.00"), sst.id, "2026-03-01");

    expect(result.amount).toBe(0n);
    expect(result.taxRateId).toBeNull();
    expect(result.note).toMatch(/not recorded as SST registered/);
  });

  it("refuses a rate without a citation", async () => {
    const codes = await listTaxCodes(db);
    const sst = codes.find((code) => code.code === "SST-OUT")!;

    await expect(
      addTaxRate(db, accountant, {
        taxCodeId: sst.id,
        rate: "0.06",
        effectiveFrom: "2026-01-01",
        sourceRef: "SST",
      }),
    ).rejects.toThrow(/Name the instrument/);
  });

  it("applies a rate once one is entered, and only from its effective date", async () => {
    const codes = await listTaxCodes(db);
    const sst = codes.find((code) => code.code === "SST-OUT")!;

    await setSetting(db, director, "tax.sst_registered", true, {
      reason: "Test fixture: exercising the tax engine",
    });
    await addTaxRate(db, accountant, {
      taxCodeId: sst.id,
      rate: "0.06",
      effectiveFrom: "2026-03-01",
      sourceRef: "Test fixture rate, entered by the test suite on 2026-03-01",
    });

    // Before the effective date there is still no rate.
    expect((await taxFor(db, parseAmount("1000.00"), sst.id, "2026-02-28")).amount).toBe(0n);
    // On and after it, there is.
    const applied = await taxFor(db, parseAmount("1000.00"), sst.id, "2026-03-01");
    expect(applied.amount).toBe(parseAmount("60.00"));
    expect(applied.taxRateId).toBeTruthy();
  });

  it("puts tax on an invoice line and records which rate was used", async () => {
    const codes = await listTaxCodes(db);
    const sst = codes.find((code) => code.code === "SST-OUT")!;

    const { id } = await createInvoice(db, clerk, {
      customerId,
      documentDate: "2026-03-05",
      lines: [
        { description: "Taxable service", quantity: "1", unitPrice: "1000.00", taxCodeId: sst.id, accountCode: "4150" },
      ],
    });

    const invoice = await getInvoice(db, id);
    expect(invoice!.taxTotal).toBe(parseAmount("60.00"));
    expect(invoice!.total).toBe(parseAmount("1060.00"));
    expect(invoice!.lines[0]!.taxRateId).toBeTruthy();
  });

  it("switches back off for the rest of the suite", async () => {
    // The worked example below is about the sales cycle, not tax; leaving SST on
    // would make every expected figure carry 6% for no reason.
    await setSetting(db, director, "tax.sst_registered", false, {
      reason: "Test fixture: back to the unconfirmed default",
    });
    const codes = await listTaxCodes(db);
    const sst = codes.find((code) => code.code === "SST-OUT")!;
    expect((await taxFor(db, parseAmount("100.00"), sst.id, "2026-03-05")).amount).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
describe("approval", () => {
  it("a clerk cannot approve at all", async () => {
    const { id } = await createInvoice(db, clerk, { customerId, lines: feeLines("500.00") });
    await submitInvoice(db, clerk, id);
    await expect(approveInvoice(db, clerk, id)).rejects.toThrow(/director/i);
  });

  it("an employee cannot even create one", async () => {
    await expect(
      createInvoice(db, employee, { customerId, lines: feeLines() }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("the preparer cannot approve their own", async () => {
    // An accountant may approve below the limit, so set one; otherwise the
    // refusal would come from the amount rather than from maker/checker, and the
    // test would pass for the wrong reason.
    await setSetting(db, director, "accounting.approval_threshold_myr", 1000000, {
      reason: "Test fixture: isolating the maker/checker rule",
    });

    const { id } = await createInvoice(db, accountant, { customerId, lines: feeLines("600.00") });
    await submitInvoice(db, accountant, id);
    await expect(approveInvoice(db, accountant, id)).rejects.toThrow(/Someone else must review/);
    // Anyone else holding the capability can.
    await expect(approveInvoice(db, director, id)).resolves.toBeUndefined();

    await setSetting(db, director, "accounting.approval_threshold_myr", null, {
      reason: "Test fixture: back to the unconfirmed default",
    });
  });

  it("needs director authority while the approval limit is unset", async () => {
    const { id } = await createInvoice(db, clerk, { customerId, lines: feeLines("50.00") });
    await submitInvoice(db, clerk, id);
    // Even a trivial amount: with no limit agreed, everything goes to a director.
    await expect(approveInvoice(db, accountant, id)).rejects.toThrow(/approval limit is unset/);
    await expect(approveInvoice(db, director, id)).resolves.toBeUndefined();
  });

  it("routes by amount once a limit is set", async () => {
    await setSetting(db, director, "accounting.approval_threshold_myr", 10000, {
      reason: "Test fixture: exercising threshold routing",
    });

    const small = await createInvoice(db, clerk, { customerId, lines: feeLines("2500.00") });
    await submitInvoice(db, clerk, small.id);
    // Below the limit, an accountant may approve.
    await expect(approveInvoice(db, accountant, small.id)).resolves.toBeUndefined();

    const large = await createInvoice(db, clerk, { customerId, lines: feeLines("25000.00") });
    await submitInvoice(db, clerk, large.id);
    await expect(approveInvoice(db, accountant, large.id)).rejects.toThrow(/above the approval limit/);
    await expect(approveInvoice(db, director, large.id)).resolves.toBeUndefined();
  });

  it("cannot approve something that was never submitted", async () => {
    const { id } = await createInvoice(db, clerk, { customerId, lines: feeLines("10.00") });
    await expect(approveInvoice(db, director, id)).rejects.toThrow(/not been submitted/);
  });

  it("sends an invoice back to draft with a reason", async () => {
    const { id } = await createInvoice(db, clerk, { customerId, lines: feeLines("11.00") });
    await submitInvoice(db, clerk, id);
    await expect(returnInvoiceToDraft(db, accountant, id, { reason: "  " })).rejects.toThrow(
      /Say what needs changing/,
    );
    await returnInvoiceToDraft(db, accountant, id, { reason: "Wrong lot number" });
    expect((await getInvoice(db, id))!.status).toBe("draft");
    // And it is editable again.
    await updateInvoice(db, clerk, id, { customerId, lines: feeLines("12.00") });
    expect((await getInvoice(db, id))!.total).toBe(parseAmount("12.00"));
  });
});

// ---------------------------------------------------------------------------
describe("the full worked example", () => {
  let invoiceId: string;
  let invoiceNo: string;
  let receiptId: string;

  it("1. an approved invoice is issued, numbered and posted to the ledger", async () => {
    const created = await createInvoice(db, clerk, {
      customerId,
      documentDate: "2026-04-01",
      subject: "Forensic investigation — Lot 4821 Skudai",
      lines: [
        { description: "Title and land search", quantity: "1", unitPrice: "1800.00", accountCode: "4120" },
        { description: "Site inspection and report", quantity: "2", unitPrice: "2100.00", accountCode: "4110" },
      ],
    });
    invoiceId = created.id;

    const draft = await getInvoice(db, invoiceId);
    expect(draft!.status).toBe("draft");
    expect(draft!.invoiceNo).toBeNull();
    expect(draft!.total).toBe(parseAmount("6000.00"));
    // The due date comes from the customer's terms, not from the form.
    expect(draft!.dueDate).toBe("2026-05-01");

    await submitInvoice(db, clerk, invoiceId);
    await approveInvoice(db, director, invoiceId);
    const issued = await issueInvoice(db, accountant, invoiceId);
    invoiceNo = issued.invoiceNo;

    expect(invoiceNo).toMatch(/^INV-2026-\d{5}$/);

    const invoice = await getInvoice(db, invoiceId);
    expect(invoice!.status).toBe("issued");
    expect(invoice!.journalNo).toBeTruthy();
    expect(invoice!.createdByName).toBe("clerk@cac.test");
    expect(invoice!.approvedByName).toBe("director@cac.test");
    expect(invoice!.issuedByName).toBe("accountant@cac.test");
  });

  it("2. the journal debits receivables and credits each line's own revenue account", async () => {
    const invoice = await getInvoice(db, invoiceId);
    const journal = await getJournal(db, invoice!.journalId!);

    expect(journal!.status).toBe("posted");
    expect(journal!.totalDebit).toBe(journal!.totalCredit);
    expect(journal!.totalDebit).toBe(parseAmount("6000.00"));

    const receivable = journal!.lines.find((line) => line.accountCode === "1210")!;
    expect(receivable.debit).toBe(parseAmount("6000.00"));

    // Two different revenue accounts, because the lines used two.
    expect(journal!.lines.find((line) => line.accountCode === "4120")!.credit).toBe(parseAmount("1800.00"));
    expect(journal!.lines.find((line) => line.accountCode === "4110")!.credit).toBe(parseAmount("4200.00"));
  });

  it("3. an issued invoice cannot be edited, deleted or re-approved", async () => {
    await expect(
      updateInvoice(db, clerk, invoiceId, { customerId, lines: feeLines("1.00") }),
    ).rejects.toThrow(/terms are fixed/);
    await expect(
      db.execute(sql`UPDATE accounting.invoice SET total = '1.0000' WHERE id = ${invoiceId}`),
    ).rejects.toThrow(/issued/);
    await expect(
      db.execute(sql`DELETE FROM accounting.invoice WHERE id = ${invoiceId}`),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(
      db.execute(sql`UPDATE accounting.invoice_line SET unit_price = '1.0000' WHERE invoice_id = ${invoiceId}`),
    ).rejects.toThrow(/Lines cannot be/);
  });

  it("4. a receipt is recorded and posted", async () => {
    const created = await createReceipt(db, clerk, {
      customerId,
      receiptDate: "2026-04-20",
      method: "transfer",
      reference: "MBB 20260420-441",
      depositAccountCode: "1251",
      amount: "2500.00",
    });
    receiptId = created.id;

    const draft = await getReceipt(db, receiptId);
    expect(draft!.status).toBe("draft");
    // Unposted money is not in the ledger and cannot settle anything.
    await expect(
      allocateReceipt(db, accountant, receiptId, [{ invoiceId, amount: "2500.00" }]),
    ).rejects.toThrow(/Post the receipt before allocating/);

    const posted = await postReceipt(db, accountant, receiptId);
    expect(posted.receiptNo).toMatch(/^RCP-2026-\d{5}$/);

    const journal = await getJournal(db, (await getReceipt(db, receiptId))!.journalId!);
    expect(journal!.lines.find((line) => line.accountCode === "1251")!.debit).toBe(parseAmount("2500.00"));
    expect(journal!.lines.find((line) => line.accountCode === "1210")!.credit).toBe(parseAmount("2500.00"));
  });

  it("5. partial settlement leaves the invoice issued with a balance", async () => {
    await allocateReceipt(db, accountant, receiptId, [{ invoiceId, amount: "2500.00" }]);

    const invoice = await getInvoice(db, invoiceId);
    expect(invoice!.status).toBe("issued");
    expect(invoice!.amountAllocated).toBe(parseAmount("2500.00"));
    expect(invoice!.outstanding).toBe(parseAmount("3500.00"));

    const receipt = await getReceipt(db, receiptId);
    expect(receipt!.unallocated).toBe(0n);
    expect(receipt!.allocations).toHaveLength(1);
  });

  it("6. over-allocation is refused on both sides", async () => {
    await expect(
      allocateReceipt(db, accountant, receiptId, [{ invoiceId, amount: "9000.00" }]),
    ).rejects.toThrow(/allocates .* from a receipt of/);

    // And directly, bypassing the engine.
    await expect(
      db.execute(sql`
        INSERT INTO accounting.allocation (invoice_id, source_type, receipt_id, amount, allocated_by)
        VALUES (${invoiceId}, 'receipt', ${receiptId}, '9999.0000', ${accountant.userId})
      `),
    ).rejects.toThrow();
  });

  it("7. full settlement marks the invoice paid", async () => {
    const second = await createReceipt(db, clerk, {
      customerId,
      receiptDate: "2026-05-02",
      method: "cheque",
      reference: "CHQ 900211",
      depositAccountCode: "1251",
      amount: "3500.00",
    });
    await postReceipt(db, accountant, second.id);

    // The suggestion is oldest-first and is only a suggestion.
    const suggested = await suggestAllocation(db, second.id);
    expect(suggested.some((entry) => entry.invoiceId === invoiceId)).toBe(true);

    await allocateReceipt(db, accountant, second.id, [{ invoiceId, amount: "3500.00" }]);

    const invoice = await getInvoice(db, invoiceId);
    expect(invoice!.status).toBe("paid");
    expect(invoice!.outstanding).toBe(0n);
  });

  it("8. a paid invoice returns to issued when an allocation is removed", async () => {
    const receipt = await getReceipt(db, receiptId);
    await removeAllocation(db, accountant, receipt!.allocations[0]!.id, { reason: "Applied in error" });

    const invoice = await getInvoice(db, invoiceId);
    expect(invoice!.status).toBe("issued");
    expect(invoice!.outstanding).toBe(parseAmount("2500.00"));

    // Put it back, so the later reports read from a settled position.
    await allocateReceipt(db, accountant, receiptId, [{ invoiceId, amount: "2500.00" }]);
    expect((await getInvoice(db, invoiceId))!.status).toBe("paid");
  });

  it("9. the ledger still balances", async () => {
    const tb = await trialBalance(db, { to: "2026-12-31" });
    expect(tb.difference).toBe(0n);
  });

  it("10. the audit trail records every step, with who did each", async () => {
    const events = await db.execute<{ action: string; actor_label: string }>(sql`
      SELECT action, actor_label FROM audit.event
       WHERE entity_id = ${invoiceId} ORDER BY created_at
    `);
    const actions = (events.rows ?? []).map((row) => row.action);

    expect(actions).toEqual([
      "INVOICE_CREATED",
      "INVOICE_SUBMITTED",
      "INVOICE_APPROVED",
      "INVOICE_ISSUED",
    ]);
    expect(events.rows!.map((row) => row.actor_label)).toEqual([
      "clerk@cac.test",
      "clerk@cac.test",
      "director@cac.test",
      "accountant@cac.test",
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("receivables aging", () => {
  it("buckets by age and reconciles to the control account", async () => {
    // Something long overdue, for a different customer.
    const overdue = await createInvoice(db, clerk, {
      customerId: secondCustomerId,
      documentDate: "2026-01-05",
      dueDate: "2026-01-19",
      lines: [{ description: "Estate administration", unitPrice: "3200.00", accountCode: "4130" }],
    });
    await submitInvoice(db, clerk, overdue.id);
    await approveInvoice(db, director, overdue.id);
    await issueInvoice(db, accountant, overdue.id);

    const aging = await receivablesAging(db, { asOf: "2026-06-30" });

    // The one number that says whether this report can be believed.
    expect(formatAmount(aging.difference ?? 0n)).toBe("0.00");

    const lim = aging.rows.find((row) => row.customerName === "Lim Estate")!;
    expect(lim.total).toBe(parseAmount("3200.00"));
    // Due 19 Jan, read at 30 Jun: comfortably in the oldest bucket.
    expect(lim.buckets[lim.buckets.length - 1]!.amount).toBe(parseAmount("3200.00"));
    expect(lim.current).toBe(0n);
  });

  it("reports the position as at the date, not as at today", async () => {
    // The bug this guards against: an aging report drawn for an earlier date that
    // deducts payments which had not arrived yet, and a control account balance
    // that quietly ignores its own date filter so the two still agree.
    const invoice = await createInvoice(db, clerk, {
      customerId: secondCustomerId,
      documentDate: "2026-03-02",
      dueDate: "2026-03-16",
      lines: [{ description: "Historic fee", unitPrice: "1000.00", accountCode: "4130" }],
    });
    await submitInvoice(db, clerk, invoice.id);
    await approveInvoice(db, director, invoice.id);
    await issueInvoice(db, accountant, invoice.id);

    // Paid later.
    const receipt = await createReceipt(db, clerk, {
      customerId: secondCustomerId,
      receiptDate: "2026-05-20",
      depositAccountCode: "1251",
      amount: "1000.00",
    });
    await postReceipt(db, accountant, receipt.id);
    await allocateReceipt(db, accountant, receipt.id, [
      { invoiceId: invoice.id, amount: "1000.00" },
    ]);

    // Before the money arrived, the whole invoice was outstanding...
    const before = await receivablesAging(db, { asOf: "2026-04-30", customerId: secondCustomerId });
    const owedInApril = before.rows.find((row) => row.customerId === secondCustomerId)!;
    expect(owedInApril.total).toBeGreaterThanOrEqual(parseAmount("1000.00"));
    // Scoped to one customer, there is nothing to reconcile against.
    expect(before.difference).toBeNull();

    // ...and afterwards it is not.
    const after = await receivablesAging(db, { asOf: "2026-05-31", customerId: secondCustomerId });
    const owedInMay = after.rows.find((row) => row.customerId === secondCustomerId);
    expect((owedInMay?.total ?? 0n) + parseAmount("1000.00")).toBe(owedInApril.total);

    // Across the whole ledger, both dates still reconcile to the control account.
    expect((await receivablesAging(db, { asOf: "2026-04-30" })).difference).toBe(0n);
    expect((await receivablesAging(db, { asOf: "2026-05-31" })).difference).toBe(0n);
  });

  it("counts an unmatched receipt against what the customer owes", async () => {
    const onAccount = await createReceipt(db, clerk, {
      customerId: secondCustomerId,
      receiptDate: "2026-06-01",
      depositAccountCode: "1251",
      amount: "1000.00",
    });
    await postReceipt(db, accountant, onAccount.id);

    const aging = await receivablesAging(db, { asOf: "2026-06-30" });
    const lim = aging.rows.find((row) => row.customerName === "Lim Estate")!;

    expect(lim.unallocatedReceipts).toBe(parseAmount("1000.00"));
    expect(lim.netOwing).toBe(parseAmount("2200.00"));
    // And the report still agrees with the ledger.
    expect(aging.difference).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
describe("credit notes", () => {
  let invoiceId: string;
  let creditNoteId: string;

  it("credits an issued invoice and settles against it", async () => {
    const created = await createInvoice(db, clerk, {
      customerId,
      documentDate: "2026-07-01",
      lines: [{ description: "Valuation report", unitPrice: "4000.00", accountCode: "4140" }],
    });
    invoiceId = created.id;
    await submitInvoice(db, clerk, invoiceId);
    await approveInvoice(db, director, invoiceId);
    await issueInvoice(db, accountant, invoiceId);

    const note = await createCreditNote(db, director, {
      invoiceId,
      reason: "Scope reduced after the site visit",
      lines: [{ description: "Reduction in scope", unitPrice: "1500.00", accountCode: "4140" }],
    });
    creditNoteId = note.id;

    const draft = await getInvoice(db, creditNoteId);
    expect(draft!.kind).toBe("credit_note");
    expect(draft!.total).toBe(parseAmount("1500.00"));
    expect(draft!.creditsInvoiceId).toBe(invoiceId);

    // The director raised the credit note, so somebody else approves it. With the
    // limit unset that has to be another director-grade approver, so a second one
    // exists for exactly this.
    await submitInvoice(db, clerk, creditNoteId);
    await approveInvoice(db, secondDirector, creditNoteId);
    const issued = await issueInvoice(db, accountant, creditNoteId);
    expect(issued.invoiceNo).toMatch(/^CN-2026-\d{5}$/);

    // The ledger entry is the invoice's, reversed.
    const journal = await getJournal(db, (await getInvoice(db, creditNoteId))!.journalId!);
    expect(journal!.lines.find((line) => line.accountCode === "1210")!.credit).toBe(parseAmount("1500.00"));
    expect(journal!.lines.find((line) => line.accountCode === "4140")!.debit).toBe(parseAmount("1500.00"));

    await allocateCreditNote(db, accountant, creditNoteId, [{ invoiceId, amount: "1500.00" }]);
    expect((await getInvoice(db, invoiceId))!.outstanding).toBe(parseAmount("2500.00"));
    expect((await trialBalance(db, { to: "2026-12-31" })).difference).toBe(0n);
  });

  it("will not credit more than the invoice is worth", async () => {
    await expect(
      createCreditNote(db, director, {
        invoiceId,
        reason: "Too much",
        lines: [{ description: "Everything and more", unitPrice: "9000.00", accountCode: "4140" }],
      }),
    ).rejects.toThrow(/left to credit/);
  });

  it("will not credit a credit note", async () => {
    await expect(
      createCreditNote(db, director, { invoiceId: creditNoteId, reason: "No" }),
    ).rejects.toThrow(/cannot credit a credit note/);
  });

  /**
   * The route the audit found: the cap was enforced when a credit note was raised and nowhere else.
   *
   * `updateInvoice` selected `status, total, created_by` and never `kind`, so the ordinary invoice
   * edit screen would happily rewrite a draft credit note — a bigger figure, a different customer —
   * and `issueInvoice` posted the reversal without looking at the cap again. There is no constraint
   * in the database either. One person could turn a RM 1,000 credit into a RM 10,000 reversal of
   * revenue against a customer who had never been invoiced.
   */
  it("cannot be edited past what is left to credit, or onto another customer", async () => {
    const invoice = await createInvoice(db, clerk, {
      customerId,
      documentDate: "2026-07-05",
      lines: [{ description: "Search fees", unitPrice: "1000.00", accountCode: "4120" }],
    });
    await submitInvoice(db, clerk, invoice.id);
    await approveInvoice(db, director, invoice.id);
    await issueInvoice(db, accountant, invoice.id);

    const note = await createCreditNote(db, director, {
      invoiceId: invoice.id,
      reason: "Credited in full",
      lines: [{ description: "Full reversal", unitPrice: "1000.00", accountCode: "4120" }],
    });

    await expect(
      updateInvoice(db, clerk, note.id, {
        customerId,
        lines: [{ description: "Rather more", unitPrice: "10000.00", accountCode: "4120" }],
      }),
    ).rejects.toThrow(/left to credit/);

    await expect(
      updateInvoice(db, clerk, note.id, {
        customerId: secondCustomerId,
        lines: [{ description: "Full reversal", unitPrice: "1000.00", accountCode: "4120" }],
      }),
    ).rejects.toThrow(/belongs to the invoice it credits/);

    // Editing it down is fine, and the cap does not count the draft against itself.
    await updateInvoice(db, clerk, note.id, {
      customerId,
      lines: [{ description: "Partial reversal", unitPrice: "600.00", accountCode: "4120" }],
    });
    expect((await getInvoice(db, note.id))!.total).toBe(parseAmount("600.00"));

    // And the last gate: issuing re-checks, because that is where it becomes a ledger entry. The
    // figure is forced past the application checks the way a second process or a later bug would.
    await db.execute(sql`
      UPDATE accounting.invoice SET total = 9000, subtotal = 9000 WHERE id = ${note.id}
    `);
    await submitInvoice(db, clerk, note.id);
    await approveInvoice(db, secondDirector, note.id);
    await expect(issueInvoice(db, accountant, note.id)).rejects.toThrow(/never invoiced/);
  });
});

// ---------------------------------------------------------------------------
describe("voiding", () => {
  it("reverses the ledger entry and keeps both visible", async () => {
    const created = await createInvoice(db, clerk, {
      customerId,
      documentDate: "2026-08-01",
      lines: feeLines("777.00"),
    });
    await submitInvoice(db, clerk, created.id);
    await approveInvoice(db, director, created.id);
    await issueInvoice(db, accountant, created.id);

    const before = await trialBalance(db, { to: "2026-12-31" });
    await voidInvoice(db, director, created.id, { reason: "Raised against the wrong client" });

    const invoice = await getInvoice(db, created.id);
    expect(invoice!.status).toBe("void");
    expect(invoice!.voidJournalId).toBeTruthy();
    // The number is kept: an invoice book with a hole in it cannot be explained.
    expect(invoice!.invoiceNo).toBeTruthy();

    const after = await trialBalance(db, { to: "2026-12-31" });
    expect(after.difference).toBe(0n);
    // The reversal nets the entry out, so the receivable and the revenue both
    // shrink by the invoice. Both entries remain in the ledger; the balances do not.
    expect(after.totalDebit).toBe(before.totalDebit - parseAmount("777.00"));
  });

  it("refuses to void an invoice with money allocated against it", async () => {
    const created = await createInvoice(db, clerk, {
      customerId,
      documentDate: "2026-08-02",
      lines: feeLines("400.00"),
    });
    await submitInvoice(db, clerk, created.id);
    await approveInvoice(db, director, created.id);
    await issueInvoice(db, accountant, created.id);

    const receipt = await createReceipt(db, clerk, {
      customerId,
      receiptDate: "2026-08-03",
      depositAccountCode: "1251",
      amount: "400.00",
    });
    await postReceipt(db, accountant, receipt.id);
    await allocateReceipt(db, accountant, receipt.id, [{ invoiceId: created.id, amount: "400.00" }]);

    await expect(
      voidInvoice(db, director, created.id, { reason: "Changed my mind" }),
    ).rejects.toThrow(/allocated against it/);

    // And the receipt cannot be voided while it is allocated either.
    await expect(
      voidReceipt(db, accountant, receipt.id, { reason: "Bounced" }),
    ).rejects.toThrow(/allocated to invoices/);
  });

  it("needs a reason", async () => {
    const created = await createInvoice(db, clerk, { customerId, lines: feeLines("5.00") });
    await submitInvoice(db, clerk, created.id);
    await approveInvoice(db, director, created.id);
    await issueInvoice(db, accountant, created.id);
    await expect(voidInvoice(db, director, created.id, { reason: " " })).rejects.toThrow(
      /needs a reason/,
    );
  });
});

// ---------------------------------------------------------------------------
describe("quotations", () => {
  it("goes from draft to invoice, copying the lines rather than sharing them", async () => {
    const created = await createQuotation(db, clerk, {
      customerId,
      documentDate: "2026-09-01",
      subject: "Proposed scope — Bandar Uda",
      lines: [
        { description: "Land search", unitPrice: "900.00", accountCode: "4120" },
        { description: "Valuation", unitPrice: "2600.00", accountCode: "4140" },
      ],
    });

    const draft = await getQuotation(db, created.id);
    expect(draft!.status).toBe("draft");
    expect(draft!.total).toBe(parseAmount("3500.00"));
    // Validity comes from the setting, 30 days by default.
    expect(draft!.validUntil).toBe("2026-10-01");

    // Cannot convert before it has been accepted.
    await expect(convertQuotationToInvoice(db, accountant, created.id)).rejects.toThrow(
      /Only an accepted quotation/,
    );

    const { quotationNo } = await sendQuotation(db, clerk, created.id);
    expect(quotationNo).toMatch(/^QT-2026-\d{5}$/);

    // Not the clerk who raised it: recording acceptance needs `accounting.quotation.approve`, which
    // an accounts executive does not hold. The code asked for `quotation.create` instead, so the
    // approve capability gated nothing while `MAKER_CHECKER_PAIRS` and the RBAC matrix both said it
    // did.
    await expect(decideQuotation(db, clerk, created.id, "accepted")).rejects.toThrow(
      /accounting\.quotation\.approve/,
    );

    await decideQuotation(db, accountant, created.id, "accepted");
    const { invoiceId } = await convertQuotationToInvoice(db, accountant, created.id);

    const invoice = await getInvoice(db, invoiceId);
    expect(invoice!.status).toBe("draft");
    expect(invoice!.total).toBe(parseAmount("3500.00"));
    expect(invoice!.quotationNo).toBe(quotationNo);

    // Editing the invoice leaves the quotation exactly as it was quoted.
    await updateInvoice(db, clerk, invoiceId, {
      customerId,
      lines: [{ description: "Land search only", unitPrice: "900.00", accountCode: "4120" }],
    });
    expect((await getInvoice(db, invoiceId))!.total).toBe(parseAmount("900.00"));
    expect((await getQuotation(db, created.id))!.total).toBe(parseAmount("3500.00"));
  });

  it("converts only once", async () => {
    const quotations = await db.execute<{ id: string }>(
      sql`SELECT id FROM accounting.quotation WHERE status = 'converted' LIMIT 1`,
    );
    await expect(
      convertQuotationToInvoice(db, accountant, quotations.rows![0]!.id),
    ).rejects.toThrow(/already been converted/);
  });

  it("cannot be accepted by the person who raised it", async () => {
    // The accountant holds both capabilities, which is the case the capability check alone does not
    // catch: one person raising a quotation and then recording that the customer accepted it is one
    // person turning nothing into a billable invoice.
    const mine = await createQuotation(db, accountant, {
      customerId,
      documentDate: "2026-09-01",
      lines: feeLines("400.00"),
    });
    await sendQuotation(db, accountant, mine.id);

    await expect(decideQuotation(db, accountant, mine.id, "accepted")).rejects.toThrow(
      /created yourself/i,
    );

    // Somebody else can, and a decline needs no second pair of hands — it closes the offer rather
    // than turning it into money.
    await decideQuotation(db, director, mine.id, "declined", { reason: "Client went elsewhere" });
    expect((await getQuotation(db, mine.id))!.status).toBe("declined");
  });

  it("refuses to accept a quotation that has lapsed", async () => {
    const stale = await createQuotation(db, clerk, {
      customerId,
      documentDate: "2020-01-01",
      lines: feeLines("400.00"),
    });
    await sendQuotation(db, clerk, stale.id);

    // `valid_until` was computed, stored, displayed on the screen and read by nothing at all, so a
    // quotation that expired years ago converted silently at the price it carried then.
    await expect(decideQuotation(db, accountant, stale.id, "accepted")).rejects.toThrow(/lapsed/);
  });

  it("a sent quotation cannot be edited", async () => {
    const created = await createQuotation(db, clerk, { customerId, lines: feeLines("100.00") });
    await sendQuotation(db, clerk, created.id);
    await expect(
      db.execute(sql`
        INSERT INTO accounting.quotation_line (quotation_id, line_no, description, unit_price, line_subtotal, line_total, account_id)
        SELECT ${created.id}, 99, 'sneak', 1, 1, 1, id FROM accounting.account WHERE code = '4110'
      `),
    ).rejects.toThrow(/Lines cannot be/);
  });
});

// ---------------------------------------------------------------------------
describe("the financial reports", () => {
  it("profit and loss separates direct costs from overheads", async () => {
    const report = await profitAndLoss(db, { from: "2026-01-01", to: "2026-12-31" });

    expect(report.revenue.total).toBeGreaterThan(0n);
    expect(report.netProfit).toBe(report.grossProfit - report.totalExpenses);
    // Revenue reads positive, which is what a reader expects.
    expect(report.revenue.lines.every((line) => line.amount > 0n)).toBe(true);
  });

  it("the balance sheet balances, including profit not yet closed to reserves", async () => {
    const sheet = await balanceSheet(db, { asOf: "2026-12-31" });

    expect(sheet.fiscalYearStart).toBe("2026-01-01");
    expect(sheet.currentYearEarnings).not.toBe(0n);
    expect(formatAmount(sheet.difference)).toBe("0.00");
    expect(sheet.totalAssets).toBe(sheet.totalLiabilities + sheet.totalEquity);
  });

  it("a customer statement runs a balance across invoices and receipts", async () => {
    const statement = await customerStatement(db, customerId, { to: "2026-12-31" });

    expect(statement!.entries.length).toBeGreaterThan(2);
    expect(statement!.entries.some((entry) => entry.kind === "invoice")).toBe(true);
    expect(statement!.entries.some((entry) => entry.kind === "receipt")).toBe(true);

    // The running balance is the sum of everything before it.
    const last = statement!.entries[statement!.entries.length - 1]!;
    expect(last.balance).toBe(statement!.closingBalance);
  });

  it("lists outstanding invoices with their age", async () => {
    const outstanding = await listInvoices(db, { outstandingOnly: true, limit: 500 });
    expect(outstanding.length).toBeGreaterThan(0);
    expect(outstanding.every((invoice) => invoice.outstanding > 0n)).toBe(true);
    expect(outstanding.every((invoice) => invoice.daysOverdue !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("the server refuses when the interface is bypassed", () => {
  it("every step checks its own capability, not the one before it", async () => {
    const { id } = await createInvoice(db, clerk, { customerId, lines: feeLines("99.00") });
    await submitInvoice(db, clerk, id);
    await approveInvoice(db, director, id);

    // A clerk prepares but does not issue.
    await expect(issueInvoice(db, clerk, id)).rejects.toThrow(AuthorizationError);
    // An employee cannot take a receipt.
    await expect(
      createReceipt(db, employee, { customerId, amount: "1.00", depositAccountCode: "1251" }),
    ).rejects.toThrow(AuthorizationError);
    // Nor allocate one.
    await expect(allocateReceipt(db, employee, id, [])).rejects.toThrow(AuthorizationError);
  });

  it("money received must land in a bank or cash account", async () => {
    await expect(
      createReceipt(db, clerk, { customerId, amount: "100.00", depositAccountCode: "4110" }),
    ).rejects.toThrow(/not a bank or cash account/);
  });

  it("a receipt cannot settle another customer's invoice", async () => {
    const receipt = await createReceipt(db, clerk, {
      customerId: secondCustomerId,
      depositAccountCode: "1251",
      amount: "100.00",
    });
    await postReceipt(db, accountant, receipt.id);

    const theirs = (await listInvoices(db, { customerId, outstandingOnly: true, limit: 50 })).find(
      (invoice) => invoice.outstanding >= parseAmount("100.00"),
    )!;
    await expect(
      allocateReceipt(db, accountant, receipt.id, [{ invoiceId: theirs.id, amount: "100.00" }]),
    ).rejects.toThrow(/same customer/);
  });

  it("an invoice cannot be raised for an inactive customer", async () => {
    const gone = await createCustomer(db, clerk, { code: "CUST-OLD", name: "Closed Ltd" });
    await db.execute(sql`UPDATE accounting.customer SET is_active = false WHERE id = ${gone.id}`);
    await expect(
      createInvoice(db, clerk, { customerId: gone.id, lines: feeLines() }),
    ).rejects.toThrow(/marked inactive/);
  });

  it("refuses an invoice with no lines", async () => {
    await expect(createInvoice(db, clerk, { customerId, lines: [] })).rejects.toThrow(
      ValidationError,
    );
  });

  it("refuses to issue into a closed period", async () => {
    const created = await createInvoice(db, clerk, {
      customerId,
      documentDate: "2026-02-10",
      lines: feeLines("250.00"),
    });
    await submitInvoice(db, clerk, created.id);
    await approveInvoice(db, director, created.id);

    const february = await db.execute<{ id: string }>(
      sql`SELECT id FROM accounting.period WHERE code = '2026-02'`,
    );
    // Close February out from under the approved invoice.
    await db.execute(sql`
      UPDATE accounting.journal SET status = 'posted' WHERE false
    `);
    const { transitionPeriod } = await import("./periods.js");
    await transitionPeriod(db, accountant, february.rows![0]!.id, "close");

    await expect(issueInvoice(db, accountant, created.id)).rejects.toThrow(ConflictError);

    await transitionPeriod(db, director, february.rows![0]!.id, "reopen", {
      reason: "Test fixture",
    });
  });
});

// ---------------------------------------------------------------------------
describe("amounts survive the document round trip", () => {
  it("keeps four decimal places through lines, totals and the ledger", async () => {
    const { id } = await createInvoice(db, clerk, {
      customerId,
      documentDate: "2026-10-01",
      lines: [
        { description: "Per-page copying", quantity: "137", unitPrice: "0.35", accountCode: "4160" },
        { description: "Mileage", quantity: "88.5", unitPrice: "0.90", accountCode: "4210" },
      ],
    });

    const invoice = await getInvoice(db, id);
    // 137 x 0.35 = 47.95 exactly; 88.5 x 0.90 = 79.65 exactly.
    expect(amountToSql(invoice!.lines[0]!.lineSubtotal)).toBe("47.9500");
    expect(amountToSql(invoice!.lines[1]!.lineSubtotal)).toBe("79.6500");
    expect(invoice!.total).toBe(parseAmount("127.60"));

    await submitInvoice(db, clerk, id);
    await approveInvoice(db, director, id);
    await issueInvoice(db, accountant, id);

    const journal = await getJournal(db, (await getInvoice(db, id))!.journalId!);
    expect(journal!.totalDebit).toBe(parseAmount("127.60"));
    expect(journal!.totalDebit).toBe(journal!.totalCredit);
  });
});
