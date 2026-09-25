/**
 * Splitting extracted text into the passages retrieval actually returns.
 *
 * Pure, deterministic and boring on purpose: the same text always produces the same
 * chunks, with the same character offsets. That is what makes a rebuild safe, and what
 * lets a retrieval result point at "characters 4,120 to 5,380 of the extracted text of
 * DOC-2026-00014, page 3" and have that mean something a year later.
 *
 * Three rules:
 *
 * **Split on structure first.** Paragraph breaks, then sentence ends, then — only if a
 * single sentence is longer than the window — a hard break. Cutting mid-sentence
 * produces passages that read as though they say something other than what the document
 * says, which is the failure that matters when the passage is quoted back to somebody.
 *
 * **Overlap, so a fact spanning a boundary is findable.** A date and the thing it is the
 * date of are often either side of a break.
 *
 * **Offsets are into the extracted text, not the chunk.** Every chunk can be located in
 * its source, and the page it fell on is carried with it.
 */

export interface ChunkingOptions {
  /** Target size in characters. Not tokens: tokens depend on a tokeniser nobody has chosen. */
  targetChars?: number;
  /** How much of the previous chunk to repeat at the start of the next. */
  overlapChars?: number;
  /** A chunk shorter than this is merged into its neighbour rather than stored alone. */
  minChars?: number;
}

export interface SourcePage {
  pageNo: number;
  text: string;
  method: string;
  confidence: number | null;
}

export interface TextChunk {
  ordinal: number;
  text: string;
  charFrom: number;
  charTo: number;
  pageFrom: number | null;
  pageTo: number | null;
  method: string;
  confidence: number | null;
  tokenEstimate: number;
}

const DEFAULTS = { targetChars: 1_400, overlapChars: 160, minChars: 200 };

/**
 * Joins the pages, splits the result, and maps every chunk back to its pages.
 *
 * The pages are joined with a form feed so the page boundaries stay locatable in the
 * combined text, and the offsets reported are into that combined text — which is what is
 * stored as the document's text and what a rebuild starts from.
 */
export function chunkPages(pages: SourcePage[], options: ChunkingOptions = {}): TextChunk[] {
  const { combined, boundaries } = joinPages(pages);
  const spans = splitText(combined, options);

  return spans.map((span, index) => {
    const pageRange = pagesFor(span.from, span.to, boundaries);
    // Every page in the span should agree about method, but if a document ever mixes
    // them the weaker claim wins: a chunk is only as certain as its least certain part.
    const covered = boundaries.filter(
      (boundary) => boundary.to > span.from && boundary.from < span.to,
    );
    const method = covered.length > 0 ? weakestMethod(covered) : (pages[0]?.method ?? "plain_text");
    const confidence = covered.length > 0 ? lowestConfidence(covered) : (pages[0]?.confidence ?? null);

    return {
      ordinal: index + 1,
      text: combined.slice(span.from, span.to),
      charFrom: span.from,
      charTo: span.to,
      pageFrom: pageRange.from,
      pageTo: pageRange.to,
      method,
      confidence,
      tokenEstimate: estimateTokens(combined.slice(span.from, span.to)),
    };
  });
}

interface PageBoundary {
  pageNo: number;
  from: number;
  to: number;
  method: string;
  confidence: number | null;
}

/** The combined text, and where each page sits in it. */
export function joinPages(pages: SourcePage[]): {
  combined: string;
  boundaries: PageBoundary[];
} {
  const boundaries: PageBoundary[] = [];
  let combined = "";

  for (const page of [...pages].sort((a, b) => a.pageNo - b.pageNo)) {
    const from = combined.length;
    combined += page.text;
    boundaries.push({
      pageNo: page.pageNo,
      from,
      to: combined.length,
      method: page.method,
      confidence: page.confidence,
    });
    combined += "\f";
  }

  return { combined: combined.replace(/\f$/, ""), boundaries };
}

function pagesFor(
  from: number,
  to: number,
  boundaries: PageBoundary[],
): { from: number | null; to: number | null } {
  const touched = boundaries.filter((boundary) => boundary.to > from && boundary.from < to);
  if (touched.length === 0) return { from: null, to: null };
  return { from: touched[0].pageNo, to: touched[touched.length - 1].pageNo };
}

