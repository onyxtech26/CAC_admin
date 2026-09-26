import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import { hashPassword } from "./password.js";
import { resolveCapabilities, type Principal } from "./authz.js";
import { ValidationError } from "./errors.js";
import {
  EInvoiceNotConfiguredError,
  MyInvoisProvider,
  NotConfiguredProvider,
  cancelSubmission,
  invoiceSubmissionBlockers,
  listSubmissions,
  resolveProvider,
  submissionReadiness,
  submitInvoiceToAuthority,
  type EInvoiceDocument,
  type EInvoiceProvider,
  type StatusResult,
  type SubmissionResult,
} from "./einvoice.js";
import { listAccounts, updateAccount } from "./accounts.js";
import { createCustomer, updateCustomer } from "./parties.js";
import { createFiscalYear } from "./periods.js";
import {
  approveInvoice,
  createInvoice,
  issueInvoice,
  submitInvoice,
} from "./sales.js";



/**
 * Phase 4: the e-Invoice boundary.
 *
 * These tests exist to prove a negative, which is the whole point of the module.
 * Nothing here talks to LHDN, and nothing here pretends to. What is proven is
 * that the platform cannot be made to *appear* to have submitted an invoice:
 *
 *   - the provider that is installed refuses, and raises rather than returning a
 *     failure that could be mistaken for a rejection by LHDN;
 *   - the real adapter cannot be constructed without complete credentials, so it
 *     cannot become active by accident or point at production by default;
 *   - what is missing is reported as a list of things CAC can act on, not as a
 *     generic error.
 */

let db: Database;
let close: () => Promise<void>;
let accountant: Principal;
/** A second pair of hands: an invoice is approved by somebody other than its maker. */
let director: Principal;

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

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  await runMigrations(db);
  await seed(db);

  const hash = await hashPassword("correct-horse-battery-staple");
  const user = await db.execute<{ id: string }>(sql`
    INSERT INTO auth."user" (email, password_hash, full_name)
    VALUES ('einvoice@cac.test', ${hash}, 'einvoice@cac.test') RETURNING id
  `);
  const userId = user.rows![0]!.id;
  await db.execute(sql`
    INSERT INTO auth.user_role (user_id, role_id)
    SELECT ${userId}, id FROM auth.role WHERE key = 'ACCOUNTANT'
  `);

  accountant = {
    userId,
    email: "einvoice@cac.test",
    fullName: "einvoice@cac.test",
    roles: ["ACCOUNTANT"],
    capabilities: await resolveCapabilities(db, userId),
    employeeId: null,
    sessionId: "00000000-0000-0000-0000-000000000000",
    mfaSatisfied: true,
    mustChangePassword: false,
    mustEnrolMfa: false,
    mfaRequired: false,
    mfaEnrolmentDueAt: null,
  };

  director = await makePrincipal("ei-director@cac.test", ["DIRECTOR"]);
}, 120_000);

afterAll(async () => {
  await close();
});

describe("the installed provider", () => {
  it("is the one that refuses, because nothing is configured", async () => {
    const status = await resolveProvider(db);

    expect(status.provider).toBeInstanceOf(NotConfiguredProvider);
    expect(status.provider.configured).toBe(false);
    expect(status.inScope).toBe(false);
    expect(status.blockers.length).toBeGreaterThan(0);
  });

  it("says what is missing in terms CAC can act on", async () => {
    const status = await resolveProvider(db);
    const all = status.blockers.join(" ");

    expect(all).toContain("in scope");
    expect(all).toContain("tax identification number");
    expect(all).toContain("credentials");
  });

  it("raises rather than returning something that looks like a rejection", async () => {
    const { provider } = await resolveProvider(db);

    // The distinction matters: a returned `{ status: "invalid" }` would be
    // indistinguishable from LHDN rejecting the document, and one of those is an
    // invoice to correct while the other is a question for CAC.
    await expect(provider.submit({} as never)).rejects.toThrow(EInvoiceNotConfiguredError);
    await expect(provider.status("anything")).rejects.toThrow(EInvoiceNotConfiguredError);
    await expect(provider.cancel("anything", "reason")).rejects.toThrow(
      EInvoiceNotConfiguredError,
    );
  });

  it("names the open question in the message, so the answer is findable", async () => {
    const { provider } = await resolveProvider(db);
    await expect(provider.submit({} as never)).rejects.toThrow(/Q-FIN-2/);
    await expect(provider.submit({} as never)).rejects.toThrow(/nothing has been submitted/i);
  });

  it("stays the refusing provider even once the company says it is in scope", async () => {
    await db.execute(
      sql`UPDATE org.setting SET value = 'true'::jsonb WHERE key = 'einvoice.enabled'`,
    );

    const status = await resolveProvider(db);
    expect(status.inScope).toBe(true);
    // Being in scope is not being able to submit. The credentials are still absent.
    expect(status.provider.configured).toBe(false);

    await db.execute(
      sql`UPDATE org.setting SET value = 'false'::jsonb WHERE key = 'einvoice.enabled'`,
    );
  });
});

