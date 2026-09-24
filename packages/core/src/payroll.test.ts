import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import { hashPassword } from "./password.js";
import { AuthorizationError, resolveCapabilities, type Principal } from "./authz.js";

import { formatAmount, parseAmount } from "./money.js";
import { createFiscalYear } from "./periods.js";
import { trialBalance } from "./ledger.js";
import { createDepartment, createEmployee, createWorkSchedule, recordEmploymentEvent } from "./people.js";
import {
  StatutoryRulesMissingError,
  applyRule,
  approveRuleVersion,
  bandFor,
  listRuleVersions,
  ruleInForce,
  rulesAvailableFor,
  saveRuleVersion,
  validateStatutoryTable,
  type RuleVersion,
} from "./statutory.js";
import {
  abandonPayrollRun,
  approvePayrollRun,
  createPayrollRun,
  finalisePayrollRun,
  getPayrollRun,
  getPayslip,
  listPayslips,
  postPayrollRun,
  preparePayrollRun,
  reversePayrollPosting,
  statutorySummary,
} from "./payroll.js";

/**
 * Phase 7: payroll.
 *
 * The exit criterion is reproducibility, and it is the last thing proven here:
 * re-running a past period after the rates change produces the same answer.
 *
 * Before that, the more important property: **payroll refuses to run without the
 * statutory rules.** They are contribution schedules rather than percentages, they
 * are not authored anywhere in this repository, and the refusal names what is missing.
 * The rule tables used in these tests are deliberately **fictional round numbers**
 * with a source that says so — they exercise the machinery without any of them being
 * presented as Malaysian law.
 */

let db: Database;
let close: () => Promise<void>;

let hrManager: Principal; // prepares, and enters statutory rules
let director: Principal; // approves rules and runs
let accountant: Principal; // posts to the ledger
let employeeUser: Principal; // sees their own payslip and nothing else

let aishahId: string;
let faizalId: string;

async function makePrincipal(
  email: string,
  roles: string[],
  employeeId?: string,
): Promise<Principal> {
  const hash = await hashPassword("correct-horse-battery-staple");
  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO auth."user" (email, password_hash, full_name, employee_id)
    VALUES (${email}, ${hash}, ${email}, ${employeeId ?? null}) RETURNING id
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
    employeeId: employeeId ?? null,
    sessionId: "00000000-0000-0000-0000-000000000000",
    mfaSatisfied: true,
    mustChangePassword: false,
  };
}

/**
 * Fictional rule tables.
 *
 * Round numbers, and every `sourceRef` says they are invented. They exist to exercise
 * the engine — band lookup, rounding, employee versus employer shares, reproducibility
 * across versions — and not one of them should be mistaken for a real Malaysian rate.
 */
const FIXTURE_SOURCE = "TEST FIXTURE — invented figures, not a real statutory table";

const epfEmployee = {
  bands: [
    { wageFrom: "0", wageTo: "5000", ratePercent: "10", ageFrom: 0, ageTo: 59 },
    { wageFrom: "5000", wageTo: null, ratePercent: "10", ageFrom: 0, ageTo: 59 },
  ],
  roundTo: "1.00",
};

const epfEmployer = {
  bands: [
    { wageFrom: "0", wageTo: "5000", ratePercent: "12", ageFrom: 0, ageTo: 59 },
    { wageFrom: "5000", wageTo: null, ratePercent: "12", ageFrom: 0, ageTo: 59 },
  ],
  roundTo: "1.00",
};

/** A contribution table: the amounts are read, not computed. */
const socso = {
  bands: [
    { wageFrom: "0", wageTo: "3000", employee: "10.00", employer: "35.00" },
    { wageFrom: "3000", wageTo: null, employee: "20.00", employer: "70.00" },
  ],
};

const eis = {
  bands: [
    { wageFrom: "0", wageTo: "3000", employee: "5.00", employer: "5.00" },
    { wageFrom: "3000", wageTo: null, employee: "8.00", employer: "8.00" },
  ],
};

