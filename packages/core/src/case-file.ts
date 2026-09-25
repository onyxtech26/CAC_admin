import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, toIsoDate, today } from "./dates.js";
import { amountToSql, parseAmount, type Amount } from "./money.js";
import { decryptSecret } from "./secrets.js";
import {
  encryptOptional,
  keep,
  optionalText,
  recordCaseEvent,
  requireCaseAccess,
  requireWritableCase,
  text,
} from "./cases.js";
import { listFactDefinitions, type FactKind } from "./case-rules.js";

/**
 * The case file: who is involved, what the estate holds and owes, what CAC has been
 * told, and which documents it holds.
 *
 * The rule that shapes every table in here: **a figure cannot exist without its basis
 * and its source.** Not by convention — by CHECK constraint, in both directions. An
 * estate inventory is relied on by a family and sometimes produced in a dispute, and a
 * number on one that nobody can trace back to how it was arrived at is worse than a
 * blank, because a blank is visibly a gap.
 *
 * The second rule: **verification is somebody's act.** Reported and verified are
 * different states, `case.fact.verify` is what moves between them, and the database
 * stamps who and when. "The bank confirmed the balance" and "the son said he thought
 * it was about that" are not the same claim, and a file that cannot tell them apart is
 * not much use.
 */

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export type PartyRole =
  | "client"
  | "executor"
  | "administrator"
  | "beneficiary"
  | "next_of_kin"
  | "creditor"
  | "witness"
  | "adviser"
  | "other";

export const PARTY_ROLES: { value: PartyRole; label: string }[] = [
  { value: "client", label: "Client (instructing)" },
  { value: "executor", label: "Executor" },
  { value: "administrator", label: "Administrator" },
  { value: "beneficiary", label: "Beneficiary" },
  { value: "next_of_kin", label: "Next of kin" },
  { value: "creditor", label: "Creditor" },
  { value: "witness", label: "Witness" },
  { value: "adviser", label: "Adviser" },
  { value: "other", label: "Other" },
];

export interface CasePartyView {
  id: string;
  role: PartyRole;
  partyKind: "person" | "organisation";
  fullName: string;
  relationship: string | null;
  idLast4: string | null;
  hasIdentification: boolean;
  dateOfBirth: string | null;
  isMinor: boolean;
  phone: string | null;
  email: string | null;
  address: string | null;
  shareNote: string | null;
  shareSource: string | null;
  consentStatus: string | null;
  notes: string | null;
  status: "reported" | "verified" | "excluded";
  verifiedAt: string | null;
  verifiedByName: string | null;
  exclusionReason: string | null;
}

export interface CasePartyInput {
  caseId: string;
  role: PartyRole;
  partyKind?: "person" | "organisation";
  fullName: string;
  relationship?: string | null;
  identification?: string | null;
  dateOfBirth?: string | null;
  isMinor?: boolean;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  /** What CAC was told the person's entitlement is — with where that came from. */
  shareNote?: string | null;
  shareSource?: string | null;
  consentStatus?: string | null;
  notes?: string | null;
}

export async function recordParty(
  db: Executor,
  principal: Principal,
  input: CasePartyInput,
  context?: AuditContext,
): Promise<string> {
  requireCapability(principal, "case.edit");
  const record = await requireWritableCase(db, principal, input.caseId);

  const fullName = input.fullName.trim();
  if (!fullName) throw new ValidationError("The party needs a name.", "fullName");
  if (!PARTY_ROLES.some((entry) => entry.value === input.role)) {
    throw new ValidationError("Choose the party's role in the matter.", "role");
  }

  const partyKind = input.partyKind ?? "person";

  // A stated entitlement without an authority is the one thing this table must not
  // hold: it would read as CAC's determination of a distribution, which it is not.
  if (input.shareNote?.trim() && !input.shareSource?.trim()) {
    throw new ValidationError(
      "Say where the stated entitlement comes from — the will, an instruction, an adviser's letter. This platform records what it was told; it does not determine shares.",
      "shareSource",
    );
  }

  if (input.dateOfBirth) {
    parseIsoDate(input.dateOfBirth);
    if (input.dateOfBirth > toIsoDate(today())) {
      throw new ValidationError("That date of birth is in the future.", "dateOfBirth");
    }
    if (partyKind === "organisation") {
      throw new ValidationError("An organisation has no date of birth.", "dateOfBirth");
    }
  }
  if (input.isMinor && partyKind === "organisation") {
    throw new ValidationError("An organisation cannot be a minor.", "isMinor");
  }

  const identity = encryptOptional(input.identification);

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO estate.case_party
      (case_id, role, party_kind, full_name, relationship, id_enc, id_last4, date_of_birth,
       is_minor, phone, email, address, share_note, share_source, consent_status, notes, created_by)
    VALUES
      (${input.caseId}, ${input.role}, ${partyKind}, ${fullName},
       ${input.relationship?.trim() || null}, ${identity.cipher}, ${identity.last4},
       ${input.dateOfBirth ?? null}, ${input.isMinor ?? false}, ${input.phone?.trim() || null},
       ${input.email?.trim() || null}, ${input.address?.trim() || null},
       ${input.shareNote?.trim() || null}, ${input.shareSource?.trim() || null},
       ${input.consentStatus?.trim() || null}, ${input.notes?.trim() || null},
       ${principal.userId})
    RETURNING id
  `);
  const id = inserted.rows![0].id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_PARTY_RECORDED,
    entityType: "estate.case_party",
    entityId: id,
    // The role, not the person. Beneficiary information is not logged.
    newValues: { caseNo: record.caseNo, role: input.role, partyKind },
  });

  await recordCaseEvent(db, {
    caseId: input.caseId,
    kind: "party",
    summary: `A ${input.role.replace(/_/g, " ")} was added to the matter.`,
    origin: "system",
    actorUserId: principal.userId,
    actorLabel: principal.fullName,
  });

  return id;
}

export async function updateParty(
  db: Executor,
  principal: Principal,
  partyId: string,
  input: Partial<Omit<CasePartyInput, "caseId">>,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.edit");

  const current = await db.execute<{ case_id: string; share_source: string | null }>(
    sql`SELECT case_id, share_source FROM estate.case_party WHERE id = ${partyId}`,
  );
  const existing = current.rows?.[0];
  if (!existing) throw new NotFoundError("That party is no longer on the file.");
  const record = await requireWritableCase(db, principal, existing.case_id);

  if (input.shareNote?.trim()) {
    const source = input.shareSource ?? existing.share_source;
    if (!source?.trim()) {
      throw new ValidationError(
        "Say where the stated entitlement comes from.",
        "shareSource",
      );
    }
  }
  if (input.dateOfBirth) parseIsoDate(input.dateOfBirth);

  const identity =
    input.identification === undefined ? undefined : encryptOptional(input.identification);

  await db.execute(sql`
    UPDATE estate.case_party
       SET role = ${keep(input.role, "role")},
           party_kind = ${keep(input.partyKind, "party_kind")},
           full_name = ${text(input.fullName, "full_name")},
           relationship = ${optionalText(input.relationship, "relationship")},
           id_enc = ${keep(identity === undefined ? undefined : identity.cipher, "id_enc")},
           id_last4 = ${keep(identity === undefined ? undefined : identity.last4, "id_last4")},
           date_of_birth = ${keep(input.dateOfBirth, "date_of_birth")},
           is_minor = ${keep(input.isMinor, "is_minor")},
           phone = ${optionalText(input.phone, "phone")},
           email = ${optionalText(input.email, "email")},
           address = ${optionalText(input.address, "address")},
           share_note = ${optionalText(input.shareNote, "share_note")},
           share_source = ${optionalText(input.shareSource, "share_source")},
           consent_status = ${optionalText(input.consentStatus, "consent_status")},
           notes = ${optionalText(input.notes, "notes")},
           updated_by = ${principal.userId}
     WHERE id = ${partyId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_PARTY_UPDATED,
    entityType: "estate.case_party",
    entityId: partyId,
    newValues: { caseNo: record.caseNo, fields: Object.keys(input).sort() },
  });
}

