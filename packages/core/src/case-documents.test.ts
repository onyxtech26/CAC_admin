import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import { hashPassword } from "./password.js";
import { AuthorizationError, resolveCapabilities, type Principal } from "./authz.js";
import { createEmployee } from "./people.js";
import { setSetting } from "./settings.js";
import type { TemplateVariable } from "./templates.js";

import {
  approveCaseDocument,
  approveCaseDocumentTemplate,
  cancelCaseDocument,
  caseDocumentDefaults,
  coerceValues,
  finaliseCaseDocument,
  generateCaseDocument,
  getGeneratedDocument,
  listCaseDocumentTemplates,
  listGeneratedDocuments,
  saveCaseDocumentTemplate,
} from "./case-documents.js";
import { openCase } from "./cases.js";
import { recordAsset, recordLiability, recordParty } from "./case-file.js";
import {
  deleteDocument,
  extractAndIndex,
  getLibraryDocument,
  searchLibrary,
} from "./library.js";

/**
 * Phase 12: documents generated for a matter.
 *
 * What is being proved:
 *
 *   * **A document keeps its own copy of everything that produced it** — the template body,
 *     the variables, the values, the rendered text, and a snapshot of the matter. Revising
 *     the template afterwards cannot change what was produced, and the snapshot shows what
 *     the estate looked like when the document described it.
 *   * **Approval of anything legal is refused until a qualified reviewer has been appointed**
 *     (Q-LEGAL-1), by the director as much as by anybody else.
 *   * **Finalising stores the PDF once**, immutably, with its checksum on the record — and
 *     that file cannot then be destroyed out from under the document.
 *   * **Whether a model was involved is on the record**, and on every row this platform can
 *     produce it is null.
 */

let db: Database;
let close: () => Promise<void>;

let author: Principal; // case.document.generate
let reviewer: Principal; // case.document.approve
let administrator: Principal; // admin.settings.manage
let director: Principal; // doc.delete, for the destruction test

let caseId: string;
let templateId: string;

const variables: TemplateVariable[] = [
  { key: "case_no", label: "Case number", type: "text" },
  { key: "deceased_name", label: "Name of the deceased", type: "text" },
  { key: "date_of_death", label: "Date of death", type: "date" },
  { key: "applicant_name", label: "Applicant", type: "text" },
  { key: "asset_total", label: "Total assets", type: "money" },
  { key: "document_date", label: "Date of the document", type: "date" },
  { key: "has_will", label: "There is a will", type: "boolean", required: false },
  { key: "will_date", label: "Date of the will", type: "date", required: false },
];

const body = `IN THE HIGH COURT OF MALAYA

In the matter of the estate of {{deceased_name}}, deceased.

The applicant, {{applicant_name}}, states that {{deceased_name}} died on {{date_of_death}}.
The estate recorded to date amounts to RM {{asset_total}}.
{{#if has_will}}
The deceased left a will dated {{will_date}}.
{{else}}
No will has been produced.
{{/if}}

Dated {{document_date}}. Our reference {{case_no}}.`;

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

  const hrAdmin = await makePrincipal("cd-hr@cac.test", ["HR_ADMIN"]);
  const authorEmployeeId = (
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

  author = await makePrincipal("cd-author@cac.test", ["CASE_MANAGER"], authorEmployeeId);
  reviewer = await makePrincipal(
    "cd-reviewer@cac.test",
    ["LAWYER_OR_AUTHORISED_REVIEWER"],
    reviewerEmployeeId,
  );
  administrator = await makePrincipal("cd-admin@cac.test", ["SUPER_ADMIN"]);
  director = await makePrincipal("cd-director@cac.test", ["DIRECTOR"], reviewerEmployeeId);

  caseId = (
    await openCase(db, author, {
      matterType: "probate",
      title: "Estate of Tan Ah Kow",
      deceasedName: "Tan Ah Kow",
      dateOfDeath: "2026-04-11",
      openedOn: "2026-05-04",
      leadEmployeeId: authorEmployeeId,
    })
  ).id;

  await recordParty(db, author, {
    caseId,
    role: "executor",
    fullName: "Tan Mei Ling",
    relationship: "Daughter",
  });
  await recordAsset(db, author, {
    caseId,
    category: "land",
    description: "Double-storey terrace, Taman Ipoh Jaya",
    valuationAmount: "480000.00",
    valuationBasis: "Market comparison",
    valuationDate: "2026-05-20",
    valuationSource: "CAC valuation report 2026/041-V1",
  });
  await recordLiability(db, author, {
    caseId,
    category: "mortgage",
    creditor: "A bank",
    description: "Housing loan",
    amount: "132450.00",
    amountBasis: "Redemption statement",
    amountAsAt: "2026-05-18",
    amountSource: "Statement dated 18 May 2026",
  });
}, 180_000);

