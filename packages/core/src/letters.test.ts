import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import { hashPassword } from "./password.js";
import { AuthorizationError, resolveCapabilities, type Principal } from "./authz.js";

import { createEmployee } from "./people.js";
import {
  analyseTemplate,
  renderTemplate,
  toParagraphs,
  validateTemplateBody,
  type TemplateVariable,
} from "./templates.js";
import {
  approveLetter,
  approveTemplate,
  cancelLetter,
  generateLetter,
  getLetter,
  issueLetter,
  letterDefaults,
  listLetters,
  listTemplates,
  saveTemplate,
} from "./letters.js";

/**
 * Phase 8: employment letters.
 *
 * The property that matters is that **what somebody was told does not change.** A
 * letter keeps its own copy of the wording and the values, so revising the template
 * next year cannot alter what was sent this year — and the test for that is the last
 * one here.
 *
 * Before that: the engine refuses to produce a letter with a placeholder left in it or
 * a required figure left blank, because both are documents somebody would act on.
 */

let db: Database;
let close: () => Promise<void>;

let hrAdmin: Principal; // writes templates and generates letters
let director: Principal; // approves both
let accountant: Principal; // neither

let aishahId: string;

const variables: TemplateVariable[] = [
  { key: "employee_name", label: "Employee name", type: "text" },
  { key: "position", label: "Position", type: "text" },
  { key: "joined_on", label: "Joining date", type: "date" },
  { key: "basic_salary", label: "Basic salary", type: "money" },
  { key: "probation_months", label: "Probation (months)", type: "number" },
  { key: "letter_date", label: "Letter date", type: "date" },
  { key: "has_car_allowance", label: "Car allowance applies", type: "boolean", required: false },
  { key: "car_allowance", label: "Car allowance", type: "money", required: false },
];

