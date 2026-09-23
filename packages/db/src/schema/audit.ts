import { index, inet, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const auditSchema = pgSchema("audit");

/**
 * Append-only record of anything that matters.
 *
 * Written inside the same transaction as the change it describes, so a
 * rolled-back change cannot leave a phantom audit row — and a successful
 * change cannot go unrecorded.
 *
 * The application database role is granted INSERT and SELECT only; see
 * `grants.sql`. Nothing in the app can amend or remove an audit row.
 */
export const event = auditSchema.table(
  "event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for unauthenticated actions such as a failed login. */
    actorUserId: uuid("actor_user_id"),
    actorLabel: text("actor_label"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    /** Redacted before write — see `redact()` in @cac/core/audit. */
    oldValues: jsonb("old_values"),
    newValues: jsonb("new_values"),
    reason: text("reason"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    /** Ties every row written during one request together. */
    correlationId: uuid("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byEntity: index("audit_entity_idx").on(t.entityType, t.entityId),
    byActor: index("audit_actor_idx").on(t.actorUserId, t.createdAt),
    byTime: index("audit_time_idx").on(t.createdAt),
    byAction: index("audit_action_idx").on(t.action, t.createdAt),
  }),
);
