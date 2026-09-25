import {
  bigint,
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { customer } from "./accounting.js";
import { employee } from "./hr.js";
import { user } from "./auth.js";

/**
 * Estate case management.
 *
 * Mirrors migrations 0019/0020. One idea carries the whole file: **facts are
 * recorded, requirements are derived.** A case holds facts about the estate; what
 * those facts require lives in `requirementRule` as approved, sourced data, and a
 * case's checklist is computed from the two. Nothing about Malaysian probate is
 * written into this schema or into the code that reads it.
 *
 * `case` is a reserved word in SQL, so the exported binding is `estateCase`.
 */

export const estateSchema = pgSchema("estate");

export const estateCase = estateSchema.table(
  "case",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseNo: text("case_no").notNull().unique(),
    /**
     * probate | letters_of_administration | estate_inventory | valuation | advisory | other
     *
     * What CAC was instructed on — a label the firm chose. It does not decide which
     * procedural route applies; that is a legal determination (Q-LEGAL-2).
     */
    matterType: text("matter_type").notNull(),
    title: text("title").notNull(),
    /** intake | open | on_hold | closed | withdrawn */
    status: text("status").notNull().default("intake"),
    customerId: uuid("customer_id").references(() => customer.id),
    instructedBy: text("instructed_by"),
    deceasedName: text("deceased_name").notNull(),
    /** Encrypted at rest, as `hr.employee.nricEnc` is; last four for identification. */
    deceasedIdEnc: text("deceased_id_enc"),
    deceasedIdLast4: text("deceased_id_last4"),
    dateOfDeath: date("date_of_death"),
    placeOfDeath: text("place_of_death"),
    domicileState: text("domicile_state"),
    courtReference: text("court_reference"),
    registry: text("registry"),
    openedOn: date("opened_on").notNull(),
    targetOn: date("target_on"),
    closedOn: date("closed_on"),
    closeReason: text("close_reason"),
    engagementRef: text("engagement_ref"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    byStatus: index("case_status_idx").on(table.status, table.openedOn),
    byCustomer: index("case_customer_idx").on(table.customerId),
  }),
);

/**
 * Who may see a case.
 *
 * `case.view` means assigned cases only; `case.view_all` means every case. Estate
 * matters carry family information the whole firm has no business reading, so the
 * narrow capability is the default and this table is what widens it. Queries join
 * against it rather than a screen filtering afterwards.
 */
export const caseAssignment = estateSchema.table(
  "case_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => estateCase.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employee.id),
    /** lead | reviewer | contributor | observer */
    role: text("role").notNull().default("contributor"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    assignedBy: uuid("assigned_by")
      .notNull()
      .references(() => user.id),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by").references(() => user.id),
  },
  (table) => ({
    // One live assignment per person per case; removals stay as history.
    live: uniqueIndex("case_assignment_live_uq")
      .on(table.caseId, table.employeeId)
      .where(sql`removed_at IS NULL`),
    byEmployee: index("case_assignment_employee_idx")
      .on(table.employeeId)
      .where(sql`removed_at IS NULL`),
  }),
);

/**
 * The people in the matter.
 *
 * `shareNote` cannot be set without `shareSource` (CHECK). Who inherits what is a
 * statutory question this platform has not been given the authority for (Q-LEGAL-2);
 * recording what CAC was told, and by whom, is a different thing from computing a
 * distribution.
 */
export const caseParty = estateSchema.table(
  "case_party",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => estateCase.id, { onDelete: "cascade" }),
    /** client | executor | administrator | beneficiary | next_of_kin | creditor | witness | adviser | other */
    role: text("role").notNull(),
    /** person | organisation */
    partyKind: text("party_kind").notNull().default("person"),
    fullName: text("full_name").notNull(),
    relationship: text("relationship"),
    idEnc: text("id_enc"),
    idLast4: text("id_last4"),
    dateOfBirth: date("date_of_birth"),
    isMinor: boolean("is_minor").notNull().default(false),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    shareNote: text("share_note"),
    shareSource: text("share_source"),
    consentStatus: text("consent_status"),
    notes: text("notes"),
    /** reported | verified | excluded */
    status: text("status").notNull().default("reported"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: uuid("verified_by").references(() => user.id),
    exclusionReason: text("exclusion_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    byCase: index("case_party_case_idx").on(table.caseId, table.role),
  }),
);

/**
 * What the estate holds.
 *
 * The valuation columns are a set: amount, basis, date and source exist together or
 * not at all, held by CHECK rather than by convention. A figure on an estate
 * inventory that nobody can trace is worse than no figure, because it gets relied on.
 */
