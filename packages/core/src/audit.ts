import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";

/**
 * The audit trail.
 *
 * Two rules matter more than the rest:
 *
 *  1. An audit row is written in the *same transaction* as the change it
 *     describes. A rolled-back change must not leave a phantom entry, and a
 *     committed change must not go unrecorded. Callers therefore pass the
 *     transaction handle, not a fresh connection.
 *
 *  2. Sensitive values never reach the row. `redact()` runs over every payload
 *     before it is written, because an audit trail full of NRICs and salaries
 *     is itself a data-protection problem.
 */

/** Keys whose values are replaced wherever they appear, at any depth. */
const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "password_hash",
  "newpassword",
  "currentpassword",
  "token",
  "tokenhash",
  "token_hash",
  "secret",
  "secretenc",
  "secret_enc",
  "totp",
  "otp",
  "recoverycode",
  "recovery_code",
  "codehash",
  "code_hash",
  "sessiontoken",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
]);

/** Keys kept but masked, because the change itself is worth auditing. */
const MASKED_KEYS = new Set([
  "nric",
  "ic",
  "icnumber",
  "ic_number",
  "passport",
  "passportno",
  "bankaccount",
  "bank_account",
  "bankaccountno",
  "accountnumber",
  "account_number",
  "salary",
  "basicsalary",
  "basic_salary",
  "netpay",
  "net_pay",
  "grosspay",
  "gross_pay",
]);

function maskValue(value: unknown): unknown {
  if (typeof value === "number") return "***";
  if (typeof value !== "string") return "***";
  if (value.length <= 4) return "***";
  return `${"*".repeat(Math.max(3, value.length - 4))}${value.slice(-4)}`;
}

/**
 * Deep-redacts a payload. Returns a new structure; the input is untouched.
 * Cycles are tolerated because audit payloads are sometimes built from ORM
 * rows with back-references.
 */
export function redact<T>(input: T, seen = new WeakSet<object>()): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input !== "object") return input;

  if (seen.has(input as object)) return "[circular]";
  seen.add(input as object);

  if (Array.isArray(input)) return input.map((item) => redact(item, seen));
  if (input instanceof Date) return input.toISOString();

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const normalised = key.toLowerCase().replace(/[^a-z_]/g, "");
    if (SENSITIVE_KEYS.has(normalised)) out[key] = "[redacted]";
    else if (MASKED_KEYS.has(normalised)) out[key] = maskValue(value);
    else out[key] = redact(value, seen);
  }
  return out;
}

export interface AuditContext {
  actorUserId?: string | null;
  actorLabel?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export interface AuditEntry extends AuditContext {
  action: string;
  entityType: string;
  entityId?: string | null;
  oldValues?: unknown;
  newValues?: unknown;
  reason?: string | null;
}

/**
 * Writes one audit row.
 *
 * `db` should be the transaction handle from the surrounding mutation. Passing
 * the pooled client instead still works, but loses the guarantee in rule 1
 * above — so it is only appropriate for events that have no transaction, such
 * as a failed login.
 */
export async function writeAudit(db: Executor, entry: AuditEntry): Promise<void> {
  const oldValues = entry.oldValues === undefined ? null : JSON.stringify(redact(entry.oldValues));
  const newValues = entry.newValues === undefined ? null : JSON.stringify(redact(entry.newValues));

  await db.execute(sql`
    INSERT INTO audit.event (
      actor_user_id, actor_label, action, entity_type, entity_id,
      old_values, new_values, reason, ip, user_agent, correlation_id
    ) VALUES (
      ${entry.actorUserId ?? null},
      ${entry.actorLabel ?? null},
      ${entry.action},
      ${entry.entityType},
      ${entry.entityId ?? null},
      ${oldValues}::jsonb,
      ${newValues}::jsonb,
      ${entry.reason ?? null},
      ${entry.ip ?? null},
      ${entry.userAgent ?? null},
      ${entry.correlationId ?? null}
    )
  `);
}

/** Canonical action names. Using the constant keeps the trail searchable. */
export const AUDIT = {
  LOGIN: "LOGIN",
  LOGIN_FAILED: "LOGIN_FAILED",
  LOGIN_LOCKED: "LOGIN_LOCKED",
  LOGOUT: "LOGOUT",
  LOGOUT_ALL: "LOGOUT_ALL",
  MFA_ENROLLED: "MFA_ENROLLED",
  MFA_FAILED: "MFA_FAILED",
  MFA_RESET: "MFA_RESET",
  PASSWORD_CHANGED: "PASSWORD_CHANGED",
  PASSWORD_RESET_REQUESTED: "PASSWORD_RESET_REQUESTED",
  PASSWORD_RESET_COMPLETED: "PASSWORD_RESET_COMPLETED",
  USER_CREATED: "USER_CREATED",
  USER_UPDATED: "USER_UPDATED",
  USER_SUSPENDED: "USER_SUSPENDED",
  USER_REACTIVATED: "USER_REACTIVATED",
  ROLE_ASSIGNED: "ROLE_ASSIGNED",
  ROLE_REVOKED: "ROLE_REVOKED",
  PERMISSION_OVERRIDDEN: "PERMISSION_OVERRIDDEN",
  SETTING_CHANGED: "SETTING_CHANGED",
  SESSION_REVOKED: "SESSION_REVOKED",
  EXPORT_SENSITIVE: "EXPORT_SENSITIVE",

  // Accounting
  ACCOUNT_CREATED: "ACCOUNT_CREATED",
  ACCOUNT_UPDATED: "ACCOUNT_UPDATED",
  ACCOUNT_DEACTIVATED: "ACCOUNT_DEACTIVATED",
  ACCOUNT_REACTIVATED: "ACCOUNT_REACTIVATED",
  FISCAL_YEAR_CREATED: "FISCAL_YEAR_CREATED",
  FISCAL_YEAR_CLOSED: "FISCAL_YEAR_CLOSED",
  PERIOD_LOCKED: "PERIOD_LOCKED",
  PERIOD_UNLOCKED: "PERIOD_UNLOCKED",
  PERIOD_CLOSED: "PERIOD_CLOSED",
  PERIOD_REOPENED: "PERIOD_REOPENED",
  JOURNAL_DRAFTED: "JOURNAL_DRAFTED",
  JOURNAL_UPDATED: "JOURNAL_UPDATED",
  JOURNAL_DELETED: "JOURNAL_DELETED",
  JOURNAL_POSTED: "JOURNAL_POSTED",
  JOURNAL_REVERSED: "JOURNAL_REVERSED",
  CUSTOMER_CREATED: "CUSTOMER_CREATED",
  CUSTOMER_UPDATED: "CUSTOMER_UPDATED",
  SUPPLIER_CREATED: "SUPPLIER_CREATED",
  SUPPLIER_UPDATED: "SUPPLIER_UPDATED",
  TAX_RATE_ADDED: "TAX_RATE_ADDED",
} as const;
