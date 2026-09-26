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
  "clientsecret",
  "client_secret",
  "privatekey",
  "private_key",
  "credential",
  "credentials",
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
  // A run total, which is an aggregate right up until the run has one person in it — and a
  // one-person supplementary run is the ordinary case. The run row holds the figure; the audit trail
  // does not need to repeat it to record who approved what and when.
  "nettotal",
  "net_total",
  "grosstotal",
  "gross_total",
  // Phase 9. An estate case holds identifying numbers for people who are not
  // employees — the deceased, the beneficiaries — and for their holdings. The
  // estate module additionally keeps names, descriptions and figures out of audit
  // payloads altogether; these entries are the backstop for anything that slips.
  "deceasedid",
  "deceased_id",
  "idnumber",
  "id_number",
  "policyno",
  "policy_number",
  "titleno",
  "title_number",
]);

function maskValue(value: unknown): unknown {
  if (typeof value !== "string") return "***";
  if (value.length <= 4) return "***";

  /**
   * An amount is masked whole; an identifier keeps its last four.
   *
   * The last four digits of an account or an NRIC are a deliberate partial identifier — enough to
   * say which account, not enough to use it, which is why `bank_account_last4` is a column. The last
   * four characters of an *amount* are nothing of the kind: "3500.00" masked to "***0.00" gives the
   * figure to the nearest hundred and its shape, from a function whose job is to remove both.
   *
   * So: anything with a fractional part, and any run of digits too short to be an account number,
   * goes entirely.
   */
  const digits = value.replace(/\D/g, "");
  const looksLikeAnAmount = /^-?[\d,]+\.\d+$/.test(value.trim());
  if (looksLikeAnAmount || digits.length < 10) return "***";

  return `${"*".repeat(Math.max(3, value.length - 4))}${value.slice(-4)}`;
}

/** A Malaysian NRIC: twelve digits, hyphenated or not. */
const NRIC_SHAPE = /\b\d{6}-?\d{2}-?\d{4}\b/g;
/** Ten or more digits in a row, with optional separators: an account or a card. */
const LONG_NUMBER_SHAPE = /\b\d[\d\s-]{8,}\d\b/g;

/**
 * Removes the two shapes that must never reach an append-only table, and nothing else.
 *
 * Exported so the same rule can be applied wherever free text is stored beside a record, and tested
 * directly against the awkward cases.
 */
