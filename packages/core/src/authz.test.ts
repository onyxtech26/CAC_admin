import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import {
  AuthorizationError,
  can,
  requireCapability,
  requireDifferentApprover,
  requireEmployeeScope,
  resolveCapabilities,
  type Principal,
} from "./authz.js";
import { redact } from "./audit.js";
import { hashPassword } from "./password.js";

let db: Database;
let close: () => Promise<void>;

async function makeUser(email: string, roles: string[], employeeId?: string): Promise<string> {
  const hash = await hashPassword("correct-horse-battery-staple");
  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO auth."user" (email, password_hash, full_name, employee_id)
    VALUES (${email}, ${hash}, ${email}, ${employeeId ?? null})
    RETURNING id
  `);
  const id = created.rows![0]!.id;
  for (const role of roles) {
    await db.execute(sql`
      INSERT INTO auth.user_role (user_id, role_id)
      SELECT ${id}, id FROM auth.role WHERE key = ${role}
    `);
  }
  return id;
}

async function principalFor(userId: string, overrides: Partial<Principal> = {}): Promise<Principal> {
  return {
    userId,
    email: "test@example.com",
    fullName: "Test",
    roles: [],
    capabilities: await resolveCapabilities(db, userId),
    employeeId: null,
    sessionId: "00000000-0000-0000-0000-000000000000",
    mfaSatisfied: true,
    mustChangePassword: false,
    mustEnrolMfa: false,
    ...overrides,
  };
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  await runMigrations(db);
  await seed(db);
}, 60_000);

afterAll(async () => {
  await close();
});

describe("capability resolution", () => {
  it("gives an accountant the ledger, and withholds it from an executive", async () => {
    const accountant = await principalFor(await makeUser("acct@cac.test", ["ACCOUNTANT"]));
    const executive = await principalFor(await makeUser("ae@cac.test", ["ACCOUNTS_EXECUTIVE"]));

    expect(can(accountant, "accounting.journal.post")).toBe(true);
    expect(can(accountant, "accounting.period.close")).toBe(true);

    // An executive prepares documents but must not post or approve.
    expect(can(executive, "accounting.invoice.create")).toBe(true);
    expect(can(executive, "accounting.journal.post")).toBe(false);
    expect(can(executive, "accounting.invoice.approve")).toBe(false);
  });

  it("unions capabilities across several roles", async () => {
    const both = await principalFor(await makeUser("both@cac.test", ["ACCOUNTS_EXECUTIVE", "HR_ADMIN"]));
    expect(can(both, "accounting.invoice.create")).toBe(true);
    expect(can(both, "hr.attendance.import")).toBe(true);
  });

  it("lets a direct deny override a role grant", async () => {
    const userId = await makeUser("denied@cac.test", ["ACCOUNTANT"]);
    expect(can(await principalFor(userId), "accounting.journal.post")).toBe(true);

    await db.execute(sql`
      INSERT INTO auth.user_permission (user_id, permission_id, effect, reason)
      SELECT ${userId}, id, 'deny', 'Under review'
      FROM auth.permission WHERE key = 'accounting.journal.post'
    `);

    expect(can(await principalFor(userId), "accounting.journal.post")).toBe(false);
    // Only the denied capability is affected.
    expect(can(await principalFor(userId), "accounting.period.close")).toBe(true);
  });

  it("does not make SUPER_ADMIN a business super-user", async () => {
    const admin = await principalFor(await makeUser("root@cac.test", ["SUPER_ADMIN"]));
    expect(can(admin, "admin.user.manage")).toBe(true);
    // Administering the platform is not the same as running the business.
    expect(can(admin, "accounting.invoice.approve")).toBe(false);
    expect(can(admin, "hr.payroll.finalise")).toBe(false);
    expect(can(admin, "case.document.approve")).toBe(false);
  });

  it("keeps AUDITOR strictly read-only", async () => {
    const auditor = await principalFor(await makeUser("auditor@cac.test", ["AUDITOR"]));
    expect(can(auditor, "audit.view")).toBe(true);
    expect(can(auditor, "accounting.report.view")).toBe(true);

    const writes = [...auditor.capabilities].filter((c) =>
      /\.(create|edit|approve|post|delete|finalise|issue|void|manage|import|reverse|close)$/.test(c),
    );
    expect(writes).toEqual([]);
  });

  it("gives an employee nothing beyond self-service", async () => {
    const employee = await principalFor(await makeUser("staff@cac.test", ["EMPLOYEE"]));
    expect(can(employee, "hr.payslip.view_own")).toBe(true);
    expect(can(employee, "hr.payslip.view_all")).toBe(false);
    expect(can(employee, "hr.employee.view_sensitive")).toBe(false);
    expect(can(employee, "accounting.invoice.view")).toBe(false);
    expect(can(employee, "case.view")).toBe(false);
  });
});

describe("requireCapability", () => {
  it("throws for a capability the principal lacks", async () => {
    const employee = await principalFor(await makeUser("emp2@cac.test", ["EMPLOYEE"]));
    expect(() => requireCapability(employee, "accounting.journal.post")).toThrow(AuthorizationError);
  });

  it("refuses everything until MFA is satisfied", async () => {
    const accountant = await principalFor(await makeUser("acct2@cac.test", ["ACCOUNTANT"]), {
      mfaSatisfied: false,
    });
    // The capability is held, but the session is only half authenticated.
    expect(can(accountant, "accounting.journal.post")).toBe(true);
    expect(() => requireCapability(accountant, "accounting.journal.post")).toThrow(
      /Multi-factor/,
    );
  });
});

describe("maker/checker", () => {
  it("stops the creator approving their own document", async () => {
    const userId = await makeUser("maker@cac.test", ["DIRECTOR"]);
    const principal = await principalFor(userId);

    expect(() =>
      requireDifferentApprover({ principal, createdByUserId: userId, action: "approve this invoice" }),
    ).toThrow(/cannot approve this invoice something you created|cannot approve/i);

    // Someone else's document is fine.
    expect(() =>
      requireDifferentApprover({
        principal,
        createdByUserId: "11111111-1111-1111-1111-111111111111",
        action: "approve this invoice",
      }),
    ).not.toThrow();
  });
});

describe("own-record scope", () => {
  // Real employee rows rather than invented uuids: `auth.user.employee_id` has been
  // a foreign key since Phase 5, and a fixture that fabricates an id is a fixture
  // that stops proving anything the moment the schema is honest about the link.
  let EMP_A: string;
  let EMP_B: string;

  beforeAll(async () => {
    const author = await makeUser("scope-fixture@cac.test", ["HR_MANAGER"]);
    const created = await db.execute<{ id: string }>(sql`
      INSERT INTO hr.employee (employee_no, full_name, joined_on, created_by)
      VALUES ('EMP-SCOPE-A', 'Scope A', '2026-01-01', ${author}),
             ('EMP-SCOPE-B', 'Scope B', '2026-01-01', ${author})
      RETURNING id
    `);
    EMP_A = created.rows![0]!.id;
    EMP_B = created.rows![1]!.id;
  });

  it("lets an employee see only their own payslip", async () => {
    const employee = await principalFor(await makeUser("scoped@cac.test", ["EMPLOYEE"], EMP_A), {
      employeeId: EMP_A,
    });

    expect(() =>
      requireEmployeeScope({
        principal: employee,
        targetEmployeeId: EMP_A,
        viewAllCapability: "hr.payslip.view_all",
        viewOwnCapability: "hr.payslip.view_own",
      }),
    ).not.toThrow();

    // Changing the id in the URL must not work.
    expect(() =>
      requireEmployeeScope({
        principal: employee,
        targetEmployeeId: EMP_B,
        viewAllCapability: "hr.payslip.view_all",
        viewOwnCapability: "hr.payslip.view_own",
      }),
    ).toThrow(/only view your own/);
  });

  it("lets HR see anyone's", async () => {
    const hr = await principalFor(await makeUser("hr@cac.test", ["HR_MANAGER"], EMP_A), {
      employeeId: EMP_A,
    });
    expect(() =>
      requireEmployeeScope({
        principal: hr,
        targetEmployeeId: EMP_B,
        viewAllCapability: "hr.payslip.view_all",
        viewOwnCapability: "hr.payslip.view_own",
      }),
    ).not.toThrow();
  });
});

describe("audit redaction", () => {
  it("removes secrets and masks personal data at any depth", () => {
    const result = redact({
      email: "person@cac.test",
      password: "hunter2",
      password_hash: "$argon2id$...",
      token: "abc",
      employee: {
        nric: "901231-14-5678",
        bank_account: "1234567890",
        basic_salary: 8500,
        name: "Keep me",
      },
      list: [{ secret: "s3cr3t" }, { keep: "yes" }],
    }) as Record<string, any>;

    expect(result.password).toBe("[redacted]");
    expect(result.password_hash).toBe("[redacted]");
    expect(result.token).toBe("[redacted]");
    expect(result.list[0].secret).toBe("[redacted]");

    // Masked, not removed: the fact of a change is auditable, the value is not.
    expect(result.employee.nric).toBe("**********5678");
    expect(result.employee.bank_account).toBe("******7890");
    expect(result.employee.basic_salary).toBe("***");

    // Everything else survives untouched.
    expect(result.email).toBe("person@cac.test");
    expect(result.employee.name).toBe("Keep me");
    expect(result.list[1].keep).toBe("yes");
  });

  it("does not loop on circular structures", () => {
    const node: Record<string, unknown> = { name: "a" };
    node.self = node;
    expect(() => redact(node)).not.toThrow();
  });
});
