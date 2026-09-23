import { boolean, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const orgSchema = pgSchema("org");

/**
 * Company-wide configuration.
 *
 * Everything the brief listed as "configurable" lives here rather than in
 * code: fiscal year start, grace periods, numbering formats, approval
 * thresholds. Two properties matter:
 *
 *  - `requiresApproval` marks settings (statutory rates, thresholds) that a
 *    single administrator must not be able to change unilaterally.
 *  - every change is audited, so altering a statutory value leaves a trail of
 *    who changed it, when and why.
 */
export const setting = orgSchema.table("setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  category: text("category").notNull(),
  label: text("label").notNull(),
  description: text("description"),
  /** Set where the correct value is not yet known — surfaced in the admin UI. */
  needsReview: boolean("needs_review").notNull().default(false),
  requiresApproval: boolean("requires_approval").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
});

export const costCentre = orgSchema.table("cost_centre", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
});

/**
 * Gapless, per-type document numbering (INV-2026-00001 …).
 *
 * Allocation takes a row lock so two concurrent invoices cannot take the same
 * number, and numbers are never recycled once issued.
 */
export const documentSequence = orgSchema.table("document_sequence", {
  key: text("key").primaryKey(),
  prefix: text("prefix").notNull(),
  /** Tokens: {YYYY} {YY} {MM} {SEQ}. */
  format: text("format").notNull().default("{PREFIX}-{YYYY}-{SEQ}"),
  padding: text("padding").notNull().default("5"),
  nextValue: text("next_value").notNull().default("1"),
  periodKey: text("period_key"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
