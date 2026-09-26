import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import { hashPassword } from "./password.js";
import { AuthorizationError, resolveCapabilities, type Principal } from "./authz.js";
import {
  ENQUIRIES_PER_ADDRESS_PER_HOUR,
  getEnquiry,
  handleEnquiry,
  listEnquiries,
  recordEnquiry,
} from "./enquiries.js";

/**
 * Enquiries from the public site.
 *
 * The one thing in this platform written by strangers, so these tests are mostly about what it
 * refuses. The happy path is three lines; the rest is the shape of the defence.
 */

let db: Database;
let close: () => Promise<void>;
let staff: Principal;
let outsider: Principal;

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

  staff = await makePrincipal("enq-staff@cac.test", ["ACCOUNTS_EXECUTIVE"]);
  outsider = await makePrincipal("enq-outsider@cac.test", ["EMPLOYEE"]);
}, 120_000);

afterAll(async () => {
  await close();
});

describe("an enquiry from the website", () => {
  it("is recorded, numbered, and readable by whoever answers the phone", async () => {
    const { reference } = await recordEnquiry(db, {
      name: "Lim Wei Ming",
      email: "lim@example.test",
      service: "Title and Document Investigation",
      message: "Two names appear on the title for our family lot in Skudai.",
    });

    expect(reference).toMatch(/^ENQ-\d{4}-\d{5}$/);

    const listed = await listEnquiries(db, staff);
    const found = listed.find((row) => row.reference === reference)!;
    expect(found.name).toBe("Lim Wei Ming");
    expect(found.status).toBe("new");
    expect(found.source).toBe("website");
  });

  it("insists on a way to answer it", async () => {
    await expect(
      recordEnquiry(db, { name: "Nobody", message: "Call me." }),
    ).rejects.toThrow(/email address or a phone number/);

    // A phone number alone is enough — plenty of people would rather be rung.
    const { reference } = await recordEnquiry(db, {
      name: "Siti",
      phone: "+60 12-345 6789",
      message: "Please call about a boundary question.",
    });
    expect(reference).toBeTruthy();
  });

  it("refuses an empty name or message rather than storing a blank", async () => {
    await expect(
      recordEnquiry(db, { name: "   ", email: "a@b.test", message: "Something" }),
    ).rejects.toThrow(/name/);
    await expect(
      recordEnquiry(db, { name: "Someone", email: "a@b.test", message: "  " }),
    ).rejects.toThrow(/what you need/i);
  });

  it("refuses a message longer than the column can hold, rather than truncating it", async () => {
    // Truncation is the failure that looks like success: the enquirer sees "sent" and the firm reads
    // half a sentence.
    await expect(
      recordEnquiry(db, { name: "Long", email: "a@b.test", message: "x".repeat(4001) }),
    ).rejects.toThrow(/4000 characters/);
  });

  it("stops one address after a handful in an hour", async () => {
    const ip = "198.51.100.9";
    for (let attempt = 0; attempt < ENQUIRIES_PER_ADDRESS_PER_HOUR; attempt += 1) {
      await recordEnquiry(db, {
        name: `Sender ${attempt}`,
        email: `sender${attempt}@example.test`,
        message: "One of several.",
        ip,
      });
    }

    await expect(
      recordEnquiry(db, { name: "One too many", email: "x@example.test", message: "Again.", ip }),
    ).rejects.toThrow(/last hour/);

    // Another address is unaffected: the limit is per connection, not a global tap.
    const elsewhere = await recordEnquiry(db, {
      name: "Somebody else",
      email: "else@example.test",
      message: "From a different place.",
      ip: "198.51.100.10",
    });
    expect(elsewhere.reference).toBeTruthy();
  });

  it("records who asked without putting their message in the audit trail", async () => {
    const { id, reference } = await recordEnquiry(db, {
      name: "Private Person",
      email: "private@example.test",
      message: "Something they would rather not see repeated in an append-only table.",
    });

    const events = await db.execute<{ actor_label: string; new_values: Record<string, unknown> }>(sql`
      SELECT actor_label, new_values FROM audit.event
       WHERE action = 'ENQUIRY_RECEIVED' AND entity_id = ${id}
    `);
    const event = events.rows![0]!;

    // No actor, because nobody was signed in — and that is the truth rather than an omission.
    expect(event.actor_label).toBe("public website");
    expect(JSON.stringify(event.new_values)).toContain(reference);
    expect(JSON.stringify(event.new_values)).not.toContain("Private Person");
    expect(JSON.stringify(event.new_values)).not.toContain("rather not see");
  });
});

describe("what the firm does about it", () => {
  it("is not readable by somebody with no business reading it", async () => {
    await expect(listEnquiries(db, outsider)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("records the handling beside the enquiry, never over it", async () => {
    const { id } = await recordEnquiry(db, {
      name: "Tan Ah Kow",
      email: "tan@example.test",
      message: "A question about a grant.",
    });

    await handleEnquiry(db, staff, id, {
      status: "answered",
      note: "Rang and explained what a search would cover.",
    });

    const after = (await getEnquiry(db, staff, id))!;
    expect(after.status).toBe("answered");
    expect(after.handledByName).toBe("enq-staff@cac.test");
    expect(after.handledAt).not.toBeNull();
    // Untouched.
    expect(after.message).toBe("A question about a grant.");

    // And it cannot be touched, by anybody, at the database.
    await expect(
      db.execute(sql`UPDATE org.enquiry SET message = 'something else' WHERE id = ${id}`),
    ).rejects.toThrow(/cannot be altered/);
  });

  it("asks why before it will call somebody's message spam", async () => {
    const { id } = await recordEnquiry(db, {
      name: "Maybe A Bot",
      email: "bot@example.test",
      message: "Buy our search engine optimisation services.",
    });

    await expect(
      handleEnquiry(db, staff, id, { status: "spam" }),
    ).rejects.toThrow(/why this is being marked/);

    await handleEnquiry(db, staff, id, {
      status: "spam",
      note: "Unsolicited marketing, nothing to do with property.",
    });
    expect((await getEnquiry(db, staff, id))!.status).toBe("spam");
  });
});
