import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { allocateDocumentNumber } from "./sequence.js";
import { requireCaseAccess } from "./cases.js";
import {
  extractText,
  normaliseMediaType,
  type ExtractionMethod,
  type OcrEngine,
} from "./extraction.js";
import { chunkPages, type SourcePage, type TextChunk } from "./chunking.js";
import {
  EmbeddingNotConfiguredError,
  type EmbeddingProvider,
} from "./embeddings.js";
import {
  ScanFailedError,
  ScannerNotConfiguredError,
  type MalwareScanner,
} from "./scanning.js";

/**
 * The document library and the ingestion pipeline.
 *
 * register -> scan -> classify -> extract -> chunk -> index -> (embed)
 *
 * Each stage is a separate call that can be run again, and each one writes what it did to
 * `library.ingestion_event`. A document carries the outcome of every stage on its own row,
 * so "why is this file not searchable" always has an answer on screen rather than in a log
 * nobody reads.
 *
 * Three things about this file are deliberate.
 *
 * **Nothing derived is trusted more than its source.** The original bytes are stored once
 * and never altered; page text, chunks and any eventual vector are derived and can be
 * thrown away and rebuilt. Every chunk records the method that produced its text and the
 * confidence of that method, and retrieval carries both — so a passage that came from OCR
 * is never presented as though it were read off the file.
 *
 * **Quarantine means quarantine.** An uploaded file cannot be downloaded, extracted or
 * indexed until either a configured scanner says it is clean or a named person releases it
 * with a reason. A released document is marked `released_unscanned` for the rest of its
 * life. There is no configuration in which this platform says "clean" without a scanner
 * having said so.
 *
 * **Retrieval is permission-filtered in SQL.** A document attached to a matter is visible
 * to the people on that matter; one attached to none needs `doc.view`. The clause is part
 * of the query, not a filter applied to its results, because a filter applied afterwards
 * is a filter somebody will forget.
 */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type ScanStatus =
  | "quarantined"
  | "clean"
  | "infected"
  | "released_unscanned"
  | "scan_failed"
  /**
   * Produced by this platform, so never ingested and never scanned.
   *
   * A finalised case document used to be filed as `clean`, because `clean` is what the downstream
   * gates check — which is exactly the borrowed claim the scan pipeline exists to refuse. It is also
   * what let "Read and index it" run the extractor over a generated PDF and delete the text
   * finalisation had supplied. See migration 0030.
   */
  | "produced_internally";

/** Documents whose contents may be read and searched: nothing unscanned, nothing infected. */
const TRUSTED_SCAN_STATUSES: ReadonlySet<ScanStatus> = new Set<ScanStatus>([
  "clean",
  "released_unscanned",
  "produced_internally",
]);

export type ExtractionStatus = "pending" | "extracted" | "needs_ocr" | "unsupported" | "failed";

export type EmbeddingStatus = "not_requested" | "not_configured" | "embedded" | "failed";

