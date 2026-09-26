import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import { hashPassword } from "./password.js";
import { AuthorizationError, resolveCapabilities, type Principal } from "./authz.js";
import { createEmployee } from "./people.js";
import { formatAmount } from "./money.js";

import {
  approveRequirementRule,
  describeCondition,
  evaluateCondition,
  factKinds,
  factsUsedBy,
  listFactDefinitions,
  listRequirementRules,
  retireRequirementRule,
  rulesInForce,
  saveFactDefinition,
  saveRequirementRule,
  validateCondition,
  type Condition,
  type FactValues,
} from "./case-rules.js";
import {
  assignToCase,
  closeCase,
  describePosition,
  estatePosition,
  getCase,
  listCaseEvents,
  listCases,
  openCase,
  recordCaseMilestone,
  removeFromCase,
  reopenCase,
  updateCase,
} from "./cases.js";
import {
  answerFact,
  getPartyIdentification,
  listAssets,
  listCaseFacts,
  listDocuments,
  listLiabilities,
  listParties,
  recordAsset,
  recordLiability,
  recordParty,
  registerDocument,
  setVerification,
  updateAsset,
} from "./case-file.js";
import {
  addRequirement,
  cancelTask,
  completeTask,
  createTask,
  listRequirements,
  listTasks,
  myCaseTasks,
  previewChecklist,
  recomputeChecklist,
  setRequirementStatus,
} from "./case-checklist.js";

/**
 * Phase 9: estate case management.
 *
 * The property that matters most is the one the whole design is arranged around: **a
 * checklist is derived from the facts of the matter, and a short checklist never means
 * "nobody asked".** Two cases with different facts get different lists from the same
 * rules; a rule waiting on an unanswered question keeps its item on the list with the
 * question named; and a requirement somebody has already dealt with is never removed
 * by a recomputation.
 *
 * The second property: **nothing in this repository knows Malaysian probate law.** The
 * first test below proves the shipped state — a case, no rules, an empty checklist and
 * a reason for it.
 *
 * The fixtures here are invented people with invented identification numbers. No real
 * client, deceased person or beneficiary appears in this repository.
 */

let db: Database;
let close: () => Promise<void>;

let caseManager: Principal; // runs matters; cannot approve a rule
let reviewer: Principal; // the authorised reviewer: approves rules, verifies facts
let caseStaff: Principal; // assigned to one matter only
let accountant: Principal; // no case capability at all

let managerEmployeeId: string;
let staffEmployeeId: string;
let reviewerEmployeeId: string;

let probateCaseId: string;
let laCaseId: string;

async function makePrincipal(
  email: string,
  roles: string[],
  employeeId: string | null = null,
): Promise<Principal> {
  const hash = await hashPassword("correct-horse-battery-staple");
  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO auth."user" (email, password_hash, full_name, employee_id)
    VALUES (${email}, ${hash}, ${email}, ${employeeId}) RETURNING id
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
    employeeId,
    sessionId: "00000000-0000-0000-0000-000000000000",
    mfaSatisfied: true,
    mustChangePassword: false,
    mustEnrolMfa: false,
  };
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  await runMigrations(db);
  await seed(db);

  const hrAdmin = await makePrincipal("cs-hr@cac.test", ["HR_ADMIN"]);

  managerEmployeeId = (
    await createEmployee(db, hrAdmin, {
      fullName: "Nurul binti Hashim",
      joinedOn: "2024-01-08",
      basicSalary: "7000.00",
    })
  ).id;
  staffEmployeeId = (
    await createEmployee(db, hrAdmin, {
      fullName: "Chong Wei Ming",
      joinedOn: "2025-03-03",
      basicSalary: "4200.00",
    })
  ).id;
  reviewerEmployeeId = (
    await createEmployee(db, hrAdmin, {
      fullName: "Sara Devi",
      joinedOn: "2023-06-01",
      basicSalary: "9500.00",
    })
  ).id;

  caseManager = await makePrincipal("cs-manager@cac.test", ["CASE_MANAGER"], managerEmployeeId);
  reviewer = await makePrincipal(
    "cs-reviewer@cac.test",
    ["LAWYER_OR_AUTHORISED_REVIEWER"],
    reviewerEmployeeId,
  );
  caseStaff = await makePrincipal("cs-staff@cac.test", ["CASE_STAFF"], staffEmployeeId);
  accountant = await makePrincipal("cs-accountant@cac.test", ["ACCOUNTANT"]);
}, 180_000);

afterAll(async () => {
  await close();
});

