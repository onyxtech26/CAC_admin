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
  resolveProvider,
  submissionReadiness,
} from "./einvoice.js";

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
});