export const caseAsset = estateSchema.table(
  "case_asset",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => estateCase.id, { onDelete: "cascade" }),
    /** land | building | bank | shares | unit_trust | epf | insurance | vehicle | business | receivable | chattel | other */
    category: text("category").notNull(),
    description: text("description").notNull(),
    /** Title number, account number, policy number — encrypted, because here it identifies holdings. */
    referenceEnc: text("reference_enc"),
    referenceLast4: text("reference_last4"),
    location: text("location"),
    holder: text("holder"),
    /** sole | joint | shared | trust | disputed */
    ownership: text("ownership").notNull().default("sole"),
    ownershipNote: text("ownership_note"),
    currency: char("currency", { length: 3 }).notNull().default("MYR"),
    valuationAmount: numeric("valuation_amount", { precision: 18, scale: 4 }),
    valuationBasis: text("valuation_basis"),
    valuationDate: date("valuation_date"),
    valuationSource: text("valuation_source"),
    /** reported | verified | excluded */
    status: text("status").notNull().default("reported"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: uuid("verified_by").references(() => user.id),
    exclusionReason: text("exclusion_reason"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    byCase: index("case_asset_case_idx").on(table.caseId, table.category),
  }),
);

/** What the estate owes. Same shape as the asset register, and read the same way. */
export const caseLiability = estateSchema.table(
  "case_liability",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => estateCase.id, { onDelete: "cascade" }),
    /** mortgage | loan | credit_card | overdraft | tax | utility | medical | funeral | trade | guarantee | other */
    category: text("category").notNull(),
    creditor: text("creditor").notNull(),
    description: text("description").notNull(),
    referenceEnc: text("reference_enc"),
    referenceLast4: text("reference_last4"),
    currency: char("currency", { length: 3 }).notNull().default("MYR"),
    amount: numeric("amount", { precision: 18, scale: 4 }),
    amountBasis: text("amount_basis"),
    amountAsAt: date("amount_as_at"),
    amountSource: text("amount_source"),
    isSecured: boolean("is_secured").notNull().default(false),
    securityNote: text("security_note"),
    /** reported | verified | excluded */
    status: text("status").notNull().default("reported"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: uuid("verified_by").references(() => user.id),
    exclusionReason: text("exclusion_reason"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    byCase: index("case_liability_case_idx").on(table.caseId, table.category),
  }),
);

/**
 * The questions a case is asked.
 *
 * Declared before they are answered, and keys are fixed once answers exist: a rule
 * that fires on `has_will` cannot see an answer filed under `will_exists`, so free
 * typing here would make the rules unwritable.
 */
export const factDefinition = estateSchema.table("fact_definition", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  label: text("label").notNull(),
  /** boolean | text | number | date | choice */
  kind: text("kind").notNull(),
  /** For a choice: the answers offered. A choice with none is refused. */
  options: jsonb("options").notNull().default([]),
  prompt: text("prompt"),
  helpText: text("help_text"),
  /** Which matters the question is asked on. Empty means all. */
  matterTypes: text("matter_types").array().notNull().default(sql`'{}'`),
  sortOrder: integer("sort_order").notNull().default(100),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => user.id),
  updatedBy: uuid("updated_by").references(() => user.id),
});

/**
 * One answer to one declared question, for one case.
 *
 * `status` of `unknown` is a real answer with no value: the question was asked and
 * could not be answered. That is what makes a rule *undecided* rather than false, so
 * a missing answer surfaces on the checklist instead of quietly removing an item.
 */
export const caseFact = estateSchema.table(
  "case_fact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => estateCase.id, { onDelete: "cascade" }),
    factKey: text("fact_key")
      .notNull()
      .references(() => factDefinition.key),
    value: text("value"),
    sourceNote: text("source_note"),
    sourceDocumentId: uuid("source_document_id"),
    /** stated | verified | unknown */
    status: text("status").notNull().default("stated"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: uuid("verified_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    oneAnswer: unique("case_fact_one_answer").on(table.caseId, table.factKey),
    byCase: index("case_fact_case_idx").on(table.caseId),
  }),
);

/**
 * The rules that produce a checklist — and where this platform stops.
 *
 * `appliesWhen` is a condition over declared fact keys, evaluated deterministically
 * by `@cac/core`'s case-rules module: no arithmetic, no free expressions. `sourceRef`
 * is NOT NULL because a requirement with no authority behind it must never reach a
 * list somebody works from. An approved version is immutable and approval is a second
 * person's act.
 *
 * **Nothing is seeded.** No Malaysian probate rule is written in this repository.
 */
export const requirementRule = estateSchema.table(
  "requirement_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    version: integer("version").notNull().default(1),
    title: text("title").notNull(),
    detail: text("detail"),
    /** document | evidence | action | form | consent | payment */
    kind: text("kind").notNull(),
    matterTypes: text("matter_types").array().notNull().default(sql`'{}'`),
    appliesWhen: jsonb("applies_when").notNull().default({ all: [] }),
    /** The authority. Required, always. */
    sourceRef: text("source_ref").notNull(),
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),
    /** draft | approved | retired */
    status: text("status").notNull().default("draft"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => user.id),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    codeVersion: unique("requirement_rule_code_version_uq").on(table.code, table.version),
    oneApproved: uniqueIndex("requirement_rule_one_approved")
      .on(table.code)
      .where(sql`status = 'approved'`),
  }),
);