describe("the MyInvois adapter", () => {
  it("cannot be constructed without every credential", () => {
    expect(
      () =>
        new MyInvoisProvider({
          tin: "",
          clientId: "id",
          clientSecret: "secret",
          environment: "sandbox",
        }),
    ).toThrow(ValidationError);

    expect(
      () =>
        new MyInvoisProvider({
          tin: "C1234567890",
          clientId: "id",
          clientSecret: "",
          environment: "sandbox",
        }),
    ).toThrow(ValidationError);
  });

  it("has no default environment, so it cannot quietly point at production", () => {
    expect(
      () =>
        new MyInvoisProvider({
          tin: "C1234567890",
          clientId: "id",
          clientSecret: "secret",
          environment: "" as never,
        }),
    ).toThrow(ValidationError);
  });

  it("refuses to submit an invoice whose buyer has no TIN, before any request is made", async () => {
    const provider = new MyInvoisProvider({
      tin: "C1234567890",
      clientId: "id",
      clientSecret: "secret",
      environment: "sandbox",
      // Nothing is reachable at this address; the point is that the refusal
      // happens before any network call is attempted.
      baseUrl: "http://127.0.0.1:1",
    });

    await expect(
      provider.submit({
        invoiceId: "00000000-0000-0000-0000-000000000000",
        invoiceNo: "INV-2026-00001",
        issuedOn: "2026-07-01",
        currency: "MYR",
        subtotal: 10_000_000n,
        taxTotal: 0n,
        total: 10_000_000n,
        buyer: { name: "Tan Sri Holdings", tin: null, registrationNo: null, email: null, address: null },
        lines: [
          {
            description: "Forensic investigation",
            quantity: "1",
            unitPrice: 10_000_000n,
            taxAmount: 0n,
            lineTotal: 10_000_000n,
            classificationCode: "022",
          },
        ],
      }),
    ).rejects.toThrow(/tax identification number/);
  });

  it("refuses a line with no classification code rather than guessing one", async () => {
    const provider = new MyInvoisProvider({
      tin: "C1234567890",
      clientId: "id",
      clientSecret: "secret",
      environment: "sandbox",
      baseUrl: "http://127.0.0.1:1",
    });

    await expect(
      provider.submit({
        invoiceId: "00000000-0000-0000-0000-000000000000",
        invoiceNo: "INV-2026-00002",
        issuedOn: "2026-07-01",
        currency: "MYR",
        subtotal: 10_000_000n,
        taxTotal: 0n,
        total: 10_000_000n,
        buyer: {
          name: "Tan Sri Holdings",
          tin: "C9876543210",
          registrationNo: null,
          email: null,
          address: null,
        },
        lines: [
          {
            description: "Forensic investigation",
            quantity: "1",
            unitPrice: 10_000_000n,
            taxAmount: 0n,
            lineTotal: 10_000_000n,
            classificationCode: null,
          },
        ],
      }),
    ).rejects.toThrow(/classification code/);
  });
});

describe("readiness", () => {
  it("reports the data CAC has to fix, before the integration exists", async () => {
    const readiness = await submissionReadiness(db, accountant);

    // Nothing is issued in this fixture, so the useful assertion is that the
    // question can be asked at all: the TIN gap is CAC's to close and takes time,
    // and it is better found now than on the day submission becomes mandatory.
    expect(readiness.companyTinRecorded).toBe(false);
    expect(readiness.invoices).toBe(0);
    expect(Array.isArray(readiness.customersWithoutTin)).toBe(true);
  });

  it("lists the revenue accounts with no classification code", async () => {
    // The other half of Q-FIN-2's data, and the half nothing surfaced before: a TIN per customer
    // was listed, and the codes were not, so the work looked half as big as it is.
    const readiness = await submissionReadiness(db, accountant);
    expect(readiness.accountsWithoutClassification.length).toBeGreaterThan(0);
    expect(readiness.accountsWithoutClassification.every((row) => row.code.startsWith("4"))).toBe(
      true,
    );
  });
});

/**
 * The submission path.
 *
 * It did not exist: `buildEInvoiceDocument` had no callers, `provider.submit()` was reached only
 * from tests, and no column recorded a submission — so the honest refusal at the seam was refusing
 * on behalf of nothing.
 *
 * These tests use a provider that records what it was asked and answers as configured. That is not
 * a pretend integration: the point is to prove the platform's own half — the refusals, the ordering
 * of them, what is written down and what cannot be written twice — without claiming anything about
 * LHDN. What the real adapter sends is tested separately, against its request shapes.
 */
