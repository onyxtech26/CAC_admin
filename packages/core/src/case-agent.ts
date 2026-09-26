import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import type { Principal } from "./authz.js";
import { getSetting } from "./settings.js";
import { formatAmount } from "./money.js";
import { parseIsoDate, toIsoDate, today } from "./dates.js";
import {
  describeCondition,
  evaluateCondition,
  factsUsedBy,
  loadCaseFacts,
  rulesInForce,
  type Condition,
} from "./case-rules.js";
import {
  caseAccessClause,
  estatePosition,
  requireCaseAccess,
  type EstatePosition,
} from "./cases.js";
import { listAssets, listCaseFacts, listLiabilities, listParties } from "./case-file.js";
import { listRequirements } from "./case-checklist.js";
import { searchLibrary } from "./library.js";

/**
 * The case agent — the deterministic half, which is all of it that exists.
 *
 * Everything in this file is arithmetic and set operations over what has been recorded.
 * It needs no model, and that is the point: the useful parts of "an agent that helps with a
 * probate matter" turn out to be questions of completeness and consistency, and those have
 * exact answers.
 *
 *   * **What to ask next** — the unanswered questions, ordered by how many undecided
 *     requirements each one would settle. A question that unblocks four rules comes before
 *     one that unblocks none.
 *   * **What is missing** — gaps in the file, each with what it blocks.
 *   * **What contradicts itself** — inconsistencies *between recorded fields*, never a
 *     legal conclusion. Each one is phrased as something to check, not something that is
 *     wrong.
 *   * **Similar matters** — past cases that answered the same questions the same way, by
 *     overlap of fact answers. Called similar matters and not precedent, because precedent
 *     is case law and CAC's own files are not that.
 *   * **Passages worth reading** — the document library's full-text search, run over terms
 *     taken from the matter, permission-filtered like every other read.
 *
 * What is **not** here: any statement about what Malaysian law requires. Every requirement
 * shown comes from an approved rule with its authority attached (Phase 9), and this file
 * only reports which of them are undecided and why. The drafting seam is `assistant.ts`,
 * and it refuses.
 */

// ---------------------------------------------------------------------------
// What to ask next
// ---------------------------------------------------------------------------

export interface NextQuestion {
  factKey: string;
  label: string;
  prompt: string | null;
  kind: string;
  options: string[];
  /** Requirements that cannot be decided until this is answered. */
  blocks: Array<{ ruleCode: string | null; title: string }>;
  /** Present when the question has been asked and recorded as unanswerable. */
  recordedUnknown: boolean;
}

/**
 * The intake order.
 *
 * Sorted by how much each question unblocks, then by the order the questions were declared
 * in. Questions that block nothing are included last: they are still worth asking, and a
 * screen that hid them would be deciding on CAC's behalf what matters.
 */
