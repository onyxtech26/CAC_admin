import { inflateRawSync, inflateSync } from "node:zlib";

/**
 * Turning a file into text — and refusing to when it cannot be done honestly.
 *
 * Extraction is the stage where a document-handling system is most tempted to guess, and
 * where guessing does the most damage. A death certificate whose text was "extracted"
 * wrongly does not look wrong: it looks like a death certificate with slightly different
 * details, and it is then chunked, indexed and retrieved as though it were the document.
 *
 * So the rule here is that every extractor either produces the text that is actually in
 * the file, or declines and says what is missing. There is no best-effort path.
 *
 * What is implemented, and genuinely:
 *
 *   - **Plain text families** — text/plain, CSV, Markdown, JSON, XML, HTML. The bytes
 *     are decoded, and for HTML and XML the markup is removed. Confidence 1: the text is
 *     the file.
 *   - **DOCX** — a .docx is a ZIP holding `word/document.xml`, and the text is the
 *     contents of its `<w:t>` elements. That is exact, not heuristic: the elements are
 *     the text runs. Paragraph and table-row boundaries become line breaks. Confidence 1.
 *
 * What is refused, and why:
 *
 *   - **PDF.** A PDF's text layer requires parsing the cross-reference table, decoding
 *     content streams and resolving font encodings, including CID fonts with custom
 *     ToUnicode maps. Done imperfectly it produces text that is *plausible and wrong* —
 *     transposed characters, dropped diacritics, ligatures silently lost. Many of CAC's
 *     documents are scans with no text layer at all. So a PDF is marked `needs_ocr`,
 *     which is the truthful state, and the screen says what would change it.
 *   - **Images.** Nothing here reads an image. `needs_ocr`.
 *   - **Everything else.** `unsupported`, naming the media type.
 *
 * An OCR engine is a configured dependency, not a bundled one — `OcrEngine` below is the
 * seam, and `NotConfiguredOcrEngine` refuses. Q-AI-1 and Q-DATA-2 cover which engine CAC
 * may use, given that these documents contain personal data and some of them may not
 * leave the country.
 */

/**
 * How a document's text was obtained.
 *
 * `generated` is text this platform produced and then rendered into the file, so the text is the
 * source and the PDF is the copy. It is distinct from `manual`, which means a person typed it in:
 * calling generated text manual was a small untruth in the one column that exists to say where text
 * came from.
 */
export type ExtractionMethod = "plain_text" | "docx_xml" | "ocr" | "manual" | "generated";

export type ExtractionOutcome =
  | {
      status: "extracted";
      method: ExtractionMethod;
      /** One entry per page. Plain text and DOCX produce a single page. */
      pages: ExtractedPage[];
      /** 1 when the text is the file's own; whatever OCR reports otherwise. */
      confidence: number | null;
      detail: string;
    }
  | { status: "needs_ocr"; detail: string }
  | { status: "unsupported"; detail: string };

export interface ExtractedPage {
  pageNo: number;
  text: string;
  method: ExtractionMethod;
  confidence: number | null;
}

const PLAIN_TEXT_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/xml",
  "text/html",
]);

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const OCR_NEEDED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/tiff",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

/**
 * Extracts what can be extracted.
 *
 * Synchronous and pure: the same bytes give the same text, every time, which is what
 * makes a rebuild safe. Nothing here reaches the network.
 */