export function redactFreeText(input: string): string {
  return input
    .replace(NRIC_SHAPE, "[identification number removed]")
    .replace(LONG_NUMBER_SHAPE, "[number removed]");
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

  /**
   * The reason is free text a person typed, and it went in untouched.
   *
   * `redact()` works on property names, and a reason has none — it is one string, and the only
   * mandatory one in the platform is the reason for resetting somebody's MFA, typed at the moment an
   * administrator is looking at an identity document. An NRIC pasted into that box landed
   * unredacted in an append-only table that cannot be scrubbed.
   *
   * So the *content* is scanned, for the two shapes that are unmistakable and irreversible: a
   * Malaysian NRIC and a long run of digits that is a bank account or a card. Deliberately narrow.
   * A reason is meant to be read by whoever reviews the trail later, and a filter that mangles
   * ordinary sentences would make people write less rather than less sensitive.
   */
  const reason = entry.reason == null ? null : redactFreeText(entry.reason);

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
      ${reason},
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
  /** A second factor accepted, and by which means. Failures without successes are unreadable. */
  MFA_SATISFIED: "MFA_SATISFIED",
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
  /**
   * A capability check that refused.
   *
   * The /denied page tells the person "The request has been recorded", which was not true: nothing
   * wrote anything. Either the sentence goes or the row does, and the row is worth more — a pattern
   * of denials is how somebody probing what they can reach looks from the inside.
   */
  ACCESS_DENIED: "ACCESS_DENIED",
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

  // Sales cycle
  QUOTATION_CREATED: "QUOTATION_CREATED",
  QUOTATION_UPDATED: "QUOTATION_UPDATED",
  QUOTATION_DELETED: "QUOTATION_DELETED",
  QUOTATION_SENT: "QUOTATION_SENT",
  QUOTATION_ACCEPTED: "QUOTATION_ACCEPTED",
  QUOTATION_DECLINED: "QUOTATION_DECLINED",
  QUOTATION_CONVERTED: "QUOTATION_CONVERTED",
  INVOICE_CREATED: "INVOICE_CREATED",
  INVOICE_UPDATED: "INVOICE_UPDATED",
  INVOICE_DELETED: "INVOICE_DELETED",
  INVOICE_SUBMITTED: "INVOICE_SUBMITTED",
  INVOICE_RETURNED: "INVOICE_RETURNED",
  INVOICE_APPROVED: "INVOICE_APPROVED",
  INVOICE_ISSUED: "INVOICE_ISSUED",
  INVOICE_VOIDED: "INVOICE_VOIDED",
  CREDIT_NOTE_CREATED: "CREDIT_NOTE_CREATED",
  RECEIPT_CREATED: "RECEIPT_CREATED",
  RECEIPT_UPDATED: "RECEIPT_UPDATED",
  RECEIPT_DELETED: "RECEIPT_DELETED",
  RECEIPT_POSTED: "RECEIPT_POSTED",
  RECEIPT_VOIDED: "RECEIPT_VOIDED",
  ALLOCATION_ADDED: "ALLOCATION_ADDED",
  ALLOCATION_REMOVED: "ALLOCATION_REMOVED",
  /** A customer-facing document was produced as a file. */
  DOCUMENT_PRODUCED: "DOCUMENT_PRODUCED",

  // Purchasing
  PO_CREATED: "PO_CREATED",
  PO_UPDATED: "PO_UPDATED",
  PO_DELETED: "PO_DELETED",
  PO_SUBMITTED: "PO_SUBMITTED",
  PO_APPROVED: "PO_APPROVED",
  PO_ISSUED: "PO_ISSUED",
  PO_RECEIVED: "PO_RECEIVED",
  PO_CLOSED: "PO_CLOSED",
  PO_CANCELLED: "PO_CANCELLED",
  VOUCHER_CREATED: "VOUCHER_CREATED",
  VOUCHER_UPDATED: "VOUCHER_UPDATED",
  VOUCHER_DELETED: "VOUCHER_DELETED",
  VOUCHER_SUBMITTED: "VOUCHER_SUBMITTED",
  VOUCHER_APPROVED: "VOUCHER_APPROVED",
  VOUCHER_POSTED: "VOUCHER_POSTED",
  VOUCHER_VOIDED: "VOUCHER_VOIDED",

  // Petty cash and claims
  PETTY_CASH_RECORDED: "PETTY_CASH_RECORDED",
  PETTY_CASH_POSTED: "PETTY_CASH_POSTED",
  PETTY_CASH_VOIDED: "PETTY_CASH_VOIDED",
  PETTY_CASH_COUNTED: "PETTY_CASH_COUNTED",
  CLAIM_CREATED: "CLAIM_CREATED",
  CLAIM_UPDATED: "CLAIM_UPDATED",
  CLAIM_DELETED: "CLAIM_DELETED",
  CLAIM_SUBMITTED: "CLAIM_SUBMITTED",
  CLAIM_APPROVED: "CLAIM_APPROVED",
  CLAIM_REJECTED: "CLAIM_REJECTED",
  CLAIM_POSTED: "CLAIM_POSTED",
  CLAIM_REIMBURSED: "CLAIM_REIMBURSED",

  // Phase 4 — the bank.
  //
  // Matching and unmatching are audited individually rather than only at
  // completion. A reconciliation that balances is only as good as the matches
  // beneath it, and "who decided these two were the same payment" is the
  // question asked when one of them turns out to be wrong.
  BANK_ACCOUNT_CREATED: "BANK_ACCOUNT_CREATED",
  BANK_ACCOUNT_UPDATED: "BANK_ACCOUNT_UPDATED",
  STATEMENT_IMPORTED: "STATEMENT_IMPORTED",
  STATEMENT_DELETED: "STATEMENT_DELETED",
  STATEMENT_LINE_MATCHED: "STATEMENT_LINE_MATCHED",
  STATEMENT_LINE_UNMATCHED: "STATEMENT_LINE_UNMATCHED",
  STATEMENT_LINE_IGNORED: "STATEMENT_LINE_IGNORED",
  STATEMENT_LINE_POSTED: "STATEMENT_LINE_POSTED",
  RECONCILIATION_OPENED: "RECONCILIATION_OPENED",
  RECONCILIATION_COMPLETED: "RECONCILIATION_COMPLETED",
  RECONCILIATION_ABANDONED: "RECONCILIATION_ABANDONED",

  // Phase 5 — the people.
  //
  // EMPLOYEE_SENSITIVE_VIEWED is not here: reading somebody's identity card number
  // is an export of personal data, and it reuses EXPORT_SENSITIVE so that one query
  // answers "who has looked at personal data" across the whole platform rather than
  // one per module.
  DEPARTMENT_CREATED: "DEPARTMENT_CREATED",
  DEPARTMENT_UPDATED: "DEPARTMENT_UPDATED",
  POSITION_CREATED: "POSITION_CREATED",
  POSITION_UPDATED: "POSITION_UPDATED",
  SCHEDULE_CREATED: "SCHEDULE_CREATED",
  SCHEDULE_UPDATED: "SCHEDULE_UPDATED",
  EMPLOYEE_CREATED: "EMPLOYEE_CREATED",
  EMPLOYEE_UPDATED: "EMPLOYEE_UPDATED",
  EMPLOYEE_TERMINATED: "EMPLOYEE_TERMINATED",
  EMPLOYMENT_EVENT_RECORDED: "EMPLOYMENT_EVENT_RECORDED",
  HOLIDAY_ADDED: "HOLIDAY_ADDED",
  HOLIDAY_REMOVED: "HOLIDAY_REMOVED",
  ATTENDANCE_IMPORT_STAGED: "ATTENDANCE_IMPORT_STAGED",
  ATTENDANCE_IMPORT_CONFIRMED: "ATTENDANCE_IMPORT_CONFIRMED",
  ATTENDANCE_IMPORT_DISCARDED: "ATTENDANCE_IMPORT_DISCARDED",
  ATTENDANCE_CORRECTED: "ATTENDANCE_CORRECTED",
  ATTENDANCE_PERIOD_OPENED: "ATTENDANCE_PERIOD_OPENED",
  ATTENDANCE_FINALISED: "ATTENDANCE_FINALISED",
  ATTENDANCE_REOPENED: "ATTENDANCE_REOPENED",
  ATTENDANCE_CALCULATED: "ATTENDANCE_CALCULATED",

  // Phase 6 — the workflows around attendance.
  LEAVE_TYPE_SAVED: "LEAVE_TYPE_SAVED",
  LEAVE_BALANCE_SET: "LEAVE_BALANCE_SET",
  LEAVE_REQUESTED: "LEAVE_REQUESTED",
  LEAVE_SUBMITTED: "LEAVE_SUBMITTED",
  LEAVE_APPROVED: "LEAVE_APPROVED",
  LEAVE_REJECTED: "LEAVE_REJECTED",
  LEAVE_CANCELLED: "LEAVE_CANCELLED",
  OVERTIME_REQUESTED: "OVERTIME_REQUESTED",
  OVERTIME_SUBMITTED: "OVERTIME_SUBMITTED",
  OVERTIME_APPROVED: "OVERTIME_APPROVED",
  /** A rate supplied after approval, once Q-HR-1 answered what it should be. */
  OVERTIME_RATED: "OVERTIME_RATED",
  OVERTIME_REJECTED: "OVERTIME_REJECTED",
  TIMEOFF_REQUESTED: "TIMEOFF_REQUESTED",
  TIMEOFF_DECIDED: "TIMEOFF_DECIDED",
  APPRAISAL_CYCLE_SAVED: "APPRAISAL_CYCLE_SAVED",
  APPRAISAL_OPENED: "APPRAISAL_OPENED",
  APPRAISAL_SELF_ASSESSED: "APPRAISAL_SELF_ASSESSED",
  APPRAISAL_REVIEWED: "APPRAISAL_REVIEWED",
  APPRAISAL_ACKNOWLEDGED: "APPRAISAL_ACKNOWLEDGED",

  // Phase 7 — payroll.
  //
  // The statutory rule actions are audited separately from the runs that use them,
  // because "who entered this EPF table, and who confirmed it" is a different
  // question from "who approved March's payroll" and is asked far less often — which
  // is exactly why it has to be answerable.
  STATUTORY_RULE_SAVED: "STATUTORY_RULE_SAVED",
  STATUTORY_RULE_APPROVED: "STATUTORY_RULE_APPROVED",
  PAY_ELEMENT_SAVED: "PAY_ELEMENT_SAVED",
  PAYROLL_RUN_CREATED: "PAYROLL_RUN_CREATED",
  PAYROLL_RUN_PREPARED: "PAYROLL_RUN_PREPARED",
  PAYROLL_RUN_APPROVED: "PAYROLL_RUN_APPROVED",
  PAYROLL_RUN_FINALISED: "PAYROLL_RUN_FINALISED",
  PAYROLL_RUN_POSTED: "PAYROLL_RUN_POSTED",
  PAYROLL_RUN_ABANDONED: "PAYROLL_RUN_ABANDONED",
  PAYROLL_POSTING_REVERSED: "PAYROLL_POSTING_REVERSED",
  PAYSLIP_VIEWED: "PAYSLIP_VIEWED",

  // Phase 8 — employment letters.
  LETTER_TEMPLATE_SAVED: "LETTER_TEMPLATE_SAVED",
  LETTER_TEMPLATE_APPROVED: "LETTER_TEMPLATE_APPROVED",
  LETTER_GENERATED: "LETTER_GENERATED",
  LETTER_APPROVED: "LETTER_APPROVED",
  LETTER_ISSUED: "LETTER_ISSUED",
  LETTER_CANCELLED: "LETTER_CANCELLED",

  // Phase 9 — estate cases.
  //
  // CASE_RULE_APPROVED is the one to watch in this group. It is the moment a legal
  // requirement enters the platform, and the row records who said so. Every checklist
  // item generated afterwards points back at it.
  CASE_OPENED: "CASE_OPENED",
  CASE_UPDATED: "CASE_UPDATED",
  CASE_CLOSED: "CASE_CLOSED",
  CASE_WITHDRAWN: "CASE_WITHDRAWN",
  CASE_REOPENED: "CASE_REOPENED",
  CASE_ASSIGNED: "CASE_ASSIGNED",
  CASE_UNASSIGNED: "CASE_UNASSIGNED",
  CASE_PARTY_RECORDED: "CASE_PARTY_RECORDED",
  CASE_PARTY_UPDATED: "CASE_PARTY_UPDATED",
  CASE_PARTY_REMOVED: "CASE_PARTY_REMOVED",
  CASE_ASSET_RECORDED: "CASE_ASSET_RECORDED",
  CASE_ASSET_UPDATED: "CASE_ASSET_UPDATED",
  CASE_ASSET_REMOVED: "CASE_ASSET_REMOVED",
  CASE_LIABILITY_RECORDED: "CASE_LIABILITY_RECORDED",
  CASE_LIABILITY_UPDATED: "CASE_LIABILITY_UPDATED",
  CASE_LIABILITY_REMOVED: "CASE_LIABILITY_REMOVED",
  /** A party, asset, liability or fact was marked verified. One action, so that
      "what has actually been checked on this matter" is a single query. */
  CASE_FACT_VERIFIED: "CASE_FACT_VERIFIED",
  CASE_FACT_DEFINED: "CASE_FACT_DEFINED",
  CASE_FACT_ANSWERED: "CASE_FACT_ANSWERED",
  CASE_RULE_SAVED: "CASE_RULE_SAVED",
  CASE_RULE_APPROVED: "CASE_RULE_APPROVED",
  CASE_RULE_RETIRED: "CASE_RULE_RETIRED",
  CASE_CHECKLIST_GENERATED: "CASE_CHECKLIST_GENERATED",
  CASE_REQUIREMENT_ADDED: "CASE_REQUIREMENT_ADDED",
  CASE_REQUIREMENT_SATISFIED: "CASE_REQUIREMENT_SATISFIED",
  CASE_REQUIREMENT_WAIVED: "CASE_REQUIREMENT_WAIVED",
  CASE_REQUIREMENT_REOPENED: "CASE_REQUIREMENT_REOPENED",
  CASE_TASK_CREATED: "CASE_TASK_CREATED",
  CASE_TASK_UPDATED: "CASE_TASK_UPDATED",
  CASE_TASK_COMPLETED: "CASE_TASK_COMPLETED",
  CASE_TASK_CANCELLED: "CASE_TASK_CANCELLED",
  CASE_DOCUMENT_REGISTERED: "CASE_DOCUMENT_REGISTERED",
  CASE_DOCUMENT_UPDATED: "CASE_DOCUMENT_UPDATED",
  CASE_DOCUMENT_REMOVED: "CASE_DOCUMENT_REMOVED",
  CASE_EVENT_RECORDED: "CASE_EVENT_RECORDED",

  // Phase 10 — the document library.
  //
  // DOCUMENT_SCANNED and DOCUMENT_RELEASED are deliberately different actions. The first
  // records a scanner's verdict; the second records a person deciding to proceed without
  // one. Conflating them would lose exactly the distinction the pipeline exists to keep.
  DOCUMENT_REGISTERED: "DOCUMENT_REGISTERED",
  DOCUMENT_SCANNED: "DOCUMENT_SCANNED",
  DOCUMENT_RELEASED: "DOCUMENT_RELEASED",
  DOCUMENT_CLASSIFIED: "DOCUMENT_CLASSIFIED",
  DOCUMENT_EXTRACTED: "DOCUMENT_EXTRACTED",
  /** A document left the platform. The moment worth recording. */
  DOCUMENT_DOWNLOADED: "DOCUMENT_DOWNLOADED",
  DOCUMENT_ARCHIVED: "DOCUMENT_ARCHIVED",
  DOCUMENT_DELETED: "DOCUMENT_DELETED",

  // Phase 12 — documents generated for a matter.
  //
  // CASE_DOCUMENT_APPROVED is the legal act in this group, and CASE_DOCUMENT_FINALISED is
  // the moment the file becomes fixed: the row carries the checksum of the PDF that was
  // stored, so "is this the document that was approved" is answerable from the trail alone.
  CASE_TEMPLATE_SAVED: "CASE_TEMPLATE_SAVED",
  CASE_TEMPLATE_APPROVED: "CASE_TEMPLATE_APPROVED",
  CASE_DOCUMENT_GENERATED: "CASE_DOCUMENT_GENERATED",
  CASE_DOCUMENT_APPROVED: "CASE_DOCUMENT_APPROVED",
  CASE_DOCUMENT_FINALISED: "CASE_DOCUMENT_FINALISED",
  CASE_DOCUMENT_CANCELLED: "CASE_DOCUMENT_CANCELLED",
} as const;