/**
 * The checklist for one case.
 *
 * Each item snapshots the rule's code, version, title and source, exactly as a letter
 * snapshots its template. Recomputation never deletes: an item that stops applying
 * becomes `not_applicable` with the reason it fell away, and a satisfied item is left
 * alone entirely.
 */
export const caseRequirement = estateSchema.table(
  "case_requirement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => estateCase.id, { onDelete: "cascade" }),
    /** Null for an item added by hand, which is allowed and visibly different. */
    ruleId: uuid("rule_id").references(() => requirementRule.id),
    ruleCode: text("rule_code"),
    ruleVersion: integer("rule_version"),
    title: text("title").notNull(),
    detail: text("detail"),
    kind: text("kind").notNull(),
    sourceRef: text("source_ref"),
    /** outstanding | in_progress | satisfied | waived | not_applicable */
    status: text("status").notNull().default("outstanding"),
    /** Facts the evaluator needed and did not have. The item stays, flagged. */
    undecidedFacts: text("undecided_facts").array().notNull().default(sql`'{}'`),
    documentId: uuid("document_id"),
    satisfiedAt: timestamp("satisfied_at", { withTimezone: true }),
    satisfiedBy: uuid("satisfied_by").references(() => user.id),
    waiveReason: text("waive_reason"),
    waivedAt: timestamp("waived_at", { withTimezone: true }),
    waivedBy: uuid("waived_by").references(() => user.id),
    droppedReason: text("dropped_reason"),
    dueOn: date("due_on"),
    sortOrder: integer("sort_order").notNull().default(100),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    onePerRule: unique("case_requirement_one_per_rule").on(table.caseId, table.ruleId),
    byCase: index("case_requirement_case_idx").on(table.caseId, table.status),
  }),
);

/**
 * Somebody's work, with a date on it.
 *
 * Deliberately not the same thing as a requirement. A requirement is what the matter
 * needs; a task is what a named person is doing about it this week.
 */
export const caseTask = estateSchema.table(
  "case_task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => estateCase.id, { onDelete: "cascade" }),
    requirementId: uuid("requirement_id").references(() => caseRequirement.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    detail: text("detail"),
    assigneeId: uuid("assignee_id").references(() => employee.id),
    dueOn: date("due_on"),
    /** low | normal | high | urgent */
    priority: text("priority").notNull().default("normal"),
    /** open | in_progress | blocked | done | cancelled */
    status: text("status").notNull().default("open"),
    blockedReason: text("blocked_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by").references(() => user.id),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    byCase: index("case_task_case_idx").on(table.caseId, table.status),
  }),
);

/**
 * The document register.
 *
 * Metadata about documents CAC holds: what it is, who provided it, whether the
 * original or a copy, where it is filed. **Not the file itself** — Phase 10 builds
 * ingestion, and `storageKey` is where that attaches. A register answers "do we have
 * the death certificate and where is it", which is the question actually asked.
 */
export const caseDocument = estateSchema.table(
  "case_document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => estateCase.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    docKind: text("doc_kind"),
    /** original | certified_copy | copy | electronic */
    form: text("form").notNull().default("copy"),
    receivedOn: date("received_on"),
    receivedFrom: text("received_from"),
    filedAt: text("filed_at"),
    /** Null until Phase 10 stores the bytes. */
    storageKey: text("storage_key"),
    originalFilename: text("original_filename"),
    byteSize: bigint("byte_size", { mode: "number" }),
    sha256: char("sha256", { length: 64 }),
    pageCount: integer("page_count"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    byCase: index("case_document_case_idx").on(table.caseId),
  }),
);

/**
 * The timeline: what happened in the matter.
 *
 * Append-only by trigger, and separate from `audit.event` on purpose. The audit log
 * answers "who did what in this system"; this answers "what happened in this matter" —
 * the death, the instruction, the filing, the grant. `origin` keeps the two kinds
 * apart: `system` for entries the platform wrote as a side effect of work, `recorded`
 * for what somebody typed in because it happened in a registry, not in a browser.
 */
export const caseEvent = estateSchema.table(
  "case_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => estateCase.id, { onDelete: "cascade" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    /** system | recorded */
    origin: text("origin").notNull().default("system"),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    /** Redacted before it is written, the same as an audit payload. */
    detail: jsonb("detail").notNull().default({}),
    actorUserId: uuid("actor_user_id").references(() => user.id),
    actorLabel: text("actor_label"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byCase: index("case_event_case_idx").on(table.caseId, table.occurredAt),
  }),
);