export function extractText(
  bytes: Uint8Array,
  mediaType: string,
  filename: string,
): ExtractionOutcome {
  const type = normaliseMediaType(mediaType, filename);

  if (PLAIN_TEXT_TYPES.has(type)) {
    const decoded = decodeText(bytes);
    const text =
      type === "text/html" || type === "application/xml" || type === "text/xml"
        ? stripMarkup(decoded)
        : decoded;
    return {
      status: "extracted",
      method: "plain_text",
      pages: [{ pageNo: 1, text, method: "plain_text", confidence: 1 }],
      confidence: 1,
      detail: `Read directly as ${type}.`,
    };
  }

  if (type === DOCX_TYPE) {
    try {
      const text = extractDocxText(bytes);

      // No text runs at all is not a successful read. It means either a genuinely empty document or a
      // file that is not the Word document it claims to be, and the two are indistinguishable from
      // here — which is the same reason `NotConfiguredOcrEngine` refuses rather than returning an
      // empty page. Reporting success with confidence 1 over an empty string put "nothing" into the
      // index as though it were the document's contents.
      if (text.trim() === "") {
        return {
          status: "unsupported",
          detail:
            "This Word document contains no text runs at all. That is either an empty document or a " +
            "file that is not what it says it is, and nothing here can tell which — so nothing is " +
            "indexed. The original is held unchanged.",
        };
      }

      return {
        status: "extracted",
        method: "docx_xml",
        pages: [{ pageNo: 1, text, method: "docx_xml", confidence: 1 }],
        confidence: 1,
        detail: "Read from the document's own text runs (word/document.xml).",
      };
    } catch (error) {
      return {
        status: "unsupported",
        detail: `This file claims to be a Word document but could not be read: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      };
    }
  }

  if (OCR_NEEDED_TYPES.has(type)) {
    const isPdf = type === "application/pdf";
    return {
      status: "needs_ocr",
      detail: isPdf
        ? "PDFs are not read here. Extracting a PDF text layer correctly means resolving font encodings, and done imperfectly it produces text that is plausible and wrong — which is worse than none on a document that may be produced in evidence. Many of these files are scans with no text layer at all. Configure an OCR engine to read it."
        : `An image (${type}) has no text to read without OCR. Configure an OCR engine to read it.`,
    };
  }

  return {
    status: "unsupported",
    detail: `Nothing here reads ${type}. The original is stored and can be downloaded; its text is not searchable.`,
  };
}

/** The declared media type, corrected by the extension where the browser guessed badly. */
export function normaliseMediaType(mediaType: string, filename: string): string {
  const declared = (mediaType || "").split(";")[0]!.trim().toLowerCase();
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();

  // Browsers send application/octet-stream for plenty of things they do not recognise,
  // and Windows sends nothing at all for .md and .csv. The extension is the better
  // signal in exactly those cases, and only in those.
  if (declared === "" || declared === "application/octet-stream") {
    switch (extension) {
      case "txt":
        return "text/plain";
      case "csv":
        return "text/csv";
      case "tsv":
        return "text/tab-separated-values";
      case "md":
        return "text/markdown";
      case "json":
        return "application/json";
      case "xml":
        return "application/xml";
      case "html":
      case "htm":
        return "text/html";
      case "pdf":
        return "application/pdf";
      case "docx":
        return DOCX_TYPE;
      case "png":
        return "image/png";
      case "jpg":
      case "jpeg":
        return "image/jpeg";
      case "tif":
      case "tiff":
        return "image/tiff";
      default:
        return declared || "application/octet-stream";
    }
  }
  return declared;
}

/**
 * Decodes bytes as text.
 *
 * UTF-8, with the BOM removed. Not a charset-detection heuristic: guessing an encoding
 * wrongly mangles exactly the characters that matter in Malaysian names, and a mangled
 * name in a case file is a real problem. Invalid sequences become the replacement
 * character, which is visible rather than silently wrong.
 */
export function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/** Markup removed, structure kept as line breaks. */
export function stripMarkup(input: string): string {
  return input
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    // A block tag leaves a space either side of the break it became; collapsing
    // those keeps the text a reader would see rather than subtly indented.
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

/**
 * The text of a Word document.
 *
 * A .docx is a ZIP. `word/document.xml` holds the body, and the text lives in `<w:t>`
 * elements — one per run. Reading those elements is exact: they *are* the text, not a
 * rendering of it. `<w:p>` ends a paragraph, `<w:tab/>` is a tab, `<w:br/>` a line break.
 *
 * Deliberately not a general XML parse: the file is read for its text runs and nothing
 * else, which keeps the failure mode "missing text" rather than "wrong text".
 */
export function extractDocxText(bytes: Uint8Array): string {
  const xml = readZipEntry(bytes, "word/document.xml");
  if (!xml) throw new Error("no word/document.xml inside the archive");

  const document = decodeText(xml);

  const withBreaks = document
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, "\t");

  const runs: string[] = [];
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|(\n|\t)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withBreaks)) !== null) {
    if (match[1] !== undefined) runs.push(decodeXmlEntities(match[1]));
    else if (match[2] !== undefined) runs.push(match[2]);
  }

  return runs
    .join("")
    .replace(/\t+\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&amp;/g, "&");
}

/**
 * The most a single entry may expand to.
 *
 * Deflate reaches about 1032:1 on a run of zeros, so a few megabytes inside the 25 MB upload limit
 * decompresses to gigabytes. `inflateRawSync` had no `maxOutputLength` and Node's default is around
 * 4 GiB, so the allocation happened inside the request and six global regex passes then ran over the
 * result. 64 MiB is far more than `word/document.xml` ever is — a thousand-page report's body XML is
 * single-digit megabytes — and small enough that refusing costs nothing real.
 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/**
 * One entry out of a ZIP archive.
 *
 * Read from the end-of-central-directory record rather than by walking local headers:
 * the central directory is authoritative about what is in the archive, and a local
 * header can lie about its sizes (the streaming case sets them to zero and puts the real
 * values in a trailing descriptor). Store and deflate only, which is what Word produces.
 *
 * Everything the archive says about itself is treated as a claim, because the archive is somebody
 * else's file. Two of those claims were believed:
 *
 * **The compressed size.** `subarray` clamps rather than throwing, so an entry that overstated its
 * size yielded whatever bytes followed — or nothing at all, past the end. The caller then found no
 * `<w:t>` elements, produced an empty string, and reported it as a successful read with full
 * confidence. `NotConfiguredOcrEngine` refuses precisely because "an empty page is indistinguishable
 * from a blank document"; this path did the thing that refusal exists to prevent.
 *
 * **The uncompressed size.** It was never read, so nothing bounded what a deflate stream could
 * expand to.
 */
function readZipEntry(bytes: Uint8Array, wanted: string): Uint8Array | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // End of central directory: signature 0x06054b50, within the last 64KB + 22 bytes.
  let eocd = -1;
  const from = Math.max(0, view.length - (0xffff + 22));
  for (let at = view.length - 22; at >= from; at -= 1) {
    if (view.readUInt32LE(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive");

  const entries = view.readUInt16LE(eocd + 10);
  let cursor = view.readUInt32LE(eocd + 16);

  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > view.length || view.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("the archive's central directory is malformed");
    }
    const method = view.readUInt16LE(cursor + 10);
    const compressedSize = view.readUInt32LE(cursor + 20);
    const uncompressedSize = view.readUInt32LE(cursor + 24);
    const nameLength = view.readUInt16LE(cursor + 28);
    const extraLength = view.readUInt16LE(cursor + 30);
    const commentLength = view.readUInt16LE(cursor + 32);
    const localOffset = view.readUInt32LE(cursor + 42);
    const name = view.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    if (name === wanted) {
      if (localOffset + 30 > view.length || view.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error("the archive's entry header is malformed");
      }
      const localNameLength = view.readUInt16LE(localOffset + 26);
      const localExtraLength = view.readUInt16LE(localOffset + 28);
      const dataAt = localOffset + 30 + localNameLength + localExtraLength;

      // The declared size has to fit inside the file. `subarray` would clamp silently, and a short
      // read is indistinguishable downstream from a document with no text in it.
      if (dataAt + compressedSize > view.length) {
        throw new Error(
          `${name} claims ${compressedSize} bytes but the archive ends before that. The file is ` +
            "truncated or the directory is wrong; either way it is not safe to read as far as it says.",
        );
      }
      if (uncompressedSize > MAX_ENTRY_BYTES) {
        throw new Error(
          `${name} says it expands to ${uncompressedSize} bytes, past the ${MAX_ENTRY_BYTES}-byte ` +
            "limit for a single entry.",
        );
      }

      const data = view.subarray(dataAt, dataAt + compressedSize);

      if (method === 0) return new Uint8Array(data);
      if (method === 8) {
        // Both bounds: the size the directory declares, and a hard ceiling regardless, because the
        // directory is part of the file being defended against.
        const limit = Math.min(MAX_ENTRY_BYTES, Math.max(uncompressedSize, 1) * 2);
        try {
          return new Uint8Array(inflateRawSync(data, { maxOutputLength: limit }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            /buffer|length|RANGE/i.test(message)
              ? `${name} expands to more than the ${limit} bytes this reader will allocate for it.`
              : `${name} could not be decompressed: ${message}`,
          );
        }
      }
      // 9 is deflate64; anything else is a compression Word does not use.
      throw new Error(`unsupported compression method ${method}`);
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** Exported for the tests, which build a tiny ZIP to prove the reader. */
export const zip = { inflateRawSync, inflateSync };

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

export interface OcrPage {
  pageNo: number;
  text: string;
  /** What the engine reports, on 0..1. Null when the engine does not say. */
  confidence: number | null;
}

export interface OcrEngine {
  readonly name: string;
  isConfigured(): boolean;
  recognise(bytes: Uint8Array, mediaType: string): Promise<OcrPage[]>;
}

export class OcrNotConfiguredError extends Error {
  readonly code = "OCR_NOT_CONFIGURED";
  constructor(message: string) {
    super(message);
    this.name = "OcrNotConfiguredError";
  }
}

/**
 * What is installed.
 *
 * Refuses, and says what is missing. It does not return an empty page, because an empty
 * page is indistinguishable from a blank document and would be indexed as one.
 *
 * Choosing an engine is not only a technical decision: these documents contain personal
 * data about identifiable people, and whether they may be sent to a cloud OCR service —
 * and to which jurisdiction — is Q-DATA-2. A local engine avoids the question entirely
 * and is the likely answer, but it is CAC's to give.
 */
export class NotConfiguredOcrEngine implements OcrEngine {
  readonly name = "none";

  isConfigured(): boolean {
    return false;
  }

  async recognise(): Promise<OcrPage[]> {
    throw new OcrNotConfiguredError(
      "No OCR engine is configured, so scanned documents and images cannot be read. The originals are stored and can be downloaded; their contents are not searchable until an engine is configured (Q-AI-1, Q-DATA-2).",
    );
  }
}

/** The OCR engine this deployment has. Absent configuration means absent OCR. */
export function ocrFromEnv(_env: Record<string, string | undefined> = process.env): OcrEngine {
  // Deliberately no engine is wired yet. When one is chosen it is constructed here from
  // explicit configuration, the same way the scanner is — and, like the scanner, a
  // missing or broken configuration produces the refusing implementation rather than a
  // silent fallback.
  return new NotConfiguredOcrEngine();
}