const pcb = {
  bands: [
    { wageFrom: "0", wageTo: "4000", ratePercent: "0" },
    { wageFrom: "4000", wageTo: null, ratePercent: "2" },
  ],
  roundTo: "0.01",
};

async function approveRule(kind: string, table: unknown, effectiveFrom: string): Promise<string> {
  const created = await saveRuleVersion(db, hrManager, {
    kind: kind as "epf_employee",
    effectiveFrom,
    sourceRef: FIXTURE_SOURCE,
    table,
  });
  await approveRuleVersion(db, director, created.id);
  return created.id;
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  await runMigrations(db);
  await seed(db);

  hrManager = await makePrincipal("pr-hr@cac.test", ["HR_MANAGER", "HR_ADMIN"]);
  director = await makePrincipal("pr-director@cac.test", ["DIRECTOR"]);
  accountant = await makePrincipal("pr-accountant@cac.test", ["ACCOUNTANT"]);

  await createFiscalYear(db, director, { startsOn: "2026-01-01" });

  const departmentId = (await createDepartment(db, hrManager, { code: "OPS", name: "Operations" }))
    .id;

  await createWorkSchedule(db, hrManager, {
    code: "STD",
    name: "Standard week",
    workDays: [1, 2, 3, 4, 5],
    startsAt: "09:00",
    endsAt: "18:00",
    isDefault: true,
  });

  aishahId = (
    await createEmployee(db, hrManager, {
      fullName: "Aishah binti Rahman",
      joinedOn: "2026-01-01",
      dateOfBirth: "1990-04-12",
      departmentId,
      basicSalary: "4500.00",
      bankName: "Maybank",
      bankAccountNo: "1142889933",
    })
  ).id;

  faizalId = (
    await createEmployee(db, hrManager, {
      fullName: "Faizal bin Omar",
      joinedOn: "2026-01-01",
      dateOfBirth: "1985-02-28",
      departmentId,
      basicSalary: "8000.00",
      // Exempt from everything, to prove the engine only demands the rules it needs.
      epfApplicable: false,
      socsoApplicable: false,
      eisApplicable: false,
      pcbApplicable: false,
    })
  ).id;

  employeeUser = await makePrincipal("pr-aishah@cac.test", ["EMPLOYEE"], aishahId);
}, 120_000);

afterAll(async () => {
  await close();
});