export async function nextQuestions(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<NextQuestion[]> {
  const record = await requireCaseAccess(db, principal, caseId);
  const [facts, definitions, rules] = await Promise.all([
    loadCaseFacts(db, caseId),
    listCaseFacts(db, principal, caseId),
    rulesInForce(db, record.matterType, toIsoDate(today())),
  ]);

  // Which rules each unanswered fact is holding up.
  const blocking = new Map<string, Array<{ ruleCode: string | null; title: string }>>();
  for (const rule of rules) {
    const verdict = evaluateCondition(rule.appliesWhen, facts);
    if (verdict.decided) continue;
    for (const factKey of verdict.missing) {
      const list = blocking.get(factKey) ?? [];
      list.push({ ruleCode: rule.code, title: rule.title });
      blocking.set(factKey, list);
    }
  }

  const open = definitions.filter((fact) => fact.value === null);

  return open
    .map((fact) => ({
      factKey: fact.factKey,
      label: fact.label,
      prompt: fact.prompt,
      kind: fact.kind,
      options: fact.options,
      blocks: blocking.get(fact.factKey) ?? [],
      recordedUnknown: fact.status === "unknown",
    }))
    .sort((a, b) => {
      if (b.blocks.length !== a.blocks.length) return b.blocks.length - a.blocks.length;
      // A question nobody has touched before one already recorded as unanswerable: asking
      // again is cheap, and re-asking something already established is not.
      if (a.recordedUnknown !== b.recordedUnknown) return a.recordedUnknown ? 1 : -1;
      return a.label.localeCompare(b.label);
    });
}

// ---------------------------------------------------------------------------
// What is missing
// ---------------------------------------------------------------------------

export type GapSeverity = "blocking" | "incomplete" | "worth_checking";

export interface Gap {
  severity: GapSeverity;
  what: string;
  /** What it holds up, where it holds something up. */
  blocks: string | null;
  /** Where to go and deal with it. */
  where: "intake" | "file" | "checklist" | "matter";
}

/**
 * What the file does not have.
 *
 * `blocking` is reserved for things an approved rule is actually waiting on, so the word
 * means something. Everything else is `incomplete` — a gap in the record — or
 * `worth_checking`, which is an observation rather than a fault.
 *
 * Nothing here says a matter *needs* anything: what a matter needs comes from approved
 * rules. These are statements about the completeness of what has been written down.
 */
export async function findGaps(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<Gap[]> {
  const record = await requireCaseAccess(db, principal, caseId);

  const [questions, requirements, parties, assets, liabilities, position] = await Promise.all([
    nextQuestions(db, principal, caseId),
    listRequirements(db, principal, caseId),
    listParties(db, principal, caseId),
    listAssets(db, principal, caseId),
    listLiabilities(db, principal, caseId),
    estatePosition(db, principal, caseId),
  ]);

  const caseRow = await db.execute<{
    date_of_death: string | null;
    deceased_id_enc: string | null;
    customer_id: string | null;
    matter_type: string;
  }>(sql`
    SELECT date_of_death, deceased_id_enc, customer_id, matter_type
      FROM estate.case WHERE id = ${caseId}
  `);
  const matter = caseRow.rows![0];

  const gaps: Gap[] = [];

  // Questions an approved rule is waiting on. The only `blocking` category.
  for (const question of questions.filter((entry) => entry.blocks.length > 0)) {
    gaps.push({
      severity: "blocking",
      what: `${question.label} has not been answered.`,
      blocks: `${question.blocks.length} requirement(s): ${question.blocks
        .map((entry) => entry.title)
        .join("; ")}`,
      where: "intake",
    });
  }

  // Requirements with nothing behind them yet.
  const outstanding = requirements.filter(
    (item) => item.status === "outstanding" || item.status === "in_progress",
  );
  if (outstanding.length > 0) {
    gaps.push({
      severity: "incomplete",
      what: `${outstanding.length} requirement(s) on the checklist are not satisfied, waived or ruled out.`,
      blocks: "closing the matter",
      where: "checklist",
    });
  }

  // The record of the matter itself.
  if (!matter.date_of_death) {
    gaps.push({
      severity: "incomplete",
      what: "No date of death is recorded.",
      blocks: null,
      where: "matter",
    });
  }
  if (!matter.deceased_id_enc) {
    gaps.push({
      severity: "incomplete",
      what: "No identification is recorded for the deceased.",
      blocks: null,
      where: "matter",
    });
  }
  if (!matter.customer_id) {
    gaps.push({
      severity: "worth_checking",
      what: "The matter is not linked to a client record, so it cannot be invoiced from here.",
      blocks: null,
      where: "matter",
    });
  }

  // The people.
  if (parties.length === 0) {
    gaps.push({
      severity: "incomplete",
      what: "Nobody is recorded on the matter — not even who instructed CAC.",
      blocks: null,
      where: "file",
    });
  } else {
    if (!parties.some((party) => party.role === "client")) {
      gaps.push({
        severity: "incomplete",
        what: "No party is recorded as the instructing client.",
        blocks: null,
        where: "file",
      });
    }
    const unidentified = parties.filter(
      (party) => party.partyKind === "person" && !party.hasIdentification,
    );
    if (unidentified.length > 0) {
      gaps.push({
        severity: "incomplete",
        what: `${unidentified.length} person(s) on the file have no identification recorded.`,
        blocks: null,
        where: "file",
      });
    }
    const unverified = parties.filter((party) => party.status === "reported");
    if (unverified.length > 0) {
      gaps.push({
        severity: "worth_checking",
        what: `${unverified.length} of ${parties.length} people on the file are as reported, not verified.`,
        blocks: null,
        where: "file",
      });
    }
    const minorsWithoutDob = parties.filter((party) => party.isMinor && !party.dateOfBirth);
    if (minorsWithoutDob.length > 0) {
      gaps.push({
        severity: "incomplete",
        what: `${minorsWithoutDob.length} person(s) are recorded as minors with no date of birth.`,
        blocks: null,
        where: "file",
      });
    }
  }

  // The inventory.
  if (assets.length === 0) {
    gaps.push({
      severity: "incomplete",
      what: "No assets are recorded.",
      blocks: null,
      where: "file",
    });
  }
  if (position.assetsUnvalued > 0) {
    gaps.push({
      severity: "incomplete",
      what: `${position.assetsUnvalued} asset(s) have no figure, so the estate's total is not the estate's total.`,
      blocks: null,
      where: "file",
    });
  }
  if (position.liabilitiesUnvalued > 0) {
    gaps.push({
      severity: "incomplete",
      what: `${position.liabilitiesUnvalued} liability(ies) have no figure.`,
      blocks: null,
      where: "file",
    });
  }
  if (liabilities.length === 0) {
    gaps.push({
      severity: "worth_checking",
      what: "No liabilities are recorded. An estate with nothing owed is possible, and worth confirming rather than assuming.",
      blocks: null,
      where: "file",
    });
  }
  const unverifiedFigures = [
    ...assets.filter((asset) => asset.valuationAmount !== null && asset.status === "reported"),
    ...liabilities.filter(
      (liability) => liability.amount !== null && liability.status === "reported",
    ),
  ];
  if (unverifiedFigures.length > 0) {
    gaps.push({
      severity: "worth_checking",
      what: `${unverifiedFigures.length} figure(s) in the inventory are as reported rather than verified.`,
      blocks: null,
      where: "file",
    });
  }

  // Documents on the matter that nobody can read.
  const unreadable = await db.execute<{ count: string }>(sql`
    SELECT count(*) AS count FROM library.document
     WHERE case_id = ${caseId} AND archived_at IS NULL
       AND (scan_status NOT IN ('clean', 'produced_internally')
            OR extraction_status <> 'extracted')
  `);
  const stuck = Number(unreadable.rows![0].count);
  if (stuck > 0) {
    gaps.push({
      severity: "worth_checking",
      what: `${stuck} document(s) filed against this matter have not been read — in quarantine, needing OCR, or of a kind nothing here reads.`,
      blocks: null,
      where: "file",
    });
  }

  void record;
  return gaps;
}

// ---------------------------------------------------------------------------
// What contradicts itself
// ---------------------------------------------------------------------------

export interface Contradiction {
  what: string;
  /** Deliberately phrased as a question. This module does not decide who is right. */
  check: string;
}

/**
 * Inconsistencies between things that have been recorded.
 *
 * Every check here compares two recorded fields and reports the disagreement. None of them
 * concludes anything: the wording is always "confirm which is right", because the platform
 * does not know, and a case file that asserts a resolution nobody made is worse than one
 * that flags the question.
 *
 * The age check is the one that would otherwise smuggle in a legal fact, so it runs only
 * when CAC has set `cases.age_of_majority` *and* the source it comes from. Unset, it is
 * skipped — the platform does not know at what age somebody stops being a minor in
 * Malaysia and will not guess.
 */
export async function findContradictions(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<Contradiction[]> {
  await requireCaseAccess(db, principal, caseId);

  const found: Contradiction[] = [];

  const matter = await db.execute<{
    date_of_death: string | null;
    deceased_id_last4: string | null;
    deceased_name: string;
    opened_on: string;
  }>(sql`
    SELECT date_of_death, deceased_id_last4, deceased_name, opened_on
      FROM estate.case WHERE id = ${caseId}
  `);
  const record = matter.rows![0];
  const parties = await listParties(db, principal, caseId);
  const assets = await listAssets(db, principal, caseId);
  const liabilities = await listLiabilities(db, principal, caseId);

  // Two people on the file with the same identification.
  const byId = new Map<string, string[]>();
  for (const party of parties) {
    if (!party.idLast4) continue;
    const list = byId.get(party.idLast4) ?? [];
    list.push(`${party.fullName} (${party.role})`);
    byId.set(party.idLast4, list);
  }
  for (const [last4, names] of byId) {
    if (names.length > 1) {
      found.push({
        what: `Two or more people share the identification ending ${last4}: ${names.join(", ")}.`,
        check:
          "Confirm whether this is one person in two roles, which is often legitimate, or a number entered against the wrong person.",
      });
    }
  }

  // Somebody on the file carrying the deceased's identification.
  if (record.deceased_id_last4) {
    const sameAsDeceased = parties.filter((party) => party.idLast4 === record.deceased_id_last4);
    if (sameAsDeceased.length > 0) {
      found.push({
        what: `${sameAsDeceased
          .map((party) => party.fullName)
          .join(", ")} carries the same identification as ${record.deceased_name}.`,
        check: "Confirm which record the number belongs to.",
      });
    }
  }

  // The age-of-majority check, gated on CAC having supplied the figure and its source.
  const majority = await getSetting<number | null>(db, "cases.age_of_majority", null);
  const majoritySource = await getSetting<string | null>(db, "cases.age_of_majority_source", null);
  if (typeof majority === "number" && majority > 0 && majoritySource) {
    for (const party of parties) {
      if (!party.dateOfBirth) continue;
      const age = wholeYearsBetween(party.dateOfBirth, toIsoDate(today()));
      if (party.isMinor && age >= majority) {
        found.push({
          what: `${party.fullName} is recorded as a minor, but the date of birth given makes them ${age}.`,
          check: `Confirm the date of birth or the flag. Majority is taken as ${majority} per ${majoritySource}.`,
        });
      }
      if (!party.isMinor && age < majority) {
        found.push({
          what: `${party.fullName} is not flagged as a minor, but the date of birth given makes them ${age}.`,
          check: `Confirm the date of birth or the flag. Majority is taken as ${majority} per ${majoritySource}.`,
        });
      }
    }
  }

  // A date of birth after the death.
  if (record.date_of_death) {
    for (const party of parties) {
      if (party.dateOfBirth && party.dateOfBirth > record.date_of_death) {
        found.push({
          what: `${party.fullName} has a date of birth after the date of death.`,
          check:
            "Confirm both dates. A beneficiary born after the death is possible and is worth being deliberate about.",
        });
      }
    }
  }

  // Duplicate asset references.
  const assetKeys = new Map<string, string[]>();
  for (const asset of assets) {
    if (!asset.referenceLast4) continue;
    const key = `${asset.category}:${asset.referenceLast4}`;
    const list = assetKeys.get(key) ?? [];
    list.push(asset.description);
    assetKeys.set(key, list);
  }
  for (const [key, descriptions] of assetKeys) {
    if (descriptions.length > 1) {
      found.push({
        what: `Two assets share a category and a reference ending ${key.split(":")[1]}: ${descriptions.join(
          ", ",
        )}.`,
        check: "Confirm whether the same asset has been entered twice.",
      });
    }
  }

  // A figure dated before the death.
  if (record.date_of_death) {
    for (const asset of assets) {
      if (asset.valuationDate && asset.valuationDate < record.date_of_death) {
        found.push({
          what: `${asset.description} is valued as at ${asset.valuationDate}, before the date of death.`,
          check:
            "Confirm the valuation date is the one intended for this inventory, and that the basis says so.",
        });
      }
    }
    for (const liability of liabilities) {
      if (liability.amountAsAt && liability.amountAsAt < record.date_of_death) {
        found.push({
          what: `The ${liability.creditor} balance is stated as at ${liability.amountAsAt}, before the date of death.`,
          check: "Confirm the date is the one intended.",
        });
      }
    }
  }

  // A verified fact whose source document is no longer on the register.
  const orphaned = await db.execute<{ fact_key: string }>(sql`
    SELECT f.fact_key
      FROM estate.case_fact f
     WHERE f.case_id = ${caseId} AND f.status = 'verified'
       AND f.source_document_id IS NULL AND f.source_note IS NULL
  `);
  for (const row of orphaned.rows ?? []) {
    found.push({
      what: `"${row.fact_key}" is marked verified with nothing recorded about where it was verified from.`,
      check: "Add the source, or return it to stated.",
    });
  }

  // A satisfied requirement whose evidence has gone.
  const dangling = await db.execute<{ title: string }>(sql`
    SELECT r.title
      FROM estate.case_requirement r
     WHERE r.case_id = ${caseId} AND r.status = 'satisfied'
       AND r.kind = 'document' AND r.document_id IS NULL
  `);
  for (const row of dangling.rows ?? []) {
    found.push({
      what: `"${row.title}" is marked satisfied but names no document.`,
      check: "Attach the document, or reopen the item.",
    });
  }

  return found;
}

function wholeYearsBetween(from: string, to: string): number {
  const start = parseIsoDate(from);
  const end = parseIsoDate(to);
  let years = end.getUTCFullYear() - start.getUTCFullYear();
  const beforeBirthday =
    end.getUTCMonth() < start.getUTCMonth() ||
    (end.getUTCMonth() === start.getUTCMonth() && end.getUTCDate() < start.getUTCDate());
  if (beforeBirthday) years -= 1;
  return years;
}

// ---------------------------------------------------------------------------
// Similar matters
// ---------------------------------------------------------------------------

export interface SimilarMatter {
  caseId: string;
  caseNo: string;
  title: string;
  matterType: string;
  status: string;
  /** Shared fact answers over the union of both matters' answers, 0..1. */
  similarity: number;
  /** The answers they have in common, which is what makes the comparison inspectable. */
  sharedAnswers: Array<{ label: string; value: string }>;
  /** How the earlier matter concluded, where it has. */
  outcome: string | null;
}

/**
 * Past matters that answered the same questions the same way.
 *
 * Jaccard overlap of `fact_key=value` pairs: the size of the intersection over the size of
 * the union. Deliberately simple and deliberately inspectable — the shared answers are
 * returned with the score, so the reason a matter is offered is visible rather than being
 * a number somebody has to trust.
 *
 * Called *similar matters* rather than precedent. Precedent is case law; a consultancy's
 * own past files are experience, which is worth a great deal and is not the same thing.
 * Scoped by `case.view` / `case.view_all` like every other read.
 */
export async function similarMatters(
  db: Executor,
  principal: Principal,
  caseId: string,
  limit = 5,
): Promise<SimilarMatter[]> {
  const record = await requireCaseAccess(db, principal, caseId);

  const mine = await db.execute<{ fact_key: string; value: string }>(sql`
    SELECT fact_key, value FROM estate.case_fact
     WHERE case_id = ${caseId} AND value IS NOT NULL
  `);
  const own = new Set((mine.rows ?? []).map((row) => `${row.fact_key}=${row.value}`));
  if (own.size === 0) return [];

  // Every other matter the caller may see, with its answers. Small volumes: a consultancy
  // has hundreds of matters, not millions, and doing this in SQL with a hand-rolled
  // similarity would be less readable for no gain.
  const others = await db.execute<{
    id: string;
    case_no: string;
    title: string;
    matter_type: string;
    status: string;
    close_reason: string | null;
    fact_key: string | null;
    value: string | null;
  }>(sql`
    SELECT c.id, c.case_no, c.title, c.matter_type, c.status, c.close_reason,
           f.fact_key, f.value
      FROM estate.case c
      LEFT JOIN estate.case_fact f ON f.case_id = c.id AND f.value IS NOT NULL
     WHERE c.id <> ${caseId}
       -- caseAccessClause, not a copy of it. This had the same predicate written out inline, and a
       -- security rule with two implementations is a security rule with one that will be missed:
       -- the receipt allocation had the same shape, and its copy had already drifted.
       AND ${caseAccessClause(principal, "c")}
  `);

  const grouped = new Map<
    string,
    { caseNo: string; title: string; matterType: string; status: string; outcome: string | null; answers: Set<string> }
  >();
  for (const row of others.rows ?? []) {
    const entry =
      grouped.get(row.id) ??
      {
        caseNo: row.case_no,
        title: row.title,
        matterType: row.matter_type,
        status: row.status,
        outcome: row.close_reason,
        answers: new Set<string>(),
      };
    if (row.fact_key && row.value !== null) entry.answers.add(`${row.fact_key}=${row.value}`);
    grouped.set(row.id, entry);
  }

  const labels = new Map(
    (
      await db.execute<{ key: string; label: string }>(
        sql`SELECT key, label FROM estate.fact_definition`,
      )
    ).rows?.map((row) => [row.key, row.label]) ?? [],
  );

  const scored: SimilarMatter[] = [];
  for (const [id, entry] of grouped) {
    if (entry.answers.size === 0) continue;
    const shared = [...own].filter((answer) => entry.answers.has(answer));
    if (shared.length === 0) continue;

    const union = new Set([...own, ...entry.answers]).size;
    scored.push({
      caseId: id,
      caseNo: entry.caseNo,
      title: entry.title,
      matterType: entry.matterType,
      status: entry.status,
      similarity: shared.length / union,
      sharedAnswers: shared.map((answer) => {
        const [key, ...rest] = answer.split("=");
        return { label: labels.get(key) ?? key, value: rest.join("=") };
      }),
      outcome: entry.outcome,
    });
  }

  void record;
  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Passages worth reading
// ---------------------------------------------------------------------------

export interface RelevantPassage {
  chunkId: string;
  documentId: string;
  documentNo: string;
  documentTitle: string;
  excerpt: string;
  method: string;
  confidence: number | null;
  caseNo: string | null;
}

/**
 * Library passages the matter's own words turn up.
 *
 * The query is built from what has been recorded — the deceased's name, the matter type in
 * words, the kinds of asset present — and run through the ordinary permission-filtered
 * search. No model is involved and none is needed; this is the retrieval an assistant
 * would be given as context, and it is useful on its own.
 */
export async function relevantPassages(
  db: Executor,
  principal: Principal,
  caseId: string,
  extraTerms = "",
  limit = 8,
): Promise<{ passages: RelevantPassage[]; query: string; note: string }> {
  await requireCaseAccess(db, principal, caseId);

  const matter = await db.execute<{ deceased_name: string; matter_type: string }>(
    sql`SELECT deceased_name, matter_type FROM estate.case WHERE id = ${caseId}`,
  );
  const record = matter.rows![0];

  const assets = await listAssets(db, principal, caseId);
  const categories = [...new Set(assets.map((asset) => asset.category))].slice(0, 4);

  const terms = [
    extraTerms.trim(),
    record.deceased_name,
    record.matter_type.replace(/_/g, " "),
    ...categories,
  ]
    .filter(Boolean)
    .join(" ");

  if (terms.trim().length < 2) {
    return { passages: [], query: terms, note: "There is not enough recorded yet to search on." };
  }

  // Any of the words, not all of them: a query assembled from a name, a matter type and
  // the kinds of asset present would match nothing if every term had to appear in one
  // passage, and an empty result would read as an empty library.
  const result = await searchLibrary(db, principal, terms, {
    limit,
    includeUnscanned: true,
    matchAny: true,
  });

  return {
    passages: result.hits.map((hit) => ({
      chunkId: hit.chunkId,
      documentId: hit.documentId,
      documentNo: hit.documentNo,
      documentTitle: hit.documentTitle,
      excerpt: hit.excerpt,
      method: hit.method,
      confidence: hit.confidence,
      caseNo: hit.caseNo,
    })),
    query: terms,
    note: result.semanticNote,
  };
}

// ---------------------------------------------------------------------------
// The preparation pack
// ---------------------------------------------------------------------------

export interface CasePack {
  caseNo: string;
  title: string;
  matterType: string;
  status: string;
  deceasedName: string;
  dateOfDeath: string | null;
  courtReference: string | null;
  preparedOn: string;
  preparedBy: string;
  parties: Array<{ role: string; name: string; relationship: string | null; status: string; share: string | null; shareSource: string | null }>;
  assets: Array<{ category: string; description: string; figure: string | null; basis: string | null; source: string | null; status: string }>;
  liabilities: Array<{ category: string; creditor: string; figure: string | null; basis: string | null; source: string | null; status: string }>;
  position: EstatePosition;
  positionNote: string;
  requirements: Array<{
    title: string;
    status: string;
    authority: string | null;
    rule: string | null;
    note: string | null;
    undecided: string[];
  }>;
  openQuestions: Array<{ label: string; blocks: number }>;
  gaps: Gap[];
  contradictions: Contradiction[];
  /** What this pack is not. Printed on it, not buried in a covering email. */
  caveats: string[];
}

/**
 * Assembles everything the matter knows into one reviewable document.
 *
 * Every figure carries its basis and its source, every requirement carries the rule and the
 * authority that produced it, and the gaps and contradictions are part of the pack rather
 * than an appendix. A preparation pack that showed only the complete parts would be a pack
 * that implied the matter was ready.
 *
 * The caveats are printed on the document. This is CAC's own working record assembled by
 * software; it is not advice, it is not a filing, and nothing in it has been approved by
 * anybody merely because it appears here.
 */
export async function buildCasePack(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<CasePack> {
  const record = await requireCaseAccess(db, principal, caseId);

  const [matterRow, parties, assets, liabilities, requirements, position, questions, gaps, contradictions] =
    await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        SELECT title, matter_type, status, deceased_name, date_of_death, court_reference
          FROM estate.case WHERE id = ${caseId}
      `),
      listParties(db, principal, caseId),
      listAssets(db, principal, caseId),
      listLiabilities(db, principal, caseId),
      listRequirements(db, principal, caseId),
      estatePosition(db, principal, caseId),
      nextQuestions(db, principal, caseId),
      findGaps(db, principal, caseId),
      findContradictions(db, principal, caseId),
    ]);

  const matter = matterRow.rows![0];
  const factLabels = new Map(
    (await listCaseFacts(db, principal, caseId)).map((fact) => [fact.factKey, fact.label]),
  );

  return {
    caseNo: record.caseNo,
    title: String(matter.title),
    matterType: String(matter.matter_type).replace(/_/g, " "),
    status: String(matter.status),
    deceasedName: String(matter.deceased_name),
    dateOfDeath: matter.date_of_death ? String(matter.date_of_death).slice(0, 10) : null,
    courtReference: (matter.court_reference as string) ?? null,
    preparedOn: toIsoDate(today()),
    preparedBy: principal.fullName,
    parties: parties.map((party) => ({
      role: party.role.replace(/_/g, " "),
      name: party.fullName,
      relationship: party.relationship,
      status: party.status,
      share: party.shareNote,
      shareSource: party.shareSource,
    })),
    assets: assets.map((asset) => ({
      category: asset.category.replace(/_/g, " "),
      description: asset.description,
      figure: asset.valuationAmount === null ? null : formatAmount(asset.valuationAmount),
      basis: asset.valuationBasis,
      source: asset.valuationSource,
      status: asset.status,
    })),
    liabilities: liabilities.map((liability) => ({
      category: liability.category.replace(/_/g, " "),
      creditor: liability.creditor,
      figure: liability.amount === null ? null : formatAmount(liability.amount),
      basis: liability.amountBasis,
      source: liability.amountSource,
      status: liability.status,
    })),
    position,
    positionNote: position.incomplete
      ? "Figures recorded so far. Assets or liabilities without a figure are listed above and are not included in these totals, so this is not the estate's total."
      : "Every asset and liability recorded carries a figure.",
    requirements: requirements.map((item) => ({
      title: item.title,
      status: item.status.replace(/_/g, " "),
      authority: item.sourceRef,
      rule: item.ruleCode ? `${item.ruleCode} v${item.ruleVersion}` : null,
      note: item.waiveReason ?? item.droppedReason ?? item.documentTitle ?? null,
      undecided: item.undecidedFacts.map((key) => factLabels.get(key) ?? key),
    })),
    openQuestions: questions.map((question) => ({
      label: question.label,
      blocks: question.blocks.length,
    })),
    gaps,
    contradictions,
    caveats: [
      "This pack is CAC's own working record for this matter, assembled from what has been entered into the platform. It is not advice and it is not a filing.",
      "Every requirement listed comes from a rule entered with the authority it rests on and approved by a named reviewer. Where the checklist is empty or short, it is because no rule covers the point — not because nothing is required.",
      "Nothing in this pack has been approved by reason of appearing in it. Figures marked as reported have not been verified; requirements marked satisfied name what satisfied them.",
      "Items listed under what is missing and what to check are produced by comparing recorded fields with each other. They are questions for whoever is running the matter, not conclusions.",
    ],
  };
}

/** A rule's condition in words, for a screen that explains why an item is on a list. */
export function explainRule(
  condition: Condition,
  labels: Map<string, string>,
): { words: string; facts: string[] } {
  return {
    words: describeCondition(condition, labels),
    facts: [...factsUsedBy(condition)].map((key) => labels.get(key) ?? key),
  };
}
