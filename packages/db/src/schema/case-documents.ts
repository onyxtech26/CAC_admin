import {
  boolean,
  char,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { estateSchema, estateCase } from "./estate.js";
import { document as libraryDocument } from "./library.js";
import { user } from "./auth.js";

/**
 * Documents generated for a matter.
 *
 * Mirrors migrations 0024/0025. The same idea as the employment letters — a document keeps
 * its own copy of the template, the variables, the values and the rendered text — with one
 * addition that matters here: `caseSnapshot`.
 *
 * A letter is about one person on one date. An application is about an estate that is still
 * moving, so the document records what the matter looked like when it was produced: the
 * counts, the totals, the checklist's state and the fact answers. A year later that is what
 * shows not only what the document said but what it was describing.
 *
 * `modelName` and `modelVersion` are null on every row this platform can currently produce,
 * because no model is configured — and the null is itself the claim.
 */

export const documentTemplate = estateSchema.table(
  "document_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    version: integer("version").notNull().default(1),
    name: text("name").notNull(),
    /** application | affidavit | inventory | schedule | letter | report | other */
    kind: text("kind").notNull().default("other"),
    /** Which matters it may be used on. Empty means any. */
    matterTypes: text("matter_types").array().notNull().default(sql`'{}'`),
    title: text("title").notNull(),
    body: text("body").notNull(),
    variables: jsonb("variables").notNull().default([]),
    /** Required for an application, an affidavit or a schedule; the database enforces it. */
    sourceRef: text("source_ref"),
    notes: text("notes"),
    /** draft | approved | retired */
    status: text("status").notNull().default("draft"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => user.id),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    codeVersion: unique("document_template_code_version_uq").on(table.code, table.version),
    // "The application" has to mean one thing when somebody generates one.
    oneApproved: uniqueIndex("document_template_one_approved")
      .on(table.code)
      .where(sql`status = 'approved'`),
  }),
);

export const generatedDocument = estateSchema.table(
  "generated_document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentNo: text("document_no").notNull().unique(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => estateCase.id),
    templateId: uuid("template_id")
      .notNull()
      .references(() => documentTemplate.id),
    /** Snapshotted beside the id, so provenance reads without a join and survives a rename. */
    templateCode: text("template_code").notNull(),
    templateVersion: integer("template_version").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),

    bodyTemplate: text("body_template").notNull(),
    variables: jsonb("variables").notNull(),
    valuesUsed: jsonb("values_used").notNull(),
    /** What was produced. The only thing the screen, the Word file and the PDF print. */
    bodyRendered: text("body_rendered").notNull(),

    /** The matter as it stood: counts, totals, checklist state, fact answers. */
    caseSnapshot: jsonb("case_snapshot").notNull().default({}),

    modelName: text("model_name"),
    modelVersion: text("model_version"),
    assistantUsed: boolean("assistant_used").notNull().default(false),

    /** draft | approved | finalised | cancelled */
    status: text("status").notNull().default("draft"),
    reviewedBy: uuid("reviewed_by").references(() => user.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    finalisedBy: uuid("finalised_by").references(() => user.id),
    finalisedAt: timestamp("finalised_at", { withTimezone: true }),
    /** The PDF produced at finalisation, held immutably in the library. */
    pdfDocumentId: uuid("pdf_document_id").references(() => libraryDocument.id),
    pdfSha256: char("pdf_sha256", { length: 64 }),
    cancelReason: text("cancel_reason"),
    supersedesId: uuid("supersedes_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    byCase: index("generated_document_case_idx").on(table.caseId, table.createdAt),
    byTemplate: index("generated_document_template_idx").on(table.templateId),
    // One document is superseded once, or "which is current" stops having an answer.
    supersedesOnce: uniqueIndex("generated_document_supersedes_uq")
      .on(table.supersedesId)
      .where(sql`supersedes_id IS NOT NULL`),
  }),
);