// ---------------------------------------------------------------------------
describe("the statutory rules, as data", () => {
  it("insists on a citation", async () => {
    await expect(
      saveRuleVersion(db, hrManager, {
        kind: "epf_employee",
        effectiveFrom: "2026-01-01",
        sourceRef: "",
        table: epfEmployee,
      }),
    ).rejects.toThrow(/Say where this comes from/);
  });

  it("refuses a table whose first band does not start at nil", () => {
    expect(() =>
      validateStatutoryTable("socso", {
        bands: [{ wageFrom: "100", wageTo: null, employee: "1", employer: "1" }],
      }),
    ).toThrow(/start at 0/);
  });

  it("refuses a table whose last band is closed", () => {
    expect(() =>
      validateStatutoryTable("socso", {
        bands: [{ wageFrom: "0", wageTo: "3000", employee: "1", employer: "1" }],
      }),
    ).toThrow(/open-ended/);
  });

  it("refuses non-contiguous bands, because some wage would fall between them", () => {
    expect(() =>
      validateStatutoryTable("socso", {
        bands: [
          { wageFrom: "0", wageTo: "1000", employee: "1", employer: "1" },
          { wageFrom: "5000", wageTo: null, employee: "2", employer: "2" },
        ],
      }),
    ).toThrow(/contiguous/);
  });

  it("is not something an accountant may enter", async () => {
    await expect(
      saveRuleVersion(db, accountant, {
        kind: "socso",
        effectiveFrom: "2026-01-01",
        sourceRef: FIXTURE_SOURCE,
        table: socso,
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("needs a second person to approve it", async () => {
    const created = await saveRuleVersion(db, hrManager, {
      kind: "hrd_levy",
      effectiveFrom: "2026-01-01",
      sourceRef: FIXTURE_SOURCE,
      table: { ratePercent: "1" },
    });

    // The person who entered a statutory table is not the person who confirms it.
    await expect(approveRuleVersion(db, hrManager, created.id)).rejects.toThrow(
      /cannot approve/i,
    );

    await approveRuleVersion(db, director, created.id);
    const versions = await listRuleVersions(db, { kind: "hrd_levy" });
    expect(versions[0]!.status).toBe("approved");
  });

  it("will not let an approved rule be edited", async () => {
    const versions = await listRuleVersions(db, { kind: "hrd_levy" });
    const id = versions[0]!.id;

    await expect(
      saveRuleVersion(db, hrManager, {
        ruleId: id,
        kind: "hrd_levy",
        effectiveFrom: "2026-01-01",
        sourceRef: FIXTURE_SOURCE,
        table: { ratePercent: "9" },
      }),
    ).rejects.toThrow(/cannot be edited/);

    // And not at the database level either, which is what makes reproducibility a
    // property rather than a promise.
    await expect(
      db.execute(
        sql`UPDATE hr.statutory_rule_version SET table_data = '{"ratePercent":"9"}'::jsonb WHERE id = ${id}`,
      ),
    ).rejects.toThrow(/do not change once approved/);
  });

  it("reads a contribution table rather than computing it", () => {
    const rule: RuleVersion = {
      id: "r",
      kind: "socso",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      sourceRef: FIXTURE_SOURCE,
      sourceUrl: null,
      table: socso,
      status: "approved",
      notes: null,
      approvedByName: null,
      approvedAt: null,
      createdByName: null,
    };

    const low = applyRule(rule, parseAmount("2500.00"));
    // 10.00 and 35.00 because the band says so, not because 2,500 was multiplied.
    expect(formatAmount(low.employee)).toBe("10.00");
    expect(formatAmount(low.employer)).toBe("35.00");
    expect(low.basis).toContain("contribution table band");

    const high = applyRule(rule, parseAmount("9000.00"));
    expect(formatAmount(high.employee)).toBe("20.00");
  });

  it("rounds an EPF share up to the next ringgit, as the scheme requires", () => {
    const rule: RuleVersion = {
      id: "r",
      kind: "epf_employee",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      sourceRef: FIXTURE_SOURCE,
      sourceUrl: null,
      table: epfEmployee,
      status: "approved",
      notes: null,
      approvedByName: null,
      approvedAt: null,
      createdByName: null,
    };

    // 10% of 4,505 is 450.50, which rounds up to 451 — not to 450.
    const result = applyRule(rule, parseAmount("4505.00"), { age: 35 });
    expect(formatAmount(result.employee)).toBe("451.00");
  });

  it("finds the band a wage falls in, including on a boundary", () => {
    expect(bandFor(socso.bands, parseAmount("3000.00"))?.employee).toBe("10.00");
    expect(bandFor(socso.bands, parseAmount("3000.01"))?.employee).toBe("20.00");
    expect(bandFor(socso.bands, parseAmount("0"))?.employee).toBe("10.00");
  });

  it("reports which rules are and are not available for a date", async () => {
    const available = await rulesAvailableFor(db, "2026-03-31");
    const epf = available.find((row) => row.kind === "epf_employee")!;
    const levy = available.find((row) => row.kind === "hrd_levy")!;

    expect(epf.rule).toBeNull();
    expect(levy.rule).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("payroll refuses to guess", () => {
  let runId: string;

  it("creates a run", async () => {
    runId = (
      await createPayrollRun(db, hrManager, {
        periodFrom: "2026-03-01",
        periodTo: "2026-03-31",
        payDate: "2026-03-31",
      })
    ).id;

    const run = await getPayrollRun(db, runId);
    expect(run?.status).toBe("draft");
  });

  it("refuses to compute without the statutory rules, and names what is missing", async () => {
    // This is the honest boundary of the phase while Q-HR-1 is open.
    await expect(preparePayrollRun(db, hrManager, runId)).rejects.toThrow(
      StatutoryRulesMissingError,
    );

    await expect(preparePayrollRun(db, hrManager, runId)).rejects.toThrow(/Q-HR-1/);
    await expect(preparePayrollRun(db, hrManager, runId)).rejects.toThrow(/EPF/);
  });

  it("refuses a second regular run for the same period", async () => {
    await expect(
      createPayrollRun(db, hrManager, {
        periodFrom: "2026-03-01",
        periodTo: "2026-03-31",
        payDate: "2026-03-31",
      }),
    ).rejects.toThrow(/would pay the month twice/);
  });

  it("is not something an ordinary employee may create", async () => {
    await expect(
      createPayrollRun(db, employeeUser, {
        periodFrom: "2026-04-01",
        periodTo: "2026-04-30",
        payDate: "2026-04-30",
      }),
    ).rejects.toThrow(AuthorizationError);
  });
});

// ---------------------------------------------------------------------------
describe("a run, once the rules exist", () => {
  let runId: string;
  let marchEpfEmployeeRuleId: string;

  beforeAll(async () => {
    marchEpfEmployeeRuleId = await approveRule("epf_employee", epfEmployee, "2026-01-01");
    await approveRule("epf_employer", epfEmployer, "2026-01-01");
    await approveRule("socso", socso, "2026-01-01");
    await approveRule("eis", eis, "2026-01-01");
    await approveRule("pcb", pcb, "2026-01-01");

    const existing = await db.execute<{ id: string }>(
      sql`SELECT id FROM hr.payroll_run WHERE period_from = '2026-03-01'`,
    );
    runId = existing.rows![0]!.id;
  });

  it("computes every figure, and each names the rule that produced it", async () => {
    const result = await preparePayrollRun(db, hrManager, runId);

    expect(result.runNo).toMatch(/^PR-2026-/);
    expect(result.payslips).toBe(2);
    expect(result.problems).toHaveLength(0);

    const payslips = await listPayslips(db, { runId });
    const aishah = payslips.find((row) => row.employeeId === aishahId)!;

    // 4,500 gross. EPF 10% = 450. SOCSO 20, EIS 8, PCB 2% of 4,500 = 90.
    expect(formatAmount(aishah.grossPay)).toBe("4,500.00");
    expect(formatAmount(aishah.totalDeductions)).toBe("568.00");
    expect(formatAmount(aishah.netPay)).toBe("3,932.00");
    // Employer: EPF 12% = 540, SOCSO 70, EIS 8.
    expect(formatAmount(aishah.employerCost)).toBe("618.00");
  });

  it("demands only the rules the run needs", async () => {
    // Faizal is exempt from everything, so his payslip is basic pay and nothing else.
    const payslips = await listPayslips(db, { runId });
    const faizal = payslips.find((row) => row.employeeId === faizalId)!;

    expect(formatAmount(faizal.grossPay)).toBe("8,000.00");
    expect(formatAmount(faizal.totalDeductions)).toBe("0.00");
    expect(formatAmount(faizal.netPay)).toBe("8,000.00");
  });

  it("explains each line in words, with the source", async () => {
    const payslips = await listPayslips(db, { runId });
    const aishah = payslips.find((row) => row.employeeId === aishahId)!;

    const full = await getPayslip(db, hrManager, aishah.id);
    const epf = full!.lines.find((line) => line.code === "EPF")!;

    expect(epf.basis).toBe("10% of 4500.00");
    expect(epf.statutoryRuleId).toBe(marchEpfEmployeeRuleId);
    expect(epf.statutorySource).toContain("TEST FIXTURE");

    const socsoLine = full!.lines.find((line) => line.code === "SOCSO")!;
    // The wording matters: it says which band, because there is no calculation.
    expect(socsoLine.basis).toContain("contribution table band");
  });

  it("needs a second person to approve it", async () => {
    await expect(approvePayrollRun(db, hrManager, runId)).rejects.toThrow(/cannot approve/i);
    await approvePayrollRun(db, director, runId);

    const run = await getPayrollRun(db, runId);
    expect(run?.status).toBe("approved");
    expect(run?.approvedByName).toBe("pr-director@cac.test");
  });

  it("finalises, and the payslips become documents", async () => {
    await finalisePayrollRun(db, director, runId);

    const run = await getPayrollRun(db, runId);
    expect(run?.status).toBe("finalised");

    const payslips = await listPayslips(db, { runId });
    await expect(
      db.execute(sql`UPDATE hr.payslip SET net_pay = 1 WHERE id = ${payslips[0]!.id}`),
    ).rejects.toThrow(/finalised run/);

    await expect(
      db.execute(sql`DELETE FROM hr.payslip_line WHERE payslip_id = ${payslips[0]!.id}`),
    ).rejects.toThrow(/finalised run/);
  });

  it("posts to the ledger, balanced, with net pay owed to staff", async () => {
    const before = await trialBalance(db, { to: "2026-12-31" });

    const posted = await postPayrollRun(db, accountant, runId);
    expect(posted.journalNo).toMatch(/^JV-2026-/);

    const after = await trialBalance(db, { to: "2026-12-31" });
    expect(after.totalDebit).toBe(after.totalCredit);
    expect(after.totalDebit).toBeGreaterThan(before.totalDebit);

    // Net pay is owed to staff, not taken from the bank: paying it is a separate act.
    const payable = after.rows.find((row) => row.code === "2150");
    expect(formatAmount(payable!.credit)).toBe("11,932.00");

    // And the statutory deductions are owed to the agencies.
    const epfPayable = after.rows.find((row) => row.code === "2141");
    expect(formatAmount(epfPayable!.credit)).toBe("990.00");
  });

  it("will not post twice", async () => {
    await expect(postPayrollRun(db, accountant, runId)).rejects.toThrow(/already been posted/);
  });

  it("will not let a posted run be reopened", async () => {
    await expect(
      db.execute(sql`UPDATE hr.payroll_run SET status = 'draft' WHERE id = ${runId}`),
    ).rejects.toThrow(/cannot be moved back/);
  });

  it("reverses the posting without disturbing the payslips", async () => {
    const reversal = await reversePayrollPosting(
      db,
      accountant,
      runId,
      "Posted to the wrong period",
    );
    expect(reversal.journalNo).toMatch(/^JV-2026-/);

    const run = await getPayrollRun(db, runId);
    // Back to finalised: the accounting was reversed, the payroll was not undone.
    expect(run?.status).toBe("finalised");
    expect(run?.journalId).toBeNull();

    const payslips = await listPayslips(db, { runId });
    expect(formatAmount(payslips.find((row) => row.employeeId === aishahId)!.netPay)).toBe(
      "3,932.00",
    );

    const after = await trialBalance(db, { to: "2026-12-31" });
    expect(after.totalDebit).toBe(after.totalCredit);

    await postPayrollRun(db, accountant, runId);
  });
});

// ---------------------------------------------------------------------------
describe("reproducibility — the point of the whole phase", () => {
  it("re-runs a past period with its own rules after the rates change", async () => {
    // April: the EPF employee rate changes, and so does the salary.
    await approveRule("epf_employee", {
      bands: [
        { wageFrom: "0", wageTo: "5000", ratePercent: "20", ageFrom: 0, ageTo: 59 },
        { wageFrom: "5000", wageTo: null, ratePercent: "20", ageFrom: 0, ageTo: 59 },
      ],
      roundTo: "1.00",
    }, "2026-04-01");

    await recordEmploymentEvent(db, hrManager, aishahId, {
      kind: "salary_changed",
      effectiveFrom: "2026-04-01",
      basicSalary: "6000.00",
      reason: "Annual review",
    });

    // March's rule is still March's.
    const marchRule = await ruleInForce(db, "epf_employee", "2026-03-31");
    const aprilRule = await ruleInForce(db, "epf_employee", "2026-04-30");
    expect(marchRule!.id).not.toBe(aprilRule!.id);
    expect((marchRule!.table as { bands: Array<{ ratePercent: string }> }).bands[0]!.ratePercent).toBe("10");
    expect((aprilRule!.table as { bands: Array<{ ratePercent: string }> }).bands[0]!.ratePercent).toBe("20");

    // Now re-prepare March. A supplementary run is the honest way to recompute a
    // finalised period, and it must produce March's figures — not today's.
    const marchRun = (
      await db.execute<{ id: string }>(
        sql`SELECT id FROM hr.payroll_run WHERE period_from = '2026-03-01' AND kind = 'regular'`,
      )
    ).rows![0]!.id;

    const rerun = await createPayrollRun(db, hrManager, {
      periodFrom: "2026-03-01",
      periodTo: "2026-03-31",
      payDate: "2026-03-31",
      kind: "supplementary",
      correctsRunId: marchRun,
      notes: "Recomputation, to prove the figures are reproducible",
    });

    await preparePayrollRun(db, hrManager, rerun.id);

    const payslips = await listPayslips(db, { runId: rerun.id });
    const aishah = payslips.find((row) => row.employeeId === aishahId)!;

    // The whole exit criterion, in three assertions: March's salary, March's EPF
    // rate, and therefore March's figures — after both changed.
    expect(formatAmount(aishah.basicSalary)).toBe("4,500.00");
    expect(formatAmount(aishah.grossPay)).toBe("4,500.00");
    expect(formatAmount(aishah.netPay)).toBe("3,932.00");

    const full = await getPayslip(db, hrManager, aishah.id);
    expect(full!.lines.find((line) => line.code === "EPF")!.basis).toBe("10% of 4500.00");
  });

  it("uses the new rate for April, from the same code path", async () => {
    const aprilRun = await createPayrollRun(db, hrManager, {
      periodFrom: "2026-04-01",
      periodTo: "2026-04-30",
      payDate: "2026-04-30",
    });

    await preparePayrollRun(db, hrManager, aprilRun.id);

    const payslips = await listPayslips(db, { runId: aprilRun.id });
    const aishah = payslips.find((row) => row.employeeId === aishahId)!;

    // 6,000 at 20% = 1,200 EPF; SOCSO 20, EIS 8, PCB 2% of 6,000 = 120.
    expect(formatAmount(aishah.basicSalary)).toBe("6,000.00");
    expect(formatAmount(aishah.totalDeductions)).toBe("1,348.00");
    expect(formatAmount(aishah.netPay)).toBe("4,652.00");

    await abandonPayrollRun(db, hrManager, aprilRun.id, "Test fixture, not a real run");
  });
});

// ---------------------------------------------------------------------------
describe("payslips are private", () => {
  it("lets somebody see their own", async () => {
    const payslips = await listPayslips(db, { employeeId: aishahId });
    const payslip = await getPayslip(db, employeeUser, payslips[0]!.id);
    expect(payslip?.employeeName).toBe("Aishah binti Rahman");
  });

  it("refuses somebody else's, however the id is obtained", async () => {
    const theirs = await listPayslips(db, { employeeId: faizalId });
    // Changing the id in the URL does not work: the scope is checked against the
    // session's own employee record.
    await expect(getPayslip(db, employeeUser, theirs[0]!.id)).rejects.toThrow(
      /only view your own/,
    );
  });

  it("lets HR see anybody's", async () => {
    const theirs = await listPayslips(db, { employeeId: faizalId });
    const payslip = await getPayslip(db, hrManager, theirs[0]!.id);
    expect(payslip?.employeeName).toBe("Faizal bin Omar");
  });
});

// ---------------------------------------------------------------------------
describe("the statutory return", () => {
  it("totals what is owed per agency, from finalised runs only, and cites its sources", async () => {
    const summary = await statutorySummary(db, { from: "2026-01-01", to: "2026-12-31" });

    const epfEmployeeTotal = summary.find((row) => row.kind === "epf_employee")!;
    expect(formatAmount(epfEmployeeTotal.employeeTotal)).toBe("450.00");
    expect(epfEmployeeTotal.sources[0]).toContain("TEST FIXTURE");

    const socsoTotal = summary.find((row) => row.kind === "socso")!;
    // Employee and employer shares both, because a return needs the pair.
    expect(formatAmount(socsoTotal.employeeTotal)).toBe("20.00");
    expect(formatAmount(socsoTotal.employerTotal)).toBe("70.00");
  });
});