export async function listParties(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<CasePartyView[]> {
  await requireCaseAccess(db, principal, caseId);

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT p.*, v.full_name AS verified_by_name
      FROM estate.case_party p
      LEFT JOIN auth."user" v ON v.id = p.verified_by
     WHERE p.case_id = ${caseId}
     ORDER BY CASE p.role
                WHEN 'client' THEN 0 WHEN 'executor' THEN 1 WHEN 'administrator' THEN 2
                WHEN 'beneficiary' THEN 3 WHEN 'next_of_kin' THEN 4 ELSE 5 END,
              p.full_name
  `);

  return (result.rows ?? []).map((row) => ({
    id: String(row.id),
    role: row.role as PartyRole,
    partyKind: row.party_kind as "person" | "organisation",
    fullName: String(row.full_name),
    relationship: (row.relationship as string) ?? null,
    idLast4: (row.id_last4 as string) ?? null,
    hasIdentification: row.id_enc !== null,
    dateOfBirth: row.date_of_birth ? String(row.date_of_birth).slice(0, 10) : null,
    isMinor: row.is_minor === true,
    phone: (row.phone as string) ?? null,
    email: (row.email as string) ?? null,
    address: (row.address as string) ?? null,
    shareNote: (row.share_note as string) ?? null,
    shareSource: (row.share_source as string) ?? null,
    consentStatus: (row.consent_status as string) ?? null,
    notes: (row.notes as string) ?? null,
    status: row.status as CasePartyView["status"],
    verifiedAt: row.verified_at ? new Date(String(row.verified_at)).toISOString() : null,
    verifiedByName: (row.verified_by_name as string) ?? null,
    exclusionReason: (row.exclusion_reason as string) ?? null,
  }));
}

/** A party's identification in full. Capability-gated, audited, with a reason. */
export async function getPartyIdentification(
  db: Executor,
  principal: Principal,
  partyId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<string | null> {
  requireCapability(principal, "case.document.view");

  const result = await db.execute<{ case_id: string; id_enc: string | null; role: string }>(
    sql`SELECT case_id, id_enc, role FROM estate.case_party WHERE id = ${partyId}`,
  );
  const row = result.rows?.[0];
  if (!row) throw new NotFoundError("That party is no longer on the file.");
  const record = await requireCaseAccess(db, principal, row.case_id);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.EXPORT_SENSITIVE,
    entityType: "estate.case_party",
    entityId: partyId,
    newValues: { caseNo: record.caseNo, role: row.role, fields: ["identification"] },
    reason: options.reason ?? null,
  });

  return row.id_enc ? decryptSecret(row.id_enc) : null;
}

// ---------------------------------------------------------------------------
// Assets and liabilities
// ---------------------------------------------------------------------------

export type AssetCategory =
  | "land"
  | "building"
  | "bank"
  | "shares"
  | "unit_trust"
  | "epf"
  | "insurance"
  | "vehicle"
  | "business"
  | "receivable"
  | "chattel"
  | "other";

export const ASSET_CATEGORIES: { value: AssetCategory; label: string }[] = [
  { value: "land", label: "Land" },
  { value: "building", label: "Building" },
  { value: "bank", label: "Bank account" },
  { value: "shares", label: "Shares" },
  { value: "unit_trust", label: "Unit trust" },
  { value: "epf", label: "EPF" },
  { value: "insurance", label: "Insurance" },
  { value: "vehicle", label: "Vehicle" },
  { value: "business", label: "Business interest" },
  { value: "receivable", label: "Money owed to the estate" },
  { value: "chattel", label: "Personal effects" },
  { value: "other", label: "Other" },
];

export type LiabilityCategory =
  | "mortgage"
  | "loan"
  | "credit_card"
  | "overdraft"
  | "tax"
  | "utility"
  | "medical"
  | "funeral"
  | "trade"
  | "guarantee"
  | "other";

export const LIABILITY_CATEGORIES: { value: LiabilityCategory; label: string }[] = [
  { value: "mortgage", label: "Mortgage" },
  { value: "loan", label: "Loan" },
  { value: "credit_card", label: "Credit card" },
  { value: "overdraft", label: "Overdraft" },
  { value: "tax", label: "Tax" },
  { value: "utility", label: "Utilities" },
  { value: "medical", label: "Medical" },
  { value: "funeral", label: "Funeral" },
  { value: "trade", label: "Trade creditor" },
  { value: "guarantee", label: "Guarantee" },
  { value: "other", label: "Other" },
];

export interface CaseAssetView {
  id: string;
  category: AssetCategory;
  description: string;
  referenceLast4: string | null;
  hasReference: boolean;
  location: string | null;
  holder: string | null;
  ownership: "sole" | "joint" | "shared" | "trust" | "disputed";
  ownershipNote: string | null;
  valuationAmount: Amount | null;
  valuationBasis: string | null;
  valuationDate: string | null;
  valuationSource: string | null;
  status: "reported" | "verified" | "excluded";
  verifiedAt: string | null;
  verifiedByName: string | null;
  exclusionReason: string | null;
  notes: string | null;
}

export interface CaseAssetInput {
  caseId: string;
  category: AssetCategory;
  description: string;
  reference?: string | null;
  location?: string | null;
  holder?: string | null;
  ownership?: CaseAssetView["ownership"];
  ownershipNote?: string | null;
  /** All four together, or none of them. */
  valuationAmount?: string | number | null;
  valuationBasis?: string | null;
  valuationDate?: string | null;
  valuationSource?: string | null;
  notes?: string | null;
}

/** The four valuation fields stand or fall together, and this is the message for it. */
function checkValuation(params: {
  amount: string | number | null | undefined;
  basis: string | null | undefined;
  date: string | null | undefined;
  source: string | null | undefined;
  amountField: string;
}): { amount: Amount | null; basis: string | null; date: string | null; source: string | null } {
  const given =
    params.amount !== null && params.amount !== undefined && String(params.amount).trim() !== "";
  const basis = params.basis?.trim() || null;
  const date = params.date?.trim() || null;
  const source = params.source?.trim() || null;

  if (!given) {
    if (basis || date || source) {
      throw new ValidationError(
        "There is a basis, a date or a source here but no figure. Enter the figure, or clear the rest.",
        params.amountField,
      );
    }
    return { amount: null, basis: null, date: null, source: null };
  }

  const amount = parseAmount(String(params.amount), params.amountField);
  if (amount < 0n) {
    throw new ValidationError("The figure cannot be negative.", params.amountField);
  }
  if (!basis) {
    throw new ValidationError(
      "Say how the figure was arrived at — a valuation report, a bank statement, an agent's appraisal.",
      "valuationBasis",
    );
  }
  if (!date) {
    throw new ValidationError("A figure needs the date it applies to.", "valuationDate");
  }
  parseIsoDate(date);
  if (date > toIsoDate(today())) {
    throw new ValidationError("That date is in the future.", "valuationDate");
  }
  if (!source) {
    throw new ValidationError(
      "Name the document the figure comes from. An untraceable figure on an estate inventory is worse than a blank one.",
      "valuationSource",
    );
  }

  return { amount, basis, date, source };
}

export async function recordAsset(
  db: Executor,
  principal: Principal,
  input: CaseAssetInput,
  context?: AuditContext,
): Promise<string> {
  requireCapability(principal, "case.edit");
  const record = await requireWritableCase(db, principal, input.caseId);

  const description = input.description.trim();
  if (!description) throw new ValidationError("Describe the asset.", "description");
  if (!ASSET_CATEGORIES.some((entry) => entry.value === input.category)) {
    throw new ValidationError("Choose what kind of asset this is.", "category");
  }

  const valuation = checkValuation({
    amount: input.valuationAmount,
    basis: input.valuationBasis,
    date: input.valuationDate,
    source: input.valuationSource,
    amountField: "valuationAmount",
  });

  const ownership = input.ownership ?? "sole";
  const reference = encryptOptional(input.reference);

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO estate.case_asset
      (case_id, category, description, reference_enc, reference_last4, location, holder,
       ownership, ownership_note, valuation_amount, valuation_basis, valuation_date,
       valuation_source, notes, created_by)
    VALUES
      (${input.caseId}, ${input.category}, ${description}, ${reference.cipher},
       ${reference.last4}, ${input.location?.trim() || null}, ${input.holder?.trim() || null},
       ${ownership}, ${input.ownershipNote?.trim() || null},
       ${valuation.amount === null ? null : amountToSql(valuation.amount)},
       ${valuation.basis}, ${valuation.date}, ${valuation.source},
       ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = inserted.rows![0].id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_ASSET_RECORDED,
    entityType: "estate.case_asset",
    entityId: id,
    // Category and whether it carries a figure. Not the description, not the amount.
    newValues: { caseNo: record.caseNo, category: input.category, valued: valuation.amount !== null },
  });

  return id;
}

export async function updateAsset(
  db: Executor,
  principal: Principal,
  assetId: string,
  input: Partial<Omit<CaseAssetInput, "caseId">>,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.edit");

  const current = await db.execute<Record<string, unknown>>(
    sql`SELECT * FROM estate.case_asset WHERE id = ${assetId}`,
  );
  const existing = current.rows?.[0];
  if (!existing) throw new NotFoundError("That asset is no longer on the file.");
  const record = await requireWritableCase(db, principal, String(existing.case_id));

  const description = input.description === undefined ? undefined : input.description.trim();
  if (description !== undefined && !description) {
    throw new ValidationError("Describe the asset.", "description");
  }

  // Any touch of the valuation revalidates the whole set, merged with what is stored —
  // otherwise clearing one field alone could leave a figure with no source behind it.
  const touchesValuation =
    input.valuationAmount !== undefined ||
    input.valuationBasis !== undefined ||
    input.valuationDate !== undefined ||
    input.valuationSource !== undefined;

  const valuation = touchesValuation
    ? checkValuation({
        amount:
          input.valuationAmount !== undefined
            ? input.valuationAmount
            : (existing.valuation_amount as string | null),
        basis:
          input.valuationBasis !== undefined
            ? input.valuationBasis
            : (existing.valuation_basis as string | null),
        date:
          input.valuationDate !== undefined
            ? input.valuationDate
            : existing.valuation_date
              ? String(existing.valuation_date).slice(0, 10)
              : null,
        source:
          input.valuationSource !== undefined
            ? input.valuationSource
            : (existing.valuation_source as string | null),
        amountField: "valuationAmount",
      })
    : null;

  const reference = input.reference === undefined ? undefined : encryptOptional(input.reference);

  await db.execute(sql`
    UPDATE estate.case_asset
       SET category = ${keep(input.category, "category")},
           description = ${text(description, "description")},
           reference_enc = ${keep(reference === undefined ? undefined : reference.cipher, "reference_enc")},
           reference_last4 = ${keep(reference === undefined ? undefined : reference.last4, "reference_last4")},
           location = ${optionalText(input.location, "location")},
           holder = ${optionalText(input.holder, "holder")},
           ownership = ${keep(input.ownership, "ownership")},
           ownership_note = ${optionalText(input.ownershipNote, "ownership_note")},
           valuation_amount = ${
             valuation === null
               ? sql.raw("valuation_amount")
               : sql`${valuation.amount === null ? null : amountToSql(valuation.amount)}`
           },
           valuation_basis = ${valuation === null ? sql.raw("valuation_basis") : sql`${valuation.basis}`},
           valuation_date = ${valuation === null ? sql.raw("valuation_date") : sql`${valuation.date}`},
           valuation_source = ${valuation === null ? sql.raw("valuation_source") : sql`${valuation.source}`},
           notes = ${optionalText(input.notes, "notes")},
           updated_by = ${principal.userId}
     WHERE id = ${assetId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_ASSET_UPDATED,
    entityType: "estate.case_asset",
    entityId: assetId,
    newValues: { caseNo: record.caseNo, fields: Object.keys(input).sort() },
  });
}

