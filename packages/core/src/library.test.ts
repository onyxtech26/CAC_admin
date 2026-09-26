import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import { hashPassword } from "./password.js";
import { AuthorizationError, resolveCapabilities, type Principal } from "./authz.js";
import { createEmployee } from "./people.js";

import {
  decodeText,
  extractDocxText,
  extractText,
  normaliseMediaType,
  NotConfiguredOcrEngine,
  stripMarkup,
  type OcrEngine,
  type OcrPage,
} from "./extraction.js";
import { chunkPages, estimateTokens, joinPages, splitText } from "./chunking.js";
import {
  cosineSimilarity,
  EmbeddingNotConfiguredError,
  NotConfiguredEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings.js";
import {
  NotConfiguredScanner,
  ScannerNotConfiguredError,
  scannerFromEnv,
  type MalwareScanner,
  type ScanResult,
} from "./scanning.js";
import {
  archiveDocument,
  deleteDocument,
  documentBytes,
  embedDocument,
  extractAndIndex,
  getLibraryDocument,
  librarySummary,
  listIngestionEvents,
  listLibraryDocuments,
  registerUpload,
  releaseQuarantine,
  scanDocument,
  searchLibrary,
  setDocumentKind,
  suggestKind,
} from "./library.js";
import { openCase, assignToCase } from "./cases.js";
import { registerDocument } from "./case-file.js";
import { addRequirement, setRequirementStatus, listRequirements } from "./case-checklist.js";

/**
 * Phase 10: the document library.
 *
 * The properties being proved are the ones a document pipeline gets wrong in ways nobody
 * notices:
 *
 *   * **Nothing is called clean unless a scanner said so.** With no scanner the document
 *     stays in quarantine and cannot be read, extracted or downloaded; the only way past
 *     is a named person's release, which records `released_unscanned` and never `clean`.
 *     An infected verdict is final.
 *   * **The original cannot be altered**, at the database, not only in the application.
 *   * **Extraction either produces the file's text or declines.** PDFs and images decline,
 *     with a reason, rather than producing plausible-and-wrong text.
 *   * **Every chunk carries its provenance** — page, character span, method, confidence —
 *     and retrieval carries it into the result.
 *   * **Retrieval is permission-filtered in SQL**, so a case document is invisible to
 *     somebody who is not on that matter, including through search.
 *   * **Semantic search reports itself unavailable** rather than quietly returning noise.
 */

let db: Database;
let close: () => Promise<void>;

let librarian: Principal; // runs the library: doc.upload + doc.archive
let director: Principal; // the only holder of doc.delete
let reader: Principal; // doc.view + doc.download only
let outsider: Principal; // no doc capability at all
let caseManager: Principal;
let caseStaff: Principal;

let staffEmployeeId: string;
let managerEmployeeId: string;
let caseId: string;

/**
 * A scanner for the tests.
 *
 * A test double in a test file is a different thing from a stub that ships: nothing in the
 * application can reach this, and the shipped `NotConfiguredScanner` refuses. What it does
 * is let the pipeline's own behaviour be exercised — clean, infected, and unable to answer
 * — which is not testable against a real clamd in CI.
 */
class TestScanner implements MalwareScanner {
  readonly name = "test-scanner";
  constructor(private readonly verdict: "clean" | "infected" | "throw") {}

  isConfigured(): boolean {
    return true;
  }
  async version(): Promise<string | null> {
    return "0.0.0-test";
  }
  async scan(): Promise<ScanResult> {
    if (this.verdict === "throw") {
      const { ScanFailedError } = await import("./scanning.js");
      throw new ScanFailedError("the scanner did not give a verdict for this file");
    }
    return {
      verdict: this.verdict,
      scanner: this.name,
      scannerVersion: "0.0.0-test",
      detail: this.verdict === "clean" ? "stream: OK" : "Eicar-Test-Signature",
    };
  }
}

const clean = new TestScanner("clean");

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
    mfaRequired: false,
    mfaEnrolmentDueAt: null,
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);

/**
 * A minimal, real .docx: a ZIP with one deflated entry.
 *
 * `tamper` makes the central directory lie about the entry's sizes, which is what a hostile file
 * does and what the reader used to believe.
 */