export interface LibraryDocument {
  id: string;
  documentNo: string;
  title: string;
  originalFilename: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  caseId: string | null;
  caseNo: string | null;
  confidentiality: "internal" | "client" | "restricted";
  suggestedKind: string | null;
  suggestedConfidence: number | null;
  kind: string | null;
  classifiedBy: "rule" | "person" | null;
  scanStatus: ScanStatus;
  scanner: string | null;
  scannerVersion: string | null;
  scannedAt: string | null;
  scanDetail: string | null;
  releasedByName: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  extractionStatus: ExtractionStatus;
  extractionMethod: string | null;
  extractionConfidence: number | null;
  extractionDetail: string | null;
  pageCount: number | null;
  textChars: number | null;
  chunkCount: number;
  indexedAt: string | null;
  embeddingStatus: EmbeddingStatus;
  embeddingModel: string | null;
  embeddingDetail: string | null;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
  createdByName: string | null;
  /**
   * True when the file may be opened: scanned clean, released with a reason, or produced by this
   * platform in the first place.
   */
  readable: boolean;
  /**
   * True when the extractor may be run over it.
   *
   * Narrower than `readable`, and the difference is not cosmetic. Extraction replaces what is there,
   * so for a document whose text was supplied at finalisation rather than read out of the file, it
   * deletes the only copy. See `extractAndIndex`.
   */
  extractable: boolean;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * Which documents a principal may read, as SQL.
 *
 * A document bound to a matter follows that matter's access; one bound to none needs
 * `doc.view`. Returned as a fragment so it can be dropped into any query over
 * `library.document d` — including retrieval, which is the one that matters most.
 */
export function libraryAccessClause(principal: Principal, alias = "d") {
  const table = sql.raw(alias);
  const firmWide = principal.capabilities.has("doc.view") ? sql`true` : sql`false`;

  if (principal.capabilities.has("case.view_all")) {
    return sql`(${table}.case_id IS NULL AND ${firmWide} OR ${table}.case_id IS NOT NULL)`;
  }

  if (!principal.capabilities.has("case.view") || !principal.employeeId) {
    return sql`(${table}.case_id IS NULL AND ${firmWide})`;
  }

  return sql`(
    (${table}.case_id IS NULL AND ${firmWide})
    OR EXISTS (
      SELECT 1 FROM estate.case_assignment a
       WHERE a.case_id = ${table}.case_id
         AND a.employee_id = ${principal.employeeId}
         AND a.removed_at IS NULL
    )
  )`;
}

async function loadAccessible(
  db: Executor,
  principal: Principal,
  documentId: string,
): Promise<{
  id: string;
  documentNo: string;
  caseId: string | null;
  scanStatus: ScanStatus;
  mediaType: string;
  originalFilename: string;
  extractionStatus: ExtractionStatus;
}> {
  const result = await db.execute<{
    id: string;
    document_no: string;
    case_id: string | null;
    scan_status: string;
    media_type: string;
    original_filename: string;
    extraction_status: string;
  }>(sql`
    SELECT d.id, d.document_no, d.case_id, d.scan_status, d.media_type,
           d.original_filename, d.extraction_status
      FROM library.document d
     WHERE d.id = ${documentId} AND ${libraryAccessClause(principal)}
  `);
  const row = result.rows?.[0];
  if (!row) throw new NotFoundError("That document does not exist, or is not one you may see.");
  return {
    id: row.id,
    documentNo: row.document_no,
    caseId: row.case_id,
    scanStatus: row.scan_status as ScanStatus,
    mediaType: row.media_type,
    originalFilename: row.original_filename,
    extractionStatus: row.extraction_status as ExtractionStatus,
  };
}

// ---------------------------------------------------------------------------
// The pipeline's own log
// ---------------------------------------------------------------------------

export type IngestionStage =
  | "registered"
  | "scanned"
  | "classified"
  | "extracted"
  | "chunked"
  | "embedded"
  | "released"
  | "archived"
  | "rebuilt";

export interface IngestionEventView {
  id: string;
  stage: IngestionStage;
  outcome: "ok" | "blocked" | "failed" | "skipped";
  detail: string;
  actorLabel: string | null;
  occurredAt: string;
}

async function logStage(
  db: Executor,
  params: {
    documentId: string;
    stage: IngestionStage;
    outcome: "ok" | "blocked" | "failed" | "skipped";
    detail: string;
    principal?: Principal;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO library.ingestion_event
      (document_id, stage, outcome, detail, actor_user_id, actor_label)
    VALUES
      (${params.documentId}, ${params.stage}, ${params.outcome}, ${params.detail},
       ${params.principal?.userId ?? null}, ${params.principal?.fullName ?? "the platform"})
  `);
}

export async function listIngestionEvents(
  db: Executor,
  principal: Principal,
  documentId: string,
): Promise<IngestionEventView[]> {
  await loadAccessible(db, principal, documentId);

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT id, stage, outcome, detail, actor_label, occurred_at
      FROM library.ingestion_event
     WHERE document_id = ${documentId}
     ORDER BY occurred_at, id
  `);
  return (result.rows ?? []).map((row) => ({
    id: String(row.id),
    stage: row.stage as IngestionStage,
    outcome: row.outcome as IngestionEventView["outcome"],
    detail: String(row.detail),
    actorLabel: (row.actor_label as string) ?? null,
    occurredAt: new Date(String(row.occurred_at)).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * A *suggestion* about what a document is, from its filename and media type.
 *
 * Rules over words, with the confidence the rule deserves and no more. This is
 * deliberately not a model and deliberately not called classification in the UI: a rule
 * that sees "death cert.pdf" can reasonably suggest a death certificate, and it has no
 * idea whether the file actually is one. `document.kind` is set by a person, and
 * `classified_by` records which of the two is speaking.
 *
 * The keyword list is CAC's vocabulary, not a legal taxonomy. It says nothing about what
 * any document is required for — that is the rule engine's business, from approved rules.
 */
const CLASSIFICATION_RULES: Array<{ kind: string; words: string[]; confidence: number }> = [
  { kind: "death certificate", words: ["death cert", "sijil kematian", "cert of death"], confidence: 0.7 },
  { kind: "will", words: ["will", "wasiat", "testament"], confidence: 0.5 },
  { kind: "identity document", words: ["ic ", "nric", "mykad", "passport", "identity card"], confidence: 0.6 },
  { kind: "land title", words: ["title", "hakmilik", "geran", "land search"], confidence: 0.55 },
  { kind: "bank statement", words: ["statement", "penyata", "bank"], confidence: 0.5 },
  { kind: "birth certificate", words: ["birth cert", "sijil lahir"], confidence: 0.7 },
  { kind: "marriage certificate", words: ["marriage cert", "sijil perkahwinan", "nikah"], confidence: 0.7 },
  { kind: "grant", words: ["grant", "probate", "letters of administration", "surat kuasa"], confidence: 0.6 },
  { kind: "valuation report", words: ["valuation", "appraisal", "penilaian"], confidence: 0.6 },
  { kind: "correspondence", words: ["letter", "email", "surat", "notice"], confidence: 0.4 },
  { kind: "invoice", words: ["invoice", "inbois", "bill", "receipt", "resit"], confidence: 0.5 },
];

export interface Suggestion {
  kind: string | null;
  confidence: number | null;
  reason: string;
}

export function suggestKind(filename: string, mediaType: string): Suggestion {
  const haystack = ` ${filename.toLowerCase().replace(/[_\-.]+/g, " ")} `;

  for (const rule of CLASSIFICATION_RULES) {
    const hit = rule.words.find((word) => haystack.includes(word));
    if (hit) {
      return {
        kind: rule.kind,
        confidence: rule.confidence,
        reason: `The filename contains "${hit.trim()}". A guess from the name, not a reading of the file.`,
      };
    }
  }

  if (mediaType.startsWith("image/")) {
    return {
      kind: null,
      confidence: null,
      reason: "An image. Nothing about the name suggests what it is of.",
    };
  }
  return {
    kind: null,
    confidence: null,
    reason: "Nothing in the name suggests what this is. Set it by hand.",
  };
}

// ---------------------------------------------------------------------------
// Registering an upload
// ---------------------------------------------------------------------------

export interface RegisterUploadInput {
  title?: string;
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
  caseId?: string | null;
  confidentiality?: "internal" | "client" | "restricted";
  notes?: string | null;
}

/**
 * Takes the bytes, checksums them, stores them, and puts the document in quarantine.
 *
 * The checksum is computed here, from the bytes actually received, before anything else
 * happens to them — not from anything the browser said. The document then starts
 * quarantined, which is not a formality: until it is scanned or released, nothing will
 * extract it, index it or let anybody download it.
 *
 * A duplicate checksum is reported rather than refused: the same death certificate
 * legitimately belongs to two matters, and refusing the second would send somebody to
 * find a workaround.
 */
export async function registerUpload(
  db: Executor,
  principal: Principal,
  input: RegisterUploadInput,
  context?: AuditContext,
): Promise<{ id: string; documentNo: string; duplicateOf: string | null }> {
  requireCapability(principal, "doc.upload");

  if (input.bytes.byteLength === 0) {
    throw new ValidationError("That file is empty.", "file");
  }
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new ValidationError(
      `That file is ${Math.round(input.bytes.byteLength / 1024 / 1024)} MB. The limit is ${
        MAX_UPLOAD_BYTES / 1024 / 1024
      } MB, because originals are held in the database so that a backup restores the file and the record describing it together.`,
      "file",
    );
  }

  const filename = input.filename.trim();
  if (!filename) throw new ValidationError("The file has no name.", "file");

  // A document filed against a matter is a write to that matter's file, so it takes the
  // same access check as anything else on it.
  if (input.caseId) {
    requireCapability(principal, "case.document.upload");
    const record = await requireCaseAccess(db, principal, input.caseId);
    if (record.status === "closed" || record.status === "withdrawn") {
      throw new ConflictError(
        `${record.caseNo} is ${record.status}. Reopen it before filing documents against it.`,
      );
    }
  }

  const mediaType = normaliseMediaType(input.mediaType, filename);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const title = input.title?.trim() || filename;

  const duplicate = await db.execute<{ id: string; document_no: string }>(sql`
    SELECT d.id, d.document_no FROM library.document d
     WHERE d.sha256 = ${sha256} AND ${libraryAccessClause(principal)}
     LIMIT 1
  `);

  const suggestion = suggestKind(filename, mediaType);
  const documentNo = await allocateDocumentNumber(db, "document");

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO library.document
      (document_no, title, original_filename, media_type, byte_size, sha256, case_id,
       confidentiality, suggested_kind, suggested_confidence, classified_by, classified_at,
       notes, created_by)
    VALUES
      (${documentNo}, ${title}, ${filename}, ${mediaType}, ${input.bytes.byteLength},
       ${sha256}, ${input.caseId ?? null}, ${input.confidentiality ?? "internal"},
       ${suggestion.kind}, ${suggestion.confidence},
       ${suggestion.kind ? "rule" : null}, ${suggestion.kind ? sql`now()` : sql`NULL`},
       ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = inserted.rows![0].id;

  await db.execute(sql`
    INSERT INTO library.document_blob (document_id, content, byte_size, sha256)
    VALUES (${id}, ${Buffer.from(input.bytes)}, ${input.bytes.byteLength}, ${sha256})
  `);

  await logStage(db, {
    documentId: id,
    stage: "registered",
    outcome: "ok",
    detail: `${filename} (${mediaType}, ${input.bytes.byteLength} bytes) stored and checksummed. In quarantine until scanned or released.`,
    principal,
  });

  if (suggestion.kind) {
    await logStage(db, {
      documentId: id,
      stage: "classified",
      outcome: "ok",
      detail: `Suggested "${suggestion.kind}" at ${suggestion.confidence}. ${suggestion.reason}`,
      principal,
    });
  }

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.DOCUMENT_REGISTERED,
    entityType: "library.document",
    entityId: id,
    // The file's identity, not its contents.
    newValues: { documentNo, mediaType, byteSize: input.bytes.byteLength, sha256, caseId: input.caseId ?? null },
  });

  return { id, documentNo, duplicateOf: duplicate.rows?.[0]?.document_no ?? null };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

export interface ScanReport {
  status: ScanStatus;
  detail: string;
}

/**
 * Asks the configured scanner about a document.
 *
 * Three outcomes, and they are all distinguishable afterwards. A verdict: `clean` or
 * `infected`, with the scanner's name against it. No scanner: the document stays
 * quarantined and the reason says what is missing. A scanner that could not answer:
 * `scan_failed`, which is not the same as clean and does not let the document through.
 */
export async function scanDocument(
  db: Executor,
  principal: Principal,
  documentId: string,
  scanner: MalwareScanner,
  context?: AuditContext,
): Promise<ScanReport> {
  requireCapability(principal, "doc.upload");
  const document = await loadAccessible(db, principal, documentId);

  if (document.scanStatus === "produced_internally") {
    throw new ConflictError(
      `${document.documentNo} was produced by this platform, not ingested from anywhere, so there is ` +
        "nothing for a scanner to have an opinion about.",
    );
  }
  if (document.scanStatus === "clean" || document.scanStatus === "infected") {
    return {
      status: document.scanStatus,
      detail: "Already scanned; the verdict stands.",
    };
  }
  if (document.scanStatus === "released_unscanned") {
    throw new ConflictError(
      "This document was released without a scan. Scanning it now would not change the fact that it was released unscanned, which is what the record has to keep saying.",
    );
  }

  const blob = await db.execute<{ content: Uint8Array }>(
    sql`SELECT content FROM library.document_blob WHERE document_id = ${documentId}`,
  );
  const bytes = blob.rows?.[0]?.content;
  if (!bytes) throw new NotFoundError("The stored file is missing.");

  try {
    const result = await scanner.scan(new Uint8Array(bytes), document.originalFilename);

    await db.execute(sql`
      UPDATE library.document
         SET scan_status = ${result.verdict}, scanner = ${result.scanner},
             scanner_version = ${result.scannerVersion}, scanned_at = now(),
             scan_detail = ${result.detail}, updated_by = ${principal.userId}
       WHERE id = ${documentId}
    `);

    await logStage(db, {
      documentId,
      stage: "scanned",
      outcome: result.verdict === "clean" ? "ok" : "blocked",
      detail: `${result.scanner}${result.scannerVersion ? ` ${result.scannerVersion}` : ""}: ${
        result.verdict === "clean" ? "no threat found" : `infected — ${result.detail}`
      }`,
      principal,
    });

    await writeAudit(db, {
      ...context,
      actorUserId: principal.userId,
      actorLabel: principal.email,
      action: AUDIT.DOCUMENT_SCANNED,
      entityType: "library.document",
      entityId: documentId,
      newValues: {
        documentNo: document.documentNo,
        verdict: result.verdict,
        scanner: result.scanner,
      },
    });

    return {
      status: result.verdict,
      detail:
        result.verdict === "clean"
          ? "Scanned; no threat found."
          : `Infected: ${result.detail}. This verdict is final and the file cannot be opened.`,
    };
  } catch (error) {
    if (error instanceof ScannerNotConfiguredError) {
      await logStage(db, {
        documentId,
        stage: "scanned",
        outcome: "skipped",
        detail: error.message,
        principal,
      });
      return { status: "quarantined", detail: error.message };
    }
    if (error instanceof ScanFailedError) {
      await db.execute(sql`
        UPDATE library.document
           SET scan_status = 'scan_failed', scan_detail = ${error.message},
               updated_by = ${principal.userId}
         WHERE id = ${documentId}
      `);
      await logStage(db, {
        documentId,
        stage: "scanned",
        outcome: "failed",
        detail: error.message,
        principal,
      });
      return { status: "scan_failed", detail: error.message };
    }
    throw error;
  }
}

/**
 * Releases a document that has not been scanned.
 *
 * The deliberate escape hatch for a firm with no scanner, and it is built to be
 * uncomfortable in proportion to what it means. It takes `doc.archive` — held by the
 * people who administer the library rather than anybody who can upload — it takes a
 * reason, it is audited, and the document is marked `released_unscanned` permanently.
 * Nothing anywhere afterwards describes it as clean.
 */
export async function releaseQuarantine(
  db: Executor,
  principal: Principal,
  documentId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "doc.archive");
  const document = await loadAccessible(db, principal, documentId);

  const why = reason.trim();
  if (why.length < 10) {
    throw new ValidationError(
      "Say why this file is being released without a scan. This is the note somebody reads if the file turns out to have been a problem.",
      "reason",
    );
  }

  if (document.scanStatus === "infected") {
    throw new ConflictError(
      "This file was found to be infected. It cannot be released, by anybody, for any reason.",
    );
  }
  if (document.scanStatus === "clean") {
    throw new ConflictError("This document has been scanned and found clean; there is nothing to release.");
  }
  if (document.scanStatus === "released_unscanned") return;

  await db.execute(sql`
    UPDATE library.document
       SET scan_status = 'released_unscanned', released_by = ${principal.userId},
           released_at = now(), release_reason = ${why}, updated_by = ${principal.userId}
     WHERE id = ${documentId}
  `);

  await logStage(db, {
    documentId,
    stage: "released",
    outcome: "ok",
    detail: `Released without a scan by ${principal.fullName}: ${why}`,
    principal,
  });

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.DOCUMENT_RELEASED,
    entityType: "library.document",
    entityId: documentId,
    newValues: { documentNo: document.documentNo, scanStatus: "released_unscanned" },
    reason: why,
  });
}

// ---------------------------------------------------------------------------
// Extraction and indexing
// ---------------------------------------------------------------------------

export interface ExtractReport {
  status: ExtractionStatus;
  method: string | null;
  pageCount: number;
  textChars: number;
  chunkCount: number;
  detail: string;
}

/**
 * Reads the document's text, splits it, and indexes the pieces.
 *
 * One call because the three are meaningless apart: text with no chunks is not
 * searchable, and chunks with no text are nothing. Running it again replaces what was
 * there — which is why chunks are deleted and rewritten rather than edited, and why the
 * database refuses an in-place edit of a chunk's text.
 *
 * `ocr` is optional and is used only when the extractor says the file needs it. With no
 * engine configured the document stops at `needs_ocr`, which is the truthful state: the
 * original is held, and its contents are not searchable.
 */
export async function extractAndIndex(
  db: Executor,
  principal: Principal,
  documentId: string,
  options: { ocr?: OcrEngine; context?: AuditContext } = {},
): Promise<ExtractReport> {
  requireCapability(principal, "doc.upload");
  const document = await loadAccessible(db, principal, documentId);

  /**
   * Refused for a document this platform produced, and this refusal is the point of the state.
   *
   * Extraction replaces: it deletes the pages and chunks that were there and writes whatever it finds
   * this time. For an uploaded file that is right — a failed re-read must not leave stale chunks
   * behind. For a generated PDF it is destruction. The extractor sees `application/pdf`, has no OCR
   * engine, returns `needs_ocr`, and the delete has already happened: the text supplied at
   * finalisation is gone, and it cannot come back, because finalising refuses to run twice and the
   * generated document is immutable by trigger. The searchable text of an approved legal document
   * was one button press from being destroyed with no warning and no way back.
   */
  if (document.scanStatus === "produced_internally") {
    throw new ConflictError(
      `${document.documentNo} was produced by this platform and its text was supplied when it was ` +
        "finalised — it is the text the PDF was rendered from, not something read out of the file. " +
        "Re-reading it would replace that text with what an extractor can find in a PDF, which is " +
        "nothing, and there is no second copy.",
    );
  }

  if (document.scanStatus !== "clean" && document.scanStatus !== "released_unscanned") {
    throw new ConflictError(
      `${document.documentNo} is ${document.scanStatus}. Nothing is read out of a file that has not cleared quarantine.`,
    );
  }

  const blob = await db.execute<{ content: Uint8Array }>(
    sql`SELECT content FROM library.document_blob WHERE document_id = ${documentId}`,
  );
  const bytes = blob.rows?.[0]?.content;
  if (!bytes) throw new NotFoundError("The stored file is missing.");

  let pages: SourcePage[] = [];
  let status: ExtractionStatus;
  let method: ExtractionMethod | null = null;
  let confidence: number | null = null;
  let detail: string;

  const outcome = extractText(new Uint8Array(bytes), document.mediaType, document.originalFilename);

  if (outcome.status === "extracted") {
    status = "extracted";
    method = outcome.method;
    confidence = outcome.confidence;
    detail = outcome.detail;
    pages = outcome.pages.map((page) => ({
      pageNo: page.pageNo,
      text: page.text,
      method: page.method,
      confidence: page.confidence,
    }));
  } else if (outcome.status === "needs_ocr") {
    const engine = options.ocr;
    if (!engine || !engine.isConfigured()) {
      status = "needs_ocr";
      detail = outcome.detail;
    } else {
      try {
        const recognised = await engine.recognise(new Uint8Array(bytes), document.mediaType);
        status = "extracted";
        method = "ocr";
        // The document's confidence is the weakest page's: a document is only as
        // reliable as its least reliable page.
        const stated = recognised.map((page) => page.confidence);
        confidence = stated.every((value) => value !== null)
          ? Math.min(...(stated as number[]))
          : null;
        detail = `Read by ${engine.name} over ${recognised.length} page(s).`;
        pages = recognised.map((page) => ({
          pageNo: page.pageNo,
          text: page.text,
          method: "ocr",
          confidence: page.confidence,
        }));
      } catch (error) {
        status = "needs_ocr";
        detail = error instanceof Error ? error.message : "OCR failed.";
      }
    }
  } else {
    status = "unsupported";
    detail = outcome.detail;
  }

  // Clear what was derived before, in both the success and the failure case: a document
  // whose extraction now fails must not keep chunks from a previous attempt.
  await db.execute(sql`DELETE FROM library.chunk WHERE document_id = ${documentId}`);
  await db.execute(sql`DELETE FROM library.document_page WHERE document_id = ${documentId}`);

  let chunks: TextChunk[] = [];
  let textChars = 0;

  if (status === "extracted") {
    for (const page of pages) {
      await db.execute(sql`
        INSERT INTO library.document_page (document_id, page_no, text, method, confidence)
        VALUES (${documentId}, ${page.pageNo}, ${page.text}, ${page.method}, ${page.confidence})
      `);
    }

    chunks = chunkPages(pages);
    textChars = pages.reduce((total, page) => total + page.text.length, 0);

    for (const chunk of chunks) {
      await db.execute(sql`
        INSERT INTO library.chunk
          (document_id, ordinal, text, page_from, page_to, char_from, char_to,
           token_estimate, method, confidence)
        VALUES
          (${documentId}, ${chunk.ordinal}, ${chunk.text}, ${chunk.pageFrom}, ${chunk.pageTo},
           ${chunk.charFrom}, ${chunk.charTo}, ${chunk.tokenEstimate}, ${chunk.method},
           ${chunk.confidence})
      `);
    }
  }

  await db.execute(sql`
    UPDATE library.document
       SET extraction_status = ${status},
           extraction_method = ${method},
           extraction_confidence = ${confidence},
           extraction_detail = ${detail},
           page_count = ${status === "extracted" ? pages.length : null},
           text_chars = ${status === "extracted" ? textChars : null},
           extracted_at = ${status === "extracted" ? sql`now()` : sql`NULL`},
           chunk_count = ${chunks.length},
           indexed_at = ${chunks.length > 0 ? sql`now()` : sql`NULL`},
           updated_by = ${principal.userId}
     WHERE id = ${documentId}
  `);

  await logStage(db, {
    documentId,
    stage: "extracted",
    outcome: status === "extracted" ? "ok" : status === "needs_ocr" ? "blocked" : "skipped",
    detail,
    principal,
  });

  if (chunks.length > 0) {
    await logStage(db, {
      documentId,
      stage: "chunked",
      outcome: "ok",
      detail: `${chunks.length} chunk(s) from ${textChars} characters, each carrying its page, character span, method and confidence.`,
      principal,
    });
  }

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.DOCUMENT_EXTRACTED,
    entityType: "library.document",
    entityId: documentId,
    // How it went, never what it said.
    newValues: {
      documentNo: document.documentNo,
      status,
      method,
      chunkCount: chunks.length,
    },
  });

  return {
    status,
    method,
    pageCount: pages.length,
    textChars,
    chunkCount: chunks.length,
    detail,
  };
}

