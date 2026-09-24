import {
  date,
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
import { hrSchema, employee, employmentEvent } from "./hr.js";
import { user } from "./auth.js";

/**
 * Employment letters.
 *
 * Mirrors migrations 0017/0018. One idea carries the whole file: **a letter keeps its
 * own copy of the template.** `bodyTemplate`, `variables` and `valuesUsed` are
 * snapshotted onto the letter, and `bodyRendered` is the text that was actually
 * produced.
 *
 * That is not redundancy. These documents turn up in employment disputes, and a letter
 * that re-renders itself from the current template is a letter whose contents depend on
 * when you read it. Revising the appointment letter next year must not change what
 * somebody was told this year.
 */

export const letterTemplate = hrSchema.table(
  "letter_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    version: integer("version").notNull().default(1),
    name: text("name").notNull(),
    /** appointment | confirmation | increment | promotion | warning | reference | termination | custom */
    kind: text("kind").notNull().default("custom"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    /** Declared variables: key, label, type, required. The engine refuses anything undeclared. */
    variables: jsonb("variables").notNull().default([]),
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
    codeVersion: unique().on(table.code, table.version),
    // "The appointment letter" has to mean one thing when somebody generates one.
    oneApproved: uniqueIndex("letter_template_one_approved_per_code")
      .on(table.code)
      .where(sql`status = 'approved'`),
  }),
);

export const letter = hrSchema.table(
  "letter",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    letterNo: text("letter_no"),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employee.id),

    /** The link, for provenance. */
    templateId: uuid("template_id").references(() => letterTemplate.id),
    /** And the snapshot, because the link's target may be revised. */
    templateCode: text("template_code").notNull(),
    templateVersion: integer("template_version").notNull(),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    bodyTemplate: text("body_template").notNull(),
    variables: jsonb("variables").notNull().default([]),
    valuesUsed: jsonb("values_used").notNull().default({}),
    /** The text that was produced. Nothing re-derives this on read. */
    bodyRendered: text("body_rendered").notNull(),

    letterDate: date("letter_date").notNull(),
    /** draft | approved | issued | cancelled */
    status: text("status").notNull().default("draft"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => user.id),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    issuedBy: uuid("issued_by").references(() => user.id),
    /** How it reached them — "was it actually given to them" is asked afterwards. */
    deliveryNote: text("delivery_note"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    /** The letter this one corrects. A correction is visible on both. */
    supersedesLetterId: uuid("supersedes_letter_id"),
    employmentEventId: uuid("employment_event_id").references(() => employmentEvent.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: uuid("updated_by").references(() => user.id),
  },
  (table) => ({
    numberUnique: uniqueIndex("letter_no_unique")
      .on(table.letterNo)
      .where(sql`letter_no IS NOT NULL`),
    byEmployee: index("letter_employee_idx").on(table.employeeId, table.letterDate),
    byStatus: index("letter_status_idx").on(table.status),
  }),
);
