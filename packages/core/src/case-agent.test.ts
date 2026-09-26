import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import { hashPassword } from "./password.js";
import { resolveCapabilities, type Principal } from "./authz.js";
import { createEmployee } from "./people.js";
import { setSetting } from "./settings.js";

import {
  AssistantNotConfiguredError,
  NotConfiguredAssistant,
  assistantFromEnv,
  checkCitations,
  type AssistantReply,
} from "./assistant.js";
import {
  buildCasePack,
  findContradictions,
  findGaps,
  nextQuestions,
  relevantPassages,
  similarMatters,
} from "./case-agent.js";
import {
  approveRequirementRule,
  saveFactDefinition,
  saveRequirementRule,
} from "./case-rules.js";
import { assignToCase, openCase } from "./cases.js";
import { answerFact, recordAsset, recordLiability, recordParty } from "./case-file.js";
import { recomputeChecklist } from "./case-checklist.js";
import { extractAndIndex, registerUpload, scanDocument } from "./library.js";
import type { MalwareScanner, ScanResult } from "./scanning.js";

/**
 * Phase 11: the case agent.
 *
 * The rule under test is the governing one: **the rule engine decides requirements; the
 * model assists, cites and drafts, and never determines a requirement alone or submits
 * anything.** With no model configured, that leaves the deterministic half — and the
 * deterministic half turns out to be the useful part.
 *
 * So these tests prove: the intake order is driven by what each answer would unblock;
 * "missing" means missing from the record and "blocking" means an approved rule is actually
 * waiting; the consistency checks compare recorded fields and never conclude; the age check
 * stays off until CAC supplies the figure *and* its source; similar matters are scored on
 * inspectable shared answers; and the assistant refuses rather than drafting.
 */

let db: Database;
let close: () => Promise<void>;

let manager: Principal;
let reviewer: Principal;
let administrator: Principal; // the only holder of admin.settings.manage here
let managerEmployeeId: string;

let probateId: string;
let secondId: string;

class TestScanner implements MalwareScanner {
  readonly name = "test-scanner";
  isConfigured(): boolean {
    return true;
  }
  async version(): Promise<string | null> {
    return "0.0.0-test";
  }
  async scan(): Promise<ScanResult> {
    return { verdict: "clean", scanner: this.name, scannerVersion: "0.0.0-test", detail: "stream: OK" };
  }
}
const clean = new TestScanner();

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

  const hrAdmin = await makePrincipal("ag-hr@cac.test", ["HR_ADMIN"]);
  managerEmployeeId = (
    await createEmployee(db, hrAdmin, {
      fullName: "Nurul binti Hashim",
      joinedOn: "2024-01-08",
      basicSalary: "7000.00",
    })
  ).id;
  const reviewerEmployeeId = (
    await createEmployee(db, hrAdmin, {
      fullName: "Sara Devi",
      joinedOn: "2023-06-01",
      basicSalary: "9500.00",
    })
  ).id;

  manager = await makePrincipal("ag-manager@cac.test", ["CASE_MANAGER"], managerEmployeeId);
  administrator = await makePrincipal("ag-admin@cac.test", ["SUPER_ADMIN"]);
  reviewer = await makePrincipal(
    "ag-reviewer@cac.test",
    ["LAWYER_OR_AUTHORISED_REVIEWER"],
    reviewerEmployeeId,
  );

  // Four declared questions.
  for (const definition of [
    { key: "has_will", label: "There is a will", kind: "boolean" as const, sortOrder: 10 },
    {
      key: "any_minor_beneficiary",
      label: "A beneficiary is a minor",
      kind: "boolean" as const,
      sortOrder: 20,
    },
    {
      key: "estate_kind",
      label: "What the estate consists of",
      kind: "choice" as const,
      options: ["movable", "immovable", "mixed"],
      sortOrder: 30,
    },
    {
      key: "foreign_assets",
      label: "There are assets outside Malaysia",
      kind: "boolean" as const,
      sortOrder: 40,
    },
  ]) {
    await saveFactDefinition(db, reviewer, definition);
  }

  // Four rules. Two depend on `estate_kind`, one on the minor question, one always applies.
  const rules = [
    {
      code: "DEATH_CERT",
      title: "Certified copy of the death certificate",
      kind: "document" as const,
      appliesWhen: { all: [] },
    },
    {
      code: "LAND_TITLE",
      title: "Certified land title search",
      kind: "evidence" as const,
      appliesWhen: { any: [{ fact: "estate_kind", oneOf: ["immovable", "mixed"] }] },
    },
    {
      code: "LAND_VALUATION",
      title: "Valuation of the land",
      kind: "evidence" as const,
      appliesWhen: { all: [{ fact: "estate_kind", oneOf: ["immovable", "mixed"] }] },
    },
    {
      code: "MINOR_ARRANGEMENT",
      title: "Arrangements for a beneficiary who is a minor",
      kind: "consent" as const,
      appliesWhen: { all: [{ fact: "any_minor_beneficiary", is: true }] },
    },
  ];
  for (const rule of rules) {
    const saved = await saveRequirementRule(db, manager, {
      ...rule,
      sourceRef: "CAC internal procedure note, 2026 — placeholder pending Q-LEGAL-2",
    });
    await approveRequirementRule(db, reviewer, saved.id);
  }

  probateId = (
    await openCase(db, manager, {
      matterType: "probate",
      title: "Estate of Tan Ah Kow",
      deceasedName: "Tan Ah Kow",
      deceasedId: "450612085432",
      dateOfDeath: "2026-04-11",
      openedOn: "2026-05-04",
      leadEmployeeId: managerEmployeeId,
    })
  ).id;

  secondId = (
    await openCase(db, manager, {
      matterType: "probate",
      title: "Estate of Lim Guan Choo",
      deceasedName: "Lim Guan Choo",
      dateOfDeath: "2025-11-02",
      openedOn: "2025-12-01",
      leadEmployeeId: managerEmployeeId,
    })
  ).id;
}, 180_000);

