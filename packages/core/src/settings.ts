import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { requireCapability, type Principal } from "./authz.js";

/**
 * Configuration.
 *
 * Nothing that CAC might reasonably want different is a constant in code:
 * fiscal year start, grace periods, approval thresholds, statutory flags. They
 * live in `org.setting` as JSON, are read here, and are changed only through
 * `setSetting`, which audits every change.
 *
 * Two flags on a setting row matter:
 *
 *  - `needs_review` marks a value nobody has confirmed yet. Several of these are
 *    deliberately null rather than plausible: an unconfirmed overtime multiplier
 *    guessed at 1.5 looks right on a payslip and is a wage claim if it is wrong.
 *  - `requires_approval` marks values a single administrator should not be able
 *    to move on their own — statutory rates, approval limits.
 */

export interface SettingRow {
  key: string;
  value: unknown;
  category: string;
  label: string;
  description: string | null;
  needsReview: boolean;
  requiresApproval: boolean;
  updatedAt: Date | string;
}

/** Reads one setting. Returns `fallback` when the row is absent. */
export async function getSetting<T>(db: Executor, key: string, fallback: T): Promise<T> {
  const result = await db.execute<{ value: unknown }>(sql`
    SELECT value FROM org.setting WHERE key = ${key}
  `);
  const row = result.rows?.[0];
  if (!row || row.value === null) return fallback;
  return row.value as T;
}

/**
 * Reads several settings at once.
 *
 * One query rather than N: a page that needs eight settings should not make
 * eight round trips.
 */
export async function getSettings(
  db: Executor,
  keys: string[],
): Promise<Record<string, unknown>> {
  if (keys.length === 0) return {};
  const result = await db.execute<{ key: string; value: unknown }>(sql`
    SELECT key, value FROM org.setting
     WHERE key IN (${sql.join(
       keys.map((k) => sql`${k}`),
       sql`, `,
     )})
  `);
  const out: Record<string, unknown> = {};
  for (const row of result.rows ?? []) out[row.key] = row.value;
  return out;
}

export async function listSettings(db: Executor, category?: string): Promise<SettingRow[]> {
  const result = await db.execute<{
    key: string;
    value: unknown;
    category: string;
    label: string;
    description: string | null;
    needs_review: boolean;
    requires_approval: boolean;
    updated_at: Date | string;
  }>(
    category
      ? sql`SELECT * FROM org.setting WHERE category = ${category} ORDER BY key`
      : sql`SELECT * FROM org.setting ORDER BY category, key`,
  );
  return (result.rows ?? []).map((row) => ({
    key: row.key,
    value: row.value,
    category: row.category,
    label: row.label,
    description: row.description,
    needsReview: row.needs_review,
    requiresApproval: row.requires_approval,
    updatedAt: row.updated_at,
  }));
}

/**
 * Changes a setting.
 *
 * The old and new values both go into the audit row, so "who raised the approval
 * limit, when, and what it was before" is answerable without a backup. Clearing
 * `needs_review` is part of the same act: confirming a value *is* the review.
 */
export async function setSetting(
  db: Executor,
  principal: Principal,
  key: string,
  value: unknown,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "admin.settings.manage");

  const before = await db.execute<{ value: unknown; requires_approval: boolean; label: string }>(sql`
    SELECT value, requires_approval, label FROM org.setting WHERE key = ${key}
  `);
  const row = before.rows?.[0];
  if (!row) throw new NotFoundError(`There is no setting called "${key}".`);

  // A setting marked `requires_approval` carries statutory or financial weight.
  // The two-person workflow for these arrives with the approval framework in
  // phase 3; until then the control is a mandatory, audited reason, so the change
  // is at least attributable and explained rather than silent.
  if (row.requires_approval && !options.reason?.trim()) {
    throw new ValidationError(
      `"${row.label}" affects statutory or approval limits. Record why it is changing.`,
      "reason",
    );
  }

  await db.execute(sql`
    UPDATE org.setting
       SET value = ${JSON.stringify(value)}::jsonb,
           needs_review = false,
           updated_by = ${principal.userId}
     WHERE key = ${key}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.SETTING_CHANGED,
    entityType: "setting",
    entityId: key,
    oldValues: { key, value: row.value },
    newValues: { key, value },
    reason: options.reason ?? null,
  });
}
