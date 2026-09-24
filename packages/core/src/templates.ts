import { ValidationError } from "./errors.js";

/**
 * The template engine.
 *
 * Used by Phase 8's employment letters and, later, by the case documents. It is
 * deliberately small and deliberately strict, because the documents it produces are
 * sent to people and occasionally to courts.
 *
 * **Three refusals define it.** An unknown placeholder is refused rather than left
 * in the output — a letter reading "Dear {{name}}" is worse than no letter. A missing
 * value for a declared variable is refused rather than rendered empty, because "your
 * salary will be  per month" is a document somebody will act on. And a variable the
 * template never declared is refused at save time, so the failure happens while
 * somebody is editing a template rather than while generating a letter for a real
 * person.
 *
 * **Conditionals, not logic.** `{{#if x}}…{{/if}}` and its `{{else}}` are the whole
 * language. There are no loops, no expressions and no arithmetic: a template that can
 * compute is a template whose output cannot be predicted by reading it, and these
 * are legal and employment documents. Anything that needs computing is computed
 * before it reaches here and passed in as a value.
 */

export type VariableType = "text" | "number" | "money" | "date" | "boolean";

export interface TemplateVariable {
  key: string;
  label: string;
  type: VariableType;
  required?: boolean;
  /** Where the value normally comes from, shown to whoever fills the letter in. */
  hint?: string;
}

