import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import { ALL_PERMISSIONS, MAKER_CHECKER_PAIRS, ROLE_PERMISSIONS, ROLES } from "@cac/db/rbac";
import { hashPassword } from "./password.js";
import { isMakerCheckerPair, resolveCapabilities, type Principal } from "./authz.js";
import { redactFreeText } from "./audit.js";

/**
 * Phase 13: the permission model as a whole, rather than one module at a time.
 *
 * Every module's own tests prove that a holder succeeds and a non-holder is refused for the
 * capabilities that module uses. What none of them can see is the shape of the catalogue itself,
 * and that is where the interesting failures live:
 *
 *   * **A capability nobody holds.** `doc.archive` and `doc.delete` were defined, checked in code,
 *     and granted to no role at all — so nobody could archive a document or destroy an original,
 *     and nothing failed loudly enough to notice. That class of bug is what the first test here
 *     exists for.
 *   * **A capability granted that does not exist.** A typo in a role bundle silently grants
 *     nothing, and the screen simply never appears for that role.
 *   * **The documented matrix and the code disagreeing.** `CASE_MANAGER` was built with
 *     `has("case.")`, which handed it the two approvals `docs/RBAC_MATRIX.md` says sit only with
 *     the reviewer and the director.
 *   * **A separation of duties that is only a convention.** Every maker capability that has a
 *     matching approver has to be in `MAKER_CHECKER_PAIRS`, or the pairing exists in somebody's
 *     head and nowhere else.
 */

let db: Database;
let close: () => Promise<void>;

// Typed as strings on purpose: these tests ask questions about keys that may not be in
// the catalogue, which is the whole point of them.
const CAPABILITY_KEYS = new Set<string>(ALL_PERMISSIONS.map((entry) => entry.key));

/** Capabilities that read rather than change anything. */
const isRead = (key: string) =>
  /\.(view|view_all|view_own|view_sensitive|download|export)$/.test(key);

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
}, 180_000);

afterAll(async () => {
  await close();
});