describe("submitting to the authority", () => {
  class RecordingProvider implements EInvoiceProvider {
    readonly name = "Recording (test)";
    readonly environment = "sandbox" as const;
    readonly configured = true;
    readonly blockers: string[] = [];
    sent: EInvoiceDocument[] = [];

    constructor(private readonly answer: SubmissionResult["status"] = "valid") {}

    async submit(document: EInvoiceDocument): Promise<SubmissionResult> {
      this.sent.push(document);
      return {
        uuid: `UUID-${this.sent.length}`,
        longId: "LONG-1",
        status: this.answer,
        submittedAt: new Date(),
        messages: this.answer === "invalid" ? ["Buyer TIN not recognised."] : [],
      };
    }

    async status(uuid: string): Promise<StatusResult> {
      return { uuid, status: "valid", messages: [] };
    }

    async cancel(uuid: string): Promise<StatusResult> {
      return { uuid, status: "cancelled", messages: [] };
    }
  }

  let invoiceId: string;
  let customerId: string;

  beforeAll(async () => {
    await createFiscalYear(db, director, { startsOn: "2026-01-01" });
    customerId = (
      await createCustomer(db, accountant, {
        code: "SUBMIT",
        name: "Submitting Client Sdn Bhd",
      })
    ).id;

    const created = await createInvoice(db, accountant, {
      customerId,
      documentDate: "2026-05-04",
      lines: [{ description: "Land search", unitPrice: "1200.00", accountCode: "4120" }],
    });
    invoiceId = created.id;
    await submitInvoice(db, accountant, invoiceId);
    await approveInvoice(db, director, invoiceId);
    await issueInvoice(db, accountant, invoiceId);
  }, 60_000);

  it("refuses because the integration does not exist, before looking at the invoice", async () => {
    // The order matters. "Not configured" is a question for CAC; "this invoice has no buyer TIN" is
    // CAC's data. Reporting the second when the first is true would send somebody to fix the wrong
    // thing — and it raises rather than returning, so a caller cannot report it as an LHDN
    // rejection.
    await expect(submitInvoiceToAuthority(db, accountant, invoiceId)).rejects.toBeInstanceOf(
      EInvoiceNotConfiguredError,
    );

    const none = await listSubmissions(db, accountant, { invoiceId });
    expect(none).toHaveLength(0);
  });

  it("refuses an invoice whose buyer has no TIN and whose service has no code", async () => {
    const blockers = await invoiceSubmissionBlockers(db, invoiceId);
    expect(blockers.some((entry) => entry.includes("tax identification number"))).toBe(true);
    expect(blockers.some((entry) => entry.includes("classification code"))).toBe(true);
  });

  it("submits once the data is there, and records what came back", async () => {
    await updateCustomer(db, accountant, customerId, {
      code: "SUBMIT",
      name: "Submitting Client Sdn Bhd",
      taxIdentifier: "C1234567890",
    });
    const account = (await listAccounts(db)).find((row) => row.code === "4120")!;
    await updateAccount(db, accountant, account.id, {
      name: account.name,
      einvoiceClassificationCode: "022",
    });

    expect(await invoiceSubmissionBlockers(db, invoiceId)).toHaveLength(0);

    const provider = new RecordingProvider();
    const result = await submitInvoiceToAuthority(db, accountant, invoiceId, { provider });

    expect(result.status).toBe("valid");
    expect(provider.sent).toHaveLength(1);
    // The document carried the code from the account, which is the point of putting it there.
    expect(provider.sent[0]!.lines[0]!.classificationCode).toBe("022");
    expect(provider.sent[0]!.buyer.tin).toBe("C1234567890");

    const recorded = await listSubmissions(db, accountant, { invoiceId });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.status).toBe("valid");
    expect(recorded[0]!.environment).toBe("sandbox");
    expect(recorded[0]!.submittedByName).toBe("einvoice@cac.test");
  });

  it("will not put the same invoice in front of the authority twice", async () => {
    const provider = new RecordingProvider();
    await expect(
      submitInvoiceToAuthority(db, accountant, invoiceId, { provider }),
    ).rejects.toThrow(/already been submitted/);
    expect(provider.sent).toHaveLength(0);
  });

  it("cancels with a reason, and keeps the submission", async () => {
    const submission = (await listSubmissions(db, accountant, { invoiceId }))[0]!;
    const provider = new RecordingProvider();

    await expect(
      cancelSubmission(db, accountant, submission.id, "   ", { provider }),
    ).rejects.toThrow(/why it is being cancelled/);

    await cancelSubmission(db, accountant, submission.id, "Raised against the wrong company.", {
      provider,
    });

    const after = (await listSubmissions(db, accountant, { invoiceId }))[0]!;
    expect(after.status).toBe("cancelled");
    expect(after.cancelReason).toMatch(/wrong company/);

    // A conversation with a tax authority is not deleted.
    await expect(
      db.execute(sql`DELETE FROM accounting.einvoice_submission WHERE id = ${submission.id}`),
    ).rejects.toThrow(/not deleted/);
  });
});
