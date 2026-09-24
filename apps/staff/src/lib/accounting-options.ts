import "server-only";
import { getDb } from "@cac/db";
import { sql } from "drizzle-orm";
import { getSetting, listCustomers, listPostableAccounts, listSuppliers, listTaxCodes } from "@cac/core";

/**
 * The reference data every sales form needs.
 *
 * One call, three queries, rather than each page assembling its own set and
 * drifting from the others. The tax note is included because it is the honest
 * answer to "why is there no tax on this invoice" and belongs next to the form
 * rather than in a FAQ.
 */
export async function salesFormOptions() {
  const db = await getDb();

  const [customers, accounts, taxCodes, sstRegistered] = await Promise.all([
    listCustomers(db),
    listPostableAccounts(db),
    listTaxCodes(db),
    getSetting<boolean>(db, "tax.sst_registered", false),
  ]);

  const usableTaxCodes = taxCodes
    .filter((code) => code.isActive && code.kind !== "input")
    .map((code) => ({ id: code.id, code: code.code, name: code.name, rate: code.currentRate }));

  return {
    customers: customers.map((customer) => ({
      id: customer.id,
      code: customer.code,
      name: customer.name,
      paymentTermsDays: customer.paymentTermsDays,
    })),
    // What a sales line may credit: revenue, and the two accounts used to recover
    // costs advanced on a client's behalf. The full chart runs to a hundred
    // entries and offering all of it invites a mis-post.
    //
    // Trade receivables (1210) is deliberately absent. It is the other side of
    // the entry, written by the posting engine; putting it on a line as well
    // would debit and credit the same control account and double-count the debt.
    accounts: accounts
      .filter(
        (account) =>
          account.type === "REVENUE" ||
          account.code === "1230" ||
          account.code === "1235",
      )
      .map((account) => ({ id: account.id, code: account.code, name: account.name })),
    allAccounts: accounts.map((account) => ({
      id: account.id,
      code: account.code,
      name: account.name,
    })),
    bankAccounts: accounts
      .filter((account) => account.subtype === "bank" || account.subtype === "cash")
      .map((account) => ({ id: account.id, code: account.code, name: account.name })),
    taxCodes: usableTaxCodes,
    taxNote: sstRegistered
      ? undefined
      : "No tax will be charged: the company is not recorded as SST registered. An administrator " +
        "confirms that under Settings, and a rate is entered — with its source — under Tax.",
  };
}

/**
 * The reference data the money-out forms need.
 *
 * A separate call from the sales one: the account list is the opposite half of
 * the chart, and offering a hundred accounts on a voucher is how a payment ends
 * up against revenue.
 */
export async function purchaseFormOptions() {
  const db = await getDb();

  const [accounts, suppliers, taxCodes, centres, sstRegistered] = await Promise.all([
    listPostableAccounts(db),
    listSuppliers(db),
    listTaxCodes(db),
    db.execute<{ id: string; code: string; name: string }>(
      sql`SELECT id, code, name FROM org.cost_centre WHERE is_active ORDER BY code`,
    ),
    getSetting<boolean>(db, "tax.sst_registered", false),
  ]);

  return {
    suppliers: suppliers.map((supplier) => ({
      id: supplier.id,
      code: supplier.code,
      name: supplier.name,
    })),
    // What money can be spent on: costs, overheads, finance and tax, plus the two
    // liability accounts a payment legitimately settles (payables and staff
    // claims) and the assets a purchase can create.
    accounts: accounts
      .filter(
        (account) =>
          account.type === "EXPENSE" ||
          account.code === "2110" ||
          account.code === "2155" ||
          account.subtype === "fixed_asset" ||
          account.code === "1225" ||
          account.code === "1235",
      )
      .map((account) => ({ id: account.id, code: account.code, name: account.name })),
    bankAccounts: accounts
      .filter((account) => account.subtype === "bank" || account.subtype === "cash")
      .map((account) => ({ id: account.id, code: account.code, name: account.name })),
    taxCodes: taxCodes
      .filter((code) => code.isActive && code.kind !== "output")
      .map((code) => ({ id: code.id, code: code.code, name: code.name, rate: code.currentRate })),
    costCentres: centres.rows ?? [],
    taxNote: sstRegistered
      ? undefined
      : "No input tax will be recorded: the company is not registered for SST, so tax paid to " +
        "suppliers is part of the cost rather than reclaimable.",
  };
}