const body = `Dear {{employee_name}},

We are pleased to offer you the position of {{position}}, beginning {{joined_on}}.

Your basic salary will be RM {{basic_salary}} per month. You will serve a probationary
period of {{probation_months}} months.
{{#if has_car_allowance}}
You will also receive a car allowance of RM {{car_allowance}} per month.
{{/if}}

Yours sincerely,`;

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
  };
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  await runMigrations(db);
  await seed(db);

  hrAdmin = await makePrincipal("lt-hr@cac.test", ["HR_ADMIN"]);
  director = await makePrincipal("lt-director@cac.test", ["DIRECTOR"]);
  accountant = await makePrincipal("lt-accountant@cac.test", ["ACCOUNTANT"]);

  aishahId = (
    await createEmployee(db, hrAdmin, {
      fullName: "Aishah binti Rahman",
      joinedOn: "2026-02-02",
      basicSalary: "4500.00",
      probationMonths: 3,
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await close();
});

// ---------------------------------------------------------------------------
describe("the template engine", () => {
  it("finds what a body uses and what it declares needlessly", () => {
    const analysis = analyseTemplate("Dear {{name}}, your {{thing}} is ready.", [
      { key: "name", label: "Name", type: "text" },
      { key: "spare", label: "Spare", type: "text" },
    ]);

    expect(analysis.used).toEqual(["name", "thing"]);
    expect(analysis.undeclared).toEqual(["thing"]);
    expect(analysis.unused).toEqual(["spare"]);
  });

  it("refuses an unclosed conditional, which would swallow the rest of the letter", () => {
    expect(() => validateTemplateBody("a {{#if x}} b")).toThrow(/never closed/);
    expect(() => validateTemplateBody("a {{/if}} b")).toThrow(/no \{\{#if\}\}/);
    expect(() => validateTemplateBody("{{#if x}}a{{else}}b{{else}}c{{/if}}")).toThrow(
      /two \{\{else\}\}/,
    );
  });

  it("refuses to render a placeholder it was never told about", () => {
    expect(() =>
      renderTemplate("Dear {{name}}, ref {{secret}}", [{ key: "name", label: "Name", type: "text" }], {
        name: "Aishah",
      }),
    ).toThrow(/not declared/);
  });

  it("refuses to render a required value that is blank", () => {
    expect(() =>
      renderTemplate(
        "Your salary is RM {{salary}}.",
        [{ key: "salary", label: "Basic salary", type: "money" }],
        {},
      ),
    ).toThrow(/Basic salary/);
  });

  it("allows an optional value to be absent", () => {
    const rendered = renderTemplate(
      "Hello{{#if extra}}, and {{extra}}{{/if}}.",
      [{ key: "extra", label: "Extra", type: "text", required: false }],
      {},
    );
    expect(rendered).toBe("Hello.");
  });

  it("formats money and dates the way a letter writes them", () => {
    const rendered = renderTemplate(
      "RM {{amount}} from {{when}}.",
      [
        { key: "amount", label: "Amount", type: "money" },
        { key: "when", label: "When", type: "date" },
      ],
      { amount: "4500", when: "2026-04-06" },
    );
    expect(rendered).toBe("RM 4,500.00 from 6 April 2026.");
  });

  it("resolves nested conditionals from the inside out", () => {
    const template = "{{#if a}}A{{#if b}}B{{else}}notB{{/if}}{{else}}notA{{/if}}";
    const declared: TemplateVariable[] = [
      { key: "a", label: "A", type: "boolean", required: false },
      { key: "b", label: "B", type: "boolean", required: false },
    ];

    expect(renderTemplate(template, declared, { a: true, b: true })).toBe("AB");
    expect(renderTemplate(template, declared, { a: true, b: false })).toBe("AnotB");
    expect(renderTemplate(template, declared, { a: false, b: true })).toBe("notA");
  });

  it("refuses an undeclared placeholder even inside a branch that is not taken", () => {
    // It would render as literal braces the first time that branch *is* taken, so
    // catching it regardless of the values is the safer behaviour.
    expect(() =>
      renderTemplate(
        "{{#if show}}{{secret}}{{/if}}visible",
        [{ key: "show", label: "Show", type: "boolean", required: false }],
        { show: false },
      ),
    ).toThrow(/not declared/);
  });

  it("does not render a declared placeholder from a branch that was not taken", () => {
    const rendered = renderTemplate(
      "{{#if show}}{{hidden}}{{/if}}visible",
      [
        { key: "show", label: "Show", type: "boolean", required: false },
        { key: "hidden", label: "Hidden", type: "text", required: false },
      ],
      { show: false, hidden: "should not appear" },
    );
    expect(rendered).toBe("visible");
  });

  it("splits text into paragraphs the way somebody typed them", () => {
    const paragraphs = toParagraphs("One.\nStill one.\n\nTwo.\n\n\nThree.");
    expect(paragraphs).toEqual([["One.", "Still one."], ["Two."], ["Three."]]);
  });
});

// ---------------------------------------------------------------------------
describe("templates", () => {
  let templateId: string;

  it("refuses a body using an undeclared placeholder", async () => {
    await expect(
      saveTemplate(db, hrAdmin, {
        code: "APPT",
        name: "Appointment letter",
        kind: "appointment",
        subject: "Offer of employment",
        body: "Dear {{employee_name}}, your bonus is {{bonus}}.",
        variables: [{ key: "employee_name", label: "Name", type: "text" }],
      }),
    ).rejects.toThrow(/\{\{bonus\}\}/);
  });

  it("refuses a duplicate variable key", async () => {
    await expect(
      saveTemplate(db, hrAdmin, {
        code: "APPT",
        name: "Appointment letter",
        kind: "appointment",
        subject: "Offer",
        body: "Dear {{name}}.",
        variables: [
          { key: "name", label: "Name", type: "text" },
          { key: "name", label: "Name again", type: "text" },
        ],
      }),
    ).rejects.toThrow(/declared twice/);
  });

  it("saves a version", async () => {
    const created = await saveTemplate(db, hrAdmin, {
      code: "APPT",
      name: "Appointment letter",
      kind: "appointment",
      subject: "Offer of employment — {{position}}",
      body,
      variables,
      sourceRef: "CAC's existing Word template, as supplied",
    });
    templateId = created.id;
    expect(created.version).toBe(1);
  });

  it("is not something an accountant may write", async () => {
    await expect(
      saveTemplate(db, accountant, {
        code: "NOPE",
        name: "No",
        kind: "custom",
        subject: "No",
        body: "No.",
        variables: [],
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("cannot be used to write to somebody while it is a draft", async () => {
    await expect(
      generateLetter(db, hrAdmin, {
        employeeId: aishahId,
        templateCode: "APPT",
        values: {},
      }),
    ).rejects.toThrow(/no approved template/);
  });

  it("is not something whoever writes templates may approve", async () => {
    // HR_ADMIN writes templates and generates letters; approving the firm's own form of
    // words is a director's act. Two different refusals, both correct.
    await expect(approveTemplate(db, hrAdmin, templateId)).rejects.toThrow(AuthorizationError);
  });

  it("will not let the same person write and approve one", async () => {
    // HR_MANAGER holds both capabilities, so it is the only principal that could try.
    const both = await makePrincipal("lt-both@cac.test", ["HR_MANAGER"]);

    const own = await saveTemplate(db, both, {
      code: "SELFAPP",
      name: "Written by the approver",
      kind: "custom",
      subject: "Test",
      body: "Dear {{employee_name}}.",
      variables: [{ key: "employee_name", label: "Name", type: "text" }],
    });

    await expect(approveTemplate(db, both, own.id)).rejects.toThrow(/cannot approve/i);
  });

  it("is approved by a second person", async () => {
    await approveTemplate(db, director, templateId);

    const templates = await listTemplates(db);
    expect(templates.find((row) => row.id === templateId)?.status).toBe("approved");
  });

  it("will not let an approved version's wording change", async () => {
    await expect(
      saveTemplate(db, hrAdmin, {
        templateId,
        code: "APPT",
        name: "Appointment letter",
        kind: "appointment",
        subject: "Offer",
        body: "Something else entirely, {{employee_name}}.",
        variables,
      }),
    ).rejects.toThrow(/Create a new version/);

    await expect(
      db.execute(sql`UPDATE hr.letter_template SET body = 'rewritten' WHERE id = ${templateId}`),
    ).rejects.toThrow(/wording is fixed/);
  });
});

// ---------------------------------------------------------------------------
describe("letters", () => {
  let letterId: string;

  it("fills what it can from the employee record", async () => {
    const defaults = await letterDefaults(db, aishahId);
    expect(defaults.employee_name).toBe("Aishah binti Rahman");
    expect(defaults.joined_on).toBe("2026-02-02");
    expect(defaults.basic_salary).toBe("4500.0000");
  });

  it("refuses to generate one with a required figure missing", async () => {
    await expect(
      generateLetter(db, hrAdmin, {
        employeeId: aishahId,
        templateCode: "APPT",
        values: { employee_name: "Aishah binti Rahman", position: "Investigator" },
      }),
    ).rejects.toThrow(/Joining date|Basic salary/);
  });

  it("refuses a date that is not a date", async () => {
    await expect(
      generateLetter(db, hrAdmin, {
        employeeId: aishahId,
        templateCode: "APPT",
        values: {
          employee_name: "Aishah",
          position: "Investigator",
          joined_on: "next Tuesday",
          basic_salary: "4500",
          probation_months: "3",
        },
      }),
    ).rejects.toThrow(/Joining date/);
  });

  it("generates one, rendering the words and keeping a copy of the template", async () => {
    const created = await generateLetter(db, hrAdmin, {
      employeeId: aishahId,
      templateCode: "APPT",
      letterDate: "2026-01-20",
      values: {
        employee_name: "Aishah binti Rahman",
        position: "Forensic Investigator",
        joined_on: "2026-02-02",
        basic_salary: "4,500",
        probation_months: "3",
        has_car_allowance: "false",
      },
    });
    letterId = created.id;

    const letter = await getLetter(db, letterId);
    expect(letter?.bodyRendered).toContain("Dear Aishah binti Rahman");
    expect(letter?.bodyRendered).toContain("RM 4,500.00 per month");
    expect(letter?.bodyRendered).toContain("beginning 2 February 2026");
    // The optional clause was not taken, and left nothing behind.
    expect(letter?.bodyRendered).not.toContain("car allowance");
    expect(letter?.bodyRendered).not.toContain("{{");

    // The subject is rendered too, so it can carry the position.
    expect(letter?.subject).toBe("Offer of employment — Forensic Investigator");

    // And the letter carries its own copy of everything.
    expect(letter?.templateVersion).toBe(1);
    expect(letter?.variables).toHaveLength(variables.length);
    expect(letter?.valuesUsed.position).toBe("Forensic Investigator");
  });

  it("includes an optional clause when it is asked for", async () => {
    const created = await generateLetter(db, hrAdmin, {
      employeeId: aishahId,
      templateCode: "APPT",
      letterDate: "2026-01-21",
      values: {
        employee_name: "Aishah binti Rahman",
        position: "Forensic Investigator",
        joined_on: "2026-02-02",
        basic_salary: "4500",
        probation_months: "3",
        has_car_allowance: "true",
        car_allowance: "300",
      },
    });

    const letter = await getLetter(db, created.id);
    expect(letter?.bodyRendered).toContain("car allowance of RM 300.00");

    await cancelLetter(db, hrAdmin, created.id, "Fixture only");
  });

  it("lets an appointment letter predate the joining date, but not a warning", async () => {
    // The appointment letter above is dated 20 January for a 2 February start, which is
    // the normal way round.
    const letter = await getLetter(db, letterId);
    expect(letter?.letterDate).toBe("2026-01-20");

    await saveTemplate(db, hrAdmin, {
      code: "WARN",
      name: "Warning letter",
      kind: "warning",
      subject: "Warning",
      body: "Dear {{employee_name}}, this is a warning dated {{letter_date}}.",
      variables: [
        { key: "employee_name", label: "Name", type: "text" },
        { key: "letter_date", label: "Letter date", type: "date" },
      ],
    });
    const warnTemplate = (await listTemplates(db)).find((row) => row.code === "WARN")!;
    await approveTemplate(db, director, warnTemplate.id);

    await expect(
      generateLetter(db, hrAdmin, {
        employeeId: aishahId,
        templateCode: "WARN",
        letterDate: "2026-01-10",
        values: { employee_name: "Aishah binti Rahman" },
      }),
    ).rejects.toThrow(/cannot be dated before/);
  });

  it("needs a second person to approve it, and is not issued before that", async () => {
    await expect(issueLetter(db, hrAdmin, letterId)).rejects.toThrow(/has not been approved/);

    // Whoever generated it cannot approve it; and in this catalogue HR_ADMIN cannot
    // approve a letter at all.
    await expect(approveLetter(db, hrAdmin, letterId)).rejects.toThrow(AuthorizationError);
    await approveLetter(db, director, letterId);

    const letter = await getLetter(db, letterId);
    expect(letter?.status).toBe("approved");
  });

  it("issues it, numbers it, and records how it was delivered", async () => {
    const issued = await issueLetter(db, hrAdmin, letterId, {
      deliveryNote: "Handed over in person, signed copy on file",
    });
    expect(issued.letterNo).toMatch(/^LTR-2026-/);

    const letter = await getLetter(db, letterId);
    expect(letter?.status).toBe("issued");
    expect(letter?.deliveryNote).toContain("Handed over");
  });

  it("will not change what somebody was given", async () => {
    await expect(
      db.execute(sql`UPDATE hr.letter SET body_rendered = 'rewritten' WHERE id = ${letterId}`),
    ).rejects.toThrow(/Supersede it/);

    await expect(
      db.execute(sql`UPDATE hr.letter SET status = 'draft' WHERE id = ${letterId}`),
    ).rejects.toThrow(/cannot be un-issued/);

    await expect(
      db.execute(sql`DELETE FROM hr.letter WHERE id = ${letterId}`),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it("will not cancel an issued letter — it supersedes it instead", async () => {
    await expect(cancelLetter(db, hrAdmin, letterId, "changed my mind")).rejects.toThrow(
      /Supersede it/,
    );
  });

  it("supersedes it with a correction, visible from both", async () => {
    const correction = await generateLetter(db, hrAdmin, {
      employeeId: aishahId,
      templateCode: "APPT",
      letterDate: "2026-01-22",
      values: {
        employee_name: "Aishah binti Rahman",
        position: "Senior Forensic Investigator",
        joined_on: "2026-02-02",
        basic_salary: "4800",
        probation_months: "3",
      },
      supersedesLetterId: letterId,
      notes: "Corrects the position and salary in the original offer",
    });

    await approveLetter(db, director, correction.id);
    await issueLetter(db, hrAdmin, correction.id);

    const corrected = await getLetter(db, correction.id);
    const original = await getLetter(db, letterId);

    expect(corrected?.supersedesLetterNo).toBe(original?.letterNo);
    expect(original?.supersededByNo).toBe(corrected?.letterNo);
    // The original still says what it said.
    expect(original?.bodyRendered).toContain("RM 4,500.00");
  });

  it("refuses a letter that would supersede itself", async () => {
    await expect(
      db.execute(sql`UPDATE hr.letter SET supersedes_letter_id = id WHERE id = ${letterId}`),
    ).rejects.toThrow(/supersede itself/);
  });
});

// ---------------------------------------------------------------------------
describe("the property the phase exists for", () => {
  it("keeps what somebody was told, after the template is revised", async () => {
    const before = await getLetter(db, (await listLetters(db, { status: "issued" }))[0]!.id);

    // A new version of the appointment letter, with different wording entirely.
    const revised = await saveTemplate(db, hrAdmin, {
      code: "APPT",
      name: "Appointment letter",
      kind: "appointment",
      subject: "Your appointment",
      body: "Dear {{employee_name}}, terms as discussed. Salary RM {{basic_salary}}.",
      variables: [
        { key: "employee_name", label: "Name", type: "text" },
        { key: "basic_salary", label: "Basic salary", type: "money" },
      ],
    });
    expect(revised.version).toBe(2);
    await approveTemplate(db, director, revised.id);

    // Only one approved version at a time, so generating now uses version 2.
    const templates = await listTemplates(db);
    const approved = templates.filter((row) => row.code === "APPT" && row.status === "approved");
    expect(approved).toHaveLength(1);
    expect(approved[0]!.version).toBe(2);

    // And the letter already issued is word for word what it was.
    const after = await getLetter(db, before!.id);
    expect(after!.bodyRendered).toBe(before!.bodyRendered);
    expect(after!.templateVersion).toBe(1);
    expect(after!.bodyRendered).toContain("We are pleased to offer you the position of");
  });

  it("keeps a template version that letters were written from", async () => {
    const templates = await listTemplates(db);
    const version1 = templates.find((row) => row.code === "APPT" && row.version === 1)!;

    expect(version1.status).toBe("retired");
    expect(version1.lettersGenerated).toBeGreaterThan(0);

    await expect(
      db.execute(sql`DELETE FROM hr.letter_template WHERE id = ${version1.id}`),
    ).rejects.toThrow(/cannot be deleted/);
  });
});