export async function listAssets(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<CaseAssetView[]> {
  await requireCaseAccess(db, principal, caseId);

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT a.*, v.full_name AS verified_by_name
      FROM estate.case_asset a
      LEFT JOIN auth."user" v ON v.id = a.verified_by
     WHERE a.case_id = ${caseId}
     ORDER BY a.category, a.description
  `);

  return (result.rows ?? []).map((row) => ({
    id: String(row.id),
    category: row.category as AssetCategory,
    description: String(row.description),
    referenceLast4: (row.reference_last4 as string) ?? null,
    hasReference: row.reference_enc !== null,
    location: (row.location as string) ?? null,
    holder: (row.holder as string) ?? null,
    ownership: row.ownership as CaseAssetView["ownership"],
    ownershipNote: (row.ownership_note as string) ?? null,
    valuationAmount: row.valuation_amount === null ? null : parseAmount(String(row.valuation_amount)),
    valuationBasis: (row.valuation_basis as string) ?? null,
    valuationDate: row.valuation_date ? String(row.valuation_date).slice(0, 10) : null,
    valuationSource: (row.valuation_source as string) ?? null,
    status: row.status as CaseAssetView["status"],
    verifiedAt: row.verified_at ? new Date(String(row.verified_at)).toISOString() : null,
    verifiedByName: (row.verified_by_name as string) ?? null,
    exclusionReason: (row.exclusion_reason as string) ?? null,
    notes: (row.notes as string) ?? null,
  }));
}

export interface CaseLiabilityView {
  id: string;
  category: LiabilityCategory;
  creditor: string;
  description: string;
  referenceLast4: string | null;
  hasReference: boolean;
  amount: Amount | null;
  amountBasis: string | null;
  amountAsAt: string | null;
  amountSource: string | null;
  isSecured: boolean;
  securityNote: string | null;
  status: "reported" | "verified" | "excluded";
  verifiedAt: string | null;
  verifiedByName: string | null;
  exclusionReason: string | null;
  notes: string | null;
}

export interface CaseLiabilityInput {
  caseId: string;
  category: LiabilityCategory;
  creditor: string;
  description: string;
  reference?: string | null;
  amount?: string | number | null;
  amountBasis?: string | null;
  amountAsAt?: string | null;
  amountSource?: string | null;
  isSecured?: boolean;
  securityNote?: string | null;
  notes?: string | null;
}

export async function recordLiability(
  db: Executor,
  principal: Principal,
  input: CaseLiabilityInput,
  context?: AuditContext,
): Promise<string> {
  requireCapability(principal, "case.edit");
  const record = await requireWritableCase(db, principal, input.caseId);

  const creditor = input.creditor.trim();
  if (!creditor) throw new ValidationError("Name who is owed.", "creditor");
  const description = input.description.trim();
  if (!description) throw new ValidationError("Describe the debt.", "description");
  if (!LIABILITY_CATEGORIES.some((entry) => entry.value === input.category)) {
    throw new ValidationError("Choose what kind of debt this is.", "category");
  }
  if (input.isSecured && !input.securityNote?.trim()) {
    throw new ValidationError(
      "Say what secures the debt. Whether a debt is secured changes how it is dealt with, so a bare flag is not enough.",
      "securityNote",
    );
  }

  const figure = checkValuation({
    amount: input.amount,
    basis: input.amountBasis,
    date: input.amountAsAt,
    source: input.amountSource,
    amountField: "amount",
  });

  const reference = encryptOptional(input.reference);

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO estate.case_liability
      (case_id, category, creditor, description, reference_enc, reference_last4, amount,
       amount_basis, amount_as_at, amount_source, is_secured, security_note, notes, created_by)
    VALUES
      (${input.caseId}, ${input.category}, ${creditor}, ${description}, ${reference.cipher},
       ${reference.last4}, ${figure.amount === null ? null : amountToSql(figure.amount)},
       ${figure.basis}, ${figure.date}, ${figure.source}, ${input.isSecured ?? false},
       ${input.securityNote?.trim() || null}, ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = inserted.rows![0].id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_LIABILITY_RECORDED,
    entityType: "estate.case_liability",
    entityId: id,
    newValues: {
      caseNo: record.caseNo,
      category: input.category,
      valued: figure.amount !== null,
      secured: input.isSecured ?? false,
    },
  });

  return id;
}

export async function updateLiability(
  db: Executor,
  principal: Principal,
  liabilityId: string,
  input: Partial<Omit<CaseLiabilityInput, "caseId">>,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.edit");

  const current = await db.execute<Record<string, unknown>>(
    sql`SELECT * FROM estate.case_liability WHERE id = ${liabilityId}`,
  );
  const existing = current.rows?.[0];
  if (!existing) throw new NotFoundError("That liability is no longer on the file.");
  const record = await requireWritableCase(db, principal, String(existing.case_id));

  const touchesFigure =
    input.amount !== undefined ||
    input.amountBasis !== undefined ||
    input.amountAsAt !== undefined ||
    input.amountSource !== undefined;

  const figure = touchesFigure
    ? checkValuation({
        amount: input.amount !== undefined ? input.amount : (existing.amount as string | null),
        basis:
          input.amountBasis !== undefined
            ? input.amountBasis
            : (existing.amount_basis as string | null),
        date:
          input.amountAsAt !== undefined
            ? input.amountAsAt
            : existing.amount_as_at
              ? String(existing.amount_as_at).slice(0, 10)
              : null,
        source:
          input.amountSource !== undefined
            ? input.amountSource
            : (existing.amount_source as string | null),
        amountField: "amount",
      })
    : null;

  const secured = input.isSecured ?? existing.is_secured === true;
  const securityNote =
    input.securityNote !== undefined
      ? input.securityNote?.trim() || null
      : (existing.security_note as string | null);
  if (secured && !securityNote) {
    throw new ValidationError("Say what secures the debt.", "securityNote");
  }

  const reference = input.reference === undefined ? undefined : encryptOptional(input.reference);

  await db.execute(sql`
    UPDATE estate.case_liability
       SET category = ${keep(input.category, "category")},
           creditor = ${text(input.creditor, "creditor")},
           description = ${text(input.description, "description")},
           reference_enc = ${keep(reference === undefined ? undefined : reference.cipher, "reference_enc")},
           reference_last4 = ${keep(reference === undefined ? undefined : reference.last4, "reference_last4")},
           amount = ${
             figure === null
               ? sql.raw("amount")
               : sql`${figure.amount === null ? null : amountToSql(figure.amount)}`
           },
           amount_basis = ${figure === null ? sql.raw("amount_basis") : sql`${figure.basis}`},
           amount_as_at = ${figure === null ? sql.raw("amount_as_at") : sql`${figure.date}`},
           amount_source = ${figure === null ? sql.raw("amount_source") : sql`${figure.source}`},
           is_secured = ${secured},
           security_note = ${securityNote},
           notes = ${optionalText(input.notes, "notes")},
           updated_by = ${principal.userId}
     WHERE id = ${liabilityId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_LIABILITY_UPDATED,
    entityType: "estate.case_liability",
    entityId: liabilityId,
    newValues: { caseNo: record.caseNo, fields: Object.keys(input).sort() },
  });
}