function buildDocx(
  paragraphs: string[],
  tamper: { compressedSize?: number; uncompressedSize?: number; body?: string } = {},
): Uint8Array {
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="x"><w:body>` +
    paragraphs
      .map((line) => `<w:p><w:r><w:t xml:space="preserve">${line}</w:t></w:r></w:p>`)
      .join("") +
    `</w:body></w:document>`;

  const name = Buffer.from("word/document.xml", "utf8");
  const raw = Buffer.from(tamper.body ?? xml, "utf8");
  const deflated = deflateRawSync(raw);
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(tamper.compressedSize ?? deflated.length, 20);
  central.writeUInt32LE(tamper.uncompressedSize ?? raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42); // local header offset

  const centralAt = local.length + name.length + deflated.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(centralAt, 16);
  eocd.writeUInt16LE(0, 20);

  return new Uint8Array(
    Buffer.concat([local, name, deflated, central, name, eocd]),
  );
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  await runMigrations(db);
  await seed(db);

  const hrAdmin = await makePrincipal("lib-hr@cac.test", ["HR_ADMIN"]);
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

  // CASE_MANAGER holds the whole doc.* set as well as case management.
  caseManager = await makePrincipal("lib-manager@cac.test", ["CASE_MANAGER"], managerEmployeeId);
  librarian = caseManager;
  caseStaff = await makePrincipal("lib-staff@cac.test", ["CASE_STAFF"], staffEmployeeId);
  director = await makePrincipal("lib-director@cac.test", ["DIRECTOR"]);
  reader = await makePrincipal("lib-reader@cac.test", ["AUDITOR"]);
  outsider = await makePrincipal("lib-outsider@cac.test", ["ACCOUNTS_EXECUTIVE"]);

  caseId = (
    await openCase(db, caseManager, {
      matterType: "probate",
      title: "Estate of Tan Ah Kow",
      deceasedName: "Tan Ah Kow",
      openedOn: "2026-05-04",
      leadEmployeeId: managerEmployeeId,
    })
  ).id;
}, 180_000);

afterAll(async () => {
  await close();
});

// ---------------------------------------------------------------------------
describe("what the shipped configuration actually does", () => {
  it("has no scanner, and refuses rather than reporting clean", async () => {
    const scanner = scannerFromEnv({});
    expect(scanner.isConfigured()).toBe(false);
    await expect(scanner.scan(bytes("x"), "x.txt")).rejects.toBeInstanceOf(
      ScannerNotConfiguredError,
    );
    await expect(new NotConfiguredScanner().scan()).rejects.toThrow(/No malware scanner/);
  });

  it("has no OCR engine, and refuses rather than returning a blank page", async () => {
    const engine = new NotConfiguredOcrEngine();
    expect(engine.isConfigured()).toBe(false);
    await expect(engine.recognise()).rejects.toThrow(/No OCR engine is configured/);
  });

  it("has no embedding model, and refuses rather than inventing a vector", async () => {
    const provider = new NotConfiguredEmbeddingProvider();
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.embed()).rejects.toBeInstanceOf(EmbeddingNotConfiguredError);
  });

  it("does not fall back to pretending when the scanner is misconfigured", () => {
    // A host with an impossible port is a configuration mistake, not a licence.
    const scanner = scannerFromEnv({ CAC_CLAMAV_HOST: "localhost", CAC_CLAMAV_PORT: "0" });
    expect(scanner.isConfigured()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("extraction", () => {
  it("reads plain text as itself, with certainty", () => {
    const outcome = extractText(bytes("Grant extracted 4 June 2026.\n"), "text/plain", "note.txt");
    expect(outcome.status).toBe("extracted");
    if (outcome.status !== "extracted") return;
    expect(outcome.method).toBe("plain_text");
    expect(outcome.confidence).toBe(1);
    expect(outcome.pages[0].text).toContain("Grant extracted");
  });

  it("strips markup rather than indexing tag names", () => {
    const outcome = extractText(
      bytes("<html><body><p>Petition filed</p><script>var x=1</script></body></html>"),
      "text/html",
      "page.html",
    );
    expect(outcome.status).toBe("extracted");
    if (outcome.status !== "extracted") return;
    expect(outcome.pages[0].text).toBe("Petition filed");
    expect(outcome.pages[0].text).not.toContain("var x");
  });

  it("reads a Word document's own text runs", () => {
    const docx = buildDocx(["Dear Mr Tan,", "The grant was extracted on 4 June 2026."]);
    const text = extractDocxText(docx);
    expect(text).toContain("Dear Mr Tan,");
    expect(text).toContain("extracted on 4 June 2026");

    const outcome = extractText(
      docx,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "letter.docx",
    );
    expect(outcome.status).toBe("extracted");
    if (outcome.status !== "extracted") return;
    expect(outcome.method).toBe("docx_xml");
    expect(outcome.confidence).toBe(1);
  });

  it("refuses an archive that overstates how much of itself it is", () => {
    // `subarray` clamps rather than throwing, so an entry that claimed more bytes than the file holds
    // used to yield whatever followed — or nothing. The decoder then found no text runs, and the
    // reader reported "extracted", confidence 1, over an empty string. An empty page and a blank
    // document are indistinguishable, which is the reason the OCR seam refuses rather than returning
    // one.
    const docx = buildDocx(["Something"], { compressedSize: 5_000_000 });
    const outcome = extractText(
      docx,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "liar.docx",
    );
    expect(outcome.status).toBe("unsupported");
    expect(outcome.detail).toMatch(/ends before that/);
  });

  it("refuses an entry that says it expands to more than it will allocate", () => {
    const docx = buildDocx(["Something"], { uncompressedSize: 500 * 1024 * 1024 });
    const outcome = extractText(
      docx,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "bomb.docx",
    );
    expect(outcome.status).toBe("unsupported");
    expect(outcome.detail).toMatch(/past the .* limit/);
  });

  it("refuses a deflate bomb that understates itself", () => {
    // Deflate reaches roughly 1032:1 on zeros, so this is a few kilobytes on disk and 40 MB in
    // memory — and the directory claims it is tiny, so the declared-size check does not catch it.
    // `inflateRawSync` had no output limit at all, and Node's default is about 4 GiB.
    const docx = buildDocx([], {
      body: "\u0000".repeat(40 * 1024 * 1024),
      uncompressedSize: 1024,
    });
    const outcome = extractText(
      docx,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "zeros.docx",
    );
    expect(outcome.status).toBe("unsupported");
    expect(outcome.detail).toMatch(/more than the .* bytes/);
  });

  it("does not call an empty Word document a successful read", () => {
    const docx = buildDocx([]);
    const outcome = extractText(
      docx,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "empty.docx",
    );
    expect(outcome.status).toBe("unsupported");
    expect(outcome.detail).toMatch(/no text runs at all/);
  });

  it("refuses a PDF rather than guessing at its text", () => {
    const outcome = extractText(bytes("%PDF-1.7\n..."), "application/pdf", "grant.pdf");
    expect(outcome.status).toBe("needs_ocr");
    // The reason has to be readable by whoever is wondering why their file is not searchable.
    expect(outcome.detail).toMatch(/plausible and wrong/);
  });

  it("refuses an image, and says what would read it", () => {
    const outcome = extractText(bytes("\x89PNG"), "image/png", "scan.png");
    expect(outcome.status).toBe("needs_ocr");
    expect(outcome.detail).toMatch(/OCR engine/);
  });

  it("says plainly when it reads nothing of a format", () => {
    const outcome = extractText(bytes("MZ"), "application/x-msdownload", "thing.exe");
    expect(outcome.status).toBe("unsupported");
    expect(outcome.detail).toMatch(/application\/x-msdownload/);
  });

  it("corrects a media type the browser did not know, from the extension only", () => {
    expect(normaliseMediaType("application/octet-stream", "notes.md")).toBe("text/markdown");
    expect(normaliseMediaType("", "report.pdf")).toBe("application/pdf");
    // A type the browser did state is not second-guessed.
    expect(normaliseMediaType("text/plain", "thing.pdf")).toBe("text/plain");
  });

  it("decodes UTF-8 and normalises line endings without guessing at charsets", () => {
    expect(decodeText(bytes("﻿Aisyah\r\nbinti\rRahman"))).toBe("Aisyah\nbinti\nRahman");
  });

  it("keeps structure when stripping markup", () => {
    expect(stripMarkup("<p>one</p><p>two</p>")).toBe("one\ntwo");
  });
});

// ---------------------------------------------------------------------------
describe("chunking", () => {
  const paragraph = (index: number) =>
    `Paragraph ${index}. ` + "The estate comprises land and a bank account. ".repeat(12);

  it("returns one chunk for a short text", () => {
    expect(splitText("Short.")).toEqual([{ from: 0, to: 6 }]);
  });

  it("returns nothing for blank text rather than a chunk of nothing", () => {
    expect(splitText("   \n\n  ")).toEqual([]);
    expect(chunkPages([{ pageNo: 1, text: "  ", method: "plain_text", confidence: 1 }])).toEqual([]);
  });

  it("cuts on paragraph boundaries and overlaps, so nothing falls between chunks", () => {
    const text = [paragraph(1), paragraph(2), paragraph(3)].join("\n\n");
    const spans = splitText(text, { targetChars: 700, overlapChars: 100, minChars: 150 });

    expect(spans.length).toBeGreaterThan(1);
    // Consecutive spans overlap: the next starts before the previous ended.
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index].from).toBeLessThan(spans[index - 1].to);
    }
    // The whole text is covered.
    expect(spans[0].from).toBe(0);
    expect(spans[spans.length - 1].to).toBe(text.length);
  });

  it("is deterministic — the same text always gives the same offsets", () => {
    const text = [paragraph(1), paragraph(2)].join("\n\n");
    expect(splitText(text, { targetChars: 600 })).toEqual(splitText(text, { targetChars: 600 }));
  });

  it("does not cut inside a decimal or mid-sentence when it can avoid it", () => {
    const text =
      "The valuation is RM 480,000.00 as at 20 May 2026. " +
      "It was arrived at by comparison. ".repeat(40);
    const spans = splitText(text, { targetChars: 400, overlapChars: 40, minChars: 100 });
    for (const span of spans.slice(0, -1)) {
      const tail = text.slice(span.to - 2, span.to);
      // Each cut lands after a sentence end or a break, never between digits.
      expect(/\d\.\d/.test(tail)).toBe(false);
    }
  });

  it("carries the page, the span and the method onto every chunk", () => {
    const chunks = chunkPages(
      [
        { pageNo: 1, text: paragraph(1), method: "plain_text", confidence: 1 },
        { pageNo: 2, text: paragraph(2), method: "ocr", confidence: 0.82 },
      ],
      { targetChars: 600, overlapChars: 50, minChars: 100 },
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.charTo).toBeGreaterThan(chunk.charFrom);
      expect(chunk.pageFrom).not.toBeNull();
      expect(chunk.tokenEstimate).toBeGreaterThan(0);
    }
    // A chunk that spans a certain page and an OCR'd one takes the weaker claim: a
    // passage is only as reliable as its least reliable part.
    const spanning = chunks.find((chunk) => chunk.pageFrom !== chunk.pageTo);
    if (spanning) {
      expect(spanning.method).toBe("ocr");
      expect(spanning.confidence).toBeCloseTo(0.82, 4);
    }
  });

  it("locates each page in the combined text it reports offsets into", () => {
    const { combined, boundaries } = joinPages([
      { pageNo: 1, text: "one", method: "plain_text", confidence: 1 },
      { pageNo: 2, text: "two", method: "plain_text", confidence: 1 },
    ]);
    expect(combined).toBe("one\ftwo");
    expect(combined.slice(boundaries[1].from, boundaries[1].to)).toBe("two");
  });

  it("calls its token count an estimate, and it is one", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

// ---------------------------------------------------------------------------
describe("classification is a suggestion, not a reading", () => {
  it("suggests from the filename, with the confidence a filename deserves", () => {
    const suggestion = suggestKind("Tan Ah Kow death cert.pdf", "application/pdf");
    expect(suggestion.kind).toBe("death certificate");
    expect(suggestion.confidence).toBeLessThan(1);
    expect(suggestion.reason).toMatch(/guess from the name/);
  });

  it("says it does not know rather than picking something", () => {
    expect(suggestKind("scan0001.pdf", "application/pdf").kind).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("registering an upload", () => {
  let noteId: string;

  it("checksums the bytes it received and holds the document in quarantine", async () => {
    const content = bytes("The grant of probate was extracted on 4 June 2026 at Ipoh.");
    const registered = await registerUpload(db, librarian, {
      title: "File note",
      filename: "file note.txt",
      mediaType: "text/plain",
      bytes: content,
    });
    noteId = registered.id;
    expect(registered.documentNo).toMatch(/^DOC/);

    const document = await getLibraryDocument(db, librarian, noteId);
    expect(document!.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(document!.scanStatus).toBe("quarantined");
    expect(document!.readable).toBe(false);
  });

  it("refuses an empty file and one that is too large", async () => {
    await expect(
      registerUpload(db, librarian, {
        filename: "empty.txt",
        mediaType: "text/plain",
        bytes: new Uint8Array(),
      }),
    ).rejects.toThrow(/empty/);

    await expect(
      registerUpload(db, librarian, {
        filename: "huge.txt",
        mediaType: "text/plain",
        bytes: new Uint8Array(26 * 1024 * 1024),
      }),
    ).rejects.toThrow(/The limit is 25 MB/);
  });

  it("reports a duplicate rather than refusing it", async () => {
    const content = bytes("The grant of probate was extracted on 4 June 2026 at Ipoh.");
    const again = await registerUpload(db, librarian, {
      filename: "file note copy.txt",
      mediaType: "text/plain",
      bytes: content,
    });
    // The same document legitimately belongs to two matters.
    expect(again.duplicateOf).toMatch(/^DOC/);
    await archiveDocument(db, librarian, again.id, "A duplicate of the original file note.");
  });

  it("will not let the stored original be altered, at the database", async () => {
    await expect(
      db.execute(sql`
        UPDATE library.document_blob SET content = decode('00','hex') WHERE document_id = ${noteId}
      `),
    ).rejects.toThrow(/cannot be altered/);
  });

  it("will not let the checksum or the arrival name be rewritten either", async () => {
    await expect(
      db.execute(sql`UPDATE library.document SET sha256 = repeat('a', 64) WHERE id = ${noteId}`),
    ).rejects.toThrow(/describe the bytes that were stored/);
    await expect(
      db.execute(sql`UPDATE library.document SET original_filename = 'other.txt' WHERE id = ${noteId}`),
    ).rejects.toThrow(/part of its provenance/);
  });

  it("refuses to read anything out of a quarantined file — in the pipeline and in the database", async () => {
    await expect(extractAndIndex(db, librarian, noteId)).rejects.toThrow(/cleared quarantine/);

    await expect(
      db.execute(sql`
        INSERT INTO library.chunk
          (document_id, ordinal, text, char_from, char_to, token_estimate, method)
        VALUES (${noteId}, 1, 'anything', 0, 8, 2, 'plain_text')
      `),
    ).rejects.toThrow(/until it has been scanned clean or released/);
  });

  it("refuses to download it", async () => {
    await expect(documentBytes(db, librarian, noteId)).rejects.toThrow(/in quarantine/);
  });

  it("records the refusal to scan, without claiming anything about the file", async () => {
    const report = await scanDocument(db, librarian, noteId, new NotConfiguredScanner());
    expect(report.status).toBe("quarantined");
    expect(report.detail).toMatch(/No malware scanner is configured/);

    const events = await listIngestionEvents(db, librarian, noteId);
    const scan = events.find((event) => event.stage === "scanned")!;
    expect(scan.outcome).toBe("skipped");
  });

  it("records a scanner that could not answer as a failure, not as clean", async () => {
    const report = await scanDocument(db, librarian, noteId, new TestScanner("throw"));
    expect(report.status).toBe("scan_failed");

    const document = await getLibraryDocument(db, librarian, noteId);
    expect(document!.scanStatus).toBe("scan_failed");
    expect(document!.readable).toBe(false);
    await expect(documentBytes(db, librarian, noteId)).rejects.toThrow(/unscanned after a failed scan/);
  });

  it("passes it once a scanner says so, and attributes the verdict", async () => {
    const report = await scanDocument(db, librarian, noteId, clean);
    expect(report.status).toBe("clean");

    const document = await getLibraryDocument(db, librarian, noteId);
    expect(document!.scanStatus).toBe("clean");
    expect(document!.scanner).toBe("test-scanner");
    expect(document!.scannerVersion).toBe("0.0.0-test");
    expect(document!.scannedAt).not.toBeNull();
    expect(document!.readable).toBe(true);
  });

  it("extracts, chunks and indexes it, recording how", async () => {
    const report = await extractAndIndex(db, librarian, noteId);
    expect(report.status).toBe("extracted");
    expect(report.method).toBe("plain_text");
    expect(report.chunkCount).toBe(1);

    const chunk = await db.execute<Record<string, unknown>>(
      sql`SELECT * FROM library.chunk WHERE document_id = ${noteId}`,
    );
    const row = chunk.rows![0];
    expect(Number(row.confidence)).toBe(1);
    expect(row.method).toBe("plain_text");
    expect(Number(row.page_from)).toBe(1);

    const events = await listIngestionEvents(db, librarian, noteId);
    expect(events.map((event) => event.stage)).toContain("chunked");
  });

  it("will not let a chunk's text or provenance be rewritten", async () => {
    const chunk = await db.execute<{ id: string }>(
      sql`SELECT id FROM library.chunk WHERE document_id = ${noteId} LIMIT 1`,
    );
    await expect(
      db.execute(sql`UPDATE library.chunk SET text = 'something else' WHERE id = ${chunk.rows![0].id}`),
    ).rejects.toThrow(/fixed. Re-extract/);
  });

  it("lets the document be downloaded, and records that it left", async () => {
    const download = await documentBytes(db, librarian, noteId, {
      reason: "Sending it to the family's solicitor.",
    });
    expect(new TextDecoder().decode(download.bytes)).toContain("grant of probate");

    const audited = await db.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM audit.event
       WHERE action = 'DOCUMENT_DOWNLOADED' AND entity_id = ${noteId}
    `);
    expect(Number(audited.rows![0].count)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("an infected file", () => {
  let badId: string;

  it("is blocked, permanently", async () => {
    badId = (
      await registerUpload(db, librarian, {
        filename: "invoice.txt",
        mediaType: "text/plain",
        bytes: bytes("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"),
      })
    ).id;

    const report = await scanDocument(db, librarian, badId, new TestScanner("infected"));
    expect(report.status).toBe("infected");
    expect(report.detail).toMatch(/final/);
  });

  it("cannot be downloaded, extracted, or released — by anybody, for any reason", async () => {
    await expect(documentBytes(db, librarian, badId)).rejects.toThrow(/cannot be downloaded/);
    await expect(extractAndIndex(db, librarian, badId)).rejects.toThrow(/cleared quarantine/);
    await expect(
      releaseQuarantine(db, librarian, badId, "The client insists it is fine."),
    ).rejects.toThrow(/cannot be released, by anybody/);
  });

  it("cannot be moved to another verdict at the database either", async () => {
    await expect(
      db.execute(sql`UPDATE library.document SET scan_status = 'clean' WHERE id = ${badId}`),
    ).rejects.toThrow(/verdict is final/);
  });
});

// ---------------------------------------------------------------------------
describe("releasing a file nobody scanned", () => {
  let releasedId: string;

  it("takes a capability, a reason of substance, and is never called clean", async () => {
    releasedId = (
      await registerUpload(db, librarian, {
        filename: "valuation working.md",
        mediaType: "text/markdown",
        bytes: bytes(
          "# Valuation working\n\nComparable transactions in Taman Ipoh Jaya during 2026.\n",
        ),
      })
    ).id;

    // Somebody who can upload but not administer the library cannot release.
    await expect(
      releaseQuarantine(db, caseStaff, releasedId, "It came from our own office."),
    ).rejects.toBeInstanceOf(AuthorizationError);

    await expect(releaseQuarantine(db, librarian, releasedId, "fine")).rejects.toThrow(
      /Say why this file is being released/,
    );

    await releaseQuarantine(
      db,
      librarian,
      releasedId,
      "Produced in this office, never left it, and no scanner is configured yet.",
    );

    const document = await getLibraryDocument(db, librarian, releasedId);
    // The distinction that matters: released, not clean.
    expect(document!.scanStatus).toBe("released_unscanned");
    expect(document!.releasedByName).toBe("lib-manager@cac.test");
    expect(document!.releaseReason).toMatch(/no scanner is configured/);
    expect(document!.readable).toBe(true);
  });

  it("stays released rather than becoming clean afterwards", async () => {
    await expect(scanDocument(db, librarian, releasedId, clean)).rejects.toThrow(
      /released without a scan/,
    );
    const document = await getLibraryDocument(db, librarian, releasedId);
    expect(document!.scanStatus).toBe("released_unscanned");
  });

  it("can be read, and is kept out of search unless it is asked for", async () => {
    await extractAndIndex(db, librarian, releasedId);

    const strict = await searchLibrary(db, librarian, "comparable transactions");
    expect(strict.hits.some((hit) => hit.documentId === releasedId)).toBe(false);

    const lenient = await searchLibrary(db, librarian, "comparable transactions", {
      includeUnscanned: true,
    });
    expect(lenient.hits.some((hit) => hit.documentId === releasedId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("a file nobody can read", () => {
  let pdfId: string;

  it("stops at needs_ocr, with the reason on the document", async () => {
    pdfId = (
      await registerUpload(db, librarian, {
        filename: "grant.pdf",
        mediaType: "application/pdf",
        bytes: bytes("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n"),
      })
    ).id;
    await scanDocument(db, librarian, pdfId, clean);

    const report = await extractAndIndex(db, librarian, pdfId);
    expect(report.status).toBe("needs_ocr");
    expect(report.chunkCount).toBe(0);

    const document = await getLibraryDocument(db, librarian, pdfId);
    expect(document!.extractionStatus).toBe("needs_ocr");
    expect(document!.extractionDetail).toMatch(/plausible and wrong/);
  });

  it("is listed by search as unsearchable, with why — separately from finding nothing", async () => {
    const result = await searchLibrary(db, librarian, "grant");
    const blocked = result.unsearchable.find((entry) => entry.title === "grant.pdf");
    expect(blocked!.reason).toMatch(/no OCR engine is configured/i);
  });

  it("reads it once an engine is configured, and marks the text as OCR", async () => {
    // A test double, as with the scanner: what is being tested is the pipeline's handling
    // of a confidence below 1, which no shipped code can produce today.
    const engine: OcrEngine = {
      name: "test-ocr",
      isConfigured: () => true,
      async recognise(): Promise<OcrPage[]> {
        return [
          { pageNo: 1, text: "IN THE HIGH COURT OF MALAYA AT IPOH", confidence: 0.91 },
          { pageNo: 2, text: "Grant of probate, sealed 4 June 2026.", confidence: 0.78 },
        ];
      },
    };

    const report = await extractAndIndex(db, librarian, pdfId, { ocr: engine });
    expect(report.status).toBe("extracted");
    expect(report.method).toBe("ocr");
    expect(report.pageCount).toBe(2);

    const document = await getLibraryDocument(db, librarian, pdfId);
    // The document's confidence is the weakest page's.
    expect(document!.extractionConfidence).toBeCloseTo(0.78, 4);

    const hits = await searchLibrary(db, librarian, "sealed probate");
    const hit = hits.hits.find((entry) => entry.documentId === pdfId);
    // The result says the text was recognised, not read.
    expect(hit!.method).toBe("ocr");
    expect(hit!.confidence).not.toBeNull();
  });

  it("replaces what a previous extraction produced rather than accumulating it", async () => {
    const before = await getLibraryDocument(db, librarian, pdfId);
    await extractAndIndex(db, librarian, pdfId);
    const after = await getLibraryDocument(db, librarian, pdfId);

    expect(before!.chunkCount).toBeGreaterThan(0);
    // Without the engine it falls back to needs_ocr, and the old chunks go with it —
    // stale text attributed to a document is worse than no text.
    expect(after!.extractionStatus).toBe("needs_ocr");
    expect(after!.chunkCount).toBe(0);

    const orphans = await db.execute<{ count: string }>(
      sql`SELECT count(*) AS count FROM library.chunk WHERE document_id = ${pdfId}`,
    );
    expect(Number(orphans.rows![0].count)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("search", () => {
  let caseDocId: string;

  beforeAll(async () => {
    caseDocId = (
      await registerUpload(db, caseManager, {
        title: "Instructions from the eldest son",
        filename: "instructions.txt",
        mediaType: "text/plain",
        bytes: bytes(
          "The eldest son instructs CAC to prepare an inventory of the estate. " +
            "Harta pusaka termasuk sebidang tanah di Taman Ipoh Jaya. " +
            "He believes the bank account holds about RM 40,000.",
        ),
        caseId,
      })
    ).id;
    await scanDocument(db, caseManager, caseDocId, clean);
    await extractAndIndex(db, caseManager, caseDocId);
  });

  it("finds English text, with the passage marked and the provenance attached", async () => {
    const result = await searchLibrary(db, caseManager, "inventory estate");
    const hit = result.hits.find((entry) => entry.documentId === caseDocId)!;

    expect(hit.excerpt).toContain("«");
    expect(hit.documentNo).toMatch(/^DOC/);
    expect(hit.caseNo).toMatch(/^CASE/);
    expect(hit.method).toBe("plain_text");
    expect(hit.charTo).toBeGreaterThan(hit.charFrom);
    expect(hit.pageFrom).toBe(1);
  });

  it("finds Malay text, which the English configuration alone would miss", async () => {
    // PostgreSQL has no Malay configuration; the unstemmed `simple` vector is what makes
    // this work, and is why both are stored.
    const result = await searchLibrary(db, caseManager, "harta pusaka");
    expect(result.hits.some((entry) => entry.documentId === caseDocId)).toBe(true);
  });

  it("says it is lexical, and says why the other half is unavailable", async () => {
    const result = await searchLibrary(db, caseManager, "inventory");
    expect(result.strategy).toBe("lexical");
    expect(result.semanticAvailable).toBe(false);
    expect(result.semanticNote).toMatch(/no embedding model is configured/i);
  });

  it("refuses a query too short to mean anything", async () => {
    await expect(searchLibrary(db, caseManager, "a")).rejects.toThrow(/at least two characters/);
  });

  it("does not return a case document to somebody who is not on that matter", async () => {
    // The staff member has doc.view but is not assigned to the matter.
    const theirs = await searchLibrary(db, caseStaff, "inventory estate");
    expect(theirs.hits.some((entry) => entry.documentId === caseDocId)).toBe(false);
    expect(await getLibraryDocument(db, caseStaff, caseDocId)).toBeNull();

    // Assigned, and the same search finds it.
    await assignToCase(db, caseManager, { caseId, employeeId: staffEmployeeId });
    const now = await searchLibrary(db, caseStaff, "inventory estate");
    expect(now.hits.some((entry) => entry.documentId === caseDocId)).toBe(true);
  });

  it("shows a firm-wide document to anybody with doc.view, and nothing to anybody without", async () => {
    const auditorsView = await searchLibrary(db, reader, "grant of probate");
    expect(auditorsView.hits.length).toBeGreaterThan(0);
    // And a case document is still not theirs to see.
    expect(auditorsView.hits.every((hit) => hit.caseId === null)).toBe(true);

    await expect(searchLibrary(db, outsider, "grant")).rejects.toBeInstanceOf(AuthorizationError);
  });
});

// ---------------------------------------------------------------------------
describe("embedding", () => {
  it("reports itself unavailable and leaves lexical search working", async () => {
    const documents = await listLibraryDocuments(db, librarian, { limit: 5 });
    const indexed = documents.find((document) => document.chunkCount > 0)!;

    const report = await embedDocument(
      db,
      librarian,
      indexed.id,
      new NotConfiguredEmbeddingProvider(),
    );
    expect(report.status).toBe("not_configured");

    const after = await getLibraryDocument(db, librarian, indexed.id);
    // Not "failed": nothing is broken, something is absent.
    expect(after!.embeddingStatus).toBe("not_configured");
    expect(after!.embeddingDetail).toMatch(/Q-AI-1/);

    const search = await searchLibrary(db, librarian, "probate");
    expect(search.hits.length).toBeGreaterThan(0);
  });

  it("refuses a provider whose vectors do not match what it declares", async () => {
    const documents = await listLibraryDocuments(db, librarian, { limit: 5 });
    const indexed = documents.find((document) => document.chunkCount > 0)!;

    const wrong: EmbeddingProvider = {
      name: "test",
      model: "test-model",
      dimensions: 4,
      isConfigured: () => true,
      async embed(texts: string[]) {
        return texts.map(() => [0.1, 0.2]); // two, not four
      },
    };
    const report = await embedDocument(db, librarian, indexed.id, wrong);
    expect(report.status).toBe("failed");
    expect(report.detail).toMatch(/dimensions/);
  });

  it("stores a vector with the model that produced it, when one is available", async () => {
    const documents = await listLibraryDocuments(db, librarian, { limit: 5 });
    const indexed = documents.find((document) => document.chunkCount > 0)!;

    const provider: EmbeddingProvider = {
      name: "test",
      model: "test-model-v1",
      dimensions: 3,
      isConfigured: () => true,
      async embed(texts: string[]) {
        return texts.map((_, index) => [index + 1, 0.5, -0.25]);
      },
    };
    const report = await embedDocument(db, librarian, indexed.id, provider);
    expect(report.status).toBe("embedded");

    const row = await db.execute<{ embedding_model: string; embedding: unknown }>(sql`
      SELECT embedding_model, embedding FROM library.chunk
       WHERE document_id = ${indexed.id} ORDER BY ordinal LIMIT 1
    `);
    // A vector never exists without the model that produced it (CHECK).
    expect(row.rows![0].embedding_model).toBe("test-model-v1");
    expect(row.rows![0].embedding).not.toBeNull();
  });

  it("compares vectors without producing NaN for the degenerate cases", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBeNull();
    expect(cosineSimilarity([0, 0], [1, 1])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("housekeeping", () => {
  it("lets a person say what a document is, over the rule's guess", async () => {
    const id = (
      await registerUpload(db, librarian, {
        filename: "scan0002.txt",
        mediaType: "text/plain",
        bytes: bytes("Sijil kematian — Tan Ah Kow."),
      })
    ).id;

    const before = await getLibraryDocument(db, librarian, id);
    expect(before!.kind).toBeNull();

    await setDocumentKind(db, librarian, id, { kind: "death certificate" });
    const after = await getLibraryDocument(db, librarian, id);
    expect(after!.kind).toBe("death certificate");
    expect(after!.classifiedBy).toBe("person");
  });

  it("archives a document out of search while keeping the original", async () => {
    const id = (
      await registerUpload(db, librarian, {
        filename: "superseded note.txt",
        mediaType: "text/plain",
        bytes: bytes("An earlier draft of the inventory, since superseded entirely."),
      })
    ).id;
    await scanDocument(db, librarian, id, clean);
    await extractAndIndex(db, librarian, id);
    expect((await searchLibrary(db, librarian, "earlier draft")).hits.length).toBeGreaterThan(0);

    await archiveDocument(db, librarian, id, "Superseded by the final inventory.");

    expect((await searchLibrary(db, librarian, "earlier draft")).hits).toEqual([]);
    // The bytes are still there.
    const download = await documentBytes(db, librarian, id);
    expect(new TextDecoder().decode(download.bytes)).toContain("earlier draft");
  });

  it("refuses to destroy a document a satisfied checklist item depends on", async () => {
    // Register the file in the library and on the case register, linked by storage key,
    // then satisfy a requirement with it.
    const libraryId = (
      await registerUpload(db, caseManager, {
        filename: "death certificate.txt",
        mediaType: "text/plain",
        bytes: bytes("Certified copy of the death certificate of Tan Ah Kow."),
        caseId,
      })
    ).id;

    const caseDocumentId = await registerDocument(db, caseManager, {
      caseId,
      title: "Death certificate (certified copy)",
      form: "certified_copy",
    });
    await db.execute(sql`
      UPDATE estate.case_document SET storage_key = ${libraryId},
             original_filename = 'death certificate.txt', byte_size = 54,
             sha256 = ${createHash("sha256").update(bytes("x")).digest("hex")}
       WHERE id = ${caseDocumentId}
    `);

    const requirementId = await addRequirement(db, caseManager, {
      caseId,
      title: "Certified copy of the death certificate",
      kind: "document",
    });
    await setRequirementStatus(db, caseManager, {
      requirementId,
      status: "satisfied",
      documentId: caseDocumentId,
    });

    // Destroying an original sits with the director alone; a case manager archives.
    await expect(
      deleteDocument(db, caseManager, libraryId, "Filed against the wrong matter entirely."),
    ).rejects.toBeInstanceOf(AuthorizationError);

    await expect(
      deleteDocument(db, director, libraryId, "Filed against the wrong matter entirely."),
    ).rejects.toThrow(/satisfied by this document/);

    // Reopen the item and the delete is allowed.
    await setRequirementStatus(db, caseManager, { requirementId, status: "outstanding" });
    await deleteDocument(db, director, libraryId, "Filed against the wrong matter entirely.");
    expect(await getLibraryDocument(db, caseManager, libraryId)).toBeNull();

    const items = await listRequirements(db, caseManager, caseId);
    expect(items.find((item) => item.id === requirementId)!.status).toBe("outstanding");
  });

  it("insists on a reason of substance before destroying an original", async () => {
    const id = (
      await registerUpload(db, librarian, {
        filename: "stray.txt",
        mediaType: "text/plain",
        bytes: bytes("Uploaded by mistake."),
      })
    ).id;
    await expect(deleteDocument(db, director, id, "oops")).rejects.toThrow(/cannot be undone/);
    await deleteDocument(db, director, id, "Uploaded to the wrong system by mistake.");
  });

  it("summarises the library honestly, including what is not configured", async () => {
    const summary = await librarySummary(
      db,
      librarian,
      new NotConfiguredScanner(),
      new NotConfiguredEmbeddingProvider(),
    );
    expect(summary.scannerConfigured).toBe(false);
    expect(summary.embeddingConfigured).toBe(false);
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.searchable).toBeGreaterThan(0);
    expect(summary.infected).toBe(1);
    expect(summary.releasedUnscanned).toBe(1);
  });
});