/**
 * Attaches vectors to a document's chunks.
 *
 * Refuses when no model is configured, and records that refusal on the document as
 * `not_configured` rather than as a failure — the distinction being that nothing is
 * wrong, something is absent. Lexical retrieval continues to work throughout.
 */
export async function embedDocument(
  db: Executor,
  principal: Principal,
  documentId: string,
  provider: EmbeddingProvider,
  context?: AuditContext,
): Promise<{ status: EmbeddingStatus; detail: string }> {
  requireCapability(principal, "doc.upload");
  const document = await loadAccessible(db, principal, documentId);

  const chunks = await db.execute<{ id: string; text: string }>(sql`
    SELECT id, text FROM library.chunk WHERE document_id = ${documentId} ORDER BY ordinal
  `);
  const rows = chunks.rows ?? [];
  if (rows.length === 0) {
    throw new ConflictError("There is nothing to embed: this document has no indexed text.");
  }

  try {
    const vectors = await provider.embed(rows.map((row) => row.text));
    if (vectors.length !== rows.length) {
      throw new Error("the provider returned a different number of vectors than it was given texts");
    }

    for (let index = 0; index < rows.length; index += 1) {
      const vector = vectors[index];
      if (provider.dimensions > 0 && vector.length !== provider.dimensions) {
        throw new Error(
          `vector ${index} has ${vector.length} dimensions, not the ${provider.dimensions} the model declares`,
        );
      }
      await db.execute(sql`
        UPDATE library.chunk
           SET embedding = ${`{${vector.join(",")}}`}::real[],
               embedding_model = ${provider.model}, embedded_at = now()
         WHERE id = ${rows[index].id}
      `);
    }

    await db.execute(sql`
      UPDATE library.document
         SET embedding_status = 'embedded', embedding_model = ${provider.model},
             embedded_at = now(), embedding_detail = NULL, updated_by = ${principal.userId}
       WHERE id = ${documentId}
    `);
    await logStage(db, {
      documentId,
      stage: "embedded",
      outcome: "ok",
      detail: `${rows.length} chunk(s) embedded with ${provider.model}.`,
      principal,
    });
    return { status: "embedded", detail: `${rows.length} chunk(s) embedded.` };
  } catch (error) {
    const notConfigured = error instanceof EmbeddingNotConfiguredError;
    const message = error instanceof Error ? error.message : "embedding failed";

    await db.execute(sql`
      UPDATE library.document
         SET embedding_status = ${notConfigured ? "not_configured" : "failed"},
             embedding_detail = ${message}, updated_by = ${principal.userId}
       WHERE id = ${documentId}
    `);
    await logStage(db, {
      documentId,
      stage: "embedded",
      outcome: notConfigured ? "skipped" : "failed",
      detail: message,
      principal,
    });

    if (!notConfigured) {
      await writeAudit(db, {
        ...context,
        actorUserId: principal.userId,
        actorLabel: principal.email,
        action: AUDIT.DOCUMENT_EXTRACTED,
        entityType: "library.document",
        entityId: documentId,
        newValues: { documentNo: document.documentNo, embedding: "failed" },
      });
    }

    return { status: notConfigured ? "not_configured" : "failed", detail: message };
  }
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export interface SearchHit {
  chunkId: string;
  documentId: string;
  documentNo: string;
  documentTitle: string;
  caseId: string | null;
  caseNo: string | null;
  ordinal: number;
  pageFrom: number | null;
  pageTo: number | null;
  charFrom: number;
  charTo: number;
  /** How the text was obtained, carried into the result on purpose. */
  method: string;
  confidence: number | null;
  /** The matching passage with the query terms marked, from ts_headline. */
  excerpt: string;
  /** Lexical rank. Not a probability and not comparable across queries. */
  score: number;
  scanStatus: ScanStatus;
}

export interface SearchOptions {
  /** Limit to one matter. Access is still checked. */
  caseId?: string | null;
  limit?: number;
  /** Include documents that were released without a scan. Off by default. */
  includeUnscanned?: boolean;
  /**
   * Match any of the words rather than all of them.
   *
   * Off by default, because somebody typing "death certificate" means both words. On for
   * a query assembled from a case's own fields — a name, a matter type, the kinds of
   * asset — where requiring every term to appear in one passage would match nothing and
   * look like an empty library.
   */
  matchAny?: boolean;
}

export interface SearchResult {
  hits: SearchHit[];
  /** What was actually used, so the screen does not imply semantic search happened. */
  strategy: "lexical";
  semanticAvailable: boolean;
  semanticNote: string;
  /** Documents that hold text nobody can search yet, with the reason. */
  unsearchable: { documentNo: string; title: string; reason: string }[];
}

/**
 * Searches the extracted text.
 *
 * Permission-filtered in the query. Lexical, over both tsvectors — the stemmed English
 * one and the unstemmed `simple` one, which is the only honest treatment of Malay, for
 * which PostgreSQL ships no configuration. Results are ranked with `ts_rank_cd`, which
 * takes term proximity into account, and each hit carries the method and confidence of
 * the text it matched.
 *
 * `strategy` is reported rather than implied: this is lexical retrieval, it says so, and
 * `semanticNote` says what would be needed for the other half. A search UI that says
 * "semantic" while running a keyword query is the kind of small lie that makes somebody
 * trust an empty result.
 */
export async function searchLibrary(
  db: Executor,
  principal: Principal,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  requireCapability(principal, "doc.view");

  const terms = query.trim();
  if (terms.length < 2) {
    throw new ValidationError("Type at least two characters to search for.", "query");
  }

  if (options.caseId) await requireCaseAccess(db, principal, options.caseId);

  const limit = Math.min(options.limit ?? 25, 100);
  // A document this platform produced is searchable on the same footing as a scanned one: its text
  // is the text it was rendered from, which is a stronger provenance than either.
  const allowed = options.includeUnscanned
    ? sql`d.scan_status IN ('clean', 'released_unscanned', 'produced_internally')`
    : sql`d.scan_status IN ('clean', 'produced_internally')`;

  // `plainto_tsquery` ANDs every word, which is what somebody typing a phrase means.
  // `matchAny` joins them with OR through `websearch_to_tsquery` instead.
  const anyText = terms.split(/\s+/).filter(Boolean).join(" or ");
  const english = options.matchAny
    ? sql`websearch_to_tsquery('english', ${anyText})`
    : sql`plainto_tsquery('english', ${terms})`;
  const simple = options.matchAny
    ? sql`websearch_to_tsquery('simple', ${anyText})`
    : sql`plainto_tsquery('simple', ${terms})`;

  const result = await db.execute<Record<string, unknown>>(sql`
    WITH q AS (
      SELECT ${english} AS en, ${simple} AS simple
    )
    SELECT c.id, c.document_id, c.ordinal, c.page_from, c.page_to, c.char_from, c.char_to,
           c.method, c.confidence,
           d.document_no, d.title, d.case_id, d.scan_status,
           cs.case_no,
           GREATEST(
             ts_rank_cd(c.tsv_en, q.en),
             ts_rank_cd(c.tsv_simple, q.simple)
           ) AS score,
           ts_headline('simple', c.text, q.simple,
                       'StartSel=«, StopSel=», MaxWords=45, MinWords=15, ShortWord=2') AS excerpt
      FROM library.chunk c
      JOIN library.document d ON d.id = c.document_id
      CROSS JOIN q
      LEFT JOIN estate.case cs ON cs.id = d.case_id
     WHERE (c.tsv_en @@ q.en OR c.tsv_simple @@ q.simple)
       AND d.archived_at IS NULL
       AND ${allowed}
       AND (${options.caseId ?? null}::uuid IS NULL OR d.case_id = ${options.caseId ?? null})
       AND ${libraryAccessClause(principal)}
     ORDER BY score DESC, d.document_no, c.ordinal
     LIMIT ${limit}
  `);

  // Documents whose text nobody can search, so the screen can say "not found here" and
  // "and these files were never read" as two different statements.
  const blocked = await db.execute<Record<string, unknown>>(sql`
    SELECT d.document_no, d.title,
           CASE
             WHEN d.scan_status = 'quarantined' THEN 'In quarantine — not scanned, so not read.'
             WHEN d.scan_status = 'infected' THEN 'Found to be infected; never opened.'
             WHEN d.scan_status = 'scan_failed' THEN 'The scanner could not give a verdict, so it has not been read.'
             WHEN d.extraction_status = 'needs_ocr' THEN 'A scan or an image; no OCR engine is configured.'
             WHEN d.extraction_status = 'unsupported' THEN 'Nothing here reads this kind of file.'
             WHEN d.extraction_status = 'failed' THEN 'Extraction failed.'
             ELSE 'Not indexed yet.'
           END AS reason
      FROM library.document d
     WHERE d.archived_at IS NULL
       AND (d.scan_status NOT IN ('clean', 'produced_internally')
            OR d.extraction_status <> 'extracted' OR d.chunk_count = 0)
       AND (${options.caseId ?? null}::uuid IS NULL OR d.case_id = ${options.caseId ?? null})
       AND ${libraryAccessClause(principal)}
     ORDER BY d.document_no
     LIMIT 50
  `);

  return {
    hits: (result.rows ?? []).map((row) => ({
      chunkId: String(row.id),
      documentId: String(row.document_id),
      documentNo: String(row.document_no),
      documentTitle: String(row.title),
      caseId: (row.case_id as string) ?? null,
      caseNo: (row.case_no as string) ?? null,
      ordinal: Number(row.ordinal),
      pageFrom: row.page_from === null ? null : Number(row.page_from),
      pageTo: row.page_to === null ? null : Number(row.page_to),
      charFrom: Number(row.char_from),
      charTo: Number(row.char_to),
      method: String(row.method),
      confidence: row.confidence === null ? null : Number(row.confidence),
      excerpt: String(row.excerpt),
      score: Number(row.score),
      scanStatus: row.scan_status as ScanStatus,
    })),
    strategy: "lexical",
    semanticAvailable: false,
    semanticNote:
      "Full-text search over the extracted text. Semantic search is not available: no embedding model is configured, and a fabricated vector would return confident nonsense (Q-AI-1, Q-DATA-2).",
    unsearchable: (blocked.rows ?? []).map((row) => ({
      documentNo: String(row.document_no),
      title: String(row.title),
      reason: String(row.reason),
    })),
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ListLibraryOptions {
  caseId?: string | null;
  scanStatus?: ScanStatus;
  search?: string;
  includeArchived?: boolean;
  limit?: number;
}

export async function listLibraryDocuments(
  db: Executor,
  principal: Principal,
  options: ListLibraryOptions = {},
): Promise<LibraryDocument[]> {
  const search = options.search?.trim() || null;

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT d.*, cs.case_no, maker.full_name AS created_by_name,
           releaser.full_name AS released_by_name
      FROM library.document d
      LEFT JOIN estate.case cs ON cs.id = d.case_id
      LEFT JOIN auth."user" maker ON maker.id = d.created_by
      LEFT JOIN auth."user" releaser ON releaser.id = d.released_by
     WHERE ${libraryAccessClause(principal)}
       AND (${options.includeArchived ?? false} = true OR d.archived_at IS NULL)
       AND (${options.caseId ?? null}::uuid IS NULL OR d.case_id = ${options.caseId ?? null})
       AND (${options.scanStatus ?? null}::text IS NULL OR d.scan_status = ${options.scanStatus ?? null})
       AND (${search}::text IS NULL
            OR d.title ILIKE '%' || ${search} || '%'
            OR d.document_no ILIKE '%' || ${search} || '%'
            OR d.original_filename ILIKE '%' || ${search} || '%')
     ORDER BY d.created_at DESC
     LIMIT ${options.limit ?? 200}
  `);
  return (result.rows ?? []).map(toLibraryDocument);
}

export async function getLibraryDocument(
  db: Executor,
  principal: Principal,
  documentId: string,
): Promise<LibraryDocument | null> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT d.*, cs.case_no, maker.full_name AS created_by_name,
           releaser.full_name AS released_by_name
      FROM library.document d
      LEFT JOIN estate.case cs ON cs.id = d.case_id
      LEFT JOIN auth."user" maker ON maker.id = d.created_by
      LEFT JOIN auth."user" releaser ON releaser.id = d.released_by
     WHERE d.id = ${documentId} AND ${libraryAccessClause(principal)}
  `);
  const row = result.rows?.[0];
  return row ? toLibraryDocument(row) : null;
}

function toLibraryDocument(row: Record<string, unknown>): LibraryDocument {
  const scanStatus = row.scan_status as ScanStatus;
  return {
    id: String(row.id),
    documentNo: String(row.document_no),
    title: String(row.title),
    originalFilename: String(row.original_filename),
    mediaType: String(row.media_type),
    byteSize: Number(row.byte_size),
    sha256: String(row.sha256),
    caseId: (row.case_id as string) ?? null,
    caseNo: (row.case_no as string) ?? null,
    confidentiality: row.confidentiality as LibraryDocument["confidentiality"],
    suggestedKind: (row.suggested_kind as string) ?? null,
    suggestedConfidence:
      row.suggested_confidence === null ? null : Number(row.suggested_confidence),
    kind: (row.kind as string) ?? null,
    classifiedBy: (row.classified_by as "rule" | "person" | null) ?? null,
    scanStatus,
    scanner: (row.scanner as string) ?? null,
    scannerVersion: (row.scanner_version as string) ?? null,
    scannedAt: row.scanned_at ? new Date(String(row.scanned_at)).toISOString() : null,
    scanDetail: (row.scan_detail as string) ?? null,
    releasedByName: (row.released_by_name as string) ?? null,
    releasedAt: row.released_at ? new Date(String(row.released_at)).toISOString() : null,
    releaseReason: (row.release_reason as string) ?? null,
    extractionStatus: row.extraction_status as ExtractionStatus,
    extractionMethod: (row.extraction_method as string) ?? null,
    extractionConfidence:
      row.extraction_confidence === null ? null : Number(row.extraction_confidence),
    extractionDetail: (row.extraction_detail as string) ?? null,
    pageCount: row.page_count === null ? null : Number(row.page_count),
    textChars: row.text_chars === null ? null : Number(row.text_chars),
    chunkCount: Number(row.chunk_count ?? 0),
    indexedAt: row.indexed_at ? new Date(String(row.indexed_at)).toISOString() : null,
    embeddingStatus: row.embedding_status as EmbeddingStatus,
    embeddingModel: (row.embedding_model as string) ?? null,
    embeddingDetail: (row.embedding_detail as string) ?? null,
    notes: (row.notes as string) ?? null,
    archivedAt: row.archived_at ? new Date(String(row.archived_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    createdByName: (row.created_by_name as string) ?? null,
    // Two questions, not one. Its contents may be handled — downloaded, searched, shown — for
    // anything that cleared quarantine and for anything this platform produced. Whether the
    // *extractor* should be run over it is a different matter: for a generated PDF, running it
    // destroys the only copy of the text.
    readable: TRUSTED_SCAN_STATUSES.has(scanStatus),
    extractable: scanStatus === "clean" || scanStatus === "released_unscanned",
  };
}

/**
 * The stored original, for download.
 *
 * Refuses a document that has not cleared quarantine, and writes an audit row every time
 * — a download is when a document leaves the platform, which is the moment worth
 * recording.
 */
export async function documentBytes(
  db: Executor,
  principal: Principal,
  documentId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<{ bytes: Uint8Array; filename: string; mediaType: string; documentNo: string }> {
  requireCapability(principal, "doc.download");
  const document = await loadAccessible(db, principal, documentId);

  if (document.scanStatus === "infected") {
    throw new ConflictError(
      "This file was found to be infected. It cannot be downloaded, by anybody.",
    );
  }
  if (document.scanStatus === "quarantined" || document.scanStatus === "scan_failed") {
    throw new ConflictError(
      `${document.documentNo} is ${
        document.scanStatus === "quarantined" ? "in quarantine" : "unscanned after a failed scan"
      }. It cannot be opened until it has been scanned clean or released with a reason.`,
    );
  }

  const blob = await db.execute<{ content: Uint8Array }>(
    sql`SELECT content FROM library.document_blob WHERE document_id = ${documentId}`,
  );
  const bytes = blob.rows?.[0]?.content;
  if (!bytes) throw new NotFoundError("The stored file is missing.");

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.DOCUMENT_DOWNLOADED,
    entityType: "library.document",
    entityId: documentId,
    newValues: { documentNo: document.documentNo, scanStatus: document.scanStatus },
    reason: options.reason ?? null,
  });

  return {
    bytes: new Uint8Array(bytes),
    filename: document.originalFilename,
    mediaType: document.mediaType,
    documentNo: document.documentNo,
  };
}

/** The text of one chunk, for showing a hit in context. */
export async function getChunk(
  db: Executor,
  principal: Principal,
  chunkId: string,
): Promise<{
  text: string;
  documentId: string;
  documentNo: string;
  documentTitle: string;
  ordinal: number;
  pageFrom: number | null;
  pageTo: number | null;
  method: string;
  confidence: number | null;
} | null> {
  requireCapability(principal, "doc.view");

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT c.text, c.document_id, c.ordinal, c.page_from, c.page_to, c.method, c.confidence,
           d.document_no, d.title
      FROM library.chunk c
      JOIN library.document d ON d.id = c.document_id
     WHERE c.id = ${chunkId} AND ${libraryAccessClause(principal)}
  `);
  const row = result.rows?.[0];
  if (!row) return null;

  return {
    text: String(row.text),
    documentId: String(row.document_id),
    documentNo: String(row.document_no),
    documentTitle: String(row.title),
    ordinal: Number(row.ordinal),
    pageFrom: row.page_from === null ? null : Number(row.page_from),
    pageTo: row.page_to === null ? null : Number(row.page_to),
    method: String(row.method),
    confidence: row.confidence === null ? null : Number(row.confidence),
  };
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/** Sets what a document is, by a person — which overrides any rule's suggestion. */
export async function setDocumentKind(
  db: Executor,
  principal: Principal,
  documentId: string,
  params: { kind: string; title?: string; confidentiality?: LibraryDocument["confidentiality"]; notes?: string | null },
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "doc.upload");
  const document = await loadAccessible(db, principal, documentId);

  const kind = params.kind.trim();
  if (!kind) throw new ValidationError("Say what this document is.", "kind");

  await db.execute(sql`
    UPDATE library.document
       SET kind = ${kind}, classified_by = 'person', classified_at = now(),
           title = ${params.title?.trim() || sql.raw("title")},
           confidentiality = ${params.confidentiality ?? sql.raw("confidentiality")},
           notes = ${params.notes === undefined ? sql.raw("notes") : (params.notes?.trim() || null)},
           updated_by = ${principal.userId}
     WHERE id = ${documentId}
  `);

  await logStage(db, {
    documentId,
    stage: "classified",
    outcome: "ok",
    detail: `Set to "${kind}" by ${principal.fullName}.`,
    principal,
  });

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.DOCUMENT_CLASSIFIED,
    entityType: "library.document",
    entityId: documentId,
    newValues: { documentNo: document.documentNo, kind },
  });
}

/**
 * Takes a document out of the library without destroying it.
 *
 * Archiving rather than deleting, because a document that was relied on once may need to
 * be produced again. Its chunks go, so it stops appearing in search; the original stays.
 */
export async function archiveDocument(
  db: Executor,
  principal: Principal,
  documentId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "doc.archive");
  const document = await loadAccessible(db, principal, documentId);

  const why = reason.trim();
  if (!why) throw new ValidationError("Say why it is being archived.", "reason");

  await db.execute(sql`DELETE FROM library.chunk WHERE document_id = ${documentId}`);
  await db.execute(sql`
    UPDATE library.document
       SET archived_at = now(), archived_by = ${principal.userId}, chunk_count = 0,
           indexed_at = NULL, updated_by = ${principal.userId}
     WHERE id = ${documentId}
  `);

  await logStage(db, {
    documentId,
    stage: "archived",
    outcome: "ok",
    detail: `Archived by ${principal.fullName}: ${why}. The original is kept; it no longer appears in search.`,
    principal,
  });

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.DOCUMENT_ARCHIVED,
    entityType: "library.document",
    entityId: documentId,
    newValues: { documentNo: document.documentNo },
    reason: why,
  });
}

/**
 * Destroys a document and everything derived from it.
 *
 * Refused while a case checklist item is satisfied by it — the database holds that too.
 * Deliberately harder to reach than archiving, and it takes a reason that goes into the
 * audit trail, because this is the one operation here that loses the original.
 */
export async function deleteDocument(
  db: Executor,
  principal: Principal,
  documentId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "doc.delete");
  const document = await loadAccessible(db, principal, documentId);

  const why = reason.trim();
  if (why.length < 10) {
    throw new ValidationError(
      "Say why the original is being destroyed. This is the only operation here that cannot be undone.",
      "reason",
    );
  }

  // Written before the delete, because the ingestion log goes with the document.
  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.DOCUMENT_DELETED,
    entityType: "library.document",
    entityId: documentId,
    oldValues: { documentNo: document.documentNo, caseId: document.caseId },
    reason: why,
  });

  await db.execute(sql`DELETE FROM library.document WHERE id = ${documentId}`);
}

/** What the library holds, for the overview. */
export interface LibrarySummary {
  total: number;
  quarantined: number;
  infected: number;
  releasedUnscanned: number;
  searchable: number;
  needsOcr: number;
  unsupported: number;
  chunks: number;
  scannerConfigured: boolean;
  embeddingConfigured: boolean;
}

export async function librarySummary(
  db: Executor,
  principal: Principal,
  scanner: MalwareScanner,
  embedding: EmbeddingProvider,
): Promise<LibrarySummary> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE d.scan_status = 'quarantined') AS quarantined,
           count(*) FILTER (WHERE d.scan_status = 'infected') AS infected,
           count(*) FILTER (WHERE d.scan_status = 'released_unscanned') AS released,
           count(*) FILTER (WHERE d.chunk_count > 0) AS searchable,
           count(*) FILTER (WHERE d.extraction_status = 'needs_ocr') AS needs_ocr,
           count(*) FILTER (WHERE d.extraction_status = 'unsupported') AS unsupported,
           COALESCE(sum(d.chunk_count), 0) AS chunks
      FROM library.document d
     WHERE d.archived_at IS NULL AND ${libraryAccessClause(principal)}
  `);
  const row = result.rows?.[0] ?? {};

  return {
    total: Number(row.total ?? 0),
    quarantined: Number(row.quarantined ?? 0),
    infected: Number(row.infected ?? 0),
    releasedUnscanned: Number(row.released ?? 0),
    searchable: Number(row.searchable ?? 0),
    needsOcr: Number(row.needs_ocr ?? 0),
    unsupported: Number(row.unsupported ?? 0),
    chunks: Number(row.chunks ?? 0),
    scannerConfigured: scanner.isConfigured(),
    embeddingConfigured: embedding.isConfigured(),
  };
}