export async function listLiabilities(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<CaseLiabilityView[]> {
  await requireCaseAccess(db, principal, caseId);

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT l.*, v.full_name AS verified_by_name
      FROM estate.case_liability l
      LEFT JOIN auth."user" v ON v.id = l.verified_by
     WHERE l.case_id = ${caseId}
     ORDER BY l.category, l.creditor
  `);

  return (result.rows ?? []).map((row) => ({
    id: String(row.id),
    category: row.category as LiabilityCategory,
    creditor: String(row.creditor),
    description: String(row.description),
    referenceLast4: (row.reference_last4 as string) ?? null,
    hasReference: row.reference_enc !== null,
    amount: row.amount === null ? null : parseAmount(String(row.amount)),
    amountBasis: (row.amount_basis as string) ?? null,
    amountAsAt: row.amount_as_at ? String(row.amount_as_at).slice(0, 10) : null,
    amountSource: (row.amount_source as string) ?? null,
    isSecured: row.is_secured === true,
    securityNote: (row.security_note as string) ?? null,
    status: row.status as CaseLiabilityView["status"],
    verifiedAt: row.verified_at ? new Date(String(row.verified_at)).toISOString() : null,
    verifiedByName: (row.verified_by_name as string) ?? null,
    exclusionReason: (row.exclusion_reason as string) ?? null,
    notes: (row.notes as string) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Verification and exclusion
// ---------------------------------------------------------------------------

const VERIFIABLE = {
  party: { table: "estate.case_party", audit: AUDIT.CASE_PARTY_UPDATED, label: "party" },
  asset: { table: "estate.case_asset", audit: AUDIT.CASE_ASSET_UPDATED, label: "asset" },
  liability: {
    table: "estate.case_liability",
    audit: AUDIT.CASE_LIABILITY_UPDATED,
    label: "liability",
  },
  fact: { table: "estate.case_fact", audit: AUDIT.CASE_FACT_VERIFIED, label: "fact" },
} as const;

export type VerifiableKind = keyof typeof VERIFIABLE;

/**
 * Moves a record between reported and verified, or excludes it.
 *
 * `case.fact.verify` is a separate capability from `case.edit` on purpose. Recording
 * what a family told you and attesting that you have checked it are different acts,
 * and the second one is what a court would be relying on.
 */
export async function setVerification(
  db: Executor,
  principal: Principal,
  params: {
    kind: VerifiableKind;
    recordId: string;
    status: "reported" | "verified" | "excluded";
    reason?: string | null;
  },
  context?: AuditContext,
): Promise<void> {
  const spec = VERIFIABLE[params.kind];
  if (!spec) throw new ValidationError("That is not something that can be verified.");

  if (params.status === "verified") requireCapability(principal, "case.fact.verify");
  else requireCapability(principal, "case.edit");

  const current = await db.execute<{ case_id: string; status: string }>(
    sql`SELECT case_id, status FROM ${sql.raw(spec.table)} WHERE id = ${params.recordId}`,
  );
  const existing = current.rows?.[0];
  if (!existing) throw new NotFoundError(`That ${spec.label} is no longer on the file.`);
  const record = await requireWritableCase(db, principal, existing.case_id);

  // A fact uses `stated` rather than `reported` for the same state.
  const target =
    params.kind === "fact" && params.status === "reported" ? "stated" : params.status;

  if (params.status === "excluded" && !params.reason?.trim()) {
    throw new ValidationError(
      "Say why it is being excluded. An item removed from an estate inventory without a reason is the kind of gap that gets noticed later.",
      "reason",
    );
  }
  if (params.kind === "fact" && params.status === "excluded") {
    throw new ConflictError("A fact is not excluded. Answer it, or record it as unknown.");
  }

  await db.execute(sql`
    UPDATE ${sql.raw(spec.table)}
       SET status = ${target},
           verified_by = ${params.status === "verified" ? principal.userId : null},
           ${
             params.kind === "fact"
               ? sql`updated_by = ${principal.userId}`
               : sql`exclusion_reason = ${params.status === "excluded" ? params.reason!.trim() : null},
                     updated_by = ${principal.userId}`
           }
     WHERE id = ${params.recordId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: params.status === "verified" ? AUDIT.CASE_FACT_VERIFIED : spec.audit,
    entityType: spec.table,
    entityId: params.recordId,
    newValues: { caseNo: record.caseNo, kind: params.kind, status: target },
    reason: params.reason?.trim() || null,
  });

  if (params.status === "verified") {
    await recordCaseEvent(db, {
      caseId: existing.case_id,
      kind: "verification",
      summary: `A ${spec.label} on the file was verified.`,
      origin: "system",
      actorUserId: principal.userId,
      actorLabel: principal.fullName,
    });
  }
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface CaseFactView {
  factKey: string;
  label: string;
  kind: FactKind;
  options: string[];
  prompt: string | null;
  helpText: string | null;
  /** Null when the question has not been reached at all. */
  value: string | null;
  answered: boolean;
  status: "stated" | "verified" | "unknown" | null;
  sourceNote: string | null;
  sourceDocumentId: string | null;
  verifiedAt: string | null;
  verifiedByName: string | null;
}

/**
 * Every question that applies to the matter, with its answer where there is one.
 *
 * Unanswered questions are included, because the point of the intake screen is the
 * ones that are missing. A rule waiting on an unanswered fact puts a flagged item on
 * the checklist, and this is where somebody clears it.
 */
export async function listCaseFacts(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<CaseFactView[]> {
  const record = await requireCaseAccess(db, principal, caseId);

  const definitions = await listFactDefinitions(db, {
    matterType: record.matterType,
    activeOnly: true,
  });

  const answers = await db.execute<Record<string, unknown>>(sql`
    SELECT f.fact_key, f.value, f.status, f.source_note, f.source_document_id,
           f.verified_at, v.full_name AS verified_by_name
      FROM estate.case_fact f
      LEFT JOIN auth."user" v ON v.id = f.verified_by
     WHERE f.case_id = ${caseId}
  `);
  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of answers.rows ?? []) byKey.set(String(row.fact_key), row);

  return definitions.map((definition) => {
    const answer = byKey.get(definition.key);
    return {
      factKey: definition.key,
      label: definition.label,
      kind: definition.kind,
      options: definition.options,
      prompt: definition.prompt,
      helpText: definition.helpText,
      value: answer ? ((answer.value as string) ?? null) : null,
      answered: answer !== undefined,
      status: answer ? (answer.status as CaseFactView["status"]) : null,
      sourceNote: answer ? ((answer.source_note as string) ?? null) : null,
      sourceDocumentId: answer ? ((answer.source_document_id as string) ?? null) : null,
      verifiedAt:
        answer && answer.verified_at ? new Date(String(answer.verified_at)).toISOString() : null,
      verifiedByName: answer ? ((answer.verified_by_name as string) ?? null) : null,
    };
  });
}

export interface AnswerFactInput {
  caseId: string;
  factKey: string;
  /** Null with `unknown: true`; otherwise the answer. */
  value?: string | null;
  unknown?: boolean;
  sourceNote?: string | null;
  sourceDocumentId?: string | null;
}

/**
 * Answers a question, or records that it cannot be answered.
 *
 * "Unknown" is a first-class answer and is why the rule engine is three-valued.
 * Recording it is how a checklist can say "this may be required — we do not know
 * whether there was a will" rather than silently leaving the requirement off.
 */
export async function answerFact(
  db: Executor,
  principal: Principal,
  input: AnswerFactInput,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.edit");
  const record = await requireWritableCase(db, principal, input.caseId);

  const definition = await db.execute<{ kind: string; options: unknown; label: string }>(
    sql`SELECT kind, options, label FROM estate.fact_definition WHERE key = ${input.factKey}`,
  );
  const question = definition.rows?.[0];
  if (!question) throw new NotFoundError("That question is no longer asked.");

  if (input.unknown) {
    await db.execute(sql`
      INSERT INTO estate.case_fact (case_id, fact_key, value, status, source_note, created_by)
      VALUES (${input.caseId}, ${input.factKey}, NULL, 'unknown',
              ${input.sourceNote?.trim() || null}, ${principal.userId})
      ON CONFLICT (case_id, fact_key) DO UPDATE
         SET value = NULL, status = 'unknown', verified_at = NULL, verified_by = NULL,
             source_note = ${input.sourceNote?.trim() || null}, updated_by = ${principal.userId}
    `);
  } else {
    const value = normaliseFactValue(
      input.value,
      question.kind as FactKind,
      question.label,
      readOptions(question.options),
    );

    await db.execute(sql`
      INSERT INTO estate.case_fact
        (case_id, fact_key, value, status, source_note, source_document_id, created_by)
      VALUES (${input.caseId}, ${input.factKey}, ${value}, 'stated',
              ${input.sourceNote?.trim() || null}, ${input.sourceDocumentId ?? null},
              ${principal.userId})
      ON CONFLICT (case_id, fact_key) DO UPDATE
         SET value = ${value}, status = 'stated', verified_at = NULL, verified_by = NULL,
             source_note = ${input.sourceNote?.trim() || null},
             source_document_id = ${input.sourceDocumentId ?? null},
             updated_by = ${principal.userId}
    `);
  }

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_FACT_ANSWERED,
    entityType: "estate.case_fact",
    entityId: `${input.caseId}:${input.factKey}`,
    // The question and whether it now has an answer; not what the answer is.
    newValues: {
      caseNo: record.caseNo,
      factKey: input.factKey,
      answered: input.unknown !== true,
    },
  });
}