const METHOD_STRENGTH: Record<string, number> = {
  plain_text: 3,
  docx_xml: 3,
  manual: 2,
  ocr: 1,
};

function weakestMethod(boundaries: PageBoundary[]): string {
  return boundaries.reduce((weakest, boundary) => {
    const a = METHOD_STRENGTH[boundary.method] ?? 0;
    const b = METHOD_STRENGTH[weakest] ?? 0;
    return a < b ? boundary.method : weakest;
  }, boundaries[0].method);
}

function lowestConfidence(boundaries: PageBoundary[]): number | null {
  const values = boundaries
    .map((boundary) => boundary.confidence)
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  // If any page in the span has no stated confidence, the span's confidence is unknown
  // rather than the minimum of the ones that did state it.
  if (values.length !== boundaries.length) return null;
  return Math.min(...values);
}

/**
 * Where to cut.
 *
 * Returns character spans into `text`. Empty and whitespace-only spans are dropped, so a
 * document of blank pages produces no chunks rather than chunks of nothing.
 */
export function splitText(
  text: string,
  options: ChunkingOptions = {},
): Array<{ from: number; to: number }> {
  const target = options.targetChars ?? DEFAULTS.targetChars;
  const overlap = Math.min(options.overlapChars ?? DEFAULTS.overlapChars, Math.floor(target / 2));
  const minimum = options.minChars ?? DEFAULTS.minChars;

  if (text.trim() === "") return [];
  if (text.length <= target) return [{ from: 0, to: text.length }];

  const spans: Array<{ from: number; to: number }> = [];
  let cursor = 0;

  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= target) {
      spans.push({ from: cursor, to: text.length });
      break;
    }

    const window = text.slice(cursor, cursor + target);
    const cut = preferredCut(window, minimum) ?? target;
    const to = cursor + cut;
    spans.push({ from: cursor, to });

    // The next chunk starts before the last one ended, so a sentence straddling the cut
    // is whole somewhere.
    const next = Math.max(to - overlap, cursor + 1);
    cursor = next;
  }

  // A trailing sliver is merged backwards rather than stored as its own chunk: a chunk of
  // twelve characters retrieves nothing useful and pollutes the ranking.
  if (spans.length > 1) {
    const last = spans[spans.length - 1];
    if (last.to - last.from < minimum) {
      spans.splice(spans.length - 1, 1);
      spans[spans.length - 1].to = last.to;
    }
  }

  return spans.filter((span) => text.slice(span.from, span.to).trim() !== "");
}

/**
 * The best place to cut within a window.
 *
 * A paragraph break if there is one past the minimum, otherwise a sentence end,
 * otherwise a line break, otherwise a space. Null when the window has no break at all —
 * a long unbroken string, such as a base64 blob, gets cut at the target.
 */
function preferredCut(window: string, minimum: number): number | null {
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= minimum) return paragraph + 2;

  const sentence = lastSentenceEnd(window, minimum);
  if (sentence !== null) return sentence;

  const line = window.lastIndexOf("\n");
  if (line >= minimum) return line + 1;

  const space = window.lastIndexOf(" ");
  if (space >= minimum) return space + 1;

  return null;
}

function lastSentenceEnd(window: string, minimum: number): number | null {
  for (let at = window.length - 1; at >= minimum; at -= 1) {
    const character = window[at];
    if (character !== "." && character !== "?" && character !== "!") continue;
    const next = window[at + 1];
    // A full stop followed by a space or nothing ends a sentence; one inside "4.5" or
    // "No. 12" does not.
    if (next === undefined || next === " " || next === "\n") {
      const previous = window[at - 1];
      if (previous !== undefined && /\d/.test(previous) && /\d/.test(window[at + 2] ?? "")) continue;
      return at + 1;
    }
  }
  return null;
}

/**
 * A rough token count, for reporting only.
 *
 * Four characters per token is the usual approximation for English and it is not right
 * for Malay, let alone for a table of figures. Nothing depends on it — it exists so a
 * screen can say how large a chunk is in the units an embedding model would charge in,
 * and it is called an estimate everywhere it appears.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4));
}