// ---------------------------------------------------------------------------
describe("the shape of the capability catalogue", () => {
  it("grants every defined capability to at least one role", () => {
    const granted = new Set<string>(Object.values(ROLE_PERMISSIONS).flat());
    const orphans = [...CAPABILITY_KEYS].filter((key) => !granted.has(key));

    // A capability nobody holds is a feature nobody can reach, and the code that checks it
    // fails in a way that looks like a bug in the feature rather than a gap in the bundles.
    expect(orphans).toEqual([]);
  });

  it("grants nothing that is not defined", () => {
    const unknown: string[] = [];
    for (const [role, keys] of Object.entries(ROLE_PERMISSIONS)) {
      for (const key of keys) {
        if (!CAPABILITY_KEYS.has(key)) unknown.push(`${role} → ${key}`);
      }
    }
    // A typo grants nothing at all, and the only symptom is a screen that never appears.
    expect(unknown).toEqual([]);
  });

  it("defines no capability twice", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const { key } of ALL_PERMISSIONS) {
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
  });

  it("has a role for every bundle and a bundle for every role", () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(Object.keys(ROLES).sort());
  });

  it("seeds the catalogue into the database exactly as the code declares it", async () => {
    const rows = await db.execute<{ key: string }>(sql`SELECT key FROM auth.permission`);
    const seeded = new Set((rows.rows ?? []).map((row) => row.key));

    expect([...CAPABILITY_KEYS].filter((key) => !seeded.has(key))).toEqual([]);
    expect([...seeded].filter((key) => !CAPABILITY_KEYS.has(key))).toEqual([]);
  });

  it("gives each role the same capabilities in the database as in the code", async () => {
    for (const [role, keys] of Object.entries(ROLE_PERMISSIONS)) {
      const rows = await db.execute<{ key: string }>(sql`
        SELECT p.key FROM auth.role r
          JOIN auth.role_permission rp ON rp.role_id = r.id
          JOIN auth.permission p ON p.id = rp.permission_id
         WHERE r.key = ${role}
      `);
      const fromDatabase = new Set((rows.rows ?? []).map((row) => row.key));
      const expected = new Set(keys);
      expect([...expected].filter((key) => !fromDatabase.has(key)).sort()).toEqual([]);
      expect([...fromDatabase].filter((key) => !expected.has(key)).sort()).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
describe("separation of duties", () => {
  it("pairs every approver with the maker it checks", () => {
    const missing: string[] = [];

    // Any `x.approve` whose family also has an `x.create`, `x.generate`, `x.propose` or
    // `x.submit` is a maker/checker relationship, and it has to be declared rather than
    // remembered.
    for (const key of CAPABILITY_KEYS) {
      if (!key.endsWith(".approve")) continue;
      const stem = key.slice(0, -".approve".length);
      for (const verb of ["create", "generate", "propose", "submit"]) {
        const maker = `${stem}.${verb}`;
        if (CAPABILITY_KEYS.has(maker) && !isMakerCheckerPair(maker, key)) {
          missing.push(`${maker} → ${key}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("names both halves of every declared pair in the catalogue", () => {
    const unknown: string[] = [];
    for (const [maker, checker] of MAKER_CHECKER_PAIRS) {
      if (!CAPABILITY_KEYS.has(maker)) unknown.push(maker);
      if (!CAPABILITY_KEYS.has(checker)) unknown.push(checker);
    }
    expect(unknown).toEqual([]);
  });

  it("keeps the two legal approvals off every role but the reviewer and the director", () => {
    // Stated in docs/RBAC_MATRIX.md, and previously contradicted by the code.
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, keys]) => keys.includes("case.rule.approve") || keys.includes("case.document.approve"))
      .map(([role]) => role)
      .sort();

    expect(holders).toEqual(["DIRECTOR", "LAWYER_OR_AUTHORISED_REVIEWER"]);
  });

  it("keeps destroying an original with the director alone", () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, keys]) => keys.includes("doc.delete"))
      .map(([role]) => role);
    expect(holders).toEqual(["DIRECTOR"]);
  });
});

// ---------------------------------------------------------------------------
describe("roles that must not be able to write", () => {
  it("gives AUDITOR nothing that changes anything", async () => {
    const auditor = await makePrincipal("hd-auditor@cac.test", ["AUDITOR"]);
    const writes = [...auditor.capabilities].filter((key) => !isRead(key));
    expect(writes).toEqual([]);
  });

  it("gives READ_ONLY nothing that changes anything", async () => {
    const reader = await makePrincipal("hd-reader@cac.test", ["READ_ONLY"]);
    const writes = [...reader.capabilities].filter((key) => !isRead(key));
    expect(writes).toEqual([]);
  });

  it("does not make SUPER_ADMIN a business super-user", async () => {
    const admin = await makePrincipal("hd-admin@cac.test", ["SUPER_ADMIN"]);
    for (const forbidden of [
      "accounting.invoice.approve",
      "accounting.voucher.approve",
      "hr.payroll.post",
      "hr.payroll.approve",
      "case.document.approve",
      "case.rule.approve",
      "doc.delete",
    ]) {
      expect(admin.capabilities.has(forbidden)).toBe(false);
    }
    // What it does hold: administration and the audit trail.
    expect(admin.capabilities.has("admin.user.manage")).toBe(true);
    expect(admin.capabilities.has("audit.view")).toBe(true);
  });

  it("gives EMPLOYEE nothing beyond self-service", async () => {
    const employee = await makePrincipal("hd-employee@cac.test", ["EMPLOYEE"]);
    const beyond = [...employee.capabilities].filter(
      (key) =>
        !/_own$/.test(key) &&
        !/^hr\.(leave|overtime|timeoff|attendance)\./.test(key) &&
        !/^accounting\.claim\.(create|view)$/.test(key),
    );
    expect(beyond).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("overrides", () => {
  it("lets a direct deny beat a role grant", async () => {
    const accountant = await makePrincipal("hd-accountant@cac.test", ["ACCOUNTANT"]);
    expect(accountant.capabilities.has("accounting.journal.post")).toBe(true);

    await db.execute(sql`
      INSERT INTO auth.user_permission (user_id, permission_id, effect)
      SELECT ${accountant.userId}, id, 'deny' FROM auth.permission
       WHERE key = 'accounting.journal.post'
    `);

    const after = await resolveCapabilities(db, accountant.userId);
    // Deny wins unconditionally: that is what makes it possible to take one capability from one
    // person without unpicking their roles, which is what actually happens when duties change.
    expect(after.has("accounting.journal.post")).toBe(false);
    expect(after.has("accounting.journal.view")).toBe(true);
  });

  it("lets a direct allow add one capability without a role", async () => {
    const executive = await makePrincipal("hd-exec@cac.test", ["ACCOUNTS_EXECUTIVE"]);
    expect(executive.capabilities.has("accounting.report.export")).toBe(false);

    await db.execute(sql`
      INSERT INTO auth.user_permission (user_id, permission_id, effect)
      SELECT ${executive.userId}, id, 'allow' FROM auth.permission
       WHERE key = 'accounting.report.export'
    `);

    const after = await resolveCapabilities(db, executive.userId);
    expect(after.has("accounting.report.export")).toBe(true);
  });

  it("takes effect as soon as a role is revoked", async () => {
    const manager = await makePrincipal("hd-manager@cac.test", ["CASE_MANAGER"]);
    expect(manager.capabilities.has("case.edit")).toBe(true);

    await db.execute(sql`
      DELETE FROM auth.user_role
       WHERE user_id = ${manager.userId}
         AND role_id = (SELECT id FROM auth.role WHERE key = 'CASE_MANAGER')
    `);

    // Capabilities are resolved per request, not cached on the session, so revoking a role is
    // effective immediately rather than at the next sign-in.
    const after = await resolveCapabilities(db, manager.userId);
    expect(after.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("the guards that do not depend on the application", () => {
  it("refuses to amend or remove an audit row, even for its own writer", async () => {
    await db.execute(sql`
      INSERT INTO audit.event (action, entity_type, actor_label)
      VALUES ('HARDENING_PROBE', 'system', 'the hardening test')
    `);
    await expect(
      db.execute(sql`UPDATE audit.event SET action = 'TAMPERED' WHERE action = 'HARDENING_PROBE'`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`DELETE FROM audit.event WHERE action = 'HARDENING_PROBE'`),
    ).rejects.toThrow();
  });

  it("has an append-only trail in every module that keeps one", async () => {
    // Each of these is a record somebody might want to revise after the fact, and each one
    // refuses at the database rather than relying on no code path existing.
    const appendOnly = [
      { table: "audit.event", column: "action" },
      { table: "estate.case_event", column: "summary" },
      { table: "library.ingestion_event", column: "detail" },
      { table: "hr.employment_event", column: "notes" },
    ];

    for (const { table, column } of appendOnly) {
      const exists = await db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM information_schema.triggers
         WHERE event_object_schema = ${table.split(".")[0]}
           AND event_object_table = ${table.split(".")[1]}
           AND event_manipulation = 'UPDATE'
      `);
      expect(
        Number(exists.rows![0].n),
        `${table} has no UPDATE trigger, so ${column} can be rewritten`,
      ).toBeGreaterThan(0);
    }
  });

  it("holds every schema the application expects", async () => {
    const rows = await db.execute<{ schema_name: string }>(sql`
      SELECT schema_name FROM information_schema.schemata
    `);
    const schemas = new Set((rows.rows ?? []).map((row) => row.schema_name));
    for (const expected of ["auth", "audit", "org", "accounting", "hr", "estate", "library"]) {
      expect(schemas.has(expected), `${expected} is missing`).toBe(true);
    }
  });

  it("applied every migration, in order, with no gaps", async () => {
    const rows = await db.execute<{ name: string }>(
      sql`SELECT name FROM public.__migration ORDER BY name`,
    );
    const names = (rows.rows ?? []).map((row) => row.name);
    expect(names.length).toBeGreaterThan(20);

    // The numbering is the order they must run in; a gap means a file was deleted or renamed
    // after it had been applied somewhere.
    const numbers = names.map((name) => Number(name.slice(0, 4)));
    for (let index = 0; index < numbers.length; index += 1) {
      expect(numbers[index], `migration numbering jumps at ${names[index]}`).toBe(index);
    }
  });
});

describe("what reaches the audit trail", () => {
  it("takes an identification number out of a free-text reason", () => {
    // `redact()` works on property names, and a reason has none. The only mandatory reason in the
    // platform is the one for resetting somebody's MFA, typed while an administrator is looking at
    // an identity document — and it went into an append-only table untouched.
    expect(redactFreeText("Lost phone, verified against NRIC 860101-14-5566")).toBe(
      "Lost phone, verified against NRIC [identification number removed]",
    );
    expect(redactFreeText("Refund to account 1234 5678 9012")).toBe(
      "Refund to account [number removed]",
    );
  });

  it("leaves an ordinary sentence alone, including the figures in it", () => {
    // Deliberately narrow. A reason exists to be read by whoever reviews the trail later, and a
    // filter that mangled ordinary sentences would make people write less rather than less
    // sensitive.
    const reason = "Corrected on 4 June 2026 after the client called; invoice 2026-114 for RM 4,500.";
    expect(redactFreeText(reason)).toBe(reason);
  });
});