function readOptions(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Coerces and checks an answer against its declared type. The trigger agrees. */
export function normaliseFactValue(
  value: string | null | undefined,
  kind: FactKind,
  label: string,
  options: string[],
): string {
  const raw = (value ?? "").trim();
  if (!raw) {
    throw new ValidationError(
      `${label} has no answer. Record it as unknown if it cannot be answered — an empty answer and "we do not know" are not the same thing on a checklist.`,
      "value",
    );
  }

  if (kind === "boolean") {
    const lowered = raw.toLowerCase();
    if (["true", "yes", "y", "1"].includes(lowered)) return "true";
    if (["false", "no", "n", "0"].includes(lowered)) return "false";
    throw new ValidationError(`${label} is a yes/no question.`, "value");
  }
  if (kind === "number") {
    if (!/^-?\d+(\.\d+)?$/.test(raw)) {
      throw new ValidationError(`${label} expects a number.`, "value");
    }
    return raw;
  }
  if (kind === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new ValidationError(`${label} expects a date written as YYYY-MM-DD.`, "value");
    }
    parseIsoDate(raw);
    return raw;
  }
  if (kind === "choice") {
    if (!options.includes(raw)) {
      throw new ValidationError(
        `${label} does not offer "${raw}" as an answer. Choose one of: ${options.join(", ")}.`,
        "value",
      );
    }
    return raw;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// The document register
// ---------------------------------------------------------------------------

export interface CaseDocumentView {
  id: string;
  title: string;
  docKind: string | null;
  form: "original" | "certified_copy" | "copy" | "electronic";
  receivedOn: string | null;
  receivedFrom: string | null;
  filedAt: string | null;
  /** Null until Phase 10 stores the bytes; the register is metadata until then. */
  storageKey: string | null;
  originalFilename: string | null;
  sha256: string | null;
  pageCount: number | null;
  notes: string | null;
  /** How many checklist items this document satisfies. */
  satisfies: number;
  createdAt: string;
}

export interface CaseDocumentInput {
  caseId: string;
  title: string;
  docKind?: string | null;
  form?: CaseDocumentView["form"];
  receivedOn?: string | null;
  receivedFrom?: string | null;
  filedAt?: string | null;
  notes?: string | null;
}

/**
 * Registers a document CAC holds.
 *
 * Metadata only. Phase 10 builds ingestion — malware scanning, checksums, extraction —
 * and attaches the bytes at `storage_key`. Registering what is held and where it is
 * filed is a real answer to a real question; an upload button with nowhere to put the
 * file, and no scanning, would not be.
 */
export async function registerDocument(
  db: Executor,
  principal: Principal,
  input: CaseDocumentInput,
  context?: AuditContext,
): Promise<string> {
  requireCapability(principal, "case.document.upload");
  const record = await requireWritableCase(db, principal, input.caseId);

  const title = input.title.trim();
  if (!title) throw new ValidationError("Say what the document is.", "title");

  if (input.receivedOn) {
    parseIsoDate(input.receivedOn);
    if (input.receivedOn > toIsoDate(today())) {
      throw new ValidationError("That date is in the future.", "receivedOn");
    }
  }

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO estate.case_document
      (case_id, title, doc_kind, form, received_on, received_from, filed_at, notes, created_by)
    VALUES
      (${input.caseId}, ${title}, ${input.docKind?.trim() || null}, ${input.form ?? "copy"},
       ${input.receivedOn ?? null}, ${input.receivedFrom?.trim() || null},
       ${input.filedAt?.trim() || null}, ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = inserted.rows![0].id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_DOCUMENT_REGISTERED,
    entityType: "estate.case_document",
    entityId: id,
    newValues: { caseNo: record.caseNo, form: input.form ?? "copy" },
  });

  await recordCaseEvent(db, {
    caseId: input.caseId,
    kind: "document",
    summary: `Document registered: ${title}.`,
    origin: "system",
    actorUserId: principal.userId,
    actorLabel: principal.fullName,
  });

  return id;
}

export async function updateDocument(
  db: Executor,
  principal: Principal,
  documentId: string,
  input: Partial<Omit<CaseDocumentInput, "caseId">>,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.document.upload");

  const current = await db.execute<{ case_id: string }>(
    sql`SELECT case_id FROM estate.case_document WHERE id = ${documentId}`,
  );
  const existing = current.rows?.[0];
  if (!existing) throw new NotFoundError("That document is no longer on the register.");
  const record = await requireWritableCase(db, principal, existing.case_id);

  if (input.receivedOn) parseIsoDate(input.receivedOn);

  await db.execute(sql`
    UPDATE estate.case_document
       SET title = ${text(input.title, "title")},
           doc_kind = ${optionalText(input.docKind, "doc_kind")},
           form = ${keep(input.form, "form")},
           received_on = ${keep(input.receivedOn, "received_on")},
           received_from = ${optionalText(input.receivedFrom, "received_from")},
           filed_at = ${optionalText(input.filedAt, "filed_at")},
           notes = ${optionalText(input.notes, "notes")},
           updated_by = ${principal.userId}
     WHERE id = ${documentId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_DOCUMENT_UPDATED,
    entityType: "estate.case_document",
    entityId: documentId,
    newValues: { caseNo: record.caseNo, fields: Object.keys(input).sort() },
  });
}

/**
 * Removes a document from the register.
 *
 * Refused while a checklist item points at it: a requirement that reads as satisfied
 * by a document nobody can find is exactly the false green tick this design avoids.
 */
export async function removeDocument(
  db: Executor,
  principal: Principal,
  documentId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "case.document.delete");

  const current = await db.execute<{ case_id: string; title: string }>(
    sql`SELECT case_id, title FROM estate.case_document WHERE id = ${documentId}`,
  );
  const existing = current.rows?.[0];
  if (!existing) throw new NotFoundError("That document is no longer on the register.");
  const record = await requireWritableCase(db, principal, existing.case_id);

  const why = reason.trim();
  if (!why) throw new ValidationError("Say why it is being removed.", "reason");

  const used = await db.execute<{ count: string }>(sql`
    SELECT count(*) AS count FROM estate.case_requirement
     WHERE document_id = ${documentId} AND status = 'satisfied'
  `);
  if (Number(used.rows![0].count) > 0) {
    throw new ConflictError(
      "A checklist item is satisfied by this document. Reopen that item first, so the checklist does not end up green with nothing behind it.",
    );
  }

  await db.execute(sql`DELETE FROM estate.case_document WHERE id = ${documentId}`);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CASE_DOCUMENT_REMOVED,
    entityType: "estate.case_document",
    entityId: documentId,
    newValues: { caseNo: record.caseNo },
    reason: why,
  });

  await recordCaseEvent(db, {
    caseId: existing.case_id,
    kind: "document",
    summary: `Document removed from the register: ${existing.title}. ${why}`,
    origin: "system",
    actorUserId: principal.userId,
    actorLabel: principal.fullName,
  });
}

export async function listDocuments(
  db: Executor,
  principal: Principal,
  caseId: string,
): Promise<CaseDocumentView[]> {
  requireCapability(principal, "case.document.view");
  await requireCaseAccess(db, principal, caseId);

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT d.*,
           (SELECT count(*) FROM estate.case_requirement r WHERE r.document_id = d.id) AS satisfies
      FROM estate.case_document d
     WHERE d.case_id = ${caseId}
     ORDER BY d.received_on DESC NULLS LAST, d.created_at DESC
  `);

  return (result.rows ?? []).map((row) => ({
    id: String(row.id),
    title: String(row.title),
    docKind: (row.doc_kind as string) ?? null,
    form: row.form as CaseDocumentView["form"],
    receivedOn: row.received_on ? String(row.received_on).slice(0, 10) : null,
    receivedFrom: (row.received_from as string) ?? null,
    filedAt: (row.filed_at as string) ?? null,
    storageKey: (row.storage_key as string) ?? null,
    originalFilename: (row.original_filename as string) ?? null,
    sha256: (row.sha256 as string) ?? null,
    pageCount: row.page_count === null ? null : Number(row.page_count),
    notes: (row.notes as string) ?? null,
    satisfies: Number(row.satisfies ?? 0),
    createdAt: new Date(String(row.created_at)).toISOString(),
  }));
}