afterAll(async () => {
  await close();
});

// ---------------------------------------------------------------------------
describe("templates for case documents", () => {
  it("refuses an application whose wording cites no form or precedent", async () => {
    await expect(
      saveCaseDocumentTemplate(db, author, {
        code: "PROBATE_APP",
        name: "Application for a grant of probate",
        kind: "application",
        title: "Application for a grant of probate",
        body,
        variables,
      }),
    ).rejects.toThrow(/names the form or precedent/);
  });

  it("refuses a placeholder nothing declares, including inside a branch not taken", async () => {
    await expect(
      saveCaseDocumentTemplate(db, author, {
        code: "PROBATE_APP",
        name: "Application",
        kind: "application",
        title: "Application",
        body: body + "\n{{#if has_will}}{{executor_address}}{{/if}}",
        variables,
        sourceRef: "fixture",
      }),
    ).rejects.toThrow(/nothing declares/);
  });

  it("refuses a matter type nothing can be", async () => {
    // These were concatenated into a Postgres array literal from the form with no allow-list. A
    // posted `probate","la` became two elements; a quote or a backslash made the literal malformed
    // and the request a 500. And a template claiming a type no case can have is silently unusable
    // for ever, because the generation trigger compares the case's type against this list.
    await expect(
      saveCaseDocumentTemplate(db, author, {
        code: "PROBATE_APP",
        name: "Application",
        kind: "application",
        matterTypes: ['probate","letters_of_administration'],
        title: "Application",
        body,
        variables,
        sourceRef: "fixture",
      }),
    ).rejects.toThrow(/is not a kind of matter/);
  });

  it("takes a draft, which cannot produce anything", async () => {
    const saved = await saveCaseDocumentTemplate(db, author, {
      code: "PROBATE_APP",
      name: "Application for a grant of probate",
      kind: "application",
      matterTypes: ["probate"],
      title: "Application for a grant of probate",
      body,
      variables,
      sourceRef: "CAC precedent file, 2026 — placeholder pending Q-LEGAL-2",
    });
    templateId = saved.id;
    expect(saved.version).toBe(1);

    await expect(
      generateCaseDocument(db, author, { caseId, templateId, values: {} }),
    ).rejects.toThrow(/Only an approved template produces a document/);
  });

  it("refuses approval while no qualified reviewer has been appointed", async () => {
    // The capability is held; the appointment has not been confirmed. Both are needed.
    expect(reviewer.capabilities.has("case.document.approve")).toBe(true);
    await expect(approveCaseDocumentTemplate(db, reviewer, templateId)).rejects.toThrow(
      /No authorised legal reviewer has been appointed/,
    );
    // Not even the director.
    await expect(approveCaseDocumentTemplate(db, director, templateId)).rejects.toThrow(
      /Q-LEGAL-1/,
    );
  });

  it("approves it once the appointment is confirmed, by somebody other than the author", async () => {
    await setSetting(db, administrator, "cases.legal_reviewer_confirmed", true, {
      reason: "Fixture: a named reviewer has been appointed for the purposes of the test.",
    });

    await expect(approveCaseDocumentTemplate(db, author, templateId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );

    await approveCaseDocumentTemplate(db, reviewer, templateId);
    const templates = await listCaseDocumentTemplates(db, { status: "approved" });
    expect(templates.map((template) => template.code)).toContain("PROBATE_APP");
  });

  it("fixes the wording of an approved version, at the database", async () => {
    await expect(
      db.execute(sql`
        UPDATE estate.document_template SET body = 'Something else' WHERE id = ${templateId}
      `),
    ).rejects.toThrow(/approved and its wording is fixed/);
  });
});

// ---------------------------------------------------------------------------
describe("generating a document", () => {
  let documentId: string;

  it("suggests values from what the matter already knows", async () => {
    const defaults = await caseDocumentDefaults(db, author, caseId, variables);
    expect(defaults.deceased_name).toBe("Tan Ah Kow");
    expect(defaults.date_of_death).toBe("2026-04-11");
    expect(defaults.applicant_name).toBe("Tan Mei Ling");
    expect(defaults.asset_total).toBe("480,000.00");
    expect(defaults.case_no).toMatch(/^CASE/);
  });

  it("refuses a value that is not what the variable declares", async () => {
    await expect(
      generateCaseDocument(db, author, {
        caseId,
        templateId,
        values: {
          case_no: "CASE-2026-00001",
          deceased_name: "Tan Ah Kow",
          date_of_death: "next Tuesday",
          applicant_name: "Tan Mei Ling",
          asset_total: "480000.00",
          document_date: "2026-06-01",
        },
      }),
    ).rejects.toThrow(/Date of death is not a date/);
  });

  it("refuses to leave a required value blank", async () => {
    await expect(
      generateCaseDocument(db, author, {
        caseId,
        templateId,
        values: { deceased_name: "Tan Ah Kow" },
      }),
    ).rejects.toThrow(/no value/);
  });

  it("renders once and keeps everything that produced it", async () => {
    const defaults = await caseDocumentDefaults(db, author, caseId, variables);
    const generated = await generateCaseDocument(db, author, {
      caseId,
      templateId,
      values: { ...defaults, asset_total: "480000.00", has_will: false },
    });
    documentId = generated.id;
    expect(generated.documentNo).toMatch(/^CDOC/);

    const document = (await getGeneratedDocument(db, author, documentId))!;
    expect(document.bodyRendered).toContain("Tan Ah Kow");
    expect(document.bodyRendered).toContain("No will has been produced.");
    expect(document.bodyRendered).not.toContain("{{");
    // The template, the variables and the values are all on the document.
    expect(document.bodyTemplate).toBe(body);
    expect(document.variables).toHaveLength(variables.length);
    expect(document.valuesUsed.deceased_name).toBe("Tan Ah Kow");
    expect(document.templateCode).toBe("PROBATE_APP");
    expect(document.templateVersion).toBe(1);
    expect(document.sourceRef).toMatch(/pending Q-LEGAL-2/);
  });

  it("records what the matter looked like at that moment", async () => {
    const document = (await getGeneratedDocument(db, author, documentId))!;
    const snapshot = document.caseSnapshot as {
      assets: { total: number; unvalued: number };
      position: { assetTotal: string; net: string; incomplete: boolean };
      parties: { total: number; byRole: Record<string, number> };
    };

    expect(snapshot.assets.total).toBe(1);
    expect(snapshot.position.assetTotal).toBe("480,000.00");
    expect(snapshot.position.net).toBe("347,550.00");
    expect(snapshot.position.incomplete).toBe(false);
    expect(snapshot.parties.byRole.executor).toBe(1);
  });

  it("says no model was involved, because none was", async () => {
    const document = (await getGeneratedDocument(db, author, documentId))!;
    expect(document.modelName).toBeNull();
    expect(document.modelVersion).toBeNull();
    expect(document.assistantUsed).toBe(false);
  });

  it("does not change when the matter moves on", async () => {
    await recordAsset(db, author, {
      caseId,
      category: "bank",
      description: "A savings account found later",
      valuationAmount: "40000.00",
      valuationBasis: "Bank statement",
      valuationDate: "2026-06-10",
      valuationSource: "Statement dated 10 June 2026",
    });

    const document = (await getGeneratedDocument(db, author, documentId))!;
    // The document still says what it said, and its snapshot still shows one asset.
    expect(document.bodyRendered).toContain("RM 480000.00");
    expect((document.caseSnapshot as { assets: { total: number } }).assets.total).toBe(1);
  });

  it("does not change when the template is revised", async () => {
    const next = await saveCaseDocumentTemplate(db, author, {
      code: "PROBATE_APP",
      name: "Application for a grant of probate (revised)",
      kind: "application",
      matterTypes: ["probate"],
      title: "Application for a grant of probate",
      body: "COMPLETELY DIFFERENT WORDING for {{deceased_name}}.",
      variables: [{ key: "deceased_name", label: "Name of the deceased", type: "text" }],
      sourceRef: "CAC precedent file, revised 2026",
    });
    expect(next.version).toBe(2);
    await approveCaseDocumentTemplate(db, reviewer, next.id);

    const document = (await getGeneratedDocument(db, author, documentId))!;
    expect(document.templateVersion).toBe(1);
    expect(document.bodyTemplate).toBe(body);
    expect(document.bodyRendered).toContain("IN THE HIGH COURT OF MALAYA");
  });
});

// ---------------------------------------------------------------------------
describe("review, finalisation and correction", () => {
  let documentId: string;
  let pdfDocumentId: string;
  const pdf = new TextEncoder().encode("%PDF-1.7\nA pretend rendering for the test.\n");

  beforeAll(async () => {
    const templates = await listCaseDocumentTemplates(db, { status: "approved" });
    const current = templates.find((template) => template.code === "PROBATE_APP")!;
    documentId = (
      await generateCaseDocument(db, author, {
        caseId,
        templateId: current.id,
        values: { deceased_name: "Tan Ah Kow" },
      })
    ).id;
  });

  it("refuses a review by the person who produced it", async () => {
    await expect(approveCaseDocument(db, author, documentId, null)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("refuses finalisation before review", async () => {
    await expect(finaliseCaseDocument(db, reviewer, documentId, pdf)).rejects.toThrow(
      /reviewed before it is finalised/,
    );
  });

  it("approves it, and then the text is fixed at the database", async () => {
    await approveCaseDocument(db, reviewer, documentId, "Checked against the precedent file.");

    const document = (await getGeneratedDocument(db, author, documentId))!;
    expect(document.status).toBe("approved");
    expect(document.reviewedByName).toBe("cd-reviewer@cac.test");
    expect(document.reviewNote).toMatch(/precedent file/);

    await expect(
      db.execute(sql`
        UPDATE estate.generated_document SET body_rendered = 'Different' WHERE id = ${documentId}
      `),
    ).rejects.toThrow(/Its text, its values and its provenance are fixed/);
  });

  it("stores the PDF once, with its checksum on the record", async () => {
    const result = await finaliseCaseDocument(db, reviewer, documentId, pdf);
    pdfDocumentId = result.pdfDocumentId;

    expect(result.sha256).toBe(createHash("sha256").update(pdf).digest("hex"));

    const document = (await getGeneratedDocument(db, author, documentId))!;
    expect(document.status).toBe("finalised");
    expect(document.pdfSha256).toBe(result.sha256);
    expect(document.finalisedByName).toBe("cd-reviewer@cac.test");

    // The stored file is in the library, attached to the matter, and readable.
    const stored = (await getLibraryDocument(db, author, pdfDocumentId))!;
    expect(stored.caseId).toBe(caseId);
    expect(stored.readable).toBe(true);
    // Produced here, not scanned — and the record says exactly that rather than "clean"
    // with nothing behind it. It used to say "clean", which is the borrowed claim the whole scan
    // pipeline exists to refuse, and which is what made the next test's defect reachable.
    expect(stored.scanStatus).toBe("produced_internally");
    expect(stored.scanner).toBe("internal:generated");
    expect(stored.scannedAt).toBeNull();
    expect(stored.scanDetail).toMatch(/no external bytes were ingested/);
  });

  it("will not let its text be destroyed by being asked to read it again", async () => {
    const before = await db.execute<{ text: string }>(sql`
      SELECT text FROM library.document_page WHERE document_id = ${pdfDocumentId}
    `);
    expect(before.rows).toHaveLength(1);
    expect(before.rows![0]!.text).toContain("Tan Ah Kow");

    // "Read and index it" was offered for any document the library called readable, and a finalised
    // PDF was readable because it was marked clean. Pressing it ran the extractor, which sees a PDF,
    // has no OCR engine, returns needs_ocr — and the delete has already happened. The text supplied
    // at finalisation was gone, with no way back: finalising refuses to run twice and the generated
    // document is immutable by trigger.
    await expect(extractAndIndex(db, author, pdfDocumentId)).rejects.toThrow(
      /supplied when it was finalised/,
    );

    const after = await db.execute<{ text: string }>(sql`
      SELECT text FROM library.document_page WHERE document_id = ${pdfDocumentId}
    `);
    expect(after.rows).toHaveLength(1);
    expect(after.rows![0]!.text).toBe(before.rows![0]!.text);

    const chunks = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM library.chunk WHERE document_id = ${pdfDocumentId}
    `);
    expect(Number(chunks.rows![0]!.n)).toBeGreaterThan(0);

    // And the screen no longer offers the button that would have done it.
    const stored = (await getLibraryDocument(db, author, pdfDocumentId))!;
    expect(stored.readable).toBe(true);
    expect(stored.extractable).toBe(false);
  });

  it("is searchable on the same footing as a scanned document", async () => {
    const found = await searchLibrary(db, author, "Tan Ah Kow");
    expect(found.hits.some((hit) => hit.documentId === pdfDocumentId)).toBe(true);
  });

  it("will not let the stored bytes be altered", async () => {
    await expect(
      db.execute(sql`
        UPDATE library.document_blob SET content = decode('00','hex')
         WHERE document_id = ${pdfDocumentId}
      `),
    ).rejects.toThrow(/cannot be altered/);
  });

  it("will not let the finalised file be destroyed under the document", async () => {
    await expect(
      deleteDocument(db, director, pdfDocumentId, "Tidying up the library by mistake."),
    ).rejects.toThrow(/finalised/);
  });

  it("will not unfinalise, and will not cancel a finalised document", async () => {
    await expect(
      db.execute(
        sql`UPDATE estate.generated_document SET status = 'draft' WHERE id = ${documentId}`,
      ),
    ).rejects.toThrow(/not unfinalised/);

    await expect(cancelCaseDocument(db, author, documentId, "Wrong form.")).rejects.toThrow(
      /Generate a corrected document that supersedes it/,
    );
  });

  it("corrects it by superseding, with both on the record", async () => {
    const templates = await listCaseDocumentTemplates(db, { status: "approved" });
    const current = templates.find((template) => template.code === "PROBATE_APP")!;

    const corrected = await generateCaseDocument(db, author, {
      caseId,
      templateId: current.id,
      values: { deceased_name: "Tan Ah Kow (corrected spelling)" },
      supersedesId: documentId,
      notes: "The name was spelled as it appears on the identity card.",
    });

    const list = await listGeneratedDocuments(db, author, caseId);
    const superseded = list.find((entry) => entry.id === documentId)!;
    const replacement = list.find((entry) => entry.id === corrected.id)!;

    expect(replacement.supersedesNo).toBe(superseded.documentNo);
    expect(superseded.supersededByNo).toBe(replacement.documentNo);
    // The superseded one is untouched: it is what was produced, and it stays that way.
    expect(superseded.status).toBe("finalised");
  });

  it("will not supersede the same document twice", async () => {
    const templates = await listCaseDocumentTemplates(db, { status: "approved" });
    const current = templates.find((template) => template.code === "PROBATE_APP")!;
    await expect(
      generateCaseDocument(db, author, {
        caseId,
        templateId: current.id,
        values: { deceased_name: "Tan Ah Kow" },
        supersedesId: documentId,
      }),
    ).rejects.toThrow();
  });

  it("cancels a draft with a reason, and will not revive it", async () => {
    const templates = await listCaseDocumentTemplates(db, { status: "approved" });
    const current = templates.find((template) => template.code === "PROBATE_APP")!;
    const draft = await generateCaseDocument(db, author, {
      caseId,
      templateId: current.id,
      values: { deceased_name: "Tan Ah Kow" },
    });

    await expect(cancelCaseDocument(db, author, draft.id, "  ")).rejects.toThrow(/Say why/);
    await cancelCaseDocument(db, author, draft.id, "Generated against the wrong template.");

    const document = (await getGeneratedDocument(db, author, draft.id))!;
    expect(document.status).toBe("cancelled");
    expect(document.cancelReason).toMatch(/wrong template/);

    await expect(
      db.execute(sql`UPDATE estate.generated_document SET status = 'draft' WHERE id = ${draft.id}`),
    ).rejects.toThrow(/not revived/);
  });
});

// ---------------------------------------------------------------------------
describe("value coercion", () => {
  it("accepts what each type accepts and refuses what it does not", () => {
    const declared: TemplateVariable[] = [
      { key: "a_date", label: "A date", type: "date", required: false },
      { key: "a_number", label: "A number", type: "number", required: false },
      { key: "an_amount", label: "An amount", type: "money", required: false },
      { key: "a_flag", label: "A flag", type: "boolean", required: false },
      { key: "some_text", label: "Some text", type: "text", required: false },
    ];

    const out = coerceValues(declared, {
      a_date: "2026-06-01",
      a_number: "42",
      an_amount: "1,234.56",
      a_flag: "yes",
      some_text: "  spaced  ",
    });
    expect(out).toEqual({
      a_date: "2026-06-01",
      a_number: "42",
      an_amount: "1234.56",
      a_flag: true,
      some_text: "spaced",
    });

    expect(() => coerceValues(declared, { a_date: "01/06/2026" })).toThrow(/YYYY-MM-DD/);
    expect(() => coerceValues(declared, { a_number: "forty two" })).toThrow(/not a number/);
    expect(() => coerceValues(declared, { an_amount: "RM 20" })).toThrow(/not an amount/);
    // A date that does not exist is refused as well as one in the wrong shape.
    expect(() => coerceValues(declared, { a_date: "2026-02-31" })).toThrow();
  });

  it("treats an absent boolean as false rather than missing", () => {
    const out = coerceValues([{ key: "flag", label: "Flag", type: "boolean" }], {});
    expect(out.flag).toBe(false);
  });

  it("reads a yes or a no the same way everywhere, and refuses anything else", () => {
    const declared: TemplateVariable[] = [{ key: "flag", label: "Flag", type: "boolean" }];

    // There were three readings of this value and they disagreed. The letters parser treated
    // anything that was not "false", "0" or "" as true, so "no" was true; this parser used an
    // allow-list, so "no" was false; and the renderer asked JavaScript, for which the string "false"
    // is true. One answer, three results, inside documents people sign.
    for (const yes of ["true", "yes", "y", "1", "on", "YES", " Yes "]) {
      expect(coerceValues(declared, { flag: yes }).flag).toBe(true);
    }
    for (const no of ["false", "no", "n", "0", "off", "", "  "]) {
      expect(coerceValues(declared, { flag: no }).flag).toBe(false);
    }

    expect(() => coerceValues(declared, { flag: "maybe" })).toThrow(/not a yes or a no/);
  });
});
