import { ValidationError } from "./errors.js";

/**
 * Reading delimited text that came from somebody else's system.
 *
 * `apps/staff/src/lib/csv.ts` writes CSV; this reads it, and the two problems are
 * not symmetrical. Writing, we choose the shape. Reading, we are handed whatever
 * a bank's export happens to be, and every assumption is a way for a month of
 * transactions to be silently misread.
 *
 * So: RFC 4180 quoting including doubled quotes and embedded newlines, CRLF or
 * LF, an optional UTF-8 BOM, and the delimiter detected from the header rather
 * than assumed — several Malaysian banks export semicolon-separated files, and
 * Excel on a machine with a comma decimal separator will do the same.
 *
 * What it deliberately does *not* do is interpret. No number parsing, no date
 * parsing, no header matching. Every cell comes back as the string it was in the
 * file, and deciding what "1,234.50" or "01/02/2026" means belongs where the
 * column mapping is known.
 */

export interface DelimitedTable {
  /** The first row, trimmed, as it appeared. */
  header: string[];
  /** Every row after the header. Short rows are padded, long ones kept whole. */
  rows: string[][];
  delimiter: string;
  /** Rows skipped because they were entirely empty, which trailing newlines produce. */
  blankRowsSkipped: number;
}

const CANDIDATES = [",", ";", "\t", "|"] as const;

/**
 * Picks the delimiter by parsing the first line with each candidate and taking
 * the one that yields the most fields.
 *
 * Counting raw occurrences instead would be fooled by a header such as
 * `"Description, long";Amount`, where the comma inside the quotes outnumbers the
 * real separator.
 */
function detectDelimiter(text: string): string {
  let best = ",";
  let bestCount = 0;

  for (const candidate of CANDIDATES) {
    const [first] = parse(text, candidate, 1);
    const count = first?.length ?? 0;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }

  return best;
}

/**
 * The parser itself: a character scanner, not a regular expression.
 *
 * A quoted field may contain the delimiter, a newline, and doubled quotes, none
 * of which a line-splitting regex survives. `limit` stops after that many
 * records, which is what makes delimiter detection cheap on a large file.
 */
function parse(text: string, delimiter: string, limit = Infinity): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let index = 0;

  const endField = () => {
    record.push(field);
    field = "";
  };

  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  while (index < text.length && records.length < limit) {
    const char = text[index]!;

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === "") {
      quoted = true;
      index += 1;
      continue;
    }

    if (char === delimiter) {
      endField();
      index += 1;
      continue;
    }

    if (char === "\r") {
      // CRLF or a lone CR; either ends the record.
      endRecord();
      index += text[index + 1] === "\n" ? 2 : 1;
      continue;
    }

    if (char === "\n") {
      endRecord();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // A file that does not end with a newline still has a last record.
  if (records.length < limit && (field !== "" || record.length > 0)) endRecord();

  return records;
}

export interface ReadOptions {
  /** Forces a delimiter instead of detecting one. */
  delimiter?: string;
  /**
   * Rows to discard before the header.
   *
   * Bank exports frequently begin with the account name, the download date and a
   * blank line. Saying "skip three" is honest; guessing which row looks like a
   * header is how the wrong row becomes the header.
   */
  skipRows?: number;
  /** Guards against a paste of something that is not a statement. */
  maxRows?: number;
}

export function readDelimited(text: string, options: ReadOptions = {}): DelimitedTable {
  // A BOM left in place becomes part of the first header name, and every lookup
  // for that column then fails for no visible reason.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === "") throw new ValidationError("That file is empty.", "file");

  const delimiter = options.delimiter ?? detectDelimiter(body);
  const all = parse(body, delimiter);

  const afterSkip = all.slice(Math.max(options.skipRows ?? 0, 0));
  const isBlank = (row: string[]) => row.every((cell) => cell.trim() === "");

  const headerRow = afterSkip.find((row) => !isBlank(row));
  if (!headerRow) {
    throw new ValidationError(
      "No column headings were found. If the file begins with a title or the account " +
        "name, say how many rows to skip before the headings.",
      "skipRows",
    );
  }

  const headerIndex = afterSkip.indexOf(headerRow);
  const dataRows = afterSkip.slice(headerIndex + 1);

  const header = headerRow.map((cell) => cell.trim());
  const rows: string[][] = [];
  let blankRowsSkipped = 0;

  for (const row of dataRows) {
    if (isBlank(row)) {
      blankRowsSkipped += 1;
      continue;
    }
    // Pad rather than reject: a bank that omits trailing empty fields is common,
    // and a missing cell is better reported by the column that needed it.
    rows.push(row.length < header.length ? [...row, ...Array(header.length - row.length).fill("")] : row);
    if (options.maxRows && rows.length > options.maxRows) {
      throw new ValidationError(
        `That file has more than ${options.maxRows} rows. Import one statement period at a time.`,
        "file",
      );
    }
  }

  return { header, rows, delimiter, blankRowsSkipped };
}

/**
 * Finds a column by any of several likely headings.
 *
 * Case and punctuation are ignored, so "Transaction Date", "TRANSACTION_DATE"
 * and "transaction date" are one thing. Returns -1 rather than throwing: whether
 * a missing column is fatal depends on which column it is, and only the caller
 * knows that.
 */
export function findColumn(header: string[], candidates: string[]): number {
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = candidates.map(normalise);
  const normalised = header.map(normalise);

  for (const candidate of wanted) {
    const exact = normalised.indexOf(candidate);
    if (exact !== -1) return exact;
  }

  // Then a containment match, so "Txn Date (DD/MM/YYYY)" still finds "txndate".
  //
  // One-directional, and only for candidates long enough to be meaningful. The
  // reverse — a heading contained in a candidate — looks symmetrical and is a
  // trap: "value date" would then claim a column headed "Date". Short candidates
  // are just as bad, because "cr" is inside "description". Both mis-mappings
  // import a month of transactions against the wrong columns, and neither looks
  // wrong afterwards.
  for (const candidate of wanted) {
    if (candidate.length < 4) continue;
    const partial = normalised.findIndex((heading) => heading.includes(candidate));
    if (partial !== -1) return partial;
  }

  return -1;
}