// ---------------------------------------------------------------------------
describe("the boundary this platform ships with", () => {
  it("opens a case, and its checklist is empty because no rule has been approved", async () => {
    const opened = await openCase(db, caseManager, {
      matterType: "probate",
      title: "Estate of Tan Ah Kow",
      deceasedName: "Tan Ah Kow",
      deceasedId: "450612085432",
      dateOfDeath: "2026-04-11",
      placeOfDeath: "Ipoh, Perak",
      domicileState: "Perak",
      openedOn: "2026-05-04",
      leadEmployeeId: managerEmployeeId,
    });
    probateCaseId = opened.id;
    expect(opened.caseNo).toMatch(/^CASE/);

    const report = await recomputeChecklist(db, caseManager, probateCaseId);

    // This is the shipped state, and it is deliberate. Q-LEGAL-1 and Q-LEGAL-2 are
    // open; no Malaysian probate requirement is seeded, and none is invented.
    expect(report.rulesConsidered).toBe(0);
    expect(report.added).toEqual([]);
    expect(await listRequirements(db, caseManager, probateCaseId)).toEqual([]);
  });

  it("a case manager cannot approve a rule — that is the reviewer's act", () => {
    // The capability itself is withheld by role design, matching docs/RBAC_MATRIX.md.
    expect(caseManager.capabilities.has("case.rule.propose")).toBe(true);
    expect(caseManager.capabilities.has("case.rule.approve")).toBe(false);
    expect(caseManager.capabilities.has("case.document.approve")).toBe(false);
    expect(reviewer.capabilities.has("case.rule.approve")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("the condition language", () => {
  const facts: FactValues = {
    has_will: { value: "true", kind: "boolean" },
    beneficiary_count: { value: "3", kind: "number" },
    death_registered_on: { value: "2026-04-20", kind: "date" },
    estate_kind: { value: "immovable", kind: "choice" },
    // Asked and not answered: the fact exists with a null value.
    any_minor_beneficiary: { value: null, kind: "boolean" },
  };

  it("an empty condition applies always, and an empty 'any' never", () => {
    expect(evaluateCondition({ all: [] }, facts)).toEqual({ decided: true, applies: true });
    expect(evaluateCondition({ any: [] }, facts)).toEqual({ decided: true, applies: false });
  });

  it("compares booleans, numbers, dates and choices", () => {
    expect(evaluateCondition({ fact: "has_will", is: true }, facts)).toEqual({
      decided: true,
      applies: true,
    });
    expect(evaluateCondition({ fact: "beneficiary_count", atLeast: 4 }, facts)).toEqual({
      decided: true,
      applies: false,
    });
    expect(evaluateCondition({ fact: "beneficiary_count", atMost: 3 }, facts)).toEqual({
      decided: true,
      applies: true,
    });
    expect(
      evaluateCondition({ fact: "death_registered_on", onOrAfter: "2026-04-01" }, facts),
    ).toEqual({ decided: true, applies: true });
    expect(
      evaluateCondition({ fact: "estate_kind", oneOf: ["immovable", "mixed"] }, facts),
    ).toEqual({ decided: true, applies: true });
  });

  it("an unanswered fact is undecided, not false — and names the question", () => {
    expect(evaluateCondition({ fact: "any_minor_beneficiary", is: true }, facts)).toEqual({
      decided: false,
      missing: ["any_minor_beneficiary"],
    });
    // Never recorded at all is the same verdict.
    expect(evaluateCondition({ fact: "has_caveat", answered: true } as Condition, facts)).toEqual({
      decided: false,
      missing: ["has_caveat"],
    });
  });

  it("a definite false settles an 'all' even when something else is unknown", () => {
    // This is what stops a missing answer from making every rule undecided. If one
    // limb is definitely false the rule cannot apply, and the question is moot.
    expect(
      evaluateCondition(
        { all: [{ fact: "has_will", is: false }, { fact: "any_minor_beneficiary", is: true }] },
        facts,
      ),
    ).toEqual({ decided: true, applies: false });
  });

  it("a definite true settles an 'any' even when something else is unknown", () => {
    expect(
      evaluateCondition(
        { any: [{ fact: "has_will", is: true }, { fact: "any_minor_beneficiary", is: true }] },
        facts,
      ),
    ).toEqual({ decided: true, applies: true });
  });

  it("but an 'all' that is otherwise true stays undecided while a question is open", () => {
    expect(
      evaluateCondition(
        { all: [{ fact: "has_will", is: true }, { fact: "any_minor_beneficiary", is: true }] },
        facts,
      ),
    ).toEqual({ decided: false, missing: ["any_minor_beneficiary"] });
  });

  it("negating 'we do not know' does not produce knowledge", () => {
    expect(evaluateCondition({ not: { fact: "any_minor_beneficiary", is: true } }, facts)).toEqual({
      decided: false,
      missing: ["any_minor_beneficiary"],
    });
    expect(evaluateCondition({ not: { fact: "has_will", is: true } }, facts)).toEqual({
      decided: true,
      applies: false,
    });
  });

  it("collects every question a rule depends on, and says what it means in words", () => {
    const condition: Condition = {
      all: [
        { fact: "has_will", is: false },
        { any: [{ fact: "beneficiary_count", atLeast: 2 }, { fact: "any_minor_beneficiary", is: true }] },
      ],
    };
    expect([...factsUsedBy(condition)].sort()).toEqual([
      "any_minor_beneficiary",
      "beneficiary_count",
      "has_will",
    ]);

    const labels = new Map([
      ["has_will", "There is a will"],
      ["beneficiary_count", "Number of beneficiaries"],
      ["any_minor_beneficiary", "A beneficiary is a minor"],
    ]);
    expect(describeCondition(condition, labels)).toBe(
      "There is a will is false and (Number of beneficiaries is at least 2 or A beneficiary is a minor is true)",
    );
  });
});

// ---------------------------------------------------------------------------
describe("intake questions", () => {
  it("declares the questions the rules will read", async () => {
    await saveFactDefinition(db, reviewer, {
      key: "has_will",
      label: "There is a will",
      kind: "boolean",
      prompt: "Did the deceased leave a will?",
      sortOrder: 10,
    });
    await saveFactDefinition(db, reviewer, {
      key: "any_minor_beneficiary",
      label: "A beneficiary is a minor",
      kind: "boolean",
      sortOrder: 20,
    });
    await saveFactDefinition(db, reviewer, {
      key: "beneficiary_count",
      label: "Number of beneficiaries",
      kind: "number",
      sortOrder: 30,
    });
    await saveFactDefinition(db, reviewer, {
      key: "estate_kind",
      label: "What the estate consists of",
      kind: "choice",
      options: ["movable", "immovable", "mixed"],
      sortOrder: 40,
    });

    const declared = await listFactDefinitions(db);
    expect(declared.map((entry) => entry.key)).toEqual([
      "has_will",
      "any_minor_beneficiary",
      "beneficiary_count",
      "estate_kind",
    ]);
  });

  it("refuses a key a rule could not reliably reference", async () => {
    await expect(
      saveFactDefinition(db, reviewer, { key: "Has Will?", label: "x", kind: "boolean" }),
    ).rejects.toThrow(/lower-case letters/);
  });

  it("refuses a multiple-choice question with nothing to choose", async () => {
    await expect(
      saveFactDefinition(db, reviewer, { key: "registry_state", label: "State", kind: "choice" }),
    ).rejects.toThrow(/needs its answers listed/);
  });

  it("will not change a question's type once answers exist against it", async () => {
    await answerFact(db, caseManager, {
      caseId: probateCaseId,
      factKey: "has_will",
      value: "true",
      sourceNote: "The will was produced at the first meeting.",
    });

    await expect(
      saveFactDefinition(db, reviewer, { key: "has_will", label: "There is a will", kind: "text" }),
    ).rejects.toThrow(/Retire it and add a new one/);
  });

  it("refuses an answer that does not match the question", async () => {
    await expect(
      answerFact(db, caseManager, {
        caseId: probateCaseId,
        factKey: "beneficiary_count",
        value: "a few",
      }),
    ).rejects.toThrow(/expects a number/);

    await expect(
      answerFact(db, caseManager, {
        caseId: probateCaseId,
        factKey: "estate_kind",
        value: "farmland",
      }),
    ).rejects.toThrow(/does not offer/);
  });

  it("records 'unknown' as a real answer, distinct from an empty one", async () => {
    await expect(
      answerFact(db, caseManager, { caseId: probateCaseId, factKey: "estate_kind", value: "  " }),
    ).rejects.toThrow(/Record it as unknown/);

    await answerFact(db, caseManager, {
      caseId: probateCaseId,
      factKey: "any_minor_beneficiary",
      unknown: true,
      sourceNote: "The family are still tracing one grandchild.",
    });

    const facts = await listCaseFacts(db, caseManager, probateCaseId);
    const minor = facts.find((entry) => entry.factKey === "any_minor_beneficiary")!;
    expect(minor.status).toBe("unknown");
    expect(minor.value).toBeNull();
    expect(minor.answered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("validating a rule's condition before it is stored", () => {
  it("refuses a question nobody records — the rule would never resolve", async () => {
    const kinds = await factKinds(db);
    expect(() => validateCondition({ fact: "has_caveat", is: true }, kinds)).toThrow(
      /no question called "has_caveat"/,
    );
  });

  it("refuses an operator that does not suit the question's type", async () => {
    const kinds = await factKinds(db);
    expect(() => validateCondition({ fact: "has_will", atLeast: 2 }, kinds)).toThrow(
      /boolean question, so "atLeast"/,
    );
    expect(() => validateCondition({ fact: "beneficiary_count", is: "three" }, kinds)).toThrow(
      /must be a number/,
    );
    expect(() =>
      validateCondition({ fact: "beneficiary_count", onOrAfter: "2026-01-01" }, kinds),
    ).toThrow(/number question, so "onOrAfter"/);
  });

  it("refuses a condition nobody could review", async () => {
    const kinds = await factKinds(db);
    let nested: unknown = { fact: "has_will", is: true };
    for (let depth = 0; depth < 12; depth += 1) nested = { all: [nested] };
    expect(() => validateCondition(nested, kinds)).toThrow(/levels deep/);
  });

  it("refuses two tests on one fact in a single node", async () => {
    const kinds = await factKinds(db);
    expect(() =>
      validateCondition({ fact: "beneficiary_count", atLeast: 1, atMost: 5 }, kinds),
    ).toThrow(/exactly one test/);
  });
});

// ---------------------------------------------------------------------------
describe("requirement rules", () => {
  it("refuses a rule with no authority behind it", async () => {
    await expect(
      saveRequirementRule(db, caseManager, {
        code: "GRANT_APP",
        title: "Application for the grant",
        kind: "form",
        appliesWhen: { all: [] },
        sourceRef: "   ",
      }),
    ).rejects.toThrow(/names the authority it comes from/);
  });

  it("takes a draft from whoever proposes it", async () => {
    const saved = await saveRequirementRule(db, caseManager, {
      code: "DEATH_CERT",
      title: "Certified copy of the death certificate",
      detail: "Required on every estate matter.",
      kind: "document",
      appliesWhen: { all: [] },
      // A fixture reference. The real one is CAC's to supply (Q-LEGAL-2).
      sourceRef: "CAC internal procedure note, 2026 — placeholder pending Q-LEGAL-2",
    });
    expect(saved.version).toBe(1);

    const rules = await listRequirementRules(db, { status: "draft" });
    expect(rules.map((rule) => rule.code)).toContain("DEATH_CERT");
  });

  it("a draft is not in force, so it produces nothing", async () => {
    expect(await rulesInForce(db, "probate")).toEqual([]);
  });

  it("refuses to let the author approve their own rule", async () => {
    const authored = await saveRequirementRule(db, reviewer, {
      code: "SELF_APPROVED",
      title: "A rule the reviewer wrote",
      kind: "action",
      appliesWhen: { all: [] },
      sourceRef: "fixture",
    });
    await expect(approveRequirementRule(db, reviewer, authored.id)).rejects.toThrow(
      /cannot approve something you created/,
    );
  });

  it("refuses approval from somebody without the capability", async () => {
    const rules = await listRequirementRules(db, { status: "draft" });
    const draft = rules.find((rule) => rule.code === "DEATH_CERT")!;
    await expect(approveRequirementRule(db, caseManager, draft.id)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("approves it, and then it is in force and fixed", async () => {
    const rules = await listRequirementRules(db, { status: "draft" });
    const draft = rules.find((rule) => rule.code === "DEATH_CERT")!;
    await approveRequirementRule(db, reviewer, draft.id);

    const inForce = await rulesInForce(db, "probate");
    expect(inForce.map((rule) => rule.code)).toEqual(["DEATH_CERT"]);
    expect(inForce[0].approvedByName).toBe("cs-reviewer@cac.test");

    // The database refuses the edit, not just the application layer.
    await expect(
      db.execute(sql`
        UPDATE estate.requirement_rule SET title = 'Something else' WHERE id = ${draft.id}
      `),
    ).rejects.toThrow(/approved and is fixed/);
  });

  it("a revision is a new version, and approving it retires the old one", async () => {
    const next = await saveRequirementRule(db, caseManager, {
      code: "DEATH_CERT",
      title: "Certified copy of the death certificate (registrar's copy)",
      kind: "document",
      appliesWhen: { all: [] },
      sourceRef: "CAC internal procedure note, revised 2026 — placeholder pending Q-LEGAL-2",
    });
    expect(next.version).toBe(2);

    await approveRequirementRule(db, reviewer, next.id);

    const versions = await listRequirementRules(db);
    const deathCert = versions.filter((rule) => rule.code === "DEATH_CERT");
    expect(deathCert.find((rule) => rule.version === 1)!.status).toBe("retired");
    expect(deathCert.find((rule) => rule.version === 2)!.status).toBe("approved");

    // One approved version per code, so "what does this rule require now" is single-valued.
    const inForce = await rulesInForce(db, "probate");
    expect(inForce.filter((rule) => rule.code === "DEATH_CERT")).toHaveLength(1);
  });

  it("refuses a second draft of the same code while one is waiting", async () => {
    await saveRequirementRule(db, caseManager, {
      code: "WILL_ORIGINAL",
      title: "The original will",
      kind: "document",
      appliesWhen: { all: [{ fact: "has_will", is: true }] },
      sourceRef: "fixture",
    });
    await expect(
      saveRequirementRule(db, caseManager, {
        code: "WILL_ORIGINAL",
        title: "The original will, again",
        kind: "document",
        appliesWhen: { all: [] },
        sourceRef: "fixture",
      }),
    ).rejects.toThrow(/already a draft awaiting approval/);
  });
});

// ---------------------------------------------------------------------------
describe("a checklist derived from the facts", () => {
  beforeAll(async () => {
    // Three more rules, so the two matters below diverge on their facts.
    const will = (await listRequirementRules(db, { status: "draft" })).find(
      (rule) => rule.code === "WILL_ORIGINAL",
    )!;
    await approveRequirementRule(db, reviewer, will.id);

    const minors = await saveRequirementRule(db, caseManager, {
      code: "MINOR_CONSENT",
      title: "Arrangements for a beneficiary who is a minor",
      kind: "consent",
      appliesWhen: { all: [{ fact: "any_minor_beneficiary", is: true }] },
      sourceRef: "fixture",
    });
    await approveRequirementRule(db, reviewer, minors.id);

    const land = await saveRequirementRule(db, caseManager, {
      code: "LAND_TITLE",
      title: "Certified land title search",
      kind: "evidence",
      matterTypes: ["probate", "letters_of_administration"],
      appliesWhen: { any: [{ fact: "estate_kind", oneOf: ["immovable", "mixed"] }] },
      sourceRef: "fixture",
    });
    await approveRequirementRule(db, reviewer, land.id);

    // A second matter, with different facts: no will, movable estate only.
    const opened = await openCase(db, caseManager, {
      matterType: "letters_of_administration",
      title: "Estate of Rajendran a/l Muthu",
      deceasedName: "Rajendran a/l Muthu",
      dateOfDeath: "2026-06-02",
      openedOn: "2026-06-15",
      leadEmployeeId: managerEmployeeId,
    });
    laCaseId = opened.id;
    await answerFact(db, caseManager, { caseId: laCaseId, factKey: "has_will", value: "false" });
    await answerFact(db, caseManager, {
      caseId: laCaseId,
      factKey: "any_minor_beneficiary",
      value: "false",
    });
    await answerFact(db, caseManager, {
      caseId: laCaseId,
      factKey: "estate_kind",
      value: "movable",
    });
  });

  it("keeps an item on the list when a question is unanswered, and names the question", async () => {
    // The probate matter: has_will = true, estate_kind unanswered, minors unknown.
    await answerFact(db, caseManager, {
      caseId: probateCaseId,
      factKey: "estate_kind",
      value: "immovable",
    });

    const report = await recomputeChecklist(db, caseManager, probateCaseId);
    expect(report.rulesConsidered).toBe(4);

    const items = await listRequirements(db, caseManager, probateCaseId);
    const byCode = new Map(items.map((item) => [item.ruleCode, item]));

    expect(byCode.get("DEATH_CERT")!.status).toBe("outstanding");
    expect(byCode.get("WILL_ORIGINAL")!.status).toBe("outstanding");
    expect(byCode.get("LAND_TITLE")!.status).toBe("outstanding");

    // This is the important one. Nobody knows whether a beneficiary is a minor, so
    // the requirement stays on the list, flagged — it does not quietly disappear.
    const minors = byCode.get("MINOR_CONSENT")!;
    expect(minors.status).toBe("outstanding");
    expect(minors.undecidedFacts).toEqual(["any_minor_beneficiary"]);
    expect(report.undecided).toEqual([
      { title: "Arrangements for a beneficiary who is a minor", facts: ["any_minor_beneficiary"] },
    ]);
  });

  it("gives a different matter a different list from the same rules", async () => {
    await recomputeChecklist(db, caseManager, laCaseId);
    const items = await listRequirements(db, caseManager, laCaseId);
    const active = items.filter((item) => item.status !== "not_applicable");

    // No will, no minor, movable estate: only the always-required item applies.
    expect(active.map((item) => item.ruleCode)).toEqual(["DEATH_CERT"]);

    const notApplicable = items.filter((item) => item.status === "not_applicable");
    expect(notApplicable.map((item) => item.ruleCode).sort()).toEqual([]);
    // Items that never applied were never created, which is different from being dropped.
    expect(items).toHaveLength(1);
  });

  it("each item carries the rule, its version and its authority", async () => {
    const items = await listRequirements(db, caseManager, probateCaseId);
    const deathCert = items.find((item) => item.ruleCode === "DEATH_CERT")!;
    expect(deathCert.ruleVersion).toBe(2);
    expect(deathCert.sourceRef).toMatch(/placeholder pending Q-LEGAL-2/);
    expect(deathCert.fromRule).toBe(true);
  });

  it("answering the open question resolves the flag", async () => {
    await answerFact(db, caseManager, {
      caseId: probateCaseId,
      factKey: "any_minor_beneficiary",
      value: "false",
      sourceNote: "All five beneficiaries are adults; birth certificates seen.",
    });

    const report = await recomputeChecklist(db, caseManager, probateCaseId);
    expect(report.undecided).toEqual([]);
    expect(report.droppedNowIrrelevant).toEqual([
      "Arrangements for a beneficiary who is a minor",
    ]);

    const items = await listRequirements(db, caseManager, probateCaseId);
    const minors = items.find((item) => item.ruleCode === "MINOR_CONSENT")!;
    expect(minors.status).toBe("not_applicable");
    // It says why it fell away rather than vanishing from the file.
    expect(minors.droppedReason).toMatch(/No longer applies/);
  });

  it("is idempotent — a second run with the same facts changes nothing", async () => {
    const before = await listRequirements(db, caseManager, probateCaseId);
    const report = await recomputeChecklist(db, caseManager, probateCaseId);
    expect(report.added).toEqual([]);
    expect(report.reopened).toEqual([]);
    expect(report.droppedNowIrrelevant).toEqual([]);

    const after = await listRequirements(db, caseManager, probateCaseId);
    expect(after.map((item) => `${item.ruleCode}:${item.status}`)).toEqual(
      before.map((item) => `${item.ruleCode}:${item.status}`),
    );
  });

  it("reinstates an item, with a note, if the facts change back", async () => {
    await answerFact(db, caseManager, {
      caseId: probateCaseId,
      factKey: "any_minor_beneficiary",
      value: "true",
      sourceNote: "A grandchild aged 11 was traced.",
    });
    const report = await recomputeChecklist(db, caseManager, probateCaseId);
    expect(report.reopened).toEqual(["Arrangements for a beneficiary who is a minor"]);

    const items = await listRequirements(db, caseManager, probateCaseId);
    const minors = items.find((item) => item.ruleCode === "MINOR_CONSENT")!;
    expect(minors.status).toBe("outstanding");
    expect(minors.droppedReason).toBeNull();
  });

  it("shows what a recomputation would do, without doing it", async () => {
    const preview = await previewChecklist(db, caseManager, laCaseId);
    const byCode = new Map(preview.map((entry) => [entry.rule.code, entry]));
    expect(byCode.get("DEATH_CERT")!.verdict).toBe("applies");
    expect(byCode.get("WILL_ORIGINAL")!.verdict).toBe("does not apply");
    expect(byCode.get("LAND_TITLE")!.verdict).toBe("does not apply");
    expect(byCode.get("WILL_ORIGINAL")!.alreadyOnList).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("working the checklist", () => {
  let documentId: string;

  it("refuses to mark a document requirement satisfied with no document", async () => {
    const items = await listRequirements(db, caseManager, probateCaseId);
    const deathCert = items.find((item) => item.ruleCode === "DEATH_CERT")!;

    await expect(
      setRequirementStatus(db, caseManager, {
        requirementId: deathCert.id,
        status: "satisfied",
      }),
    ).rejects.toThrow(/Name the document/);
  });

  it("satisfies it once the document is on the register", async () => {
    documentId = await registerDocument(db, caseManager, {
      caseId: probateCaseId,
      title: "Death certificate (certified copy)",
      docKind: "death certificate",
      form: "certified_copy",
      receivedOn: "2026-05-06",
      receivedFrom: "The eldest son",
      filedAt: "Case file 2026/041, tab 1",
    });

    const items = await listRequirements(db, caseManager, probateCaseId);
    const deathCert = items.find((item) => item.ruleCode === "DEATH_CERT")!;
    await setRequirementStatus(db, caseManager, {
      requirementId: deathCert.id,
      status: "satisfied",
      documentId,
    });

    const after = await listRequirements(db, caseManager, probateCaseId);
    const satisfied = after.find((item) => item.ruleCode === "DEATH_CERT")!;
    expect(satisfied.status).toBe("satisfied");
    expect(satisfied.documentTitle).toBe("Death certificate (certified copy)");
    expect(satisfied.satisfiedByName).toBe("cs-manager@cac.test");
  });

  it("refuses a document belonging to another matter", async () => {
    const items = await listRequirements(db, caseManager, laCaseId);
    const deathCert = items.find((item) => item.ruleCode === "DEATH_CERT")!;
    await expect(
      setRequirementStatus(db, caseManager, {
        requirementId: deathCert.id,
        status: "satisfied",
        documentId,
      }),
    ).rejects.toThrow(/different case/);
  });

  it("never removes a satisfied item, even when the facts say it no longer applies", async () => {
    // The land title requirement, satisfied, then the estate turns out to be movable.
    const items = await listRequirements(db, caseManager, probateCaseId);
    const land = items.find((item) => item.ruleCode === "LAND_TITLE")!;
    await setRequirementStatus(db, caseManager, {
      requirementId: land.id,
      status: "waived",
      reason: "The title search was produced by the family's own solicitor and is on file.",
    });

    await answerFact(db, caseManager, {
      caseId: probateCaseId,
      factKey: "estate_kind",
      value: "movable",
    });
    const report = await recomputeChecklist(db, caseManager, probateCaseId);
    expect(report.settled).toBeGreaterThan(0);

    const after = await listRequirements(db, caseManager, probateCaseId);
    const stillWaived = after.find((item) => item.ruleCode === "LAND_TITLE")!;
    // Work already done is not erased by a change of facts.
    expect(stillWaived.status).toBe("waived");
    expect(stillWaived.waiveReason).toMatch(/family's own solicitor/);

    // Put the fact back so the rest of the file reads as it did.
    await answerFact(db, caseManager, {
      caseId: probateCaseId,
      factKey: "estate_kind",
      value: "immovable",
    });
    await recomputeChecklist(db, caseManager, probateCaseId);
  });

  it("needs a reason to waive", async () => {
    const minorItem = (await listRequirements(db, caseManager, probateCaseId)).find(
      (item) => item.ruleCode === "MINOR_CONSENT",
    )!;
    await expect(
      setRequirementStatus(db, caseManager, { requirementId: minorItem.id, status: "waived" }),
    ).rejects.toThrow(/Say why/);
  });

  it("will not let somebody rule an item out by hand", async () => {
    const minorItem = (await listRequirements(db, caseManager, probateCaseId)).find(
      (item) => item.ruleCode === "MINOR_CONSENT",
    )!;
    await expect(
      setRequirementStatus(db, caseManager, {
        requirementId: minorItem.id,
        status: "not_applicable",
      }),
    ).rejects.toThrow(/fall away by recomputation/);
  });

  it("takes an item added by hand, with no authority of its own", async () => {
    const id = await addRequirement(db, caseManager, {
      caseId: probateCaseId,
      title: "Chase the bank for the closing balance letter",
      kind: "action",
      dueOn: "2026-07-01",
    });
    const items = await listRequirements(db, caseManager, probateCaseId);
    const manual = items.find((item) => item.id === id)!;
    expect(manual.fromRule).toBe(false);
    expect(manual.ruleCode).toBeNull();
    expect(manual.sourceRef).toBeNull();
  });

  it("keeps a hand-added item through a recomputation", async () => {
    await recomputeChecklist(db, caseManager, probateCaseId);
    const items = await listRequirements(db, caseManager, probateCaseId);
    expect(items.some((item) => item.title.startsWith("Chase the bank"))).toBe(true);
  });

  it("drops an item whose rule has been withdrawn, saying so", async () => {
    const rules = await listRequirementRules(db, { status: "approved" });
    const will = rules.find((rule) => rule.code === "WILL_ORIGINAL")!;
    await retireRequirementRule(
      db,
      reviewer,
      will.id,
      "Superseded by the reviewer's consolidated note.",
    );

    const report = await recomputeChecklist(db, caseManager, probateCaseId);
    expect(report.droppedNowIrrelevant).toEqual(["The original will"]);

    const items = await listRequirements(db, caseManager, probateCaseId);
    const willItem = items.find((item) => item.ruleCode === "WILL_ORIGINAL")!;
    expect(willItem.status).toBe("not_applicable");
    expect(willItem.droppedReason).toMatch(/no longer in force/);
    // The snapshot is untouched: the item still says what was required, and under
    // which version, when it was on the list.
    expect(willItem.ruleVersion).toBe(1);
    expect(willItem.title).toBe("The original will");
  });

  it("refuses to remove a document a satisfied item depends on", async () => {
    const { removeDocument } = await import("./case-file.js");
    await expect(
      removeDocument(db, caseManager, documentId, "Filed in the wrong matter."),
    ).rejects.toThrow(/satisfied by this document/);
  });
});

// ---------------------------------------------------------------------------
describe("who can see a matter", () => {
  it("shows a case manager every matter", async () => {
    const cases = await listCases(db, caseManager, { status: "active" });
    expect(cases.map((entry) => entry.id).sort()).toEqual([probateCaseId, laCaseId].sort());
  });

  it("shows case staff only the matters they are assigned to", async () => {
    // Not yet assigned to anything.
    expect(await listCases(db, caseStaff)).toEqual([]);
    await expect(getCase(db, caseStaff, probateCaseId)).resolves.toBeNull();

    await assignToCase(db, caseManager, {
      caseId: probateCaseId,
      employeeId: staffEmployeeId,
      role: "contributor",
    });

    const visible = await listCases(db, caseStaff);
    expect(visible.map((entry) => entry.id)).toEqual([probateCaseId]);
    // The other matter still does not exist as far as they are concerned.
    await expect(getCase(db, caseStaff, laCaseId)).resolves.toBeNull();
    await expect(listRequirements(db, caseStaff, laCaseId)).rejects.toThrow(/not one of yours/);
  });

  it("refuses somebody with no case capability at all, and says why", async () => {
    await expect(listRequirements(db, accountant, probateCaseId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("will not leave a matter with nobody assigned to it", async () => {
    await removeFromCase(db, caseManager, {
      caseId: probateCaseId,
      employeeId: staffEmployeeId,
    });
    await expect(
      removeFromCase(db, caseManager, { caseId: probateCaseId, employeeId: managerEmployeeId }),
    ).rejects.toThrow(/only person assigned/);

    // Put the staff member back for the task tests below.
    await assignToCase(db, caseManager, {
      caseId: probateCaseId,
      employeeId: staffEmployeeId,
    });
  });
});

// ---------------------------------------------------------------------------
describe("the inventory", () => {
  let assetId: string;

  it("refuses a figure with no basis, date or source", async () => {
    await expect(
      recordAsset(db, caseManager, {
        caseId: probateCaseId,
        category: "land",
        description: "Double-storey terrace, Taman Ipoh Jaya",
        valuationAmount: "480000.00",
      }),
    ).rejects.toThrow(/how the figure was arrived at/);
  });

  it("refuses a basis with no figure — somebody stopped halfway", async () => {
    await expect(
      recordAsset(db, caseManager, {
        caseId: probateCaseId,
        category: "bank",
        description: "Savings account",
        valuationBasis: "Bank statement",
      }),
    ).rejects.toThrow(/no figure/);
  });

  it("takes an asset with no figure at all, which is an honest gap", async () => {
    assetId = await recordAsset(db, caseManager, {
      caseId: probateCaseId,
      category: "land",
      description: "Double-storey terrace, Taman Ipoh Jaya",
      reference: "HSD 44219 Lot 8821",
      location: "Ipoh, Perak",
      ownership: "joint",
      ownershipNote: "Held jointly with the surviving spouse.",
    });
    const assets = await listAssets(db, caseManager, probateCaseId);
    expect(assets).toHaveLength(1);
    expect(assets[0].valuationAmount).toBeNull();
    // The identifying number is encrypted; the list shows only the last four.
    expect(assets[0].hasReference).toBe(true);
    expect(assets[0].referenceLast4).toBe("8821");
  });

  it("takes the figure once it has a basis, a date and a source", async () => {
    await updateAsset(db, caseManager, assetId, {
      valuationAmount: "480000.00",
      valuationBasis: "Market comparison of three recent transactions in the same scheme",
      valuationDate: "2026-05-20",
      valuationSource: "CAC valuation report 2026/041-V1",
    });
    const assets = await listAssets(db, caseManager, probateCaseId);
    expect(formatAmount(assets[0].valuationAmount!)).toBe("480,000.00");
    expect(assets[0].valuationSource).toBe("CAC valuation report 2026/041-V1");
  });

  it("holds the same line for a liability, and insists on what secures it", async () => {
    await expect(
      recordLiability(db, caseManager, {
        caseId: probateCaseId,
        category: "mortgage",
        creditor: "A bank",
        description: "Housing loan",
        isSecured: true,
      }),
    ).rejects.toThrow(/what secures the debt/);

    await recordLiability(db, caseManager, {
      caseId: probateCaseId,
      category: "mortgage",
      creditor: "A bank",
      description: "Housing loan on the Taman Ipoh Jaya property",
      isSecured: true,
      securityNote: "Charged over HSD 44219 Lot 8821",
      amount: "132450.00",
      amountBasis: "Redemption statement",
      amountAsAt: "2026-05-18",
      amountSource: "Bank redemption statement dated 18 May 2026",
    });

    const liabilities = await listLiabilities(db, caseManager, probateCaseId);
    expect(liabilities).toHaveLength(1);
    expect(formatAmount(liabilities[0].amount!)).toBe("132,450.00");
  });

  it("adds up what it has, and refuses to present it as the whole estate", async () => {
    await recordAsset(db, caseManager, {
      caseId: probateCaseId,
      category: "bank",
      description: "Savings account",
      reference: "7712345678",
    });

    const position = await estatePosition(db, caseManager, probateCaseId);
    expect(formatAmount(position.assetTotal)).toBe("480,000.00");
    expect(formatAmount(position.liabilityTotal)).toBe("132,450.00");
    expect(formatAmount(position.net)).toBe("347,550.00");
    expect(position.assetsUnvalued).toBe(1);
    expect(position.incomplete).toBe(true);
    expect(describePosition(position)).toMatch(/not the estate's total/);
  });

  it("distinguishes what was reported from what was checked", async () => {
    const assets = await listAssets(db, caseManager, probateCaseId);
    const land = assets.find((asset) => asset.category === "land")!;
    expect(land.status).toBe("reported");

    // Recording what the family said and attesting that it has been checked are
    // different acts, and `case.fact.verify` is the second one. Case staff record;
    // they do not attest.
    expect(caseStaff.capabilities.has("case.edit")).toBe(true);
    expect(caseStaff.capabilities.has("case.fact.verify")).toBe(false);
    await expect(
      setVerification(db, caseStaff, {
        kind: "asset",
        recordId: land.id,
        status: "verified",
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    await assignToCase(db, caseManager, {
      caseId: probateCaseId,
      employeeId: reviewerEmployeeId,
      role: "reviewer",
    });
    await setVerification(db, reviewer, { kind: "asset", recordId: land.id, status: "verified" });

    const verified = (await listAssets(db, caseManager, probateCaseId)).find(
      (asset) => asset.category === "land",
    )!;
    expect(verified.status).toBe("verified");
    expect(verified.verifiedByName).toBe("cs-reviewer@cac.test");
    expect(verified.verifiedAt).not.toBeNull();
  });

  it("clears the attestation when a record stops being verified", async () => {
    const land = (await listAssets(db, caseManager, probateCaseId)).find(
      (asset) => asset.category === "land",
    )!;
    await setVerification(db, caseManager, {
      kind: "asset",
      recordId: land.id,
      status: "reported",
    });

    const after = (await listAssets(db, caseManager, probateCaseId)).find(
      (asset) => asset.category === "land",
    )!;
    // Nobody's name stays against a claim they no longer make.
    expect(after.status).toBe("reported");
    expect(after.verifiedByName).toBeNull();
    expect(after.verifiedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("the people in the matter", () => {
  it("refuses a stated entitlement with nothing behind it", async () => {
    await expect(
      recordParty(db, caseManager, {
        caseId: probateCaseId,
        role: "beneficiary",
        fullName: "Tan Mei Ling",
        relationship: "Daughter",
        shareNote: "One third of the residue",
      }),
    ).rejects.toThrow(/does not determine shares/);
  });

  it("records it when the authority is named", async () => {
    await recordParty(db, caseManager, {
      caseId: probateCaseId,
      role: "beneficiary",
      fullName: "Tan Mei Ling",
      relationship: "Daughter",
      identification: "920318086644",
      shareNote: "One third of the residue",
      shareSource: "Clause 4 of the will dated 3 March 2019",
    });

    const parties = await listParties(db, caseManager, probateCaseId);
    const daughter = parties.find((party) => party.fullName === "Tan Mei Ling")!;
    expect(daughter.shareSource).toMatch(/Clause 4 of the will/);
    // Identification is masked in the list.
    expect(daughter.idLast4).toBe("6644");
    expect(daughter.hasIdentification).toBe(true);
  });

  it("returns the full identification only on a separate, audited call", async () => {
    const parties = await listParties(db, caseManager, probateCaseId);
    const daughter = parties.find((party) => party.fullName === "Tan Mei Ling")!;

    const full = await getPartyIdentification(db, caseManager, daughter.id, {
      reason: "Completing the application form.",
    });
    expect(full).toBe("920318086644");

    const audited = await db.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM audit.event
       WHERE action = 'EXPORT_SENSITIVE' AND entity_id = ${daughter.id}
    `);
    expect(Number(audited.rows![0].count)).toBe(1);
  });

  it("does not put the beneficiary's name or share into the audit trail", async () => {
    const rows = await db.execute<{ new_values: unknown }>(sql`
      SELECT new_values FROM audit.event WHERE action = 'CASE_PARTY_RECORDED'
    `);
    const payloads = JSON.stringify(rows.rows ?? []);
    expect(payloads).not.toContain("Tan Mei Ling");
    expect(payloads).not.toContain("One third of the residue");
    // What it does say is that a beneficiary was added to that matter.
    expect(payloads).toContain("beneficiary");
  });

  it("refuses a date of birth for an organisation", async () => {
    await expect(
      recordParty(db, caseManager, {
        caseId: probateCaseId,
        role: "creditor",
        partyKind: "organisation",
        fullName: "A bank",
        dateOfBirth: "1990-01-01",
      }),
    ).rejects.toThrow(/no date of birth/);
  });
});

// ---------------------------------------------------------------------------
describe("tasks", () => {
  let taskId: string;

  it("assigns work with a date on it", async () => {
    taskId = await createTask(db, caseManager, {
      caseId: probateCaseId,
      title: "Obtain the bank's closing balance letter",
      assigneeId: staffEmployeeId,
      dueOn: "2026-06-01",
      priority: "high",
    });
    const tasks = await listTasks(db, caseManager, probateCaseId);
    expect(tasks.map((task) => task.title)).toContain("Obtain the bank's closing balance letter");
    // Dated in the past relative to today, so it reads as overdue rather than as fine.
    expect(tasks.find((task) => task.id === taskId)!.overdue).toBe(true);
  });

  it("shows somebody their own case work across matters", async () => {
    const mine = await myCaseTasks(db, caseStaff);
    expect(mine.map((task) => task.id)).toEqual([taskId]);
    expect(mine[0].caseNo).toMatch(/^CASE/);
  });

  it("lets the assignee finish it without the capability to manage other people's", async () => {
    expect(caseStaff.capabilities.has("case.task.manage")).toBe(false);
    await completeTask(db, caseStaff, taskId);

    const tasks = await listTasks(db, caseManager, probateCaseId);
    expect(tasks.find((task) => task.id === taskId)!.status).toBe("done");
    expect(await myCaseTasks(db, caseStaff)).toEqual([]);
  });

  it("needs a reason to cancel, and will not cancel finished work", async () => {
    const another = await createTask(db, caseManager, {
      caseId: probateCaseId,
      title: "Ask the registry about the caveat",
    });
    await expect(cancelTask(db, caseManager, another, "  ")).rejects.toThrow(/Say why/);
    await cancelTask(db, caseManager, another, "The registry confirmed there is no caveat.");
    await expect(cancelTask(db, caseManager, taskId, "no longer needed")).rejects.toThrow(
      /finished/,
    );
  });
});

// ---------------------------------------------------------------------------
describe("the timeline", () => {
  it("records what the platform did, and what happened elsewhere, separately", async () => {
    await recordCaseMilestone(db, caseManager, {
      caseId: probateCaseId,
      kind: "filing",
      summary: "Petition filed at the High Court registry.",
      occurredAt: "2026-06-18",
    });

    const events = await listCaseEvents(db, caseManager, probateCaseId);
    const filing = events.find((event) => event.kind === "filing")!;
    expect(filing.origin).toBe("recorded");
    expect(events.some((event) => event.kind === "case_opened" && event.origin === "system")).toBe(
      true,
    );
  });

  it("refuses a milestone dated in the future", async () => {
    await expect(
      recordCaseMilestone(db, caseManager, {
        caseId: probateCaseId,
        kind: "grant",
        summary: "Grant extracted.",
        occurredAt: "2099-01-01",
      }),
    ).rejects.toThrow(/in the future/);
  });

  it("is append-only — the database refuses to rewrite history", async () => {
    const events = await listCaseEvents(db, caseManager, probateCaseId);
    const one = events[0];

    await expect(
      db.execute(sql`UPDATE estate.case_event SET summary = 'Something else' WHERE id = ${one.id}`),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.execute(sql`DELETE FROM estate.case_event WHERE id = ${one.id}`),
    ).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
describe("closing a matter", () => {
  it("refuses to close while work is outstanding", async () => {
    await expect(
      closeCase(db, caseManager, probateCaseId, {
        outcome: "closed",
        reason: "Grant extracted and the estate distributed.",
      }),
    ).rejects.toThrow(/not satisfied, waived or ruled out/);
  });

  it("closes once every item has been dealt with", async () => {
    const items = await listRequirements(db, caseManager, probateCaseId);
    for (const item of items) {
      if (item.status === "outstanding" || item.status === "in_progress") {
        await setRequirementStatus(db, caseManager, {
          requirementId: item.id,
          status: "waived",
          reason: "Dealt with outside the checklist; noted on the file.",
        });
      }
    }

    await closeCase(db, caseManager, probateCaseId, {
      outcome: "closed",
      reason: "Grant extracted and the estate distributed.",
    });

    const record = await getCase(db, caseManager, probateCaseId);
    expect(record!.status).toBe("closed");
    expect(record!.closedOn).not.toBeNull();
  });

  it("refuses to write into a closed file, at the database", async () => {
    await expect(
      recordAsset(db, caseManager, {
        caseId: probateCaseId,
        category: "chattel",
        description: "A wristwatch found later",
      }),
    ).rejects.toThrow(/Reopen it before changing the file/);

    // And not only through the application layer.
    await expect(
      db.execute(sql`
        INSERT INTO estate.case_task (case_id, title, created_by)
        VALUES (${probateCaseId}, 'A task on a closed case', ${caseManager.userId})
      `),
    ).rejects.toThrow(/reopen it before changing its file/i);
  });

  it("needs a reason to reopen, and then the file takes writes again", async () => {
    await expect(reopenCase(db, caseManager, probateCaseId, "   ")).rejects.toThrow(/Say why/);
    await reopenCase(db, caseManager, probateCaseId, "A further asset came to light.");

    const id = await recordAsset(db, caseManager, {
      caseId: probateCaseId,
      category: "chattel",
      description: "A wristwatch found later",
    });
    expect(id).toBeTruthy();

    const events = await listCaseEvents(db, caseManager, probateCaseId);
    expect(events.some((event) => event.kind === "case_reopened")).toBe(true);
  });

  it("will not accept a close with no outcome on it", async () => {
    await expect(
      closeCase(db, caseManager, laCaseId, { outcome: "closed", reason: "  " }),
    ).rejects.toThrow(/how the matter concluded/);
  });

  it("withdraws a matter that stopped, which is not the same word as closed", async () => {
    await closeCase(db, caseManager, laCaseId, {
      outcome: "withdrawn",
      reason: "The family instructed their own solicitor.",
    });
    const record = await getCase(db, caseManager, laCaseId);
    expect(record!.status).toBe("withdrawn");
  });
});

// ---------------------------------------------------------------------------
describe("amending a matter", () => {
  it("leaves alone what a partial update does not mention", async () => {
    const before = await getCase(db, caseManager, probateCaseId);
    await updateCase(db, caseManager, probateCaseId, {
      courtReference: "PA-32NCVC-118-06/2026",
    });
    const after = await getCase(db, caseManager, probateCaseId);

    expect(after!.courtReference).toBe("PA-32NCVC-118-06/2026");
    // The rest of the matter is untouched — including the domicile the form did not show.
    expect(after!.deceasedName).toBe(before!.deceasedName);
    expect(after!.domicileState).toBe("Perak");
    expect(after!.dateOfDeath).toBe("2026-04-11");
  });

  it("puts the court reference on the timeline, because it is an event not a field", async () => {
    const events = await listCaseEvents(db, caseManager, probateCaseId);
    expect(events.some((event) => event.summary.includes("PA-32NCVC-118-06/2026"))).toBe(true);
  });

  it("refuses a date of death after the matter was opened", async () => {
    await expect(
      updateCase(db, caseManager, probateCaseId, { dateOfDeath: "2026-12-01" }),
    ).rejects.toThrow(/after the date the matter was opened/);
  });

  it("keeps the document register readable only to those who may see documents", async () => {
    const documents = await listDocuments(db, caseManager, probateCaseId);
    expect(documents).toHaveLength(1);
    // Metadata only: Phase 10 attaches the bytes.
    expect(documents[0].storageKey).toBeNull();
    expect(documents[0].filedAt).toBe("Case file 2026/041, tab 1");
    expect(documents[0].satisfies).toBe(1);
  });
});