export interface TemplateAnalysis {
  /** Every placeholder the body uses, in order of first appearance. */
  used: string[];
  /** Conditionals the body opens. */
  conditions: string[];
  /** Placeholders used but not declared — a template error. */
  undeclared: string[];
  /** Variables declared but never used — harmless, but worth showing. */
  unused: string[];
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
const BLOCK = /\{\{\s*(#if|\/if|else)\s*([A-Za-z0-9_.]*)\s*\}\}/g;

/**
 * Reads a template without rendering it.
 *
 * Used when saving a template, so a mistake is caught by the person writing it rather
 * than by the person generating a letter from it three months later.
 */
export function analyseTemplate(body: string, declared: TemplateVariable[]): TemplateAnalysis {
  const declaredKeys = new Set(declared.map((variable) => variable.key));

  const used: string[] = [];
  const conditions: string[] = [];

  for (const match of body.matchAll(BLOCK)) {
    const [, keyword, key] = match;
    if (keyword === "#if" && key) {
      if (!conditions.includes(key)) conditions.push(key);
    }
  }

  // Placeholders, excluding the block keywords, which the same braces express.
  const withoutBlocks = body.replace(BLOCK, "");
  for (const match of withoutBlocks.matchAll(PLACEHOLDER)) {
    const key = match[1]!;
    if (!used.includes(key)) used.push(key);
  }

  const referenced = new Set([...used, ...conditions]);

  return {
    used,
    conditions,
    undeclared: [...referenced].filter((key) => !declaredKeys.has(key)),
    unused: [...declaredKeys].filter((key) => !referenced.has(key)),
  };
}

/**
 * Checks the block structure balances.
 *
 * An unclosed `{{#if}}` would otherwise swallow the rest of the letter silently, which
 * is exactly the kind of failure that reaches a recipient.
 */
export function validateTemplateBody(body: string): void {
  let depth = 0;
  let seenElseAtDepth: number[] = [];

  for (const match of body.matchAll(BLOCK)) {
    const [, keyword, key] = match;

    if (keyword === "#if") {
      if (!key) {
        throw new ValidationError("An {{#if}} has no variable after it.", "body");
      }
      depth += 1;
    } else if (keyword === "else") {
      if (depth === 0) {
        throw new ValidationError("There is an {{else}} outside any {{#if}}.", "body");
      }
      if (seenElseAtDepth.includes(depth)) {
        throw new ValidationError("One {{#if}} has two {{else}} clauses.", "body");
      }
      seenElseAtDepth.push(depth);
    } else {
      if (depth === 0) {
        throw new ValidationError("There is a {{/if}} with no {{#if}} before it.", "body");
      }
      seenElseAtDepth = seenElseAtDepth.filter((level) => level !== depth);
      depth -= 1;
    }
  }

  if (depth > 0) {
    throw new ValidationError(
      `${depth} {{#if}} block${depth === 1 ? "" : "s"} were never closed. An unclosed block would ` +
        "silently swallow the rest of the letter.",
      "body",
    );
  }
}

export interface RenderOptions {
  /** How money and dates are written out. Defaults suit a Malaysian letter. */
  formatMoney?: (value: string) => string;
  formatDate?: (value: string) => string;
}

/**
 * Renders a template.
 *
 * Every declared variable marked required has to have a value; every placeholder has
 * to be declared. Nothing is silently omitted, and the error names the variable, so
 * the person filling the letter in knows which box is empty.
 */
export function renderTemplate(
  body: string,
  declared: TemplateVariable[],
  values: Record<string, unknown>,
  options: RenderOptions = {},
): string {
  validateTemplateBody(body);

  const analysis = analyseTemplate(body, declared);
  if (analysis.undeclared.length > 0) {
    throw new ValidationError(
      `The template uses ${analysis.undeclared.map((key) => `{{${key}}}`).join(", ")}, which ` +
        "is not declared. A letter that reaches somebody with a placeholder still in it is worse " +
        "than no letter.",
      "body",
    );
  }

  const byKey = new Map(declared.map((variable) => [variable.key, variable]));

  const missing = declared
    .filter((variable) => variable.required !== false)
    .filter((variable) => {
      // A boolean's falsity is a value; everything else has to be present.
      if (variable.type === "boolean") return values[variable.key] === undefined;
      const value = values[variable.key];
      return value === undefined || value === null || String(value).trim() === "";
    })
    .map((variable) => variable.label);

  if (missing.length > 0) {
    throw new ValidationError(
      `${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no value. Nothing is left ` +
        "blank in a letter: an empty figure is something the recipient will act on.",
      "values",
    );
  }

  // Conditionals first, innermost outwards, so a placeholder inside a false branch is
  // removed before it is ever looked up.
  let rendered = resolveConditionals(body, values);

  rendered = rendered.replace(PLACEHOLDER, (_whole, key: string) => {
    const variable = byKey.get(key);
    const raw = values[key];

    if (raw === undefined || raw === null) return "";

    switch (variable?.type) {
      case "money":
        return (options.formatMoney ?? defaultMoney)(String(raw));
      case "date":
        return (options.formatDate ?? defaultDate)(String(raw));
      case "boolean":
        return raw ? "yes" : "no";
      default:
        return String(raw);
    }
  });

  return rendered;
}

/**
 * Resolves `{{#if}}` blocks.
 *
 * Works from the innermost block outwards by repeatedly matching blocks that contain
 * no further `{{#if}}`. A single regex pass cannot nest, and a recursive parser would
 * be more machinery than a language with one construct deserves.
 */
function resolveConditionals(body: string, values: Record<string, unknown>): string {
  const innermost = /\{\{\s*#if\s+([A-Za-z0-9_.]+)\s*\}\}((?:(?!\{\{\s*#if)[\s\S])*?)\{\{\s*\/if\s*\}\}/;

  let result = body;
  let guard = 0;

  while (innermost.test(result)) {
    if (guard++ > 100) {
      throw new ValidationError(
        "The template nests conditionals more than a hundred deep, which is a mistake rather " +
          "than a document.",
        "body",
      );
    }

    result = result.replace(innermost, (_whole, key: string, inner: string) => {
      const [whenTrue, whenFalse = ""] = inner.split(/\{\{\s*else\s*\}\}/);
      return isTruthy(values[key]) ? whenTrue! : whenFalse;
    });
  }

  return result;
}

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  return text !== "" && text !== "0" && text !== "false" && text !== "no";
}

/** "4500.00" → "4,500.00". Thousands separators, two decimals, no currency. */
function defaultMoney(value: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return number.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "2026-04-06" → "6 April 2026", which is how a letter writes a date. */
function defaultDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;

  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  return `${Number(match[3])} ${months[Number(match[2]) - 1]} ${match[1]}`;
}

/**
 * Splits rendered text into paragraphs for a document writer.
 *
 * A blank line separates paragraphs; a single newline is a line break within one.
 * That is how people write letters in a text box, and it is the difference between a
 * DOCX with sensible paragraph spacing and one long run of text.
 */
export function toParagraphs(rendered: string): string[][] {
  return rendered
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").map((line) => line.trim()))
    .filter((lines) => lines.some((line) => line !== ""));
}