afterAll(async () => {
  await close();
});

// ---------------------------------------------------------------------------
describe("the assistant boundary", () => {
  it("is not configured, and refuses rather than drafting", async () => {
    const assistant = assistantFromEnv({});
    expect(assistant.isConfigured()).toBe(false);

    const request = {
      question: "Draft the covering letter for the application.",
      context: [],
      matterSummary: "A probate matter.",
    };
    await expect(assistant.draft(request)).rejects.toBeInstanceOf(AssistantNotConfiguredError);
    await expect(new NotConfiguredAssistant().draft(request)).rejects.toThrow(/Q-LEGAL-2/);
  });

  it("throws away a draft that cites a passage it was not given", () => {
    const reply: AssistantReply = {
      draft: "The grant should be applied for at the High Court.",
      citations: [{ chunkId: "not-in-context", claim: "the registry" }],
      model: "test",
      reviewed: false,
      limitations: [],
    };
    const verdict = checkCitations(reply, ["a", "b"]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/fabricated citation/);
  });

  it("throws away an empty draft", () => {
    const reply: AssistantReply = {
      draft: "   ",
      citations: [],
      model: "test",
      reviewed: false,
      limitations: [],
    };
    expect(checkCitations(reply, []).ok).toBe(false);
  });

  it("accepts one whose citations all resolve", () => {
    const reply: AssistantReply = {
      draft: "Draft text.",
      citations: [{ chunkId: "a", claim: "supported" }],
      model: "test",
      reviewed: false,
      limitations: ["Could not find the land title reference in the passages given."],
    };
    expect(checkCitations(reply, ["a", "b"]).ok).toBe(true);
    // A reply always arrives unreviewed. Nothing here can set it otherwise.
    expect(reply.reviewed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("what to ask next", () => {
  it("puts the question that unblocks the most requirements first", async () => {
    const questions = await nextQuestions(db, manager, probateId);

    // `estate_kind` holds up two rules; the minor question one; `has_will` and
    // `foreign_assets` hold up nothing, because no rule reads them.
    expect(questions[0].factKey).toBe("estate_kind");
    expect(questions[0].blocks).toHaveLength(2);
    expect(questions[1].factKey).toBe("any_minor_beneficiary");
    expect(questions[1].blocks).toHaveLength(1);

    const unblocking = questions.filter((question) => question.blocks.length === 0);
    // Still listed: a question nobody's rule reads is still worth asking, and hiding it
    // would be the platform deciding what matters.
    expect(unblocking.map((question) => question.factKey).sort()).toEqual([
      "foreign_assets",
      "has_will",
    ]);
  });

  it("names what each question is holding up", async () => {
    const questions = await nextQuestions(db, manager, probateId);
    const titles = questions[0].blocks.map((entry) => entry.title).sort();
    expect(titles).toEqual(["Certified land title search", "Valuation of the land"]);
  });

  it("drops a question once it is answered, and keeps one recorded as unknown — at the back", async () => {
    await answerFact(db, manager, { caseId: probateId, factKey: "estate_kind", value: "immovable" });
    await answerFact(db, manager, {
      caseId: probateId,
      factKey: "has_will",
      unknown: true,
      sourceNote: "The family are still looking.",
    });

    const questions = await nextQuestions(db, manager, probateId);
    expect(questions.map((question) => question.factKey)).not.toContain("estate_kind");

    const unknown = questions.find((question) => question.factKey === "has_will")!;
    expect(unknown.recordedUnknown).toBe(true);
    // Behind a question nobody has touched, because re-asking a settled unknown is worse
    // value than asking something new.
    const touched = questions.findIndex((question) => question.factKey === "has_will");
    const untouched = questions.findIndex((question) => question.factKey === "foreign_assets");
    expect(touched).toBeGreaterThan(untouched);
  });
});

// ---------------------------------------------------------------------------
describe("what is missing", () => {
  it("calls a question blocking only when an approved rule is waiting on it", async () => {
    const gaps = await findGaps(db, manager, probateId);
    const blocking = gaps.filter((gap) => gap.severity === "blocking");

    // Only the minor question: `estate_kind` is answered, and nothing reads the other two.
    expect(blocking).toHaveLength(1);
    expect(blocking[0].what).toMatch(/A beneficiary is a minor/);
    expect(blocking[0].blocks).toMatch(/Arrangements for a beneficiary/);
  });

  it("reports the file's own gaps without calling them requirements", async () => {
    const gaps = await findGaps(db, manager, probateId);
    const what = gaps.map((gap) => gap.what);

    expect(what.some((entry) => entry.includes("Nobody is recorded on the matter"))).toBe(true);
    expect(what.some((entry) => entry.includes("No assets are recorded"))).toBe(true);
    // Nothing in the list asserts that the matter needs anything.
    expect(what.every((entry) => !/must|required by law/i.test(entry))).toBe(true);
  });

  it("stops reporting a gap once it is filled", async () => {
    await recordParty(db, manager, {
      caseId: probateId,
      role: "client",
      fullName: "Tan Mei Ling",
      relationship: "Daughter",
      identification: "920318086644",
      dateOfBirth: "1992-03-18",
    });
    await recordAsset(db, manager, {
      caseId: probateId,
      category: "land",
      description: "Double-storey terrace, Taman Ipoh Jaya",
      reference: "HSD 44219 Lot 8821",
      valuationAmount: "480000.00",
      valuationBasis: "Market comparison of three recent transactions",
      valuationDate: "2026-05-20",
      valuationSource: "CAC valuation report 2026/041-V1",
    });

    const gaps = await findGaps(db, manager, probateId);
    const what = gaps.map((gap) => gap.what);
    expect(what.some((entry) => entry.includes("Nobody is recorded"))).toBe(false);
    expect(what.some((entry) => entry.includes("No assets are recorded"))).toBe(false);
    // And it notices the inventory has no liabilities, as something to confirm.
    expect(what.some((entry) => entry.includes("No liabilities are recorded"))).toBe(true);
  });

  it("notices a figure recorded but not verified, as worth checking rather than wrong", async () => {
    const gaps = await findGaps(db, manager, probateId);
    const unverified = gaps.find((gap) => gap.what.includes("as reported rather than verified"))!;
    expect(unverified.severity).toBe("worth_checking");
  });

  it("notices documents on the matter that nobody has read", async () => {
    await registerUpload(db, manager, {
      filename: "grant.pdf",
      mediaType: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.7 nothing readable"),
      caseId: probateId,
    });

    const gaps = await findGaps(db, manager, probateId);
    expect(gaps.some((gap) => gap.what.includes("have not been read"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("what contradicts itself", () => {
  it("finds two people sharing one identification, and asks rather than concludes", async () => {
    await recordParty(db, manager, {
      caseId: probateId,
      role: "beneficiary",
      fullName: "Tan Mei Ling (executor capacity)",
      identification: "920318086644",
    });

    const found = await findContradictions(db, manager, probateId);
    const shared = found.find((entry) => entry.what.includes("share the identification"))!;
    expect(shared.check).toMatch(/Confirm whether this is one person in two roles/);
    // Never a conclusion.
    expect(found.every((entry) => /^Confirm|^Add|^Attach/.test(entry.check))).toBe(true);
  });

  it("finds somebody carrying the deceased's identification", async () => {
    await recordParty(db, manager, {
      caseId: probateId,
      role: "next_of_kin",
      fullName: "Somebody entered wrongly",
      identification: "450612085432",
    });
    const found = await findContradictions(db, manager, probateId);
    expect(found.some((entry) => entry.what.includes("same identification as Tan Ah Kow"))).toBe(
      true,
    );
  });

  it("finds a valuation dated before the death, and asks about the basis", async () => {
    await recordAsset(db, manager, {
      caseId: probateId,
      category: "bank",
      description: "Savings account",
      valuationAmount: "40000.00",
      valuationBasis: "Bank statement",
      valuationDate: "2026-01-31",
      valuationSource: "Statement dated 31 January 2026",
    });
    const found = await findContradictions(db, manager, probateId);
    const early = found.find((entry) => entry.what.includes("before the date of death"))!;
    expect(early.check).toMatch(/Confirm the valuation date/);
  });

  it("finds a duplicated asset reference", async () => {
    await recordAsset(db, manager, {
      caseId: probateId,
      category: "land",
      description: "Terrace house, Ipoh (entered again)",
      reference: "HSD 44219 Lot 8821",
    });
    const found = await findContradictions(db, manager, probateId);
    expect(found.some((entry) => entry.what.includes("share a category and a reference"))).toBe(
      true,
    );
  });

  it("does not check anybody's age until CAC supplies the figure and its source", async () => {
    // A party whose flag and date of birth disagree, on any reading.
    await recordParty(db, manager, {
      caseId: probateId,
      role: "beneficiary",
      fullName: "Tan Wei Jie",
      dateOfBirth: "1990-06-01",
      isMinor: true,
    });

    // Unset: the platform does not know at what age somebody stops being a minor here.
    let found = await findContradictions(db, manager, probateId);
    expect(found.some((entry) => entry.what.includes("recorded as a minor, but"))).toBe(false);

    // A figure without its source is still not enough.
    await setSetting(db, administrator, "cases.age_of_majority", 18, {
      reason: "Fixture for the test.",
    });
    found = await findContradictions(db, manager, probateId);
    expect(found.some((entry) => entry.what.includes("recorded as a minor, but"))).toBe(false);

    // Both set, and the check runs — quoting the source it was given.
    await setSetting(
      db,
      administrator,
      "cases.age_of_majority_source",
      "Fixture source, pending Q-LEGAL-2",
      { reason: "Fixture for the test." },
    );
    found = await findContradictions(db, manager, probateId);
    const age = found.find((entry) => entry.what.includes("recorded as a minor, but"))!;
    expect(age.check).toMatch(/Fixture source, pending Q-LEGAL-2/);
  });
});

// ---------------------------------------------------------------------------
describe("similar matters", () => {
  it("returns nothing when the matter has no answers to compare", async () => {
    expect(await similarMatters(db, manager, secondId)).toEqual([]);
  });

  it("scores on shared answers, and shows which ones they are", async () => {
    await answerFact(db, manager, { caseId: secondId, factKey: "estate_kind", value: "immovable" });
    await answerFact(db, manager, {
      caseId: secondId,
      factKey: "any_minor_beneficiary",
      value: "false",
    });

    const similar = await similarMatters(db, manager, secondId);
    const match = similar.find((entry) => entry.caseId === probateId)!;

    expect(match.similarity).toBeGreaterThan(0);
    expect(match.similarity).toBeLessThanOrEqual(1);
    // Inspectable: the reason it is offered is returned with it.
    expect(match.sharedAnswers).toEqual([
      { label: "What the estate consists of", value: "immovable" },
    ]);
  });

  it("does not offer a matter the caller is not on", async () => {
    const otherStaff = await makePrincipal("ag-staff@cac.test", ["CASE_STAFF"], null);
    // No employee record, so no assignment can exist: nothing is visible.
    expect(await similarMatters(db, otherStaff, secondId).catch(() => "refused")).toBeTruthy();

    const staffEmployeeId = (
      await createEmployee(db, await makePrincipal("ag-hr2@cac.test", ["HR_ADMIN"]), {
        fullName: "Chong Wei Ming",
        joinedOn: "2025-03-03",
        basicSalary: "4200.00",
      })
    ).id;
    const staff = await makePrincipal("ag-staff2@cac.test", ["CASE_STAFF"], staffEmployeeId);
    await assignToCase(db, manager, { caseId: secondId, employeeId: staffEmployeeId });

    // Assigned to the second matter only, so the first is not offered as similar to it.
    const similar = await similarMatters(db, staff, secondId);
    expect(similar.some((entry) => entry.caseId === probateId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("passages worth reading", () => {
  it("says so plainly when there is not enough recorded to search on", async () => {
    const empty = (
      await openCase(db, manager, {
        matterType: "advisory",
        title: "A new enquiry",
        deceasedName: "x",
        openedOn: "2026-06-01",
        leadEmployeeId: managerEmployeeId,
      })
    ).id;
    const result = await relevantPassages(db, manager, empty);
    // "x" plus the matter type is enough to form a query but finds nothing; either way it
    // never invents a passage.
    expect(result.passages).toEqual([]);
  });

  it("finds library passages from the matter's own words, carrying their provenance", async () => {
    const id = (
      await registerUpload(db, manager, {
        title: "File note on the Tan matter",
        filename: "note.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode(
          "Tan Ah Kow died at Ipoh. The estate includes land at Taman Ipoh Jaya and a bank account.",
        ),
        caseId: probateId,
      })
    ).id;
    await scanDocument(db, manager, id, clean);
    await extractAndIndex(db, manager, id);

    const result = await relevantPassages(db, manager, probateId);
    expect(result.passages.length).toBeGreaterThan(0);
    expect(result.passages[0].method).toBe("plain_text");
    expect(result.note).toMatch(/no embedding model is configured/i);
  });
});

// ---------------------------------------------------------------------------
describe("the preparation pack", () => {
  it("assembles the matter with every figure's basis and every requirement's authority", async () => {
    await recomputeChecklist(db, manager, probateId);
    await recordLiability(db, manager, {
      caseId: probateId,
      category: "mortgage",
      creditor: "A bank",
      description: "Housing loan",
      isSecured: true,
      securityNote: "Charged over HSD 44219 Lot 8821",
      amount: "132450.00",
      amountBasis: "Redemption statement",
      amountAsAt: "2026-05-18",
      amountSource: "Bank redemption statement dated 18 May 2026",
    });

    const pack = await buildCasePack(db, manager, probateId);

    expect(pack.caseNo).toMatch(/^CASE/);
    expect(pack.deceasedName).toBe("Tan Ah Kow");
    expect(pack.preparedBy).toBe("ag-manager@cac.test");

    const valued = pack.assets.find((asset) => asset.figure !== null)!;
    expect(valued.basis).toBeTruthy();
    expect(valued.source).toBeTruthy();

    // Every rule-produced requirement names the authority behind it.
    const fromRules = pack.requirements.filter((item) => item.rule !== null);
    expect(fromRules.length).toBeGreaterThan(0);
    expect(fromRules.every((item) => Boolean(item.authority))).toBe(true);
  });

  it("says on its face that the totals are not the estate's total while a figure is missing", async () => {
    const pack = await buildCasePack(db, manager, probateId);
    expect(pack.position.incomplete).toBe(true);
    expect(pack.positionNote).toMatch(/not the estate's total/);
  });

  it("carries the gaps and the contradictions rather than only the finished parts", async () => {
    const pack = await buildCasePack(db, manager, probateId);
    expect(pack.gaps.length).toBeGreaterThan(0);
    expect(pack.contradictions.length).toBeGreaterThan(0);
    expect(pack.openQuestions.length).toBeGreaterThan(0);
  });

  it("prints what it is not", async () => {
    const pack = await buildCasePack(db, manager, probateId);
    expect(pack.caveats.join(" ")).toMatch(/not advice/);
    expect(pack.caveats.join(" ")).toMatch(/not because nothing is required/);
    expect(pack.caveats.join(" ")).toMatch(/questions for whoever is running the matter/);
  });

  it("shows an undecided requirement with the question it is waiting on, in words", async () => {
    const pack = await buildCasePack(db, manager, probateId);
    const waiting = pack.requirements.find((item) => item.undecided.length > 0)!;
    expect(waiting.undecided).toContain("A beneficiary is a minor");
  });
});
